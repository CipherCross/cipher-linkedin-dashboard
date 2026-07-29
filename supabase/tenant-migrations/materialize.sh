#!/bin/sh
set -eu

if [ "$#" -ne 1 ]; then
  echo "usage: $0 OUTPUT_DIRECTORY" >&2
  exit 2
fi

script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
supabase_dir=$(CDPATH= cd -- "$script_dir/.." && pwd)
output_dir=$1
migrations_dir="$output_dir/migrations"
baseline_source="$supabase_dir/tenant-baseline/v053/053_tenant_baseline.sql"

if [ -e "$output_dir" ] && [ "$(find "$output_dir" -mindepth 1 -maxdepth 1 -print -quit)" ]; then
  echo "refusing to overwrite non-empty output directory: $output_dir" >&2
  exit 2
fi

mkdir -p "$migrations_dir"
cp "$baseline_source" "$migrations_dir/053_tenant_baseline.sql"

for migration in "$supabase_dir"/migrations/*.sql; do
  filename=$(basename -- "$migration")
  version=${filename%%_*}

  case "$version" in
    *[!0-9]*|'') continue ;;
  esac

  version_number=$(printf '%s' "$version" | sed 's/^0*//')
  [ -n "$version_number" ] || version_number=0
  if [ "$version_number" -ge 54 ]; then
    cp "$migration" "$migrations_dir/$filename"
  fi
done

if find "$migrations_dir" -type f -name '*.sql' ! -name '053_tenant_baseline.sql' -maxdepth 1 \
    -exec sh -c '
      for file do
        version=${file##*/}
        version=${version%%_*}
        number=$(printf "%s" "$version" | sed "s/^0*//")
        [ -n "$number" ] || number=0
        [ "$number" -ge 54 ] || exit 1
      done
    ' sh {} +; then
  :
else
  echo "tenant catalog contains a historical migration below 054" >&2
  exit 1
fi

printf '%s\n' "$migrations_dir"
