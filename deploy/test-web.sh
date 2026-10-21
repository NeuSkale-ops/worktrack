#!/usr/bin/env bash
set -euo pipefail
name="worktrack-web-test-$$"
downloads="$(mktemp -d "${TMPDIR:-/tmp}/worktrack-downloads.XXXXXX")"
cleanup() {
  result=$?
  if [ "$result" -ne 0 ]; then docker logs "$name" >&2 || true; fi
  docker rm -f "$name" >/dev/null 2>&1 || true
  rm -rf "$downloads"
  exit "$result"
}
trap cleanup EXIT
mkdir "$downloads/0.1.2"
printf 'worktrack installer fixture\n' > "$downloads/0.1.2/WorkTrack_0.1.2_x64-setup.exe"
chmod 755 "$downloads" "$downloads/0.1.2"
chmod 644 "$downloads/0.1.2/WorkTrack_0.1.2_x64-setup.exe"
docker run -d --name "$name" --network none --read-only --cap-drop ALL \
  --security-opt no-new-privileges:true \
  --tmpfs /tmp:mode=1777 --tmpfs /data:uid=10001,gid=10001 --tmpfs /config:uid=10001,gid=10001 \
  -v "$downloads:/srv/downloads:ro" \
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
installer='/downloads/0.1.2/WorkTrack_0.1.2_x64-setup.exe'
body="$(docker exec "$name" wget --no-check-certificate -q -O - "https://localhost:8443$installer")"
test "$body" = 'worktrack installer fixture'
headers="$(docker exec "$name" wget --no-check-certificate -S --spider "https://localhost:8443$installer" 2>&1)"
[[ "$headers" == *'Content-Disposition: attachment'* ]]
[[ "$headers" == *'max-age=31536000, immutable'* ]]
for path in /downloads/missing.exe /downloads/.hidden /downloads/0.1.2/; do
  headers="$(docker exec "$name" wget --no-check-certificate -S --spider "https://localhost:8443$path" 2>&1 || true)"
  [[ "$headers" == *'404 Not Found'* ]]
done
echo 'Nonroot read-only Caddy, SPA fallback, HTTPS, health, redirects and installer download checks passed.'
