#!/usr/bin/env bash
# Deploy config validation, image builds and container acceptance.
# Used by .woodpecker/ci.yaml. Needs Docker, Python 3, minisign and Node on the agent.
set -euo pipefail
cd "$(dirname "$0")/../.."
export APP_DOMAIN=worktrack.example.com ACME_EMAIL=ops@example.com
export POSTGRES_PASSWORD=validation-only
export DATABASE_URL=postgres://worktrack:validation-only@db:5432/worktrack?sslmode=disable
JCODE_SCRATCH_DIR="$(mktemp -d)"
export JCODE_SCRATCH_DIR
trap 'rm -rf "$JCODE_SCRATCH_DIR"' EXIT

docker compose -f deploy/compose.yaml config --quiet
bash -n deploy/backup.sh deploy/test-web.sh
docker run --rm -e APP_DOMAIN -e ACME_EMAIL -v "$PWD/deploy/Caddyfile:/etc/caddy/Caddyfile:ro" \
  caddy:2-alpine caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile
docker build --target api -f deploy/Dockerfile .
docker build --target web -t worktrack-web:test -f deploy/Dockerfile .
bash deploy/test-web.sh
python3 -m unittest discover -s scripts -p 'test_updater*.py' -v
bash scripts/test_updater_hosting.sh
bash scripts/container-acceptance.sh
