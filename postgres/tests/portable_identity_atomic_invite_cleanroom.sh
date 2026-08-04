#!/usr/bin/env bash
set -euo pipefail

# Clean-room proof for ledger step 005: the atomic cross-store invite.
#
# Everything runs through the migration ledger, because the ledger is the only
# sanctioned apply path and an artifact proved any other way is not proved at all.
#
# Covered:
#   1. a fresh apply of 001 -> 002 -> 003 -> 004 -> 005 into an empty,
#      control-plane prepared database;
#   2. behaviour assertions as the real app_runtime request principal: the
#      non-admin denial, the anonymous denial, a successful admin invite,
#      atomicity, argument validation and the duplicate-email refusal;
#   3. the store half observed from an identity_store session -- one user row and
#      one account row, with the password hash present and the passphrase absent;
#   4. the isolation step 004 established is unchanged: app_runtime still cannot
#      read or write the identity tables, and the grants step 005 adds are INSERT
#      only, on two tables, to app_owner only;
#   5. a re-apply is an idempotent no-op and verify still passes;
#   6. step 005 refuses to apply to a database that has not had step 004 -- the
#      prerequisite check has to bite.

repo_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
baseline_dir="$repo_dir/postgres/tenant-baseline/v1"
tests_dir="$repo_dir/postgres/tests"
runner="$repo_dir/postgres/tools/portable_migration_ledger.mjs"
bootstrap="$baseline_dir/000_control_plane_role_bootstrap.sql"
identity_bootstrap="$baseline_dir/000_identity_store_role_bootstrap.sql"
fixture_seed="$tests_dir/portable_identity_roles_rls_fixture_seed.sql"
invite_assertions="$tests_dir/portable_identity_atomic_invite_assertions.sql"
image="${POSTGRES_IMAGE:-postgres:17-alpine}"
container="portable-identity-atomic-invite-$$"
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

check_file() {
  local label="$1" user="$2" db="$3" file="$4"
  if run_file "$user" "$db" "$file" >"$work_dir/out.txt" 2>&1; then
    ok "$label"
  else
    bad "$label"
    sed 's/^/       /' "$work_dir/out.txt" >&2
  fi
}

expect() {
  local label="$1" expected="$2" actual="$3"
  if [ "$expected" = "$actual" ]; then
    ok "$label: $actual"
  else
    bad "$label: expected '$expected', got '$actual'"
  fi
}

new_db() {
  local db="$1"
  docker exec "$container" psql -U postgres -d postgres -q -c "CREATE DATABASE $db;" >/dev/null
  docker exec --interactive "$container" psql -U postgres -d "$db" --set ON_ERROR_STOP=1 -q \
    < "$bootstrap" >/dev/null
}

echo "Clean-room PostgreSQL: $(docker exec "$container" psql -U postgres -d postgres -tA -c 'select version()')"
echo
echo "Step 005 clean-room apply"

# --- 1. fresh apply through the ledger ---------------------------------------
new_db invite_prepared
docker exec --interactive "$container" psql -U postgres -d invite_prepared --set ON_ERROR_STOP=1 -q \
  < "$identity_bootstrap" >/dev/null
ok "control-plane prerequisites applied (seven-role bootstrap plus the identity store role)"

if LEDGER_DB=invite_prepared node "$runner" apply --json "$work_dir/ledger.json" >"$work_dir/apply.txt" 2>&1; then
  ok "fresh apply accepted: $(tr '\n' '; ' < "$work_dir/apply.txt" | sed 's/; $//')"
else
  bad "fresh apply was rejected"
  sed 's/^/       /' "$work_dir/apply.txt" >&2
fi

# The ledger is granted to nobody but its owner, so every read of it enters
# app_owner explicitly -- the same thing the runner does.
expect "the ledger records five steps in canonical order" \
  "1 -> 2 -> 3 -> 4 -> 5" \
  "$(query app_migration invite_prepared \
     "SET ROLE app_owner;
      SELECT string_agg(step::text, ' -> ' ORDER BY applied_seq)
        FROM app_ledger.applied_migration;")"

expect "every step recorded the documented apply principal" "t" \
  "$(query app_migration invite_prepared \
     "SET ROLE app_owner;
      SELECT bool_and(apply_principal = 'app_migration' AND apply_role = 'app_owner')
        FROM app_ledger.applied_migration;")"

