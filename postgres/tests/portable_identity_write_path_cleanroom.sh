#!/usr/bin/env bash
set -euo pipefail

# Clean-room proof for ledger step 004: the identity write path, the actor
# resolver, the roster read and the identity store schema.
#
# Everything runs through the migration ledger, because the ledger is the only
# sanctioned apply path and an artifact proved any other way is not proved at all.
#
# Covered:
#   1. a fresh apply of 001 -> 002 -> 003 -> 004 into an empty, control-plane
#      prepared database;
#   2. catalog assertions: ownership, ACLs, pinned search_path, store isolation;
#   3. behaviour assertions as the real app_runtime request principal, including
#      the non-admin denials;
#   4. behaviour assertions as the identity_store principal: the store cannot
#      read the workspace;
#   5. behaviour assertions as the AI execution principal: the guard cannot reach
#      any step 004 function;
#   6. a re-apply is an idempotent no-op and verify still passes;
#   7. a database without the control-plane identity prerequisite refuses step 004
#      and lands nothing of it -- the prerequisite check has to bite.

repo_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
baseline_dir="$repo_dir/postgres/tenant-baseline/v1"
tests_dir="$repo_dir/postgres/tests"
runner="$repo_dir/postgres/tools/portable_migration_ledger.mjs"
bootstrap="$baseline_dir/000_control_plane_role_bootstrap.sql"
identity_bootstrap="$baseline_dir/000_identity_store_role_bootstrap.sql"
test_roles="$tests_dir/portable_dump_restore_test_roles.sql"
fixture_seed="$tests_dir/portable_identity_roles_rls_fixture_seed.sql"
catalog_assertions="$tests_dir/portable_identity_write_path_catalog_assertions.sql"
behavior_assertions="$tests_dir/portable_identity_write_path_behavior_assertions.sql"
store_assertions="$tests_dir/portable_identity_store_isolation_assertions.sql"
ai_assertions="$tests_dir/portable_identity_write_path_ai_boundary_assertions.sql"
image="${POSTGRES_IMAGE:-postgres:17-alpine}"
container="portable-identity-write-path-$$"
work_dir="$(mktemp -d)"

if ! docker info >/dev/null 2>&1; then
  echo "Docker daemon is unavailable; clean-room apply was not run" >&2
  exit 2
fi

if ! docker image inspect "$image" >/dev/null 2>&1; then
  echo "PostgreSQL image $image is not present locally; refusing an implicit network pull" >&2
  exit 2
fi

