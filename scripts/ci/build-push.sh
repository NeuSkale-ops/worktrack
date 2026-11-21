#!/usr/bin/env bash
# Build and push the api and web images to GHCR, tagged with the commit SHA.
# Used by .woodpecker/deploy.yaml. Needs GHCR_USER, GHCR_TOKEN (write:packages)
# and GH_TOKEN (read access to this repo's releases) in the environment.
set -euo pipefail
cd "$(dirname "$0")/../.."
sha="${CI_COMMIT_SHA:?}"
repo="${CI_REPO:-NeuSkale-ops/worktrack}"

printf '%s' "$GHCR_TOKEN" | docker login ghcr.io -u "$GHCR_USER" --password-stdin >/dev/null
trap 'docker logout ghcr.io >/dev/null 2>&1 || true' EXIT

docker buildx build --target api -f deploy/Dockerfile \
  -t "ghcr.io/neuskale-ops/worktrack-api:$sha" --push .

# The dashboard offers the managed agent zip from its own origin. The committed
# manifest pins the release and its checksum, so a mismatch or a missing release
# fails the deploy instead of shipping a dead link.
(
  cd web/public/managed-agent
  version=$(jq -er .version latest.json)
  [[ "$version" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]
  zip="worktrack-managed-agent-$version.zip"
  gh release download "managed-agent-v$version" --repo "$repo" --pattern "$zip" --clobber
  echo "$(jq -er .sha256 latest.json)  $zip" | sha256sum --check
)

docker buildx build --target web -f deploy/Dockerfile \
  -t "ghcr.io/neuskale-ops/worktrack-web:$sha" --push .
