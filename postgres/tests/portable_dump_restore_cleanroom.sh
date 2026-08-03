#!/usr/bin/env bash
set -euo pipefail

# Clean-room reproducibility and dump/restore harness for the portable baseline.
#
# Three disposable PostgreSQL containers, each its own cluster:
#
#   source   control-plane bootstrap -> ledger apply -> clean inventory snapshot
#            -> fixtures -> pre-dump snapshot -> pg_dump
#   replica  an INDEPENDENT second clean apply, for the reproducibility diff
#   target   control-plane bootstrap only -> restore window -> pg_restore ->
#            window close -> reconciliation, behaviour and ledger verification
#
# The replica is a separate cluster rather than a second database in the source
# cluster on purpose: roles are cluster objects, and reusing them would hide a
# dependency on state the bootstrap is supposed to create.
#
# The two test-only login roles are created identically in all three clusters so
# the inventory snapshots stay comparable. They exist only so the harness can
# reach the NOLOGIN app_system and app_readonly principals from a real session,
# and they are not part of any portable artifact or of the production contract.
#
# Nothing outside these containers is touched. No credential, connection string
# or provider resource ID is used or produced.

repo_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
baseline_dir="$repo_dir/postgres/tenant-baseline/v1"
tests_dir="$repo_dir/postgres/tests"
runner="$repo_dir/postgres/tools/portable_migration_ledger.mjs"
bootstrap="$baseline_dir/000_control_plane_role_bootstrap.sql"
# Additive control-plane prerequisite for ledger step 004. It runs everywhere the
# seven-role bootstrap runs, including the restore target: identity_store is a
# cluster object, so pg_restore cannot recreate an object owned by it unless the
# role is already there.
identity_bootstrap="$baseline_dir/000_identity_store_role_bootstrap.sql"
image="${POSTGRES_IMAGE:-postgres:17-alpine}"
work_dir="$(mktemp -d)"
evidence_path="${S08_EVIDENCE_JSON:-}"

source_container="portable-dumprestore-source-$$"
replica_container="portable-dumprestore-replica-$$"
target_container="portable-dumprestore-target-$$"

if ! docker info >/dev/null 2>&1; then
  echo "Docker daemon is unavailable; dump/restore clean-room was not run" >&2
  exit 2
fi

if ! docker image inspect "$image" >/dev/null 2>&1; then
  echo "PostgreSQL image $image is not present locally; refusing an implicit network pull" >&2
  exit 2
fi

cleanup() {
  docker rm -f "$source_container" "$replica_container" "$target_container" >/dev/null 2>&1 || true
  rm -rf "$work_dir"
}
trap cleanup EXIT

start_cluster() {
  local name="$1"
  docker run --name "$name" --detach --env POSTGRES_HOST_AUTH_METHOD=trust "$image" >/dev/null
  for _ in $(seq 1 60); do
    if docker exec "$name" pg_isready -U postgres -d postgres >/dev/null 2>&1; then
      return 0
    fi
    sleep 1
  done
  docker exec "$name" pg_isready -U postgres -d postgres >/dev/null
}

run_sql() {
  local container="$1" user="$2" db="$3" file="$4"
  docker exec --interactive "$container" \
    psql --username "$user" --dbname "$db" --no-psqlrc --set ON_ERROR_STOP=1 < "$file"
}

capture() {
  local container="$1" user="$2" db="$3" file="$4" out="$5"
  docker exec --interactive "$container" \
    psql --username "$user" --dbname "$db" --no-psqlrc --set ON_ERROR_STOP=1 < "$file" > "$out"
}

psql_wrapper() {
  local container="$1" path="$2"
  cat > "$path" <<EOF
#!/usr/bin/env bash
exec docker exec --interactive $container psql "\$@"
EOF
  chmod +x "$path"
}

step() { printf '\n== %s\n' "$1"; }
ok()   { printf '  ok   %s\n' "$1"; }
die()  { printf '  FAIL %s\n' "$1" >&2; exit 1; }