cleanup() {
  docker rm -f "$container" >/dev/null 2>&1 || true
  docker rm -f "$container-neg" >/dev/null 2>&1 || true
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

# The runner reaches PostgreSQL only through $LEDGER_PSQL, so it never learns a
# host, port or credential.
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

run_file() {
  local user="$1" db="$2" file="$3"
  docker exec --interactive "$container" \
    psql --username "$user" --dbname "$db" --no-psqlrc --quiet --set ON_ERROR_STOP=1 < "$file"
}

query() {
  local user="$1" db="$2" sql="$3"
  printf '%s\n' "$sql" | docker exec --interactive "$container" \
    psql --username "$user" --dbname "$db" --no-psqlrc --quiet --no-align --tuples-only \
         --set ON_ERROR_STOP=1
}

new_db() {
  local db="$1"
  docker exec "$container" psql -U postgres -d postgres -q -c "CREATE DATABASE $db;" >/dev/null
  docker exec --interactive "$container" psql -U postgres -d "$db" --set ON_ERROR_STOP=1 -q \
    < "$bootstrap" >/dev/null
}

check_file() {
  local label="$1" user="$2" db="$3" file="$4"
  if run_file "$user" "$db" "$file" >"$work_dir/out.txt" 2>&1; then
    ok "$label"
  else
    bad "$label"
    sed 's/^/       /' "$work_dir/out.txt" >&2
  fi
}

echo "Clean-room PostgreSQL: $(docker exec "$container" psql -U postgres -d postgres -tA -c 'select version()')"
echo
echo "Step 004 clean-room apply"

# --- 1. fresh apply, fully prepared database ---------------------------------
new_db identity_prepared
docker exec --interactive "$container" psql -U postgres -d identity_prepared --set ON_ERROR_STOP=1 -q \
  < "$identity_bootstrap" >/dev/null
ok "control-plane prerequisites applied (seven-role bootstrap plus the identity store role)"

if LEDGER_DB=identity_prepared node "$runner" apply --json "$work_dir/ledger.json" >"$work_dir/apply.txt" 2>&1; then
  ok "fresh apply accepted: $(tr '\n' '; ' < "$work_dir/apply.txt" | sed 's/; $//')"
else
  bad "fresh apply was rejected"
  sed 's/^/       /' "$work_dir/apply.txt" >&2
fi

recorded="$(query app_migration identity_prepared \
  "SET ROLE app_owner;
   SELECT string_agg(step || ':' || artifact, ' | ' ORDER BY applied_seq)
     FROM app_ledger.applied_migration;")"
expected="1:001_portable_business_baseline.sql | 2:002_identity_roles_actor_rls.sql | 3:003_functions_triggers_ai_guard.sql | 4:004_identity_write_path_and_store.sql"
if [ "$recorded" = "$expected" ]; then
  ok "the ledger records four steps in canonical order"
else
  bad "ledger contents differ
       expected: $expected
       actual:   $recorded"
fi

# --- 2. catalog and behaviour ------------------------------------------------
check_file "catalog assertions (app_migration)" app_migration identity_prepared "$catalog_assertions"
check_file "identity fixtures seeded (app_migration)" app_migration identity_prepared "$fixture_seed"
check_file "behaviour assertions as the request principal (app_runtime)" \
  app_runtime identity_prepared "$behavior_assertions"
check_file "store isolation assertions as the store principal (identity_store)" \
  identity_store identity_prepared "$store_assertions"

docker exec --interactive "$container" psql -U postgres -d identity_prepared --set ON_ERROR_STOP=1 -q \
  < "$test_roles" >/dev/null
check_file "AI boundary assertions as the AI execution principal (app_system)" \
  app_ai_client identity_prepared "$ai_assertions"

# --- 3. the runtime principal cannot become the store, or the owner -----------
for role in app_owner app_migration identity_store; do
  if docker exec "$container" psql --username app_runtime --dbname identity_prepared \
       --set ON_ERROR_STOP=1 --command "SET ROLE $role;" >/dev/null 2>&1; then
    bad "app_runtime unexpectedly gained SET ROLE $role"
  else
    ok "app_runtime cannot SET ROLE $role"
  fi
done

# --- 4. re-apply is an idempotent no-op --------------------------------------
before="$(query app_migration identity_prepared \
  "SET ROLE app_owner; SELECT count(*) || '/' || max(applied_seq) FROM app_ledger.applied_migration;")"
reapply="$(LEDGER_DB=identity_prepared node "$runner" apply 2>&1)"
after="$(query app_migration identity_prepared \
  "SET ROLE app_owner; SELECT count(*) || '/' || max(applied_seq) FROM app_ledger.applied_migration;")"
if [ "$before" = "$after" ] && printf '%s' "$reapply" | grep -q 'nothing to apply'; then
  ok "re-applying step 004 is an idempotent no-op ($reapply)"
else
  bad "re-apply was not a no-op (before=$before after=$after output=$reapply)"
fi

if LEDGER_DB=identity_prepared node "$runner" verify >"$work_dir/verify.txt" 2>&1; then
  ok "verify accepts the completed four-step ledger: $(cat "$work_dir/verify.txt")"
else
  bad "verify rejected the completed ledger"
  sed 's/^/       /' "$work_dir/verify.txt" >&2
fi

# The store's rows survived both the assertions and the re-apply, so nothing in
# step 004 is destructive on a second run.
store_rows="$(query identity_store identity_prepared 'SELECT count(*) FROM identity."user";')"
if [ "$store_rows" = "1" ]; then
  ok "the identity store's rows survived the re-apply"
else
  bad "identity store rows after re-apply: $store_rows (expected 1)"
fi

# --- 5. the prerequisite check bites ----------------------------------------
#
# A database prepared with the seven-role bootstrap ALONE must refuse step 004 and
# must land nothing of it.
#
# This needs a SECOND cluster, and that is the point rather than an inconvenience:
# identity_store is a cluster-level object, so every further database in an
# already-prepared cluster finds the role waiting for it. The unprepared case only
# exists on a cluster that has never run the prerequisite -- a fresh provider
# project, or a restore target.
docker run --name "$container-neg" --detach \
  --env POSTGRES_HOST_AUTH_METHOD=trust \
  "$image" >/dev/null
for _ in $(seq 1 60); do
  if docker exec "$container-neg" pg_isready -U postgres -d postgres >/dev/null 2>&1; then
    break
  fi
  sleep 1
done
docker exec "$container-neg" pg_isready -U postgres -d postgres >/dev/null

cat > "$work_dir/psql-neg" <<EOF
#!/usr/bin/env bash
exec docker exec --interactive "$container-neg" psql "\$@"
EOF
chmod +x "$work_dir/psql-neg"

docker exec "$container-neg" psql -U postgres -d postgres -q \
  -c "CREATE DATABASE identity_unprepared;" >/dev/null
docker exec --interactive "$container-neg" psql -U postgres -d identity_unprepared \
  --set ON_ERROR_STOP=1 -q < "$bootstrap" >/dev/null

query_neg() {
  printf '%s\n' "$1" | docker exec --interactive "$container-neg" \
    psql --username app_migration --dbname identity_unprepared --no-psqlrc --quiet \
         --no-align --tuples-only --set ON_ERROR_STOP=1
}

set +e
unprepared_output="$(LEDGER_PSQL="$work_dir/psql-neg" LEDGER_DB=identity_unprepared \
  node "$runner" apply 2>&1)"
unprepared_status=$?
set -e
if [ "$unprepared_status" -ne 0 ] \
   && printf '%s' "$unprepared_output" | grep -q '\[step_apply_failed\]' \
   && printf '%s' "$unprepared_output" | grep -q '000_identity_store_role_bootstrap.sql'; then
  ok "step 004 refuses to apply without its control-plane prerequisite, and says which artifact is missing"
else
  bad "the missing prerequisite was not reported as expected (exit $unprepared_status: $unprepared_output)"
fi

partial="$(query_neg \
  "SET ROLE app_owner;
   SELECT count(*)::text || '/' || (to_regnamespace('identity') IS NULL)::text
     FROM app_ledger.applied_migration;")"
if [ "$partial" = "3/true" ]; then
  ok "the refused step left the first three steps applied and no part of itself: $partial"
else
  bad "unexpected state after the refused step: $partial (expected 3/true)"
fi

# And the earlier steps are still consistent, so the failure is recoverable by
# running the prerequisite and applying again -- not by editing the ledger.
if LEDGER_PSQL="$work_dir/psql-neg" LEDGER_DB=identity_unprepared \
     node "$runner" verify --allow-partial >/dev/null 2>&1; then
  ok "the partially applied ledger still verifies, so the fix is to apply again"
else
  bad "the partially applied ledger no longer verifies"
fi

docker exec --interactive "$container-neg" psql -U postgres -d identity_unprepared \
  --set ON_ERROR_STOP=1 -q < "$identity_bootstrap" >/dev/null
if LEDGER_PSQL="$work_dir/psql-neg" LEDGER_DB=identity_unprepared \
     node "$runner" apply >"$work_dir/recover.txt" 2>&1; then
  ok "after the prerequisite is run, step 004 applies: $(tr '\n' '; ' < "$work_dir/recover.txt" | sed 's/; $//')"
else
  bad "step 004 did not apply after the prerequisite was run"
  sed 's/^/       /' "$work_dir/recover.txt" >&2
fi

echo
echo "Step 004 clean-room: $pass_count passed, $fail_count failed"
[ "$fail_count" -eq 0 ]
