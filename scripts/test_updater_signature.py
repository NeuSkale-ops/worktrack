"""Real minisign CLI boundary checks using public upstream test vectors, not secrets."""
import base64
import json
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest

import updater_release as release

# Public throwaway vectors from tauri-plugin-updater 2.14.0 src/updater.rs,
# offline_tests. Payload is the four bytes b"test". No private key is included.
PUBLIC_KEY = "untrusted comment: minisign public key: A49EF4746FA6E6D7\nRWTX5qZvdPSepDGWg2bz8n6ArQnBMwgQK1geVosorcbLzcunD+KJ+cYe"
SIGNATURE = "untrusted comment: signature from tauri secret key\nRUTX5qZvdPSepPF2zsjvP/L/TQtBLRnWRvaq+4omK1UEugtQp/USrGiI1v762sDy3id3aor7bRC9ETyeot6lMHHrWoZ5hjUM1Qc=\ntrusted comment: timestamp:1791649051\tfile:payload\tversion:2.0.0\nDDq2CLOEl5cQmC2eJRHlnZPVViOZsu1CjpPKQoei4A/XBfkDqGO0B+QMrcrHgEQ5qV3mne75tdFWhJpqUXh9AA=="
WRONG_KEY = "untrusted comment: minisign public key E7620F1842B4E81F\nRWQf6LRCGA9i53mlYecO4IzT51TGPpvWucNSCh1CBM0QTaLn73Y7GFO3"


def encoded(value):
    return base64.b64encode(value.encode()).decode()


@unittest.skipUnless(shutil.which("minisign"), "Install minisign to exercise actual signature verification")
class SignatureBoundaryTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.stage = Path(self.temporary.name)
        self.payload = self.stage / release.INSTALLER
        self.payload.write_bytes(b"test")
        self.manifest = {"version": "2.0.0", "platforms": {"windows-x86_64": {
            "url": f"{release.BASE_URL}/releases/2.0.0/{release.INSTALLER}",
            "signature": encoded(SIGNATURE),
        }}}
        self.persist()

    def persist(self):
        (self.stage / "latest.json").write_text(json.dumps(self.manifest))
        (self.stage / (release.INSTALLER + ".sig")).write_text(self.manifest["platforms"]["windows-x86_64"]["signature"])
        (self.stage / "SHA256SUMS").write_text(f"{release.digest(self.payload)}  {release.INSTALLER}\n")

    def test_actual_tauri_signature_is_accepted(self):
        verified = release.verify(self.stage, encoded(PUBLIC_KEY), release.BASE_URL)
        self.assertEqual(verified["version"], "2.0.0")

    def test_modified_payload_is_rejected_even_with_updated_checksum(self):
        self.payload.write_bytes(b"tampered")
        self.persist()
        with self.assertRaises(subprocess.CalledProcessError):
            release.verify(self.stage, encoded(PUBLIC_KEY), release.BASE_URL)

    def test_other_valid_public_key_is_rejected(self):
        with self.assertRaises(subprocess.CalledProcessError):
            release.verify(self.stage, encoded(WRONG_KEY), release.BASE_URL)

    def test_changing_manifest_and_trusted_version_does_not_forge_signature(self):
        platform = self.manifest["platforms"]["windows-x86_64"]
        self.manifest["version"] = "2.0.1"
        platform["url"] = platform["url"].replace("2.0.0", "2.0.1")
        platform["signature"] = encoded(SIGNATURE.replace("version:2.0.0", "version:2.0.1"))
        self.persist()
        with self.assertRaises(subprocess.CalledProcessError):
            release.verify(self.stage, encoded(PUBLIC_KEY), release.BASE_URL)


if __name__ == "__main__":
    unittest.main()
