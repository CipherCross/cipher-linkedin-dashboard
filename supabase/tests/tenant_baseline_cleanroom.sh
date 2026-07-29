#!/bin/sh
set -eu

script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
supabase_dir=$(CDPATH= cd -- "$script_dir/.." && pwd)
repo_dir=$(CDPATH= cd -- "$supabase_dir/.." && pwd)
manifest="$supabase_dir/tenant-baseline/v053/manifest.json"
baseline="$supabase_dir/tenant-baseline/v053/053_tenant_baseline.sql"
internal_seed="$supabase_dir/seeds/internal/web2mob.sql"
temporary_dir=$(mktemp -d "${TMPDIR:-/tmp}/linkedin-dashboard-p1b.XXXXXX")
container_name="linkedin-dashboard-p1b-$$"
postgres_version=$(node -e "
  const m = require(process.argv[1]);
  process.stdout.write(m.provider_postgres_version);
" "$manifest")
postgres_image="public.ecr.aws/supabase/postgres:$postgres_version"

cleanup() {
  case "$container_name" in
    linkedin-dashboard-p1b-[0-9]*) docker rm -f "$container_name" >/dev/null 2>&1 || true ;;
  esac
  case "$temporary_dir" in
    "${TMPDIR:-/tmp}"/linkedin-dashboard-p1b.*) rm -rf "$temporary_dir" ;;
  esac
}
trap cleanup EXIT HUP INT TERM