# ---------------------------------------------------------------------------
step "Clean-room clusters"
start_cluster "$source_container"
start_cluster "$replica_container"
start_cluster "$target_container"

server_version="$(docker exec "$source_container" psql -U postgres -d postgres -tA -c 'select version()')"
pg_dump_version="$(docker exec "$source_container" pg_dump --version)"
pg_restore_version="$(docker exec "$target_container" pg_restore --version)"
psql_version="$(docker exec "$source_container" psql --version)"
echo "  server:     $server_version"
echo "  pg_dump:    $pg_dump_version"
echo "  pg_restore: $pg_restore_version"
echo "  psql:       $psql_version"

# ---------------------------------------------------------------------------
step "Clean apply #1 (source cluster)"
docker exec "$source_container" psql -U postgres -d postgres -q -c "CREATE DATABASE tenant_source;" >/dev/null
run_sql "$source_container" postgres tenant_source "$bootstrap" >/dev/null
run_sql "$source_container" postgres tenant_source "$identity_bootstrap" >/dev/null
run_sql "$source_container" postgres tenant_source "$tests_dir/portable_dump_restore_test_roles.sql" >/dev/null
psql_wrapper "$source_container" "$work_dir/psql-source"
LEDGER_PSQL="$work_dir/psql-source" LEDGER_DB=tenant_source \
  node "$runner" apply --json "$work_dir/ledger-source.json"
capture "$source_container" app_migration tenant_source \
  "$tests_dir/portable_schema_inventory_snapshot.sql" "$work_dir/inventory-apply-1.txt"
ok "first clean apply produced $(wc -l < "$work_dir/inventory-apply-1.txt" | tr -d ' ') inventory lines"

# ---------------------------------------------------------------------------
step "Clean apply #2 (independent replica cluster)"
docker exec "$replica_container" psql -U postgres -d postgres -q -c "CREATE DATABASE tenant_source;" >/dev/null
run_sql "$replica_container" postgres tenant_source "$bootstrap" >/dev/null
run_sql "$replica_container" postgres tenant_source "$identity_bootstrap" >/dev/null
run_sql "$replica_container" postgres tenant_source "$tests_dir/portable_dump_restore_test_roles.sql" >/dev/null
psql_wrapper "$replica_container" "$work_dir/psql-replica"
LEDGER_PSQL="$work_dir/psql-replica" LEDGER_DB=tenant_source \
  node "$runner" apply --json "$work_dir/ledger-replica.json"
capture "$replica_container" app_migration tenant_source \
  "$tests_dir/portable_schema_inventory_snapshot.sql" "$work_dir/inventory-apply-2.txt"
ok "second clean apply produced $(wc -l < "$work_dir/inventory-apply-2.txt" | tr -d ' ') inventory lines"

step "Reproducibility: inventory diff between the two clean applies"
if diff -u "$work_dir/inventory-apply-1.txt" "$work_dir/inventory-apply-2.txt" > "$work_dir/reproducibility.diff"; then
  ok "inventory diff between the two independent clean applies is empty"
else
  cat "$work_dir/reproducibility.diff" >&2
  die "two independent clean applies produced different inventories"
fi

# The ledger state must also be reproducible, apart from its timestamps.
if diff <(node -e 'const s=require(process.argv[1]);console.log(JSON.stringify(s.applied.map(({step,artifact,sha256,apply_principal,apply_role,applied_seq})=>({step,artifact,sha256,apply_principal,apply_role,applied_seq})),null,2))' "$work_dir/ledger-source.json") \
        <(node -e 'const s=require(process.argv[1]);console.log(JSON.stringify(s.applied.map(({step,artifact,sha256,apply_principal,apply_role,applied_seq})=>({step,artifact,sha256,apply_principal,apply_role,applied_seq})),null,2))' "$work_dir/ledger-replica.json") \
        > "$work_dir/ledger.diff"; then
  ok "both clean applies recorded the same ledger"
else
  cat "$work_dir/ledger.diff" >&2
  die "the two clean applies recorded different ledgers"
fi

