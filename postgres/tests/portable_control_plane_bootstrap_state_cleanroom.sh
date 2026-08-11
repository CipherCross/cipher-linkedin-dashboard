#!/usr/bin/env bash
set -euo pipefail

# Live-shaped tests for the control plane's own bootstrap-state probes.
#
# WHY THIS HARNESS EXISTS
#
# The Worker decides whether to replay an immutable bootstrap, and whether the
# migration ledger already exists, by running two SELECTs against the tenant
# database. Both decisions were covered only by unit tests that handed
# readBootstrapState a ready-made row of booleans, so the SQL itself was never
# executed and its own privilege requirements were never exercised. That hid a
# defect that made every S26 step-3 retry fail: the ledger-presence probe used
# `to_regclass('app_ledger.applied_migration')`, and resolving a
# schema-qualified name needs USAGE on the schema. The ledger bootstrap revokes
# everything on app_ledger from PUBLIC, and app_migration is NOINHERIT, so the
# probe returned NULL on the first apply (schema absent) and then raised
# 42501 permission denied for schema app_ledger on every apply afterwards.
#
# Two properties of a real cluster are what make that visible, and neither is
# present in the other harnesses in this directory:
#
#   1. the privileged principal is a NON-SUPERUSER with CREATEROLE, the shape a
#      managed provider hands the operator (Neon's neondb_owner and equivalents).
#      Every other harness here bootstraps as the postgres superuser, which is
#      exempt from the membership and ownership checks that bite in production;
#   2. the probes run as the principal that really issues them, against a
#      database that has ALREADY been prepared — the state a retry sees.
#
# The probe SQL is not copied here. It is extracted from the Worker source, so
# this harness cannot keep passing while the shipped SQL drifts.
#
# Covered:
#   1. the real bootstrap-state probe is valid SQL and runs as the provider
#      principal on a cluster with no bootstrap at all, reporting all four false;
#   2. after the control-plane bootstrap alone, exactly controlPlane is true, so
#      only the missing extensions get applied;
#   3. after all four bootstraps, all four are true, so nothing is replayed;
#   4. replaying the control-plane bootstrap really is unsafe, which is what the
#      probe exists to prevent;
#   5. the ledger-presence probe answers false before and true after the ledger
#      bootstrap, as app_migration, needing no schema USAGE;
#   6. the retired to_regclass form still fails with 42501 once the ledger
#      exists — the exact live step-3 409, pinned so it cannot return;
#   7. on a fully migrated database (baseline 053 + migration 054, the live
#      state) both probes report an already-prepared cluster, so a retry adopts
#      it instead of re-running anything.

repo_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
baseline_dir="$repo_dir/postgres/tenant-baseline/v1"
probe_sql_tool="$repo_dir/postgres/tests/portable_control_plane_bootstrap_probe_sql.mjs"
ledger_runner="$repo_dir/postgres/tools/portable_migration_ledger.mjs"
image="${POSTGRES_IMAGE:-postgres:17-alpine}"
container="portable-bootstrap-state-tests-$$"
work_dir="$(mktemp -d)"

# The provider principal: non-superuser, CREATEROLE, owns the tenant database.
provider_role="provider_owner"
provider_password="harness-provider-secret"
migration_password="harness-migration-secret"

if ! docker info >/dev/null 2>&1; then
  echo "Docker daemon is unavailable; bootstrap-state tests were not run" >&2
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
  --env POSTGRES_PASSWORD=harness-superuser-secret \
  "$image" >/dev/null

for _ in $(seq 1 60); do
  if docker exec "$container" pg_isready -U postgres -d postgres >/dev/null 2>&1; then
    break
  fi
  sleep 1
done
docker exec "$container" pg_isready -U postgres -d postgres >/dev/null

server_version="$(docker exec "$container" psql -U postgres -d postgres -tAc "SHOW server_version_num")"
if [ "$server_version" -lt 170000 ]; then
  echo "This harness pins PostgreSQL 17 role-graph semantics; found $server_version" >&2
  exit 2
fi

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

# psql as the superuser, used only to create the provider principal itself.
sql_super() {
  docker exec --interactive "$container" \
    psql -U postgres -d "$1" --no-psqlrc --quiet --no-align --tuples-only --set ON_ERROR_STOP=1
}

# psql as a password-authenticated non-superuser, over TCP, which is how a
# managed provider is actually reached.
sql_as() {
  local user="$1" password="$2" db="$3"
  docker exec --interactive --env "PGPASSWORD=$password" "$container" \
    psql -U "$user" -d "$db" -h 127.0.0.1 --no-psqlrc --quiet --no-align --tuples-only \
         --set ON_ERROR_STOP=1
}

probe_sql="$(node "$probe_sql_tool" BOOTSTRAP_STATE_PROBE_SQL)"
presence_sql="$(node "$probe_sql_tool" LEDGER_PRESENCE_SQL)"
ok "the shipped probe SQL was extracted from ops/src/worker/pinned-postgres.ts"

