#!/usr/bin/env bash
# Apply migrations to EVERY provisioned team's Supabase project. Migrations are
# written to be safe to re-run (IF NOT EXISTS / drop-and-recreate), so this is
# idempotent. Pass a single filename to roll out just that one.
#
#   infra/migrate-all.sh                       # apply all migrations to all teams
#   infra/migrate-all.sh 015_something.sql     # apply just that one to all teams
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
MIGRATIONS="$HERE/../supabase/migrations"
TARGET="${1:-}"

shopt -s nullglob
secrets=("$HERE"/tenants/*.secrets.env)
if [[ ${#secrets[@]} -eq 0 ]]; then echo "no teams provisioned"; exit 0; fi

for sec in "${secrets[@]}"; do
  slug="$(basename "$sec" .secrets.env)"
  echo "==> $slug"
  (
    set -a; source "$sec"; set +a
    if [[ -n "$TARGET" ]]; then
      psql "$SUPABASE_DB_URL" -v ON_ERROR_STOP=1 -q -f "$MIGRATIONS/$TARGET"
    else
      for f in "$MIGRATIONS"/*.sql; do
        echo "    - $(basename "$f")"
        psql "$SUPABASE_DB_URL" -v ON_ERROR_STOP=1 -q -f "$f"
      done
    fi
  )
done
echo "done"