manifest_baseline_sha=$(node -e "
  const m = require(process.argv[1]);
  process.stdout.write(m.files.find((f) => f.path === '053_tenant_baseline.sql').sha256);
" "$manifest")
manifest_baseline_bytes=$(node -e "
  const m = require(process.argv[1]);
  process.stdout.write(String(m.files.find((f) => f.path === '053_tenant_baseline.sql').bytes));
" "$manifest")
manifest_seed_sha=$(node -e "
  const m = require(process.argv[1]);
  process.stdout.write(m.related_internal_seed.sha256);
" "$manifest")
manifest_seed_bytes=$(node -e "
  const m = require(process.argv[1]);
  process.stdout.write(String(m.related_internal_seed.bytes));
" "$manifest")
manifest_catalog_sha=$(node -e "
  const m = require(process.argv[1]);
  process.stdout.write(m.source_catalog.sha256);
" "$manifest")
manifest_source_revision=$(node -e "
  const m = require(process.argv[1]);
  process.stdout.write(m.source_revision);
" "$manifest")

actual_baseline_sha=$(shasum -a 256 "$baseline" | awk '{print $1}')
actual_baseline_bytes=$(wc -c < "$baseline" | tr -d ' ')
actual_seed_sha=$(shasum -a 256 "$internal_seed" | awk '{print $1}')
actual_seed_bytes=$(wc -c < "$internal_seed" | tr -d ' ')

[ "$actual_baseline_sha" = "$manifest_baseline_sha" ] || {
  echo "baseline checksum does not match manifest" >&2
  exit 1
}
[ "$actual_baseline_bytes" = "$manifest_baseline_bytes" ] || {
  echo "baseline byte count does not match manifest" >&2
  exit 1
}
[ "$actual_seed_sha" = "$manifest_seed_sha" ] || {
  echo "internal seed checksum does not match manifest" >&2
  exit 1
}
[ "$actual_seed_bytes" = "$manifest_seed_bytes" ] || {
  echo "internal seed byte count does not match manifest" >&2
  exit 1
}
git -C "$repo_dir" cat-file -e "$manifest_source_revision^{commit}"

catalog_hash_input="$temporary_dir/catalog-hashes.txt"
(
  cd "$repo_dir"
  for migration in supabase/migrations/*.sql; do
    filename=${migration##*/}
    version=${filename%%_*}
    case "$version" in
      *[!0-9]*|'') continue ;;
    esac
    version_number=$(printf '%s' "$version" | sed 's/^0*//')
    [ -n "$version_number" ] || version_number=0
    if [ "$version_number" -le 53 ]; then
      shasum -a 256 "$migration"
    fi
  done
) > "$catalog_hash_input"
actual_catalog_sha=$(shasum -a 256 "$catalog_hash_input" | awk '{print $1}')
[ "$actual_catalog_sha" = "$manifest_catalog_sha" ] || {
  echo "historical 001-053 catalog digest does not match manifest" >&2
  exit 1
}

catalog_root="$temporary_dir/tenant-catalog"
"$supabase_dir/tenant-migrations/materialize.sh" "$catalog_root" >/dev/null

catalog_count=$(find "$catalog_root/migrations" -maxdepth 1 -type f -name '*.sql' | wc -l | tr -d ' ')
[ "$catalog_count" -ge 1 ] || {
  echo "materialized tenant catalog is empty" >&2
  exit 1
}

if grep -Eiq \
  'Web 2 Mob|app4P6PbWSwEEmOIz|notebook-1(:4)?|test-campaign|analysis-campaign' \
  "$catalog_root"/migrations/*.sql; then
  echo "internal business marker leaked into tenant catalog" >&2
  exit 1
fi

docker run \
  --name "$container_name" \
  -e POSTGRES_PASSWORD=postgres \
  -v "$supabase_dir:/repo/supabase:ro" \
  -v "$catalog_root/migrations:/tenant-catalog:ro" \
  -d "$postgres_image" >/dev/null

ready=false
attempt=0
while [ "$attempt" -lt 30 ]; do
  if docker exec "$container_name" pg_isready -U postgres >/dev/null 2>&1; then
    ready=true
    break
  fi
  attempt=$((attempt + 1))
  sleep 1
done
[ "$ready" = true ] || {
  echo "PostgreSQL clean-room container did not become ready" >&2
  exit 1
}

docker exec "$container_name" createdb -U postgres tenant
docker exec "$container_name" createdb -U postgres history
docker exec -e PGOPTIONS='-c client_min_messages=warning' \
  "$container_name" psql -U postgres -d tenant -v ON_ERROR_STOP=1 \
  -f /repo/supabase/tests/fixtures/provider_bootstrap.sql >/dev/null

for migration in "$catalog_root"/migrations/*.sql; do
  filename=${migration##*/}
  version=${filename%%_*}
  name=${filename#*_}
  name=${name%.sql}
  case "$version:$name" in
    *[!0-9A-Za-z_:]*) echo "unsafe tenant migration filename: $filename" >&2; exit 1 ;;
  esac
  docker exec -e PGOPTIONS='-c client_min_messages=warning' \
    "$container_name" psql -U postgres -d tenant -v ON_ERROR_STOP=1 \
    -f "/tenant-catalog/$filename" >/dev/null
  docker exec -e PGOPTIONS='-c client_min_messages=warning' \
    "$container_name" psql -U postgres -d tenant -v ON_ERROR_STOP=1 \
    -c "insert into supabase_migrations.schema_migrations(version, statements, name) values ('$version', array[]::text[], '$name')" \
    >/dev/null
done

docker exec -e PGOPTIONS='-c client_min_messages=warning' \
  "$container_name" psql -U postgres -d history -v ON_ERROR_STOP=1 \
  -f /repo/supabase/tests/fixtures/provider_bootstrap.sql >/dev/null

for migration in "$supabase_dir"/migrations/*.sql; do
  filename=${migration##*/}
  version=${filename%%_*}
  name=${filename#*_}
  name=${name%.sql}
  case "$version:$name" in
    *[!0-9A-Za-z_:]*) echo "unsafe historical migration filename: $filename" >&2; exit 1 ;;
  esac
  docker exec -e PGOPTIONS='-c client_min_messages=warning' \
    "$container_name" psql -U postgres -d history -v ON_ERROR_STOP=1 \
    -f "/repo/supabase/migrations/$filename" >/dev/null
  docker exec -e PGOPTIONS='-c client_min_messages=warning' \
    "$container_name" psql -U postgres -d history -v ON_ERROR_STOP=1 \
    -c "insert into supabase_migrations.schema_migrations(version, statements, name) values ('$version', array[]::text[], '$name')" \
    >/dev/null
done

tenant_ledger_count=$(docker exec "$container_name" psql -U postgres -d tenant -Atc \
  "select count(*) from supabase_migrations.schema_migrations")
[ "$tenant_ledger_count" = "$catalog_count" ] || {
  echo "tenant ledger does not match materialized catalog" >&2
  exit 1
}

history_cutover_count=$(docker exec "$container_name" psql -U postgres -d history -Atc \
  "select count(*) from supabase_migrations.schema_migrations where version between '001' and '053'")
[ "$history_cutover_count" = 53 ] || {
  echo "clean full-history ledger is missing a version in 001-053" >&2
  exit 1
}

docker exec -e PGOPTIONS='-c client_min_messages=warning' \
  "$container_name" psql -U postgres -d tenant -v ON_ERROR_STOP=1 \
  -f /repo/supabase/tests/tenant_baseline_assertions.sql >/dev/null
docker exec -e PGOPTIONS='-c client_min_messages=warning' \
  "$container_name" psql -U postgres -d tenant -v ON_ERROR_STOP=1 \
  -f /repo/supabase/tests/private_lead_photos_access.sql >/dev/null
docker exec -e PGOPTIONS='-c client_min_messages=warning' \
  "$container_name" psql -U postgres -d history -v ON_ERROR_STOP=1 \
  -f /repo/supabase/tests/private_lead_photos_access.sql >/dev/null

docker exec -e PGOPTIONS='-c client_min_messages=warning' \
  "$container_name" psql -U postgres -d history -v ON_ERROR_STOP=1 \
  -f /repo/supabase/seeds/internal/web2mob.sql >/dev/null
docker exec -e PGOPTIONS='-c client_min_messages=warning' \
  "$container_name" psql -U postgres -d history -v ON_ERROR_STOP=1 \
  -f /repo/supabase/seeds/internal/web2mob.sql >/dev/null

seed_counts=$(docker exec "$container_name" psql -U postgres -d history -At -F ':' -c "
  select
    (select count(*) from icps where lower(name) = lower('Web 2 Mob')),
    (select count(*) from icp_personas p join icps i on i.id = p.icp_id where lower(i.name) = lower('Web 2 Mob')),
    (select count(*) from icp_industries d join icps i on i.id = d.icp_id where lower(i.name) = lower('Web 2 Mob'));
")
[ "$seed_counts" = "1:3:23" ] || {
  echo "internal Web 2 Mob seed is not idempotent/final: $seed_counts" >&2
  exit 1
}

docker exec "$container_name" pg_dump -U postgres -d tenant \
  --schema-only --schema=public --no-security-labels > "$temporary_dir/tenant.sql"
docker exec "$container_name" pg_dump -U postgres -d history \
  --schema-only --schema=public --no-security-labels > "$temporary_dir/history.sql"
sed -E '/^\\(un)?restrict /d' "$temporary_dir/tenant.sql" \
  > "$temporary_dir/tenant.normalized.sql"
sed -E '/^\\(un)?restrict /d' "$temporary_dir/history.sql" \
  > "$temporary_dir/history.normalized.sql"
diff -u "$temporary_dir/history.normalized.sql" "$temporary_dir/tenant.normalized.sql"

echo "Tenant baseline + shared-delta clean-room checks passed"