# ---------------------------------------------------------------------------
step "Seed fixtures and dump the source"
run_sql "$source_container" app_migration tenant_source \
  "$tests_dir/portable_identity_roles_rls_fixture_seed.sql" >/dev/null
run_sql "$source_container" app_migration tenant_source \
  "$tests_dir/portable_functions_triggers_fixture_seed.sql" >/dev/null

capture "$source_container" app_migration tenant_source \
  "$tests_dir/portable_schema_inventory_snapshot.sql" "$work_dir/inventory-pre-dump.txt"
capture "$source_container" app_migration tenant_source \
  "$tests_dir/portable_sequence_state.sql" "$work_dir/sequences-pre-dump.txt"

if diff -q "$work_dir/inventory-apply-1.txt" "$work_dir/inventory-pre-dump.txt" >/dev/null; then
  ok "seeding data changed nothing in the schema inventory"
else
  die "seeding fixtures altered the schema inventory"
fi

# The dump is taken by the ordinary non-superuser migration login, acting as the
# object owner. No roles are dumped: pg_dumpall --roles-only would move role
# definitions and credentials between clusters and is deliberately not used.
docker exec "$source_container" pg_dump \
  --username app_migration --role app_owner --dbname tenant_source \
  --format=custom --file /tmp/tenant.dump
docker cp "$source_container":/tmp/tenant.dump "$work_dir/tenant.dump" >/dev/null
ok "pg_dump produced $(wc -c < "$work_dir/tenant.dump" | tr -d ' ') bytes as a non-superuser"

# ---------------------------------------------------------------------------
step "Restore into a clean, separately bootstrapped cluster"
docker exec "$target_container" psql -U postgres -d postgres -q -c "CREATE DATABASE tenant_restored;" >/dev/null
run_sql "$target_container" postgres tenant_restored "$bootstrap" >/dev/null
run_sql "$target_container" postgres tenant_restored "$identity_bootstrap" >/dev/null
run_sql "$target_container" postgres tenant_restored "$tests_dir/portable_dump_restore_test_roles.sql" >/dev/null
ok "restore target prepared by the control-plane role bootstraps alone (seven-role plus the identity store extension)"

# Prove the roles came from the bootstrap and not from the dump.
docker cp "$work_dir/tenant.dump" "$target_container":/tmp/tenant.dump >/dev/null
if docker exec "$target_container" pg_restore --list /tmp/tenant.dump | grep -qiE '^[0-9;].*\b(ROLE|ACL - ROLE)\b'; then
  die "the dump appears to contain role definitions"
else
  ok "the dump contains no role definitions; roles come from the bootstrap"
fi

run_sql "$target_container" postgres tenant_restored "$baseline_dir/restore_window_open.sql" >/dev/null

restore_log="$work_dir/pg_restore.log"
if docker exec "$target_container" pg_restore \
     --username app_migration --role app_owner --dbname tenant_restored \
     --exit-on-error /tmp/tenant.dump > "$restore_log" 2>&1; then
  ok "pg_restore completed as a non-superuser with no error"
else
  cat "$restore_log" >&2
  die "pg_restore failed"
fi

# pg_restore reports a failed GRANT as a warning, not an error, so the log is
# inspected as well as the exit status.
if grep -qi 'warning' "$restore_log"; then
  cat "$restore_log" >&2
  die "pg_restore emitted warnings; a silently skipped GRANT or REVOKE would change privileges"
else
  ok "pg_restore emitted no warnings"
fi

run_sql "$target_container" postgres tenant_restored "$baseline_dir/restore_window_close.sql"

# ---------------------------------------------------------------------------
step "Reconciliation"
capture "$target_container" app_migration tenant_restored \
  "$tests_dir/portable_schema_inventory_snapshot.sql" "$work_dir/inventory-post-restore.txt"
capture "$target_container" app_migration tenant_restored \
  "$tests_dir/portable_sequence_state.sql" "$work_dir/sequences-post-restore.txt"

if diff -u "$work_dir/inventory-pre-dump.txt" "$work_dir/inventory-post-restore.txt" > "$work_dir/restore.diff"; then
  ok "post-restore inventory is identical to the pre-dump inventory"
