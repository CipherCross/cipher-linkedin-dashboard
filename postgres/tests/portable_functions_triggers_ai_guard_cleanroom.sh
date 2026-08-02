#!/usr/bin/env bash
set -euo pipefail

# Clean-room apply of the full portable baseline in order:
#   1. S05 business baseline
#   2. S06 identity, roles, actor context and RLS
#   3. S07 functions, triggers and the SELECT-only AI SQL guard
#
# The S06 catalog assertions are replayed after step 2 so a regression in the
# identity/RLS contract is caught before S07 is applied on top of it.

repo_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
baseline="$repo_dir/postgres/tenant-baseline/v1/001_portable_business_baseline.sql"
identity_artifact="$repo_dir/postgres/tenant-baseline/v1/002_identity_roles_actor_rls.sql"
functions_artifact="$repo_dir/postgres/tenant-baseline/v1/003_functions_triggers_ai_guard.sql"
identity_bootstrap="$repo_dir/postgres/tests/portable_identity_roles_rls_role_bootstrap.sql"
identity_catalog="$repo_dir/postgres/tests/portable_identity_roles_rls_catalog_assertions.sql"
identity_fixtures="$repo_dir/postgres/tests/portable_identity_roles_rls_fixture_seed.sql"
ai_bootstrap="$repo_dir/postgres/tests/portable_functions_triggers_ai_guard_role_bootstrap.sql"
business_fixtures="$repo_dir/postgres/tests/portable_functions_triggers_fixture_seed.sql"
catalog_assertions="$repo_dir/postgres/tests/portable_functions_triggers_ai_guard_catalog_assertions.sql"
behavior_assertions="$repo_dir/postgres/tests/portable_functions_triggers_behavior_assertions.sql"
ai_assertions="$repo_dir/postgres/tests/portable_ai_guard_behavior_assertions.sql"
image="${POSTGRES_IMAGE:-postgres:17-alpine}"
container="portable-functions-ai-cleanroom-$$"

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
echo "Clean-room PostgreSQL: $(docker exec "$container" psql --username postgres --dbname postgres --tuples-only --no-align --command 'select version()')"

run_as() {
  local role="$1"
  local file="$2"
  docker exec --interactive "$container" \
    psql --username "$role" --dbname postgres --set ON_ERROR_STOP=1 < "$file"
}

# 1. Business baseline, applied by the disposable bootstrap superuser.
run_as postgres "$baseline" >/dev/null

# 2. Identity, roles and RLS, applied by the non-superuser migration principal.
run_as postgres "$identity_bootstrap" >/dev/null
run_as app_migration "$identity_artifact" >/dev/null
run_as app_migration "$identity_catalog"

# 3. Functions, triggers and the AI guard, applied by the same principal.
run_as postgres "$ai_bootstrap" >/dev/null
run_as app_migration "$functions_artifact" >/dev/null
run_as app_migration "$catalog_assertions"

# Fixtures are seeded through the owner capability; every assertion below runs
# in a separate, lower-privileged connection.
run_as app_migration "$identity_fixtures" >/dev/null
run_as app_migration "$business_fixtures" >/dev/null

if docker exec "$container" psql --username app_runtime --dbname postgres --set ON_ERROR_STOP=1 \
     --command "SET ROLE app_ai_runner;" >/dev/null 2>&1; then
  echo "Runtime principal unexpectedly gained SET ROLE app_ai_runner" >&2
  exit 1
fi
if docker exec "$container" psql --username app_runtime --dbname postgres --set ON_ERROR_STOP=1 \
     --command "SELECT public.ai_execute_sql('select 1');" >/dev/null 2>&1; then
  echo "Runtime principal unexpectedly executed the AI SQL guard" >&2
  exit 1
fi
if docker exec "$container" psql --username app_ai_client --dbname postgres --set ON_ERROR_STOP=1 \
     --command "SELECT public.ai_execute_sql('select 1');" >/dev/null 2>&1; then
  echo "AI guard was reachable without switching to the AI execution principal" >&2
  exit 1
fi
echo "AI SQL guard is unreachable from the runtime principal and from an unswitched session"

run_as app_runtime "$behavior_assertions"
run_as app_ai_client "$ai_assertions"

echo "Portable functions, triggers and AI SQL guard clean-room apply passed using $image"
