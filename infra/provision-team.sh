#!/usr/bin/env bash
# Provision one team end-to-end: apply the schema to their Supabase project, seed
# the first admin, render the container + Caddy vhost, bring it up, and print the
# onboarding packet. Idempotent enough to re-run (migrations use IF NOT EXISTS /
# drop-and-recreate; user seeding is skipped if the user already exists).
#
# Usage:
#   1. cp infra/templates/team.secrets.env.example infra/tenants/<slug>.secrets.env
#   2. edit it (Supabase keys, admin creds, subdomain)
#   3. infra/provision-team.sh <slug>
#
# Prereqs on the box you run this from: bash, curl, psql, docker (with compose),
# openssl. The Supabase PROJECT itself must already exist (create it in the
# dashboard, or via the Management API) — this script configures and fills it.
set -euo pipefail

SLUG="${1:-}"
if [[ -z "$SLUG" ]]; then
  echo "usage: $0 <slug>" >&2
  exit 1
fi
if [[ ! "$SLUG" =~ ^[a-z0-9][a-z0-9-]*$ ]]; then
  echo "slug must be lowercase letters, digits, and dashes" >&2
  exit 1
fi

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(cd "$HERE/.." && pwd)"
MIGRATIONS="$REPO/supabase/migrations"
TEAM_DIR="$HERE/tenants/$SLUG"
SECRETS="$HERE/tenants/$SLUG.secrets.env"

if [[ ! -f "$SECRETS" ]]; then
  echo "missing $SECRETS — copy infra/templates/team.secrets.env.example and fill it in" >&2
  exit 1
fi
# shellcheck disable=SC1090
set -a; source "$SECRETS"; set +a

require() { [[ -n "${!1:-}" ]] || { echo "missing required var: $1 (in $SECRETS)" >&2; exit 1; }; }
for v in SUBDOMAIN SUPABASE_URL SUPABASE_ANON_KEY SUPABASE_SERVICE_ROLE_KEY \
         SUPABASE_JWT_SECRET SUPABASE_DB_URL ANTHROPIC_API_KEY ADMIN_EMAIL ADMIN_PASSWORD; do
  require "$v"
done
IMAGE_TAG="${IMAGE_TAG:-latest}"
CRON_SECRET="$(openssl rand -hex 24)"

