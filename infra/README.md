# infra — hosting & provisioning

Self-hosted app tier for the LinkedIn Campaign Dashboard. Each **team** gets its
own Supabase Cloud project (DB + Auth + Storage) and its own container on your
VPS, fronted by one shared Caddy reverse proxy that terminates TLS and routes
each subdomain to the right container. Data can't mix: separate Supabase project
per team, separate container holding only that team's keys.

```
 Caddy (TLS, :80/:443)
   ├─ acme.app.example.com   → acme-app:8080    → Supabase project A
   ├─ globex.app.example.com → globex-app:8080  → Supabase project B
   └─ you.app.example.com    → you-app:8080     → your own project
```

## One-time VPS setup

```bash
# install docker + compose, point *.app.example.com DNS at the VPS, then:
ACME_EMAIL=you@example.com docker compose -f infra/docker-compose.yml up -d   # start the proxy
```

## Add a team

```bash
cp infra/templates/team.secrets.env.example infra/tenants/acme.secrets.env
$EDITOR infra/tenants/acme.secrets.env        # Supabase keys, admin creds, subdomain
infra/provision-team.sh acme                  # migrate, seed admin, build, run, route, TLS
```

`provision-team.sh` applies all DB migrations, seeds the first admin, renders the
container + Caddy vhost, brings it up, and prints the onboarding packet (app URL,
admin login, and the bootstrap `config.yaml` keys for that team's notebooks). Then
record the team in `tenants.yaml`.

> The Supabase **project** must exist first (create it in the dashboard). The
> script fills and configures it; it doesn't create the project.

## Fleet operations

| Script | What it does |
|---|---|
| `migrate-all.sh [file.sql]` | Apply all migrations (or one) to every team's project |
| `redeploy-all.sh [--build]` | Rebuild the image and restart every team's container |
| `deploy-agent-all.sh` | Push the current sync-agent to every team's storage bucket |

## Files

| Path | Purpose |
|---|---|
| `docker-compose.yml` | The shared Caddy proxy + `dashboard_net` network |
| `Caddyfile` | Global TLS config; imports `sites/*.caddy` |
| `sites/<slug>.caddy` | Per-team vhost (generated) |
| `templates/` | Rendered per team into `tenants/<slug>/` |
| `tenants.yaml` | Human registry of teams (safe to commit) |
| `tenants/<slug>.secrets.env` | Operator inputs (gitignored) |
| `tenants/<slug>/` | Rendered `.env` + `docker-compose.yml` (gitignored) |

Secrets (`tenants/*.secrets.env`, `tenants/*/.env`) are gitignored and live only
on the VPS. The container image is built once from `frontend/` and reused by every
team — only the env file differs.
