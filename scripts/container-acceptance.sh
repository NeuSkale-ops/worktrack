#!/usr/bin/env bash
# Exercise the actual production images over HTTPS with an isolated disposable DB.
set -euo pipefail
cd "$(dirname "$0")/.."
id="worktrack-acceptance-$$"
web="$id-web"
api="$id-api"
db="$id-db"
scratch="$(mktemp -d "${JCODE_SCRATCH_DIR:-${TMPDIR:-/tmp}}/worktrack-acceptance.XXXXXX")"
cleanup() {
  result=$?
  if [ "$result" -ne 0 ]; then
    docker logs "$web" >&2 || true
    docker logs "$api" >&2 || true
  fi
  docker rm -f -v "$web" "$api" "$db" >/dev/null 2>&1 || true
  docker network rm "$id" >/dev/null 2>&1 || true
  # The directory contains only the disposable test CA certificate.
  rm -f "$scratch/root.crt"
  rmdir "$scratch" 2>/dev/null || true
  exit "$result"
}
trap cleanup EXIT

docker build --target api -t worktrack-api:acceptance -f deploy/Dockerfile .
docker build --target web -t worktrack-web:acceptance -f deploy/Dockerfile .
docker network create "$id" >/dev/null
docker run -d --name "$db" --network "$id" --network-alias db \
  -e POSTGRES_DB=worktrack -e POSTGRES_USER=worktrack \
  -e POSTGRES_PASSWORD=disposable-acceptance-password postgres:17-alpine >/dev/null
for attempt in {1..30}; do
  if docker exec "$db" pg_isready -U worktrack -d worktrack >/dev/null 2>&1; then break; fi
  [ "$attempt" -lt 30 ] || exit 1
  sleep 1
done
docker run -d --name "$web" --network "$id" --read-only --cap-drop ALL \
  --security-opt no-new-privileges:true \
  --tmpfs /tmp:mode=1777 --tmpfs /data:uid=10001,gid=10001 --tmpfs /config:uid=10001,gid=10001 \
  -p 127.0.0.1::8443 -e APP_DOMAIN=localhost -e ACME_EMAIL=ops@example.com \
  worktrack-web:acceptance >/dev/null
port="$(docker port "$web" 8443/tcp | head -1 | awk -F: '{print $NF}')"
origin="https://localhost:$port"
docker run -d --name "$api" --network "$id" --network-alias api --read-only --cap-drop ALL \
  --security-opt no-new-privileges:true --tmpfs /tmp:mode=1777 \
  -e DATABASE_URL='postgres://worktrack:disposable-acceptance-password@db:5432/worktrack?sslmode=disable' \
  -e APP_ORIGIN="$origin" -e DEV_MODE=false \
  -e BOOTSTRAP_EMAIL=container-owner@example.test \
  -e BOOTSTRAP_PASSWORD=disposable-acceptance-password \
  worktrack-api:acceptance >/dev/null
for attempt in {1..30}; do
  if curl --silent --fail --insecure "$origin/api/health" >/dev/null; then break; fi
  [ "$attempt" -lt 30 ] || exit 1
  sleep 1
done
docker exec "$web" cat /data/caddy/pki/authorities/local/root.crt > "$scratch/root.crt"
# Trust only this fixture CA for this process, not globally and not with TLS validation disabled.
NODE_EXTRA_CA_CERTS="$scratch/root.crt" APP_ORIGIN="$origin" \
  WT_TEST_BASE="$origin" WT_TEST_OWNER_EMAIL=container-owner@example.test \
  WT_TEST_OWNER_PASSWORD=disposable-acceptance-password node scripts/integration.mjs
curl --silent --fail --cacert "$scratch/root.crt" "$origin/invite?token=example" | grep -q '<html'
echo 'PASS: production nonroot read-only React/Caddy + Go + PostgreSQL stack over HTTPS, Secure cookies and SPA routing'