# Runs the real parameterised probe verbatim. The Worker binds $1/$2; PREPARE is
# how psql can bind the same placeholders without altering the statement text.
run_probe() {
  local db="$1"
  {
    printf 'PREPARE bootstrap_state (text[], bigint) AS\n%s;\n' "$probe_sql"
    printf "EXECUTE bootstrap_state (ARRAY['app_owner','app_migration','app_runtime','app_readonly','app_machine','app_system','app_ai_runner']::text[], 7);\n"
  } | sql_as "$provider_role" "$provider_password" "$db"
}

new_db() {
  local db="$1"
  printf 'CREATE DATABASE %s OWNER %s;\n' "$db" "$provider_role" | sql_super postgres >/dev/null
}

apply_bootstrap() {
  local db="$1" artifact="$2"
  sql_as "$provider_role" "$provider_password" "$db" < "$baseline_dir/$artifact" >/dev/null 2>&1
}

expect_probe() {
  local label="$1" db="$2" expected="$3"
  local observed
  if ! observed="$(run_probe "$db" 2>&1)"; then
    bad "$label (the probe itself failed: $observed)"
    return
  fi
  if [ "$observed" = "$expected" ]; then
    ok "$label"
  else
    bad "$label (expected '$expected', got '$observed')"
  fi
}

printf 'CREATE ROLE %s LOGIN CREATEROLE PASSWORD %s;\n' \
  "$provider_role" "'$provider_password'" | sql_super postgres >/dev/null
if [ "$(printf "SELECT rolsuper FROM pg_roles WHERE rolname = '%s';\n" "$provider_role" \
        | sql_super postgres)" = "f" ]; then
  ok "the provider principal is a non-superuser, as a managed provider hands it over"
else
  bad "the provider principal must not be a superuser"
fi

# --- 1. no bootstrap at all --------------------------------------------------
new_db bootstrap_absent
expect_probe "an unprepared database reports no bootstrap applied" \
  bootstrap_absent "f|f|f|f"

# --- 2. the control-plane bootstrap alone ------------------------------------
new_db bootstrap_partial
apply_bootstrap bootstrap_partial 000_control_plane_role_bootstrap.sql
expect_probe "the control-plane bootstrap alone is reported on its own" \
  bootstrap_partial "t|f|f|f"

# --- 3. all four bootstraps --------------------------------------------------
new_db bootstrap_prepared
for artifact in 000_control_plane_role_bootstrap.sql 000_identity_store_role_bootstrap.sql \
                000_ai_execution_role_bootstrap.sql 000_machine_ingest_role_bootstrap.sql; do
  apply_bootstrap bootstrap_prepared "$artifact"
done
expect_probe "a fully prepared database reports every bootstrap applied" \
  bootstrap_prepared "t|t|t|t"

# --- 4. what replaying a bootstrap actually does ------------------------------
# This pins a correction. The retry hardening recorded the step-3 409 as an
# unconditional bootstrap colliding with already-created roles, and specifically
# as `ALTER SCHEMA public OWNER TO app_owner` failing because the executing
# principal is only a NON-INHERITING member of the new owner. That is not what
# happens: the control-plane artifact grants the non-superuser principal
# app_owner WITH SET TRUE for exactly this reason, and its role and membership
# sections are written to be normalising. All four artifacts therefore replay
# cleanly, and no replay ever produced the observed 409.
#
# Each artifact is sent the way the Worker sends it — one multi-statement simple
# query, so PostgreSQL runs it in a single implicit transaction — because a
# statement-at-a-time replay would not prove the same thing.
replay_artifact() {
  local db="$1" artifact="$2"
  # Mirrors postgresSql(): psql -c rejects backslash meta-commands, and the
  # Worker strips those same lines before sending the artifact as one query.
  local text
  text="$(grep -v '^\\' "$baseline_dir/$artifact")"
  docker exec --interactive --env "PGPASSWORD=$provider_password" "$container" \
    psql -U "$provider_role" -d "$db" -h 127.0.0.1 --no-psqlrc --quiet \
         --set ON_ERROR_STOP=1 -c "$text"
}

replay_failures=""
for artifact in 000_control_plane_role_bootstrap.sql 000_identity_store_role_bootstrap.sql \
                000_ai_execution_role_bootstrap.sql 000_machine_ingest_role_bootstrap.sql; do
  set +e
  replay_output="$(replay_artifact bootstrap_prepared "$artifact" 2>&1)"
  replay_status=$?
  set -e
  if [ "$replay_status" -ne 0 ]; then
    replay_failures="$replay_failures $artifact -> $(printf '%s' "$replay_output" | grep -i error | head -1);"
  fi
done
if [ -z "$replay_failures" ]; then
  ok "every bootstrap artifact replays cleanly as one query, so no replay explains the 409"
