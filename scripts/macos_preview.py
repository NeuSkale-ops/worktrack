"""Fail closed when either Mac preview overlay enables updater or publisher signing."""

import argparse
import hashlib
import json
import re
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
OVERLAYS = ("agent/src-tauri/tauri.macos.conf.json", "deploy/macos-preview.json")


def validate(config):
    updater = config.get("plugins", {}).get("updater", {})
    bundle = config.get("bundle", {})
    if updater.get("pubkey") != "" or updater.get("endpoints") != []:
        raise ValueError("Mac previews must explicitly clear updater key and endpoints")
    if bundle.get("createUpdaterArtifacts") is not False:
        raise ValueError("Mac previews must disable updater artifacts")
    if bundle.get("macOS", {}).get("signingIdentity") != "-":
        raise ValueError("Mac previews must use explicitly ad-hoc signing")
    if bundle.get("targets") != ["app", "dmg"]:
        raise ValueError("Mac previews must build app and DMG, never Windows installers")


def manifest(dmg, version):
    if not re.fullmatch(r"(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)", version):
        raise ValueError("Mac download version must be stable semver")
    if dmg.name != f"WorkTrack_{version}_aarch64.dmg":
        raise ValueError("Mac preview DMG filename must match its version and architecture")
    return {
        "version": version,
        "architecture": "aarch64",
        "url": f"/downloads/macos/{version}/{dmg.name}",
        "sha256": hashlib.sha256(dmg.read_bytes()).hexdigest(),
        "signing": "ad-hoc",
        "notarized": False,
    }


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--dmg", type=Path)
    parser.add_argument("--manifest", type=Path)
    args = parser.parse_args()
    if bool(args.dmg) != bool(args.manifest):
        parser.error("--dmg and --manifest must be provided together")
    for path in OVERLAYS:
        validate(json.loads((ROOT / path).read_text()))
        print(f"{path}: ad-hoc preview, updater disabled")
    if args.dmg:
        version = json.loads((ROOT / "agent/src-tauri/tauri.conf.json").read_text())["version"]
        args.manifest.write_text(json.dumps(manifest(args.dmg, version), indent=2) + "\n")
