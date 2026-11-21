#!/usr/bin/env bash
# Record the new image tags in NeuSkale-ops/infra, then wait for Flux to roll out.
# Used by .woodpecker/deploy.yaml. Needs INFRA_DEPLOY_KEY (write deploy key).
set -euo pipefail
sha="${CI_COMMIT_SHA:?}"
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
umask 077
printf '%s\n' "$INFRA_DEPLOY_KEY" > "$work/key"
ssh-keyscan -t ed25519 github.com > "$work/known_hosts" 2>/dev/null
export GIT_SSH_COMMAND="ssh -i $work/key -o IdentitiesOnly=yes -o UserKnownHostsFile=$work/known_hosts -o StrictHostKeyChecking=yes"
git clone -q --depth 20 git@github.com:NeuSkale-ops/infra.git "$work/infra"
cd "$work/infra"
git config user.name "worktrack ci"
git config user.email "ci@neuskale.com"
scripts/bump-image.sh apps/neuskale/worktrack "$sha" worktrack-api worktrack-web

sleep 90
for i in $(seq 1 30); do
  code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 10 https://worktrack.neuskale.com/ || true)
  echo "attempt $i: / -> $code"
  [ "$code" = 200 ] && exit 0
  sleep 10
done
echo "worktrack not healthy after deploy" >&2
exit 1
