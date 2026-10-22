#!/usr/bin/env bash
# Local-only acceptance against the real shared Caddy config, never production.
set -euo pipefail
repo="$(cd "$(dirname "$0")/.." && pwd)"
image="${UPDATER_CADDY_IMAGE:-worktrack-web:test}"
scratch="${JCODE_SCRATCH_DIR:-${RUNNER_TEMP:-${TMPDIR:-/tmp}}}"
fixtures="$(mktemp -d "$scratch/updater-hosting.XXXXXX")"
container=""
cleanup() {
  if [[ -n "$container" ]]; then docker rm -f "$container" >/dev/null; fi
  rm -rf "$fixtures"
}
trap cleanup EXIT
mkdir -p "$fixtures/site/updates/windows/x86_64/releases/0.1.2"
mkdir -p "$fixtures/site/downloads/0.1.2"
printf 'production download fixture\000\377\n' > "$fixtures/site/downloads/0.1.2/WorkTrack_0.1.2_x64-setup.exe"
printf 'hidden download\n' > "$fixtures/site/downloads/0.1.2/.private"
printf '<html>dashboard fixture</html>\n' > "$fixtures/site/index.html"
printf '{"version":"0.1.2"}\n' > "$fixtures/site/updates/windows/x86_64/latest.json"
printf 'immutable installer fixture\000\377\n' > "$fixtures/site/updates/windows/x86_64/releases/0.1.2/worktrack-setup.exe"
printf 'must remain hidden\n' > "$fixtures/site/updates/windows/x86_64/.latest.json.tmp"
cp -R "$fixtures/site/updates" "$fixtures/site/updates-staging"
printf '{"version":"0.1.3"}\n' > "$fixtures/site/updates-staging/windows/x86_64/latest.json"
docker run --rm --pull never -v "$repo/deploy/Caddyfile.shared:/etc/caddy/Caddyfile:ro" \
  "$image" caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile
container="$(docker run -d --rm --pull never -p 127.0.0.1::8080 \
  -v "$repo/deploy/Caddyfile.shared:/etc/caddy/Caddyfile:ro" \
  -v "$fixtures/site:/srv:ro" "$image")"
port="$(docker port "$container" 8080/tcp | awk -F: '{print $NF}')"
base="http://127.0.0.1:$port"
for attempt in {1..30}; do
  if curl --silent --fail "$base/" > /dev/null; then break; fi
  if [[ "$attempt" == 30 ]]; then docker logs "$container"; exit 1; fi
  sleep 0.2
done
curl --silent --fail -D "$fixtures/headers" "$base/updates/windows/x86_64/latest.json" > "$fixtures/manifest"
cmp "$fixtures/manifest" "$fixtures/site/updates/windows/x86_64/latest.json"
grep -qi '^content-type: application/json' "$fixtures/headers"
grep -qi '^cache-control: no-cache, max-age=0, must-revalidate' "$fixtures/headers"
curl --silent --fail -D "$fixtures/headers" "$base/updates/windows/x86_64/releases/0.1.2/worktrack-setup.exe" > "$fixtures/installer"
cmp "$fixtures/installer" "$fixtures/site/updates/windows/x86_64/releases/0.1.2/worktrack-setup.exe"
grep -qi '^cache-control: public, max-age=31536000, immutable' "$fixtures/headers"
grep -qi '^content-disposition: attachment' "$fixtures/headers"
curl --silent --fail -D "$fixtures/headers" "$base/updates-staging/windows/x86_64/releases/0.1.2/worktrack-setup.exe" > "$fixtures/staging-installer"
cmp "$fixtures/staging-installer" "$fixtures/site/updates-staging/windows/x86_64/releases/0.1.2/worktrack-setup.exe"
grep -qi '^content-disposition: attachment' "$fixtures/headers"
curl --silent --fail -D "$fixtures/headers" "$base/downloads/0.1.2/WorkTrack_0.1.2_x64-setup.exe" > "$fixtures/download"
cmp "$fixtures/download" "$fixtures/site/downloads/0.1.2/WorkTrack_0.1.2_x64-setup.exe"
grep -qi '^content-disposition: attachment' "$fixtures/headers"
grep -qi '^cache-control: public, max-age=31536000, immutable' "$fixtures/headers"
for path in /downloads/missing.exe /downloads/0.1.2/.private /downloads/0.1.2/; do
  test "$(curl --silent -o /dev/null -w '%{http_code}' "$base$path")" = 404
done
test "$(curl --silent -X PUT --data 'not allowed' -o /dev/null -w '%{http_code}' "$base/downloads/0.1.2/WorkTrack_0.1.2_x64-setup.exe")" = 405
cmp "$fixtures/download" "$fixtures/site/downloads/0.1.2/WorkTrack_0.1.2_x64-setup.exe"
for path in /updates/windows/x86_64/missing.json /updates/windows/x86_64/releases/missing.exe /updates/windows/x86_64/.latest.json.tmp; do
  test "$(curl --silent -o "$fixtures/missing" -w '%{http_code}' "$base$path")" = 404
  ! cmp -s "$fixtures/missing" "$fixtures/site/index.html"
done
curl --silent --fail "$base/updates-staging/windows/x86_64/latest.json" > "$fixtures/staging-manifest"
cmp "$fixtures/staging-manifest" "$fixtures/site/updates-staging/windows/x86_64/latest.json"
test "$(curl --silent -o /dev/null -w '%{http_code}' "$base/updates-staging/windows/x86_64/missing.json")" = 404
curl --silent --fail "$base/dashboard/deep/link" > "$fixtures/dashboard"
cmp "$fixtures/dashboard" "$fixtures/site/index.html"
test "$(curl --silent -X PUT --data 'not allowed' -o /dev/null -w '%{http_code}' "$base/updates/windows/x86_64/latest.json")" = 405
cmp "$fixtures/manifest" "$fixtures/site/updates/windows/x86_64/latest.json"
printf 'PASS: real Caddy update and worker download bytes/cache, attachment headers, missing/hidden 404, SPA fallback and read-only methods\n'
