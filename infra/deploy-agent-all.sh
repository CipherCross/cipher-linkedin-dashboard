#!/usr/bin/env bash
# Push the current sync-agent build to EVERY team's private 'agent' storage
# bucket; notebooks self-update within 30 min. Reuses sync-agent/deploy.sh per
# team by linking the Supabase CLI to each project in turn.
#
# Requires: supabase CLI installed, and SUPABASE_ACCESS_TOKEN exported (so
# `supabase link` is non-interactive). Each team's secrets file must set
# SUPABASE_PROJECT_REF.
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(cd "$HERE/.." && pwd)"
: "${SUPABASE_ACCESS_TOKEN:?export SUPABASE_ACCESS_TOKEN for non-interactive supabase link}"

shopt -s nullglob
secrets=("$HERE"/tenants/*.secrets.env)
if [[ ${#secrets[@]} -eq 0 ]]; then echo "no teams provisioned"; exit 0; fi

for sec in "${secrets[@]}"; do
  slug="$(basename "$sec" .secrets.env)"
  (
    set -a; source "$sec"; set +a
    if [[ -z "${SUPABASE_PROJECT_REF:-}" ]]; then
      echo "==> skip $slug (no SUPABASE_PROJECT_REF in $sec)"; exit 0
    fi
    echo "==> $slug ($SUPABASE_PROJECT_REF)"
    supabase link --project-ref "$SUPABASE_PROJECT_REF" >/dev/null
    "$REPO/sync-agent/deploy.sh"
  )
done
echo "done"
