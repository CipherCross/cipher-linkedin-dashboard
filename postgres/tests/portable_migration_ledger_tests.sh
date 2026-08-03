#!/usr/bin/env bash
set -euo pipefail

# Contract tests for the provider-neutral migration ledger.
#
# Every case runs against its own throwaway database inside one disposable
# PostgreSQL container, so a rejected case cannot contaminate the next one.
#
# Covered:
#   1. the correct apply order is accepted, and the ledger records 001 -> 002 ->
#      003 -> 004 with their SHA-256, the apply principal and the role-bootstrap
#      dependency;
#   2. a re-apply is an idempotent no-op (the chosen contract);
#   3. an artifact whose bytes no longer match the manifest is rejected;
#   4. a ledger row whose SHA-256 no longer matches the manifest is rejected;
#   5. a skipped step is rejected;
#   6. steps applied in the wrong order are rejected;
#   7. recording the same step twice is refused by the database itself;
#   8. the ledger is append-only: UPDATE, DELETE and TRUNCATE are refused;
#   9. applying without the control-plane role bootstrap is rejected;
#  10. a superuser apply principal is rejected;
#  11. the ledger declares no down migration path.

repo_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
baseline_dir="$repo_dir/postgres/tenant-baseline/v1"
runner="$repo_dir/postgres/tools/portable_migration_ledger.mjs"
bootstrap="$baseline_dir/000_control_plane_role_bootstrap.sql"
# Step 004 needs an eighth role that the seven-role bootstrap deliberately does
# not create. Every prepared database in these tests therefore also receives the
# additive control-plane extension; the case that proves the prerequisite check
# bites lives in portable_identity_write_path_cleanroom.sh, which is the harness
# that owns step 004.
identity_bootstrap="$baseline_dir/000_identity_store_role_bootstrap.sql"
image="${POSTGRES_IMAGE:-postgres:17-alpine}"
container="portable-ledger-tests-$$"
work_dir="$(mktemp -d)"

if ! docker info >/dev/null 2>&1; then
  echo "Docker daemon is unavailable; ledger tests were not run" >&2
  exit 2
fi

if ! docker image inspect "$image" >/dev/null 2>&1; then
  echo "PostgreSQL image $image is not present locally; refusing an implicit network pull" >&2
  exit 2
fi

cleanup() {
  docker rm -f "$container" >/dev/null 2>&1 || true
  rm -rf "$work_dir"
}
trap cleanup EXIT

docker run --name "$container" --detach \
  --env POSTGRES_HOST_AUTH_METHOD=trust \
  "$image" >/dev/null

for _ in $(seq 1 60); do
  if docker exec "$container" pg_isready -U postgres -d postgres >/dev/null 2>&1; then
    break
  fi
  sleep 1
done
docker exec "$container" pg_isready -U postgres -d postgres >/dev/null

# The runner talks to PostgreSQL through $LEDGER_PSQL. Pointing it at a wrapper
# keeps the runner free of any host, port or credential knowledge.
cat > "$work_dir/psql" <<EOF
#!/usr/bin/env bash
exec docker exec --interactive "$container" psql "\$@"
EOF
chmod +x "$work_dir/psql"
export LEDGER_PSQL="$work_dir/psql"

pass_count=0
fail_count=0

ok() {
  printf '  ok   %s\n' "$1"
  pass_count=$((pass_count + 1))
}

bad() {
  printf '  FAIL %s\n' "$1" >&2
  fail_count=$((fail_count + 1))
}

sql_as() {
  local user="$1" db="$2"
  docker exec --interactive "$container" \
    psql --username "$user" --dbname "$db" --no-psqlrc --quiet --no-align --tuples-only \
         --set ON_ERROR_STOP=1
}

# Fresh database prepared with the control-plane role bootstrap.
new_db() {
  local db="$1"
  docker exec "$container" psql -U postgres -d postgres -q -c "CREATE DATABASE $db;" >/dev/null
  docker exec --interactive "$container" psql -U postgres -d "$db" --set ON_ERROR_STOP=1 -q \
    < "$bootstrap" >/dev/null
  docker exec --interactive "$container" psql -U postgres -d "$db" --set ON_ERROR_STOP=1 -q \
    < "$identity_bootstrap" >/dev/null
}