else
  cat "$work_dir/restore.diff" >&2
  die "the restored database differs from the source"
fi

if diff -u "$work_dir/sequences-pre-dump.txt" "$work_dir/sequences-post-restore.txt" > "$work_dir/sequences.diff"; then
  ok "sequence values, row counts and ledger rows survived the restore unchanged"
else
  cat "$work_dir/sequences.diff" >&2
  die "sequence, row-count or ledger state changed across the restore"
fi

run_sql "$target_container" app_migration tenant_restored "$tests_dir/portable_restore_reconciliation.sql"

psql_wrapper "$target_container" "$work_dir/psql-target"
LEDGER_PSQL="$work_dir/psql-target" LEDGER_DB=tenant_restored \
  node "$runner" verify --json "$work_dir/ledger-restored.json"
ok "the restored ledger still verifies against the manifest"

# ---------------------------------------------------------------------------
step "Post-restore behaviour"
run_sql "$target_container" app_runtime tenant_restored \
  "$tests_dir/portable_identity_roles_rls_behavior_assertions.sql"
run_sql "$target_container" app_runtime tenant_restored \
  "$tests_dir/portable_restore_behavior_assertions.sql"
run_sql "$target_container" app_ai_client tenant_restored \
  "$tests_dir/portable_restore_ai_guard_assertions.sql"

# The read-only principal must not reach the guard either. It is NOLOGIN in the
# contract, so it is reached through the test-only client.
if docker exec "$target_container" psql --username app_readonly_client --dbname tenant_restored \
     --no-psqlrc --set ON_ERROR_STOP=1 \
     --command "SET ROLE app_readonly; SELECT public.ai_execute_sql('select 1');" >/dev/null 2>&1; then
  die "app_readonly executed the AI SQL guard after restore"
else
  ok "app_readonly cannot execute the AI SQL guard after restore"
fi

if docker exec "$target_container" psql --username app_runtime --dbname tenant_restored \
     --no-psqlrc --set ON_ERROR_STOP=1 \
     --command "SELECT public.ai_execute_sql('select 1');" >/dev/null 2>&1; then
  die "app_runtime executed the AI SQL guard after restore"
else
  ok "app_runtime cannot execute the AI SQL guard after restore"
fi

# ---------------------------------------------------------------------------
if [ -n "$evidence_path" ]; then
  step "Machine-readable run record"
  {
    printf '{\n'
    printf '  "harness": "portable_dump_restore_cleanroom.sh",\n'
    printf '  "postgres_image": "%s",\n' "$image"
    printf '  "server_version": "%s",\n' "$server_version"
    printf '  "pg_dump_version": "%s",\n' "$pg_dump_version"
    printf '  "pg_restore_version": "%s",\n' "$pg_restore_version"
    printf '  "psql_version": "%s",\n' "$psql_version"
    printf '  "clean_applies": 2,\n'
    printf '  "clean_apply_inventory_lines": %s,\n' "$(wc -l < "$work_dir/inventory-apply-1.txt" | tr -d ' ')"
    printf '  "clean_apply_diff_lines": %s,\n' "$(wc -l < "$work_dir/reproducibility.diff" | tr -d ' ')"
    printf '  "dump_bytes": %s,\n' "$(wc -c < "$work_dir/tenant.dump" | tr -d ' ')"
    printf '  "restore_warnings": %s,\n' "$(grep -ci warning "$restore_log" || true)"
    printf '  "restore_inventory_diff_lines": %s,\n' "$(wc -l < "$work_dir/restore.diff" | tr -d ' ')"
    printf '  "sequence_state_diff_lines": %s,\n' "$(wc -l < "$work_dir/sequences.diff" | tr -d ' ')"
    printf '  "reconciliation": "passed",\n'
    printf '  "post_restore_behaviour": "passed"\n'
    printf '}\n'
  } > "$evidence_path"
  ok "run record written to $evidence_path"
fi

printf '\nPortable dump/restore clean-room passed using %s\n' "$image"
