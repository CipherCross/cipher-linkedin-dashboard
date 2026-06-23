#!/usr/bin/env bash
# Rebuild the image (with --build) and restart every team's container. Use after
# shipping new frontend/server code. Pass --build to rebuild the shared image
# first; otherwise just restarts containers on the current image.
#
#   infra/redeploy-all.sh --build
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(cd "$HERE/.." && pwd)"
IMAGE_TAG="${IMAGE_TAG:-latest}"

if [[ "${1:-}" == "--build" ]]; then
  echo "==> building linkedin-dashboard:$IMAGE_TAG"
  docker build -t "linkedin-dashboard:$IMAGE_TAG" "$REPO/frontend"
fi

shopt -s nullglob
dirs=("$HERE"/tenants/*/)
if [[ ${#dirs[@]} -eq 0 ]]; then echo "no teams provisioned"; exit 0; fi

for dir in "${dirs[@]}"; do
  [[ -f "$dir/docker-compose.yml" ]] || continue
  slug="$(basename "$dir")"
  echo "==> $slug"
  docker compose -p "$slug" -f "$dir/docker-compose.yml" up -d
done

echo "==> reloading Caddy"
docker compose -f "$HERE/docker-compose.yml" exec -T caddy \
  caddy reload --config /etc/caddy/Caddyfile || echo "(reload Caddy manually)"
echo "done"
