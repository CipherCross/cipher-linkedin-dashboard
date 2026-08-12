#!/usr/bin/env bash
set -euo pipefail

# Clean-room proof that the invitation email actually leaves the building.
#
# `admin.invite` creates an account whose passphrase nobody knows, so the letter
# carrying the one-time link is the only route into it. Everything about that
# letter that lives in our code is proved offline in frontend/tests. The half
# that is not ours -- whether Better Auth accepts the request the endpoint mints,
# and whether it calls the sink at all -- can only be proved against the real
# candidate and a real store, which is what this builds.
#
# It is worth having because that half has been wrong before and stayed wrong:
# CANDIDATE_ROUTES named `/forget-password` for the operation's entire life and
# answered 404 every time, invisible because delivery was discarded anyway.
#
# Covered:
#   1. a fresh apply of 001 -> 005 through the migration ledger, the only
#      sanctioned apply path, into an empty control-plane prepared database;
#   2. the endpoint's own request against the real candidate: the route resolves,
#      the origin check passes without a session cookie, a token is issued and
#      reaches the sink, and the invitation purpose survives the candidate's own
#      async hop;
#   3. a refused delivery is reported as refused even though the candidate
#      answers 200 -- it awaits the sink and swallows what it throws;
#   4. an address with no account is reported as undelivered rather than sent.
#
# The container is deleted afterwards. Nothing here may be pointed at a database
# whose rows matter: it creates people.

repo_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
baseline_dir="$repo_dir/postgres/tenant-baseline/v1"
tests_dir="$repo_dir/postgres/tests"
runner="$repo_dir/postgres/tools/portable_migration_ledger.mjs"
bootstrap="$baseline_dir/000_control_plane_role_bootstrap.sql"
identity_bootstrap="$baseline_dir/000_identity_store_role_bootstrap.sql"
fixture_seed="$tests_dir/portable_identity_roles_rls_fixture_seed.sql"
image="${POSTGRES_IMAGE:-postgres:17-alpine}"
container="portable-identity-invitation-link-$$"
work_dir="$(mktemp -d)"
db=invitation_link

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

# Published on the loopback only, and on an ephemeral port: the suite is a Node
# process on the host, so unlike the other clean rooms this one needs TCP.
docker run --name "$container" --detach \
  --publish 127.0.0.1::5432 \
  --env POSTGRES_HOST_AUTH_METHOD=trust \
  "$image" >/dev/null

for _ in $(seq 1 60); do
  if docker exec "$container" pg_isready -U postgres -d postgres >/dev/null 2>&1; then
    break
  fi
  sleep 1
done
docker exec "$container" pg_isready -U postgres -d postgres >/dev/null

port="$(docker port "$container" 5432/tcp | head -n1 | sed 's/.*://')"
if [ -z "$port" ]; then
  echo "the container published no port; the suite has no way to reach it" >&2
  exit 1
fi

# The runner reaches PostgreSQL only through $LEDGER_PSQL, so it never learns a
# host, port or credential.
cat > "$work_dir/psql" <<EOF
#!/usr/bin/env bash
exec docker exec --interactive "$container" psql "\$@"
EOF
chmod +x "$work_dir/psql"
export LEDGER_PSQL="$work_dir/psql"

echo "Clean-room PostgreSQL: $(docker exec "$container" psql -U postgres -d postgres -tA -c 'select version()')"
echo
echo "Invitation link clean room"

docker exec "$container" psql -U postgres -d postgres -q -c "CREATE DATABASE $db;" >/dev/null
docker exec --interactive "$container" psql -U postgres -d "$db" --set ON_ERROR_STOP=1 -q \
  < "$bootstrap" >/dev/null
docker exec --interactive "$container" psql -U postgres -d "$db" --set ON_ERROR_STOP=1 -q \
  < "$identity_bootstrap" >/dev/null
echo "  ok   control-plane prerequisites applied (seven-role bootstrap plus the identity store role)"

if LEDGER_DB="$db" node "$runner" apply --json "$work_dir/ledger.json" >"$work_dir/apply.txt" 2>&1; then
  echo "  ok   fresh apply accepted: $(tr '\n' '; ' < "$work_dir/apply.txt" | sed 's/; $//')"
else
  echo "  FAIL fresh apply was rejected" >&2
  sed 's/^/       /' "$work_dir/apply.txt" >&2
  exit 1
fi

# The S06 identity fixtures: the invite function authorizes against the admin
# among them, exactly as the request path does.
docker exec --interactive "$container" \
  psql --username app_migration --dbname "$db" --no-psqlrc --quiet --set ON_ERROR_STOP=1 \
  < "$fixture_seed" >/dev/null
echo "  ok   S06 identity fixtures seeded"

# Trust auth, a throwaway container, loopback only: there is no credential here
# to protect, and inventing one would only make the harness harder to read.
export IDENTITY_STORE_DATABASE_URL="postgresql://identity_store@127.0.0.1:$port/$db"
export APP_RUNTIME_DATABASE_URL="postgresql://app_runtime@127.0.0.1:$port/$db"
export IDENTITY_BASE_URL="http://localhost:3000"
export IDENTITY_SESSION_SECRET="$(printf 'x%.0s' $(seq 1 64))"

echo
cd "$repo_dir/frontend"
npm run --silent test:cleanroom