# The fixtures the behaviour file needs. Seeded as app_migration, exactly as the
# other identity clean rooms do it.
run_file app_migration invite_prepared "$fixture_seed" >/dev/null
ok "S06 identity fixtures seeded"

# --- 2. behaviour, as the real request principal -----------------------------
check_file "behaviour assertions as app_runtime (denials, atomicity, validation)" \
  app_runtime invite_prepared "$invite_assertions"

# --- 3a. the canonical half, as app_owner ------------------------------------
# The behaviour file could not check these: every policy restricts app_runtime to
# its own row, so it cannot see the person it just created. app_owner can.
expect "the invited person has exactly one users row, active" "1" \
  "$(query app_migration invite_prepared "SET ROLE app_owner; select count(*) from public.users u join public.user_identities ui on ui.user_id = u.id where ui.provider_subject = 'subject-invited-001' and u.active;")"

expect "the invited person has exactly one user_identities row" "1" \
  "$(query app_migration invite_prepared "SET ROLE app_owner; select count(*) from public.user_identities where provider = 'better-auth' and provider_subject = 'subject-invited-001';")"

# The strongest form of the atomicity claim, and it can only be made from here:
# no users row exists without a membership, so no refused invite left a fragment.
expect "no users row is orphaned by any refused invite" "0" \
  "$(query app_migration invite_prepared "SET ROLE app_owner; select count(*) from public.users u where not exists (select 1 from public.team_members tm where tm.user_id = u.id);")"

expect "no canonical row survives from the refused duplicate-subject invite" "0" \
  "$(query app_migration invite_prepared "SET ROLE app_owner; select count(*) from public.team_members where lower(email) = 'second@example.test';")"

# --- 3. the store half, from the store's own principal -----------------------
expect "the invited person has exactly one identity.user row" "1" \
  "$(query identity_store invite_prepared "select count(*) from identity.\"user\" where \"id\" = 'subject-invited-001';")"

expect "the invited person has exactly one credential account row" "1" \
  "$(query identity_store invite_prepared "select count(*) from identity.\"account\" where \"userId\" = 'subject-invited-001' and \"providerId\" = 'credential';")"

expect "the account carries the hash the caller supplied" "t" \
  "$(query identity_store invite_prepared "select \"password\" = 'scrypt\$fake:hash' from identity.\"account\" where \"userId\" = 'subject-invited-001';")"

expect "the store user row carries the same email as the roster" "t" \
  "$(query identity_store invite_prepared "select \"email\" = 'invited@example.test' and not \"emailVerified\" from identity.\"user\" where \"id\" = 'subject-invited-001';")"

# The failed invites must have left nothing at all in the store, which is the
# other direction of the atomicity claim: not only were the canonical rows rolled
# back, no store row was orphaned either.
expect "no store row survives from any refused invite" "1" \
  "$(query identity_store invite_prepared "select count(*) from identity.\"user\";")"

# --- 3b. the grant surface step 005 adds -------------------------------------
# Asked from app_owner, because app_runtime cannot even resolve these table names
# to ask about them (which the behaviour file asserts from its side). The grants
# must be INSERT, on exactly two tables, to exactly app_owner: a widened grant
# here is what would quietly undo the store's isolation.
expect "the added grants are INSERT only, on two tables, to app_owner only" "t" \
  "$(query app_migration invite_prepared \
     "SET ROLE app_owner;
      SELECT bool_and(ok) FROM (
        SELECT has_table_privilege('app_owner', 'identity.\"user\"', 'INSERT') AS ok
        UNION ALL SELECT has_table_privilege('app_owner', 'identity.\"account\"', 'INSERT')
        UNION ALL SELECT NOT has_table_privilege('app_owner', 'identity.\"session\"', 'INSERT')
        UNION ALL SELECT NOT has_table_privilege('app_owner', 'identity.\"verification\"', 'INSERT')
        UNION ALL SELECT NOT has_table_privilege('app_owner', 'identity.\"user\"', 'UPDATE')
        UNION ALL SELECT NOT has_table_privilege('app_owner', 'identity.\"user\"', 'DELETE')
        UNION ALL SELECT NOT has_table_privilege('app_owner', 'identity.\"account\"', 'UPDATE')
        UNION ALL SELECT NOT has_table_privilege('app_owner', 'identity.\"account\"', 'DELETE')
        UNION ALL SELECT NOT has_table_privilege('app_runtime', 'identity.\"user\"', 'INSERT')
        UNION ALL SELECT NOT has_table_privilege('app_ai_runner', 'identity.\"user\"', 'INSERT')
        UNION ALL SELECT NOT has_table_privilege('app_system', 'identity.\"user\"', 'INSERT')
        UNION ALL SELECT NOT has_schema_privilege('app_runtime', 'identity', 'USAGE')
        UNION ALL SELECT NOT has_schema_privilege('app_ai_runner', 'identity', 'USAGE')
      ) checks;")"

