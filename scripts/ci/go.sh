#!/usr/bin/env bash
# Go tests plus the real HTTP API integration test against a disposable Postgres.
# Used by .woodpecker/ci.yaml. Needs Docker, Go and Node on the agent.
set -euo pipefail
cd "$(dirname "$0")/../.."
pass=ci-only-not-a-secret
db="wt-ci-pg-${CI_PIPELINE_NUMBER:-local}-$$"
tmp="$(mktemp -d)"
api_pid=0
cleanup() {
  kill "$api_pid" 2>/dev/null || true
  docker rm -f "$db" >/dev/null 2>&1 || true
  rm -rf "$tmp"
}
trap cleanup EXIT

docker run -d --name "$db" -e POSTGRES_DB=worktrack_test -e POSTGRES_USER=worktrack \
  -e POSTGRES_PASSWORD="$pass" -p 127.0.0.1::5432 postgres:17-alpine >/dev/null
port="$(docker port "$db" 5432/tcp | head -1 | awk -F: '{print $NF}')"
for i in $(seq 1 30); do
  docker exec "$db" pg_isready -U worktrack -d worktrack_test >/dev/null 2>&1 && break
  [ "$i" = 30 ] && exit 1
  sleep 1
done
export DATABASE_URL="postgres://worktrack:$pass@127.0.0.1:$port/worktrack_test?sslmode=disable"
export WT_TEST_DATABASE_URL="$DATABASE_URL"

(
  cd server
  test -z "$(gofmt -l .)"
  go vet ./...
  CGO_ENABLED=1 go test -race ./...
  go build -o "$tmp/worktrack-api" .
)

export WT_TEST_BASE=http://127.0.0.1:18080
export WT_TEST_OWNER_EMAIL=owner@example.test
export WT_TEST_OWNER_PASSWORD=ci-only-disposable-password
export APP_ORIGIN=http://localhost:5173 LISTEN_ADDR=127.0.0.1:18080 DEV_MODE=true
BOOTSTRAP_EMAIL="$WT_TEST_OWNER_EMAIL" BOOTSTRAP_PASSWORD="$WT_TEST_OWNER_PASSWORD" BOOTSTRAP_NAME='CI owner' \
  "$tmp/worktrack-api" >"$tmp/api.log" 2>&1 &
api_pid=$!
for i in $(seq 1 30); do
  curl -fs "$WT_TEST_BASE/api/health" >/dev/null && break
  [ "$i" = 30 ] && { cat "$tmp/api.log"; exit 1; }
  sleep 1
done
node scripts/integration.mjs || { cat "$tmp/api.log"; exit 1; }