# Runs the ledger runner and checks the outcome. Expected exit status 0 means
# "accepted"; any other value means "rejected", and the reason code printed by
# the runner must match.
expect_runner() {
  local label="$1" db="$2" command="$3" expected_code="$4"
  shift 4
  local output status
  set +e
  output="$(LEDGER_DB="$db" node "$runner" "$command" "$@" 2>&1)"
  status=$?
  set -e
  if [ "$expected_code" = "accept" ]; then
    if [ "$status" -eq 0 ]; then
      ok "$label"
    else
      bad "$label (expected acceptance, got exit $status: $output)"
    fi
    return
  fi
  if [ "$status" -eq 0 ]; then
    bad "$label (expected rejection [$expected_code], but the runner accepted it)"
  elif printf '%s' "$output" | grep -q "\[$expected_code\]"; then
    ok "$label"
  else
    bad "$label (expected rejection [$expected_code], got: $output)"
  fi
}

# Runs SQL that must fail, and checks the error text.
expect_sql_error() {
  local label="$1" db="$2" user="$3" statement="$4" needle="$5"
  local output status
  set +e
  output="$(printf '%s\n' "$statement" | sql_as "$user" "$db" 2>&1)"
  status=$?
  set -e
  if [ "$status" -eq 0 ]; then
    bad "$label (statement unexpectedly succeeded)"
  elif printf '%s' "$output" | grep -qi "$needle"; then
    ok "$label"
  else
    bad "$label (expected /$needle/, got: $output)"
  fi
}

insert_ledger_row() {
  local db="$1" step="$2" artifact="$3" sha="$4"
  printf "SET ROLE app_owner;\nINSERT INTO app_ledger.applied_migration (step, artifact, sha256, ledger_version) VALUES (%s, '%s', '%s', 'v1');\n" \
    "$step" "$artifact" "$sha" | sql_as app_migration "$db" >/dev/null
}

sha_of() {
  docker exec "$container" true # keep container warm; digest is computed on the host
  shasum -a 256 "$baseline_dir/$1" | awk '{print $1}'
}

echo "Clean-room PostgreSQL: $(docker exec "$container" psql -U postgres -d postgres -tA -c 'select version()')"
echo
echo "Ledger contract tests"

# --- 1. correct order is accepted -------------------------------------------
new_db ledger_happy
expect_runner "correct apply order 001 -> 002 -> 003 -> 004 is accepted" ledger_happy apply accept

recorded="$(printf "SET ROLE app_owner;\nSELECT string_agg(step || ':' || artifact || ':' || sha256 || ':' || apply_principal || '/' || apply_role, ' | ' ORDER BY applied_seq) FROM app_ledger.applied_migration;\n" | sql_as app_migration ledger_happy)"
expected="1:001_portable_business_baseline.sql:$(sha_of 001_portable_business_baseline.sql):app_migration/app_owner | 2:002_identity_roles_actor_rls.sql:$(sha_of 002_identity_roles_actor_rls.sql):app_migration/app_owner | 3:003_functions_triggers_ai_guard.sql:$(sha_of 003_functions_triggers_ai_guard.sql):app_migration/app_owner | 4:004_identity_write_path_and_store.sql:$(sha_of 004_identity_write_path_and_store.sql):app_migration/app_owner"
if [ "$recorded" = "$expected" ]; then
  ok "ledger records the order, digests and apply principal"
else
  bad "ledger contents differ
  expected: $expected
  actual:   $recorded"
fi

bootstrap_row="$(printf "SET ROLE app_owner;\nSELECT artifact || ':' || sha256 || ':' || array_length(required_roles, 1) FROM app_ledger.role_bootstrap;\n" | sql_as app_migration ledger_happy)"
if [ "$bootstrap_row" = "000_control_plane_role_bootstrap.sql:$(sha_of 000_control_plane_role_bootstrap.sql):7" ]; then
  ok "ledger records the role-bootstrap dependency and its seven roles"
