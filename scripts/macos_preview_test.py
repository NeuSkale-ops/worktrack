import copy
import json
from pathlib import Path
import tempfile
import unittest

from macos_preview import OVERLAYS, ROOT, manifest, validate


class MacPreviewConfigTests(unittest.TestCase):
    def setUp(self):
        self.config = json.loads((ROOT / OVERLAYS[0]).read_text())

    def test_both_overlays_disable_updater(self):
        for path in OVERLAYS:
            with self.subTest(path=path):
                validate(json.loads((ROOT / path).read_text()))

    def test_missing_explicit_settings_fail_closed(self):
        for path in ("plugins", "bundle"):
            config = copy.deepcopy(self.config)
            del config[path]
            with self.subTest(path=path), self.assertRaises(ValueError):
                validate(config)

    def test_unsafe_overrides_fail_closed(self):
        cases = [
            ("plugins", "updater", "endpoints", ["https://example.com/updates/windows/x86_64/latest.json"]),
            ("plugins", "updater", "pubkey", "a-key"),
            ("bundle", None, "createUpdaterArtifacts", True),
            ("bundle", "macOS", "signingIdentity", "Developer ID Application: Placeholder"),
            ("bundle", None, "targets", ["nsis"]),
        ]
        for section, nested, key, value in cases:
            config = copy.deepcopy(self.config)
            target = config[section] if nested is None else config[section][nested]
            target[key] = value
            with self.subTest(key=key), self.assertRaises(ValueError):
                validate(config)

    def test_manifest_binds_exact_bytes_and_canonical_path(self):
        with tempfile.TemporaryDirectory() as directory:
            dmg = Path(directory) / "WorkTrack_0.1.7_aarch64.dmg"
            dmg.write_bytes(b"abc")
            self.assertEqual(manifest(dmg, "0.1.7"), {
                "version": "0.1.7",
                "architecture": "aarch64",
                "url": "/downloads/macos/0.1.7/WorkTrack_0.1.7_aarch64.dmg",
                "sha256": "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
                "signing": "ad-hoc",
                "notarized": False,
            })

    def test_manifest_rejects_version_or_filename_mismatch(self):
        for version in ("../1.2.3", "1.2.3-preview", "01.2.3", "1.2.3"):
            with self.subTest(version=version), self.assertRaises(ValueError):
                manifest(Path("wrong.dmg"), version)