else
  bad "a bootstrap artifact no longer replays cleanly:$replay_failures"
fi
expect_probe "the probe still reports every bootstrap applied after a full replay" \
  bootstrap_prepared "t|t|t|t"

# --- 5/6. the ledger-presence probe, before and after the ledger exists ------
expect_presence() {
  local label="$1" db="$2" expected="$3"
  local observed
  set +e
  observed="$(printf '%s;\n' "$presence_sql" \
    | sql_as app_migration "$migration_password" "$db" 2>&1)"
  local status=$?
  set -e
  if [ "$status" -ne 0 ]; then
    bad "$label (the presence probe failed: $observed)"
  elif [ "$observed" = "$expected" ]; then
    ok "$label"
  else
    bad "$label (expected '$expected', got '$observed')"
  fi
}

printf "ALTER ROLE app_migration PASSWORD '%s';\n" "$migration_password" \
  | sql_as "$provider_role" "$provider_password" bootstrap_prepared >/dev/null

expect_presence "the ledger-presence probe reports absent before the ledger bootstrap" \
  bootstrap_prepared "f"

sql_as app_migration "$migration_password" bootstrap_prepared \
  < "$baseline_dir/000_migration_ledger.sql" >/dev/null

# The Worker records the role-bootstrap dependency itself, immediately after
# creating the ledger, and the runner refuses to apply without that row.
manifest_field() {
  node -p "JSON.parse(require('node:fs').readFileSync(process.argv[1],'utf8'))$1" \
    "$baseline_dir/ledger.manifest.json"
}
role_artifact="$(manifest_field '.role_bootstrap.artifact')"
role_digest="$(manifest_field '.role_bootstrap.sha256')"
ledger_version="$(manifest_field '.ledger_version')"
{
  printf 'SET ROLE app_owner;\n'
  printf 'INSERT INTO app_ledger.role_bootstrap (artifact, sha256, ledger_version, required_roles)\n'
  printf "VALUES ('%s', '%s', '%s', ARRAY['app_owner','app_migration','app_runtime','app_readonly','app_machine','app_system','app_ai_runner']::text[]);\n" \
    "$role_artifact" "$role_digest" "$ledger_version"
  printf 'RESET ROLE;\n'
} | sql_as app_migration "$migration_password" bootstrap_prepared >/dev/null

expect_presence "the ledger-presence probe reports present afterwards, as app_migration" \
  bootstrap_prepared "t"

# The retired form. app_migration has no USAGE on the schema the ledger
# bootstrap just locked down, and resolving a qualified name requires it.
set +e
regclass_output="$(printf "SELECT to_regclass('app_ledger.applied_migration') IS NOT NULL;\n" \
  | sql_as app_migration "$migration_password" bootstrap_prepared 2>&1)"
regclass_status=$?
set -e
if [ "$regclass_status" -ne 0 ] && printf '%s' "$regclass_output" | grep -q "permission denied for schema app_ledger"; then
  ok "the retired to_regclass probe still fails once the ledger exists (the live step-3 409)"
else
  bad "to_regclass no longer fails on a locked-down app_ledger (status $regclass_status: $regclass_output); the regression's premise changed"
fi

# The probes must also survive the reasserted ownership the ledger installs.
expect_probe "the bootstrap probe is unchanged by the ledger bootstrap" \
  bootstrap_prepared "t|t|t|t"

# --- 7. the live state: baseline 053 plus migration 054 ----------------------
cat > "$work_dir/psql" <<EOF
#!/usr/bin/env bash
exec docker exec --interactive --env PGPASSWORD=$migration_password "$container" \
  psql -h 127.0.0.1 "\$@"
EOF
chmod +x "$work_dir/psql"

if LEDGER_PSQL="$work_dir/psql" LEDGER_DB=bootstrap_prepared \
     node "$ledger_runner" apply >"$work_dir/apply.log" 2>&1; then
  ok "the pinned ledger applied baseline 053 plus migration 054 as app_migration"
else
  bad "the pinned ledger failed to apply ($(tail -3 "$work_dir/apply.log" | tr '\n' ' '))"
fi

expect_probe "a fully migrated database still reports every bootstrap applied" \
  bootstrap_prepared "t|t|t|t"
expect_presence "the ledger-presence probe still reports present after all ten steps" \
  bootstrap_prepared "t"

# A second run must change nothing: this is the retry the live operation makes.
if LEDGER_PSQL="$work_dir/psql" LEDGER_DB=bootstrap_prepared \
     node "$ledger_runner" verify >"$work_dir/verify.log" 2>&1; then
  ok "re-verifying the fully migrated database is a clean no-op"
else
  bad "re-verifying the fully migrated database reported drift ($(tail -3 "$work_dir/verify.log" | tr '\n' ' '))"
fi

echo
echo "Control-plane bootstrap-state tests: $pass_count passed, $fail_count failed"
[ "$fail_count" -eq 0 ]
