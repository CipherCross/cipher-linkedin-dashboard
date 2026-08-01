#!/usr/bin/env bash
set -euo pipefail

repo_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
baseline="$repo_dir/postgres/tenant-baseline/v1/001_portable_business_baseline.sql"
identity_artifact="$repo_dir/postgres/tenant-baseline/v1/002_identity_roles_actor_rls.sql"
role_bootstrap="$repo_dir/postgres/tests/portable_identity_roles_rls_role_bootstrap.sql"
fixture_seed="$repo_dir/postgres/tests/portable_identity_roles_rls_fixture_seed.sql"
catalog_assertions="$repo_dir/postgres/tests/portable_identity_roles_rls_catalog_assertions.sql"
behavior_assertions="$repo_dir/postgres/tests/portable_identity_roles_rls_behavior_assertions.sql"
runtime_boundary="$repo_dir/postgres/tests/portable_identity_roles_rls_runtime_boundary.sql"
image="${POSTGRES_IMAGE:-postgres:17-alpine}"
container="portable-identity-rls-cleanroom-$$"

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
docker exec --interactive "$container" psql --username postgres --dbname postgres --set ON_ERROR_STOP=1 < "$baseline" >/dev/null
docker exec --interactive "$container" psql --username postgres --dbname postgres --set ON_ERROR_STOP=1 < "$role_bootstrap" >/dev/null
docker exec --interactive "$container" psql --username app_migration --dbname postgres --set ON_ERROR_STOP=1 < "$identity_artifact" >/dev/null
docker exec --interactive "$container" psql --username app_migration --dbname postgres --set ON_ERROR_STOP=1 < "$catalog_assertions"
docker exec --interactive "$container" psql --username app_migration --dbname postgres --set ON_ERROR_STOP=1 < "$fixture_seed"
docker exec --interactive "$container" psql --username app_runtime --dbname postgres --set ON_ERROR_STOP=1 < "$runtime_boundary"
if docker exec "$container" psql --username app_runtime --dbname postgres --set ON_ERROR_STOP=1 --command "SET ROLE app_owner;" >/dev/null 2>&1; then
  echo "Runtime principal unexpectedly gained SET ROLE app_owner" >&2
  exit 1
fi
if docker exec "$container" psql --username app_runtime --dbname postgres --set ON_ERROR_STOP=1 --command "SET ROLE app_migration;" >/dev/null 2>&1; then
  echo "Runtime principal unexpectedly gained SET ROLE app_migration" >&2
  exit 1
fi
echo "Runtime principal cannot SET ROLE app_owner or app_migration"
docker exec --interactive "$container" psql --username app_runtime --dbname postgres --set ON_ERROR_STOP=1 < "$behavior_assertions"
echo "Portable identity, roles and RLS clean-room apply passed using $image via app_migration"
