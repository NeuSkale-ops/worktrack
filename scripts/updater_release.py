#!/usr/bin/env python3
"""Prepare and publish Tauri Windows updates. No private signing key is read here."""
import argparse
import base64
import datetime
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys
import tarfile
import tempfile
import tomllib
import urllib.request

BASE_URL = "https://worktrack.178.156.213.40.sslip.io/updates/windows/x86_64"
INSTALLER = "worktrack-setup.exe"
CHANNEL_URLS = {
    "production": BASE_URL,
    "staging": "https://worktrack.178.156.213.40.sslip.io/updates-staging/windows/x86_64",
}
FILES = {INSTALLER, INSTALLER + ".sig", "latest.json", "SHA256SUMS"}
MAX_INSTALLER = 512 * 1024 * 1024


def version_tuple(value):
    # V1 deliberately accepts stable releases only. No ambiguous prerelease ordering.
    if not isinstance(value, str) or not re.fullmatch(r"(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)", value):
        raise ValueError("Expected a stable major.minor.patch version")
    return tuple(map(int, value.split(".")))


def decode_box(value, prefix):
    decoded = base64.b64decode(value.strip(), validate=True).decode("utf-8")
    if not decoded.startswith(prefix):
        raise ValueError("Invalid Tauri public key or signature format")
    return decoded


def validate_public_key(value):
    lines = decode_box(value, "untrusted comment:").splitlines()
    if len(lines) != 2 or len(base64.b64decode(lines[1], validate=True)) != 42:
        raise ValueError("Expected a real Tauri public verification key")
    return value.strip()


def digest(path):
    with path.open("rb") as source:
        return hashlib.file_digest(source, "sha256").hexdigest()


def config(path, version):
    data = json.loads(path.read_text())
    version_tuple(version)
    if version_tuple(version) <= (0, 1, 1):
        raise ValueError("First updater release must be newer than legacy 0.1.1")
    if data["version"] != version:
        raise ValueError("Release input must match committed Tauri version")
    updater = data["plugins"]["updater"]
    validate_public_key(updater["pubkey"])
    if updater.get("requireSignedVersion") is not True:
        raise ValueError("requireSignedVersion must be enabled")
    if updater["endpoints"] != [BASE_URL + "/latest.json"]:
        raise ValueError("Unexpected production updater endpoint")
    if data["identifier"] != "com.worktrack.agent" or data["bundle"]["windows"]["nsis"]["installMode"] != "currentUser":
        raise ValueError("Application identity or installation scope changed")
    return data


def consistent_versions(path, version):
    agent = path.parent.parent
    cargo = tomllib.loads((path.parent / "Cargo.toml").read_text())["package"]["version"]
    package = json.loads((agent / "package.json").read_text())["version"]
    lock = json.loads((agent / "package-lock.json").read_text())
    if any(value != version for value in (cargo, package, lock["version"], lock["packages"][""]["version"])):
        raise ValueError("Tauri, Cargo, npm package and package lock versions must match")


def make_package(args):
    data = config(args.config, args.version)
    installers = list(args.bundle.glob("*-setup.exe"))
    if len(installers) != 1:
        raise ValueError("Expected exactly one signed NSIS installer")
    installer = installers[0]
    signature = Path(str(installer) + ".sig").read_text().strip()
    # Cryptographic verification happens in verify/receive, never just this parser.
    signed_version(signature, args.version)
    manifest = {
        "version": args.version,
        "notes": args.notes.read_text(encoding="utf-8"),
        "pub_date": datetime.datetime.now(datetime.timezone.utc).isoformat().replace("+00:00", "Z"),
        "platforms": {"windows-x86_64": {
            "url": f"{CHANNEL_URLS[args.channel]}/releases/{args.version}/{INSTALLER}",
            "signature": signature,
        }},
    }
    with tempfile.TemporaryDirectory() as directory:
        stage = Path(directory)
        shutil.copyfile(installer, stage / INSTALLER)
        (stage / (INSTALLER + ".sig")).write_text(signature, encoding="utf-8")
        (stage / "latest.json").write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")
        (stage / "SHA256SUMS").write_text(f"{digest(stage / INSTALLER)}  {INSTALLER}\n", encoding="utf-8")
        with tarfile.open(args.output, "w") as archive:
            for name in sorted(FILES):
                archive.add(stage / name, arcname=name)
    # Public key only, retained alongside the archive for the verification job.
    args.public_key.write_text(data["plugins"]["updater"]["pubkey"], encoding="utf-8")