else
  bad "role-bootstrap record differs: $bootstrap_row"
fi

# --- 2. re-apply is an idempotent no-op --------------------------------------
before="$(printf "SET ROLE app_owner;\nSELECT count(*) || '/' || max(applied_seq) FROM app_ledger.applied_migration;\n" | sql_as app_migration ledger_happy)"
reapply_output="$(LEDGER_DB=ledger_happy node "$runner" apply 2>&1)"
after="$(printf "SET ROLE app_owner;\nSELECT count(*) || '/' || max(applied_seq) FROM app_ledger.applied_migration;\n" | sql_as app_migration ledger_happy)"
if [ "$before" = "$after" ] && printf '%s' "$reapply_output" | grep -q 'nothing to apply'; then
  ok "re-applying an already-applied ledger is an idempotent no-op"
else
  bad "re-apply was not a no-op (before=$before after=$after output=$reapply_output)"
fi
expect_runner "verify accepts the completed ledger" ledger_happy verify accept

# --- 3. a modified artifact is rejected --------------------------------------
# The manifest and artifacts are copied into a scratch tree so the real ones are
# never touched; a single appended byte is enough to change the digest.
cp -R "$repo_dir/postgres" "$work_dir/repo_postgres"
mkdir -p "$work_dir/tampered/postgres"
cp -R "$work_dir/repo_postgres/." "$work_dir/tampered/postgres/"
printf -- '-- tampered\n' >> "$work_dir/tampered/postgres/tenant-baseline/v1/002_identity_roles_actor_rls.sql"
new_db ledger_tampered
set +e
tamper_output="$(LEDGER_DB=ledger_tampered node "$work_dir/tampered/postgres/tools/portable_migration_ledger.mjs" apply 2>&1)"
tamper_status=$?
set -e
if [ "$tamper_status" -ne 0 ] && printf '%s' "$tamper_output" | grep -q '\[artifact_sha_mismatch\]'; then
  ok "an artifact whose bytes changed is rejected before anything is applied"
else
  bad "modified artifact was not rejected (exit $tamper_status: $tamper_output)"
fi
applied_after_tamper="$(printf "SET ROLE app_owner;\nSELECT to_regclass('app_ledger.applied_migration') IS NULL;\n" | sql_as app_migration ledger_tampered)"
if [ "$applied_after_tamper" = "t" ]; then
  ok "a rejected artifact leaves the target database untouched"
else
  bad "the tampered run created a ledger in the target database"
fi

# --- 4. a ledger row that disagrees with the manifest is rejected ------------
new_db ledger_sha
insert_ledger_bootstrap() {
  printf "SET ROLE app_owner;\nINSERT INTO app_ledger.role_bootstrap (artifact, sha256, ledger_version, required_roles) VALUES ('000_control_plane_role_bootstrap.sql', '%s', 'v1', ARRAY['app_owner','app_migration','app_runtime','app_readonly','app_machine','app_system','app_ai_runner']::text[]);\n" \
    "$(sha_of 000_control_plane_role_bootstrap.sql)" | sql_as app_migration "$1" >/dev/null
}
docker exec --interactive "$container" psql -U app_migration -d ledger_sha --set ON_ERROR_STOP=1 -q \
  < "$baseline_dir/000_migration_ledger.sql" >/dev/null
insert_ledger_bootstrap ledger_sha
insert_ledger_row ledger_sha 1 001_portable_business_baseline.sql \
  0000000000000000000000000000000000000000000000000000000000000000
expect_runner "a ledger row whose digest differs from the manifest is rejected" \
  ledger_sha verify ledger_sha_mismatch --allow-partial

# --- 5. a skipped step is rejected -------------------------------------------
new_db ledger_gap
docker exec --interactive "$container" psql -U app_migration -d ledger_gap --set ON_ERROR_STOP=1 -q \
  < "$baseline_dir/000_migration_ledger.sql" >/dev/null
