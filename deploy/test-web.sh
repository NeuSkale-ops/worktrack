#!/usr/bin/env bash
set -euo pipefail
name="worktrack-web-test-$$"
cleanup() {
  if [ "$?" -ne 0 ]; then docker logs "$name" >&2 || true; fi
  docker rm -f "$name" >/dev/null 2>&1 || true
}
trap cleanup EXIT
docker run -d --name "$name" --network none --read-only --cap-drop ALL \
  --security-opt no-new-privileges:true \
  --tmpfs /tmp:mode=1777 --tmpfs /data:uid=10001,gid=10001 --tmpfs /config:uid=10001,gid=10001 \
  -e APP_DOMAIN=localhost -e ACME_EMAIL=ops@example.com "${1:-worktrack-web:test}" >/dev/null
for attempt in {1..15}; do
  if docker exec "$name" wget -q -O /dev/null http://127.0.0.1:8081/healthz; then break; fi
  if [ "$attempt" = 15 ]; then exit 1; fi
  sleep 1
done
docker exec "$name" sh -c 'test "$(id -u)" = 10001'
docker exec "$name" wget --no-check-certificate -q -O - https://localhost:8443/deep/link | grep -q '<html'
headers="$(docker exec "$name" wget -S --spider -T 2 http://localhost:8080/deep/link 2>&1 || true)"
if [[ "$headers" != *'Location: https://localhost/deep/link'* ]]; then
  printf '%s\n' "$headers" >&2
  exit 1
fi
echo 'Nonroot read-only Caddy, SPA fallback, HTTPS, health and public redirect checks passed.'