echo "==> [$SLUG] applying migrations to Supabase"
for f in "$MIGRATIONS"/*.sql; do
  echo "    - $(basename "$f")"
  psql "$SUPABASE_DB_URL" -v ON_ERROR_STOP=1 -q -f "$f"
done

# --- seed users ------------------------------------------------------------
seed_user() {  # email password role
  local email="$1" password="$2" role="$3"
  local resp
  resp="$(curl -sS -X POST "$SUPABASE_URL/auth/v1/admin/users" \
    -H "apikey: $SUPABASE_SERVICE_ROLE_KEY" \
    -H "authorization: Bearer $SUPABASE_SERVICE_ROLE_KEY" \
    -H "content-type: application/json" \
    -d "{\"email\":\"$email\",\"password\":\"$password\",\"email_confirm\":true}")"
  if echo "$resp" | grep -qi 'already been registered\|already exists'; then
    echo "    - $email already exists; updating role only"
  fi
  # Trigger created a default-viewer profile; set the intended role.
  psql "$SUPABASE_DB_URL" -v ON_ERROR_STOP=1 -q \
    -c "update public.profiles set role='$role', email='$email' where email='$email';"
}

echo "==> [$SLUG] seeding admin $ADMIN_EMAIL"
seed_user "$ADMIN_EMAIL" "$ADMIN_PASSWORD" "admin"
if [[ -n "${OWNER_EMAIL:-}" && -n "${OWNER_PASSWORD:-}" ]]; then
  echo "==> [$SLUG] seeding owner $OWNER_EMAIL"
  seed_user "$OWNER_EMAIL" "$OWNER_PASSWORD" "owner"
fi

# --- configure Auth (signups off + access-token hook) ----------------------
if [[ -n "${SUPABASE_ACCESS_TOKEN:-}" && -n "${SUPABASE_PROJECT_REF:-}" ]]; then
  echo "==> [$SLUG] configuring Auth via Management API"
  curl -sS -X PATCH "https://api.supabase.com/v1/projects/$SUPABASE_PROJECT_REF/config/auth" \
    -H "authorization: Bearer $SUPABASE_ACCESS_TOKEN" \
    -H "content-type: application/json" \
    -d "{\"disable_signup\":true,\"site_url\":\"https://$SUBDOMAIN\",\"uri_allow_list\":\"https://$SUBDOMAIN\",\"hook_custom_access_token_enabled\":true,\"hook_custom_access_token_uri\":\"pg-functions://postgres/public/custom_access_token_hook\"}" \
    >/dev/null && echo "    - done"
else
  cat <<EOF
==> [$SLUG] MANUAL Auth steps (no SUPABASE_ACCESS_TOKEN given):
    In the Supabase dashboard for this project:
      Authentication → Providers → disable "Allow new users to sign up"
      Authentication → URL Configuration → Site URL = https://$SUBDOMAIN
      Authentication → Hooks → Custom Access Token →
        enable, function = public.custom_access_token_hook
EOF
fi

# --- render container + vhost ---------------------------------------------
echo "==> [$SLUG] rendering container + Caddy vhost"
mkdir -p "$TEAM_DIR"
render() {  # template dest
  sed -e "s#{{SLUG}}#$SLUG#g" \
      -e "s#{{SUBDOMAIN}}#$SUBDOMAIN#g" \
      -e "s#{{IMAGE_TAG}}#$IMAGE_TAG#g" \
      -e "s#{{SUPABASE_URL}}#$SUPABASE_URL#g" \
      -e "s#{{SUPABASE_ANON_KEY}}#$SUPABASE_ANON_KEY#g" \
      -e "s#{{SUPABASE_SERVICE_ROLE_KEY}}#$SUPABASE_SERVICE_ROLE_KEY#g" \
      -e "s#{{SUPABASE_JWT_SECRET}}#$SUPABASE_JWT_SECRET#g" \
      -e "s#{{ANTHROPIC_API_KEY}}#$ANTHROPIC_API_KEY#g" \
      -e "s#{{CRON_SECRET}}#$CRON_SECRET#g" \
      "$1" > "$2"
}
render "$HERE/templates/team.docker-compose.yml.tmpl" "$TEAM_DIR/docker-compose.yml"
render "$HERE/templates/team.env.tmpl"                "$TEAM_DIR/.env"
render "$HERE/templates/team.caddy.tmpl"             "$HERE/sites/$SLUG.caddy"
chmod 600 "$TEAM_DIR/.env"

# --- build image once + bring the team up ----------------------------------
if ! docker image inspect "linkedin-dashboard:$IMAGE_TAG" >/dev/null 2>&1; then
  echo "==> building linkedin-dashboard:$IMAGE_TAG"
  docker build -t "linkedin-dashboard:$IMAGE_TAG" "$REPO/frontend"
fi

echo "==> [$SLUG] starting container"
docker compose -p "$SLUG" -f "$TEAM_DIR/docker-compose.yml" up -d

echo "==> reloading Caddy"
if docker compose -f "$HERE/docker-compose.yml" ps caddy >/dev/null 2>&1; then
  docker compose -f "$HERE/docker-compose.yml" exec -T caddy \
    caddy reload --config /etc/caddy/Caddyfile || \
    echo "    (could not reload Caddy automatically — reload it manually)"
else
  echo "    (proxy not running — start it: ACME_EMAIL=you@example.com docker compose -f infra/docker-compose.yml up -d)"
fi

# --- onboarding packet -----------------------------------------------------
cat <<EOF

============================================================
 TEAM PROVISIONED: $SLUG
============================================================
 Dashboard:   https://$SUBDOMAIN
 Admin login: $ADMIN_EMAIL / (the password you set)

 Each notebook's sync-agent config.yaml needs ONLY these bootstrap keys
 (everything else is editable from the dashboard's Health page):

   supabase_url: "$SUPABASE_URL"
   supabase_service_key: "<SERVICE_ROLE_KEY — keep secret, do not share across teams>"
   instance_id: "$SLUG-nb-1"      # unique per notebook

 Next:
   - add this team to infra/tenants.yaml
   - run sync-agent on each notebook (see sync-agent/README or repo README)
   - the admin can invite the rest of the team from the Members page
============================================================
EOF
