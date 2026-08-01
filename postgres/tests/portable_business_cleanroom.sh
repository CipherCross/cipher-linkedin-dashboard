#!/usr/bin/env bash
set -euo pipefail

repo_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
baseline="$repo_dir/postgres/tenant-baseline/v1/001_portable_business_baseline.sql"
catalog_assertions="$repo_dir/postgres/tests/portable_business_catalog_assertions.sql"
image="${POSTGRES_IMAGE:-postgres:17-alpine}"
container="portable-business-cleanroom-$$"

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
docker exec --interactive "$container" psql --username postgres --dbname postgres --set ON_ERROR_STOP=1 < "$catalog_assertions"
echo "Portable business baseline clean-room apply passed using $image"