def signed_version(signature, version):
    lines = decode_box(signature, "untrusted comment:").splitlines()
    if len(lines) != 4 or not lines[2].startswith("trusted comment: "):
        raise ValueError("Malformed minisign signature")
    fields = lines[2][len("trusted comment: "):].split("\t")
    if [field for field in fields if field.startswith("version:")] != ["version:" + version]:
        raise ValueError("Signature must bind the exact manifest version")
    return "\n".join(lines) + "\n"


def unpack(stream, stage):
    seen = set()
    with tarfile.open(fileobj=stream, mode="r|") as archive:
        for member in archive:
            limit = MAX_INSTALLER if member.name == INSTALLER else 128 * 1024
            if member.name not in FILES or member.name in seen or not member.isfile() or not 0 < member.size <= limit:
                raise ValueError("Unsafe, duplicate, unexpected, or oversized archive member")
            seen.add(member.name)
            with archive.extractfile(member) as source, (stage / member.name).open("xb") as target:
                shutil.copyfileobj(source, target)
    if seen != FILES:
        raise ValueError("Incomplete release archive")


def verify(stage, public_key, base_url):
    key = validate_public_key(public_key)
    manifest = json.loads((stage / "latest.json").read_text())
    version = manifest["version"]
    version_tuple(version)
    if version_tuple(version) <= (0, 1, 1):
        raise ValueError("Refusing legacy non-updater version")
    platform = manifest["platforms"]["windows-x86_64"]
    if set(manifest["platforms"]) != {"windows-x86_64"}:
        raise ValueError("Unexpected update platform")
    if platform["url"] != f"{base_url}/releases/{version}/{INSTALLER}":
        raise ValueError("Installer URL is not the expected immutable HTTPS URL")
    if not base_url.startswith("https://"):
        raise ValueError("HTTPS is required")
    signature = (stage / (INSTALLER + ".sig")).read_text().strip()
    if platform["signature"] != signature:
        raise ValueError("Manifest signature differs from installer signature")
    decoded = signed_version(signature, version)
    expected = f"{digest(stage / INSTALLER)}  {INSTALLER}\n"
    if (stage / "SHA256SUMS").read_text() != expected:
        raise ValueError("Installer checksum mismatch")
    with tempfile.TemporaryDirectory() as directory:
        key_path, sig_path = Path(directory) / "key.pub", Path(directory) / "installer.minisig"
        key_path.write_text(decode_box(key, "untrusted comment:"), encoding="utf-8")
        sig_path.write_text(decoded, encoding="utf-8")
        subprocess.run(["minisign", "-V", "-q", "-p", str(key_path), "-x", str(sig_path), "-m", str(stage / INSTALLER)], check=True)
    return manifest


def public_integrity(url, expected_hash):
    request = urllib.request.Request(url, headers={"Cache-Control": "no-cache", "Accept-Encoding": "identity"})
    with urllib.request.urlopen(request, timeout=60) as response:
        if response.geturl() != url or response.status != 200:
            raise ValueError("Unexpected public download redirect or status")
        checksum = hashlib.sha256()
        size = 0
        while chunk := response.read(1024 * 1024):
            size += len(chunk)
            if size > MAX_INSTALLER:
                raise ValueError("Oversized public download")
            checksum.update(chunk)
    if checksum.hexdigest() != expected_hash:
        raise ValueError("Public download does not match the tested artifact")


def sync_directory(path):
    descriptor = os.open(path, os.O_RDONLY)
    try:
        os.fsync(descriptor)
    finally:
        os.close(descriptor)


