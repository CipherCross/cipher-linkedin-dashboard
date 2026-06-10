#!/usr/bin/env bash
# Deploy the sync agent to all notebooks: upload agent.py to the private
# 'agent' Supabase Storage bucket. Each notebook self-updates from it at the
# start of its next scheduled sync (i.e. within 30 minutes), then re-runs
# itself — no manual copying. Verify the rollout on the dashboard's Health
# page, which shows each instance's agent_version.
#
# Requires the Supabase CLI logged in and linked (supabase login / link).
set -euo pipefail
cd "$(dirname "$0")/.."   # repo root — supabase CLI needs the linked project

python3 -m py_compile sync-agent/agent.py   # never ship a build that can't parse

# storage cp refuses to overwrite (409), so replace: notebooks that poll in
# the brief gap see a 404 and harmlessly skip that update cycle. rm prompts
# for confirmation, hence the piped yes.
echo y | supabase storage rm ss:///agent/agent.py --experimental || true
supabase storage cp ./sync-agent/agent.py ss:///agent/agent.py --experimental

version=$(grep -m1 'AGENT_VERSION = ' sync-agent/agent.py)
echo "deployed: ${version} — notebooks pick it up within 30 min"