insert_ledger_bootstrap ledger_gap
insert_ledger_row ledger_gap 1 001_portable_business_baseline.sql "$(sha_of 001_portable_business_baseline.sql)"
insert_ledger_row ledger_gap 3 003_functions_triggers_ai_guard.sql "$(sha_of 003_functions_triggers_ai_guard.sql)"
expect_runner "a skipped step is rejected" ledger_gap verify ledger_gap --allow-partial

# --- 6. steps applied in the wrong order are rejected ------------------------
new_db ledger_order
docker exec --interactive "$container" psql -U app_migration -d ledger_order --set ON_ERROR_STOP=1 -q \
  < "$baseline_dir/000_migration_ledger.sql" >/dev/null
insert_ledger_bootstrap ledger_order
insert_ledger_row ledger_order 2 002_identity_roles_actor_rls.sql "$(sha_of 002_identity_roles_actor_rls.sql)"
insert_ledger_row ledger_order 1 001_portable_business_baseline.sql "$(sha_of 001_portable_business_baseline.sql)"
expect_runner "steps recorded out of order are rejected" ledger_order verify ledger_out_of_order --allow-partial

# --- 7. the database refuses a duplicate step -------------------------------
expect_sql_error "recording the same step twice is refused by the primary key" \
  ledger_happy app_migration \
  "SET ROLE app_owner; INSERT INTO app_ledger.applied_migration (step, artifact, sha256, ledger_version) VALUES (1, '001_portable_business_baseline.sql', '$(sha_of 001_portable_business_baseline.sql)', 'v1');" \
  'duplicate key value'

# --- 8. the ledger is append-only -------------------------------------------
expect_sql_error "the ledger refuses UPDATE" ledger_happy app_migration \
  "SET ROLE app_owner; UPDATE app_ledger.applied_migration SET sha256 = repeat('0', 64) WHERE step = 1;" \
  'append-only'
expect_sql_error "the ledger refuses DELETE" ledger_happy app_migration \
  "SET ROLE app_owner; DELETE FROM app_ledger.applied_migration WHERE step = 1;" \
  'append-only'
expect_sql_error "the ledger refuses TRUNCATE" ledger_happy app_migration \
  "SET ROLE app_owner; TRUNCATE app_ledger.applied_migration;" \
  'append-only'
expect_sql_error "the role-bootstrap record refuses UPDATE" ledger_happy app_migration \
  "SET ROLE app_owner; UPDATE app_ledger.role_bootstrap SET sha256 = repeat('0', 64);" \
  'append-only'

# --- 9. no ledger without the control-plane role bootstrap -------------------
docker exec "$container" psql -U postgres -d postgres -q -c "CREATE DATABASE ledger_unprepared;" >/dev/null
docker exec "$container" psql -U postgres -d ledger_unprepared -q \
  -c "REVOKE ALL ON SCHEMA public FROM PUBLIC;" >/dev/null
expect_runner "applying without the control-plane database bootstrap fails" \
  ledger_unprepared apply ledger_bootstrap_failed

# --- 10. the apply principal must not be a superuser -------------------------
docker exec "$container" psql -U postgres -d postgres -q \
  -c "ALTER ROLE app_migration SUPERUSER;" >/dev/null
new_db ledger_superuser
expect_runner "a superuser apply principal is rejected" ledger_superuser apply apply_principal_invalid
docker exec "$container" psql -U postgres -d postgres -q \
  -c "ALTER ROLE app_migration NOSUPERUSER;" >/dev/null
ok "apply principal restored to non-superuser"

# --- 11. no down migrations --------------------------------------------------
if grep -qiE '"?down"?[_ ]?(migration|step)s?"?\s*:\s*(\[|\{|"?[^f])' "$baseline_dir/ledger.manifest.json" \
   && ! grep -q '"supported": false' "$baseline_dir/ledger.manifest.json"; then
  bad "the manifest appears to declare a down migration path"
else
  ok "the ledger declares no down migration path"
fi

echo
echo "Ledger contract tests: $pass_count passed, $fail_count failed"
[ "$fail_count" -eq 0 ]
