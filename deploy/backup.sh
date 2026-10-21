#!/usr/bin/env bash
set -euo pipefail
umask 077

: "${BACKUP_RECIPIENT:?Set an age public recipient, never a private key}"
command -v age >/dev/null || { echo 'Install age before running backups.' >&2; exit 1; }
cd "$(dirname "$0")"
backup_dir="${BACKUP_DIR:-./backups}"
mkdir -p "$backup_dir"
chmod 700 "$backup_dir"
output="$backup_dir/worktrack-$(date -u +%Y%m%dT%H%M%SZ)-$$.dump.age"
trap 'rm -f "$output.partial"' EXIT
docker compose -f compose.yaml exec -T db pg_dump -U worktrack -d worktrack --format=custom \
  | age -r "$BACKUP_RECIPIENT" -o "$output.partial"
mv "$output.partial" "$output"
printf '%s\n' "$output"