def promote(stage, root, manifest, public_check=public_integrity, watermark=None):
    # The caller holds the host lock across validation, publication and promotion.
    version = manifest["version"]
    current = root / "latest.json"
    if watermark is not None and watermark.exists() and version_tuple(version) < version_tuple(watermark.read_text().strip()):
        raise ValueError("Refusing rollback below previously published version")
    if current.exists() and version_tuple(version) <= version_tuple(json.loads(current.read_text())["version"]):
        raise ValueError("Refusing rollback or repeat promotion")
    releases = root / "releases"
    releases.mkdir(exist_ok=True)
    target = releases / version
    if target.exists():
        # An interrupted attempt may have installed immutable files already.
        # Resume only if every byte is identical, never overwrite a version.
        if any(not (target / name).is_file() or digest(target / name) != digest(stage / name) for name in FILES):
            raise ValueError("Immutable version already exists with different contents")
    else:
        stage.chmod(0o755)
        for name in FILES:
            (stage / name).chmod(0o644)
        os.rename(stage, target)
        # Persist immutable bytes before making discovery durable.
        for name in FILES:
            with (target / name).open("rb") as artifact:
                os.fsync(artifact.fileno())
        for directory_path in (target, releases):
            sync_directory(directory_path)
    url = manifest["platforms"]["windows-x86_64"]["url"]
    public_check(url, digest(target / INSTALLER))
    public_check(url + ".sig", digest(target / (INSTALLER + ".sig")))
    if watermark is not None:
        # Retain rollback protection even when an operator withdraws latest.json.
        watermark_temp = watermark.with_suffix(".tmp")
        with watermark_temp.open("w") as output:
            output.write(version + "\n")
            output.flush()
            os.fsync(output.fileno())
        os.replace(watermark_temp, watermark)
        sync_directory(watermark.parent)
    # Last operation changes discovery. Same filesystem rename is atomic.
    temporary = root / ".latest.json.tmp"
    with temporary.open("wb") as output:
        output.write((target / "latest.json").read_bytes())
        output.flush()
        os.fsync(output.fileno())
    temporary.chmod(0o644)
    os.replace(temporary, current)
    sync_directory(root)


def receive(args):
    import fcntl  # Host-only Linux API, not needed by Windows preparation.
    storage = args.root.resolve(strict=True)
    root = storage / "public" / "windows" / "x86_64"
    if not root.is_dir():
        raise ValueError("Host update directory has not been provisioned")
    with (storage / ".publish.lock").open("a") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        with tempfile.TemporaryDirectory(prefix=".incoming-", dir=storage) as directory:
            stage = Path(directory) / "release"
            stage.mkdir()
            unpack(sys.stdin.buffer, stage)
            manifest = verify(stage, args.public_key.read_text(), args.base_url)
            promote(stage, root, manifest, watermark=storage / "highest-version")
            print(f"Promoted {manifest['version']}")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest="command", required=True)
    preflight = commands.add_parser("config")
    preflight.add_argument("--config", type=Path, required=True)
    preflight.add_argument("--version", required=True)
    preflight.add_argument("--output", type=Path, required=True)
    package = commands.add_parser("package")
    for name in ("config", "bundle", "notes", "output", "public-key"):
        package.add_argument("--" + name, type=Path, required=True)
    package.add_argument("--version", required=True)
    check = commands.add_parser("verify")
    check.add_argument("--archive", type=Path, required=True)
    check.add_argument("--public-key", type=Path, required=True)
    for command in (preflight, package, check):
        command.add_argument("--channel", choices=CHANNEL_URLS, default="production")
    host = commands.add_parser("receive")
    host.add_argument("--root", type=Path, required=True)
    host.add_argument("--public-key", type=Path, required=True)
    host.add_argument("--base-url", default=BASE_URL)
    args = parser.parse_args()
    if args.command == "config":
        config(args.config, args.version)
        consistent_versions(args.config, args.version)
        args.output.write_text(json.dumps({
            "bundle": {"createUpdaterArtifacts": True},
            "plugins": {"updater": {"endpoints": [CHANNEL_URLS[args.channel] + "/latest.json"]}},
        }), encoding="utf-8")
    elif args.command == "package":
        make_package(args)
    elif args.command == "verify":
        with tempfile.TemporaryDirectory() as directory, args.archive.open("rb") as source:
            stage = Path(directory)
            unpack(source, stage)
            verify(stage, args.public_key.read_text(), CHANNEL_URLS[args.channel])
    else:
        receive(args)


if __name__ == "__main__":
    try:
        main()
    except (ValueError, KeyError, OSError, subprocess.CalledProcessError, tarfile.TarError) as error:
        sys.exit(f"Release refused: {error}")
