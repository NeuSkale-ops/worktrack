#!/usr/bin/env bash
# Operator only. Review before running as root on the approved Linux update host.
# Inputs are reviewed receiver code and PUBLIC keys, never private SSH/signing keys.
set -euo pipefail
umask 077
export PATH=/usr/sbin:/usr/bin:/sbin:/bin

fail() { printf 'ERROR: %s\n' "$*" >&2; exit 1; }
[[ $# == 4 ]] || fail "Usage: $0 RECEIVER.py TAURI_PUBLIC_KEY PRODUCTION_SSH_PUBLIC_KEY STAGING_SSH_PUBLIC_KEY"
[[ $(id -u) == 0 && $(uname -s) == Linux ]] || fail 'Run as root on the approved Linux host.'
/usr/bin/python3 -I -c 'import sys; assert sys.version_info >= (3, 11), "Python 3.11+ required"'
for input in "$@"; do
  [[ -f "$input" && ! -L "$input" && -r "$input" ]] || fail 'Each input must be a readable regular file, not a symlink.'
done

work=$(mktemp -d /run/worktrack-updater-setup.XXXXXX)
fragment=/etc/ssh/sshd_config.d/70-worktrack-updates.conf
changed=0
backup=''
cleanup() {
  result=$?
  trap - EXIT
  if (( result != 0 && changed == 1 )); then
    if [[ -n "$backup" ]]; then
      cp -p -- "$backup" "$fragment"
    else
      rm -f -- "$fragment"
    fi
    # A failed reload may have partially applied configuration. Restore the old one.
    if /usr/sbin/sshd -t; then systemctl reload ssh || printf 'ERROR: SSH rollback reload failed. Keep the administrative session open.\n' >&2; fi
  fi
  rm -rf -- "$work"
  exit "$result"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
trap 'exit 129' HUP

# Validate before installing packages, creating accounts, or changing host files.
/usr/bin/python3 -I - "$1" "$2" "$3" "$4" "$work" <<'PY'
import base64
import pathlib
import re
import struct
import sys

receiver, tauri, production, staging, output = map(pathlib.Path, sys.argv[1:])
compile(receiver.read_bytes(), str(receiver), 'exec')
encoded = tauri.read_bytes().decode('ascii').removesuffix('\n')
if not re.fullmatch(r'[A-Za-z0-9+/]+={0,2}', encoded):
    raise SystemExit('Expected a single encoded Tauri public-key line')
lines = base64.b64decode(encoded, validate=True).decode('utf-8').splitlines()
if len(lines) != 2 or not lines[0].startswith('untrusted comment:'):
    raise SystemExit('Invalid Tauri public-key box')
if len(base64.b64decode(lines[1], validate=True)) != 42:
    raise SystemExit('Invalid Tauri public-key payload')
(output / 'public-key.txt').write_text(encoded + '\n')
keys = []
for path, name in ((production, 'production.pub'), (staging, 'staging.pub')):
    line = path.read_bytes().decode('ascii').removesuffix('\n')
    match = re.fullmatch(r'ssh-ed25519 ([A-Za-z0-9+/]+={0,2})(?: [ -~]*)?', line)
    if not match:
        raise SystemExit('Expected one plain ssh-ed25519 public key, without options or control characters')
    blob = base64.b64decode(match[1], validate=True)
    expected = struct.pack('>I', 11) + b'ssh-ed25519' + struct.pack('>I', 32)
    if len(blob) != 51 or not blob.startswith(expected):
        raise SystemExit('Invalid Ed25519 SSH public-key payload')
    keys.append(blob)
    (output / name).write_text('restrict ssh-ed25519 ' + match[1] + '\n')
if keys[0] == keys[1]:
    raise SystemExit('Production and staging require different dedicated SSH keys')
PY

# Refuse symlink traversal and writable trusted ancestors rather than repairing them.
trusted_dir() {
  [[ -d "$1" && ! -L "$1" ]] || fail "Expected real directory: $1"
  [[ $(stat -c %u "$1") == 0 ]] || fail "Expected root ownership: $1"
  (( (8#$(stat -c %a "$1") & 0022) == 0 )) || fail "Trusted directory is writable by non-root: $1"
}
for directory in / /usr /usr/local /usr/local/lib /etc /etc/ssh /etc/ssh/sshd_config.d /srv /var /var/lib; do
  trusted_dir "$directory"
done
for directory in /usr/local/lib/worktrack-updater /etc/worktrack-updater /etc/ssh/authorized_keys; do
  if [[ -e "$directory" || -L "$directory" ]]; then trusted_dir "$directory"; fi
done

cat > "$work/sshd.conf" <<'SSHD'
# Managed by scripts/setup_updater_host.sh. Deployment keys have no shell access.
Match User worktrack-updates
    AuthorizedKeysFile /etc/ssh/authorized_keys/%u
    AuthenticationMethods publickey
    PasswordAuthentication no
    KbdInteractiveAuthentication no
    DisableForwarding yes
    PermitTTY no
    ForceCommand /usr/bin/timeout 600 /usr/bin/python3 -I /usr/local/lib/worktrack-updater/updater_release.py receive --root /srv/worktrack-updates --public-key /etc/worktrack-updater/public-key.txt

Match User worktrack-updates-staging
    AuthorizedKeysFile /etc/ssh/authorized_keys/%u
    AuthenticationMethods publickey
    PasswordAuthentication no
    KbdInteractiveAuthentication no
    DisableForwarding yes
    PermitTTY no
    ForceCommand /usr/bin/timeout 600 /usr/bin/python3 -I /usr/local/lib/worktrack-updater/updater_release.py receive --root /srv/worktrack-updates-staging --public-key /etc/worktrack-updater/public-key.txt --base-url https://worktrack.neuskale.com/updates-staging/windows/x86_64

Match all
SSHD

# Existing unmanaged content needs operator review, not an implicit key/config rotation.
unchanged_file() {
  if [[ -e "$2" || -L "$2" ]]; then
    [[ -f "$2" && ! -L "$2" && $(stat -c %u "$2") == 0 ]] || fail "Unsafe existing file: $2"
    (( (8#$(stat -c %a "$2") & 0022) == 0 )) || fail "Existing file writable by non-root: $2"
    cmp -s -- "$1" "$2" || fail "Existing file differs; review it separately: $2"
  fi
}
unchanged_file "$work/sshd.conf" "$fragment"
unchanged_file "$1" /usr/local/lib/worktrack-updater/updater_release.py
unchanged_file "$work/public-key.txt" /etc/worktrack-updater/public-key.txt
unchanged_file "$work/production.pub" /etc/ssh/authorized_keys/worktrack-updates
unchanged_file "$work/staging.pub" /etc/ssh/authorized_keys/worktrack-updates-staging

for account in worktrack-updates worktrack-updates-staging; do
  home="/var/lib/$account"
  if getent passwd "$account" > /dev/null; then
    IFS=: read -r name _ uid gid _ existing_home shell < <(getent passwd "$account")
    [[ "$name" == "$account" && "$uid" != 0 && "$existing_home" == "$home" && "$shell" == /bin/sh ]] || fail "Unexpected existing account: $account"
    [[ $(id -gn "$account") == "$account" && $(id -G "$account") == "$gid" ]] || fail "Unexpected groups for $account"
    [[ $(passwd -S "$account" | awk '{print $2}') == L ]] || fail "Existing account password is not locked: $account"
  else
    ! getent group "$account" > /dev/null || fail "Group already exists without its account: $account"
  fi
  if [[ -e "$home" || -L "$home" ]]; then trusted_dir "$home"; fi
  # Never repair a pre-existing storage tree silently or follow symlinks inside it.
  for suffix in '' /public /public/windows /public/windows/x86_64; do
    path="/srv/$account$suffix"
    if [[ -e "$path" || -L "$path" ]]; then
      [[ -d "$path" && ! -L "$path" ]] || fail "Unsafe storage directory: $path"
      [[ $(stat -c %U "$path") == "$account" ]] || fail "Unexpected storage owner: $path"
      (( (8#$(stat -c %a "$path") & 0022) == 0 )) || fail "Storage writable by another account: $path"
    fi
  done
done
/usr/sbin/sshd -t
systemctl is-active --quiet ssh || fail 'Expected active ssh.service for graceful reload.'
[[ -x /usr/bin/timeout ]] || fail '/usr/bin/timeout required.'
if ! command -v minisign > /dev/null; then
  command -v apt-get > /dev/null || fail 'Install minisign through trusted OS packages first.'
  apt-get update
  DEBIAN_FRONTEND=noninteractive apt-get install --yes minisign
fi

install -d -o root -g root -m 0755 /usr/local/lib/worktrack-updater /etc/worktrack-updater /etc/ssh/authorized_keys
install -o root -g root -m 0644 -- "$1" /usr/local/lib/worktrack-updater/updater_release.py
install -o root -g root -m 0644 "$work/public-key.txt" /etc/worktrack-updater/public-key.txt
for account in worktrack-updates worktrack-updates-staging; do
  if ! getent passwd "$account" > /dev/null; then
    useradd --system --user-group --no-create-home --home-dir "/var/lib/$account" --shell /bin/sh "$account"
  fi
  [[ $(id -gn "$account") == "$account" && $(id -G "$account") == "$(id -g "$account")" ]] || fail "Unexpected groups after creating $account"
  [[ $(passwd -S "$account" | awk '{print $2}') == L ]] || fail "Account password must remain locked: $account"
  install -d -o root -g root -m 0755 "/var/lib/$account"
  install -d -o "$account" -g "$account" -m 0711 "/srv/$account"
  install -d -o "$account" -g "$account" -m 0755 "/srv/$account/public" "/srv/$account/public/windows" "/srv/$account/public/windows/x86_64"
done
install -o root -g root -m 0644 "$work/production.pub" /etc/ssh/authorized_keys/worktrack-updates
install -o root -g root -m 0644 "$work/staging.pub" /etc/ssh/authorized_keys/worktrack-updates-staging

if [[ -f "$fragment" ]]; then
  backup="${fragment}.backup.$(date -u +%Y%m%dT%H%M%SZ).$$"
  [[ ! -e "$backup" && ! -L "$backup" ]] || fail 'SSH backup path already exists.'
  cp -p -- "$fragment" "$backup"
fi
changed=1
install -o root -g root -m 0644 "$work/sshd.conf" "$fragment"
/usr/sbin/sshd -t
# Verify that the existing global Include actually loads this fragment and no earlier
# Match block overrides its protections. Never replace global sshd configuration.
for account in worktrack-updates worktrack-updates-staging; do
  /usr/sbin/sshd -T -C "user=$account,host=localhost,addr=127.0.0.1" > "$work/effective"
  for setting in 'authenticationmethods publickey' 'passwordauthentication no' 'kbdinteractiveauthentication no' 'disableforwarding yes' 'permittty no' 'authorizedkeysfile /etc/ssh/authorized_keys/%u'; do
    grep -Fxq "$setting" "$work/effective" || fail "Effective SSH restriction missing for $account: $setting"
  done
  expected=$(awk -v account="$account" '$0 == "Match User " account { found=1; next } found && $1 == "ForceCommand" { sub(/^[[:space:]]*ForceCommand /, ""); print; exit }' "$work/sshd.conf")
  grep -Fxq "forcecommand $expected" "$work/effective" || fail "Effective SSH receiver mismatch for $account"
done
systemctl reload ssh
changed=0
printf 'Provisioned isolated update receivers. No public mounts or manifests were changed.\n'
printf 'Keep the administrative session open. Verify both dedicated keys and cross-account isolation before enabling CI publication.\n'