# --- 4. the resolver sees the new person, end to end -------------------------
# The point of an invite is that the person can then be resolved to an actor. This
# closes the loop through the *same* function the request path uses.
expect "the invited subject resolves to an active member actor" "member" \
  "$(query app_runtime invite_prepared "select role from public.identity_resolve_actor('better-auth', 'subject-invited-001');")"

# --- 5. idempotent re-apply --------------------------------------------------
if LEDGER_DB=invite_prepared node "$runner" apply >"$work_dir/reapply.txt" 2>&1; then
  ok "re-apply is a no-op: $(tr '\n' '; ' < "$work_dir/reapply.txt" | sed 's/; $//')"
else
  bad "re-apply failed"
  sed 's/^/       /' "$work_dir/reapply.txt" >&2
fi

expect "the re-apply added no ledger row" "5" \
  "$(query app_migration invite_prepared "SET ROLE app_owner; select count(*) from app_ledger.applied_migration;")"

expect "the re-apply did not disturb the invited person" "1" \
  "$(query identity_store invite_prepared "select count(*) from identity.\"user\" where \"id\" = 'subject-invited-001';")"

if LEDGER_DB=invite_prepared node "$runner" verify >"$work_dir/verify.txt" 2>&1; then
  ok "verify passes: $(tr '\n' '; ' < "$work_dir/verify.txt" | sed 's/; $//')"
else
  bad "verify failed"
  sed 's/^/       /' "$work_dir/verify.txt" >&2
fi

# --- 6. the prerequisite check has to bite ----------------------------------
# A database prepared with the seven-role bootstrap but *not* the identity store
# role gets no schema identity, so step 004 refuses first and 005 is never
# reached. The case that matters for 005 specifically is a database that has the
# role but is stopped before 004 -- which the runner will not do, since it applies
# in order. So the honest test of 005's own guard is to run the artifact directly
# against a database at step 3.
new_db invite_partial
docker exec --interactive "$container" psql -U postgres -d invite_partial --set ON_ERROR_STOP=1 -q \
  < "$identity_bootstrap" >/dev/null

# Apply 001..003 only, by pointing the runner at nothing and applying the three
# artifacts as app_migration under SET ROLE app_owner, the same principal pair the
# runner uses. This database deliberately never receives step 004.
for artifact in 001_portable_business_baseline.sql 002_identity_roles_actor_rls.sql 003_functions_triggers_ai_guard.sql; do
  printf 'SET ROLE app_owner;\n' > "$work_dir/step.sql"
  cat "$baseline_dir/$artifact" >> "$work_dir/step.sql"
  docker exec --interactive "$container" \
    psql --username app_migration --dbname invite_partial --no-psqlrc --quiet \
         --set ON_ERROR_STOP=1 < "$work_dir/step.sql" >/dev/null
done

printf 'SET ROLE app_owner;\n' > "$work_dir/step005.sql"
cat "$baseline_dir/005_identity_atomic_invite.sql" >> "$work_dir/step005.sql"
if docker exec --interactive "$container" \
     psql --username app_migration --dbname invite_partial --no-psqlrc --quiet \
          --set ON_ERROR_STOP=1 < "$work_dir/step005.sql" >"$work_dir/partial.txt" 2>&1; then
  bad "step 005 applied to a database that never received step 004"
else
  if grep -q 'apply ledger step 004' "$work_dir/partial.txt"; then
    ok "step 005 refuses a database without step 004, and says which step is missing"
  else
    bad "step 005 refused, but not with its own prerequisite message"
    sed 's/^/       /' "$work_dir/partial.txt" >&2
  fi
fi

expect "the refused step left no function behind" "" \
  "$(query postgres invite_partial "select coalesce(to_regprocedure('public.identity_admin_invite_member_atomic(text,text,text,text,text,text)')::text, '');")"

echo
if [ "$fail_count" -eq 0 ]; then
  echo "Step 005 clean-room: $pass_count passed, 0 failed"
else
  echo "Step 005 clean-room: $pass_count passed, $fail_count failed" >&2
  exit 1
fi
