"""Release safety checks. Fixtures are synthetic, never real signing keys."""
import base64
import io
import json
import os
from pathlib import Path
import subprocess
import sys
import tarfile
import tempfile
import unittest
from unittest.mock import patch

import updater_release as release


def signature(version="0.1.2"):
    return base64.b64encode(("untrusted comment: synthetic test signature\nAA==\n"
                            f"trusted comment: timestamp:0\tfile:test.exe\tversion:{version}\nAA==\n").encode()).decode()


class ValidationTests(unittest.TestCase):
    def test_stable_versions_only(self):
        for value in ("../1.2.3", "01.2.3", "1.2.3-rc.1", "v1.2.3", "1.2", "1.2.3\n"):
            with self.subTest(value=value), self.assertRaises(ValueError):
                release.version_tuple(value)
        self.assertGreater(release.version_tuple("0.10.0"), release.version_tuple("0.9.9"))

    def test_missing_key_and_wrong_version_fail_closed(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "tauri.conf.json"
            path.write_text(json.dumps({"version": "0.1.2", "plugins": {"updater": {"pubkey": ""}}}))
            with self.assertRaisesRegex(ValueError, "newer than legacy"):
                release.config(path, "0.1.1")
            with self.assertRaisesRegex(ValueError, "match committed"):
                release.config(path, "0.1.3")
            with self.assertRaises(ValueError):
                release.config(path, "0.1.2")
            with self.assertRaises(ValueError):
                release.validate_public_key("")

    def test_committed_package_versions_must_match(self):
        with tempfile.TemporaryDirectory() as directory:
            agent = Path(directory)
            tauri = agent / "src-tauri"
            tauri.mkdir()
            (tauri / "Cargo.toml").write_text('[package]\nversion = "0.1.2"\n')
            (agent / "package.json").write_text('{"version":"0.1.2"}')
            lock = {"version": "0.1.2", "packages": {"": {"version": "0.1.2"}}}
            (agent / "package-lock.json").write_text(json.dumps(lock))
            release.consistent_versions(tauri / "tauri.conf.json", "0.1.2")
            lock["packages"][""]["version"] = "0.1.1"
            (agent / "package-lock.json").write_text(json.dumps(lock))
            with self.assertRaisesRegex(ValueError, "versions must match"):
                release.consistent_versions(tauri / "tauri.conf.json", "0.1.2")

    def test_signature_version_is_bound(self):
        self.assertIn("version:0.1.2", release.signed_version(signature(), "0.1.2"))
        with self.assertRaises(ValueError):
            release.signed_version(signature(), "0.1.3")

    def test_signature_requires_crypto_verification(self):
        with tempfile.TemporaryDirectory() as directory:
            stage = Path(directory)
            (stage / release.INSTALLER).write_bytes(b"synthetic executable")
            (stage / (release.INSTALLER + ".sig")).write_text(signature())
            manifest = {"version": "0.1.2", "platforms": {"windows-x86_64": {
                "url": f"{release.BASE_URL}/releases/0.1.2/{release.INSTALLER}", "signature": signature()}}}
            (stage / "latest.json").write_text(json.dumps(manifest))
            (stage / "SHA256SUMS").write_text(f"{release.digest(stage / release.INSTALLER)}  {release.INSTALLER}\n")
            # Deliberately invalid public fixture, just for exercising process wiring.
            public_key = base64.b64encode(("untrusted comment: synthetic public fixture\n" + base64.b64encode(bytes(42)).decode() + "\n").encode()).decode()
            with patch.object(release.subprocess, "run", side_effect=subprocess.CalledProcessError(1, "minisign")) as verify:
                with self.assertRaises(subprocess.CalledProcessError):
                    release.verify(stage, public_key, release.BASE_URL)
                self.assertEqual(verify.call_args.args[0][:3], ["minisign", "-V", "-q"])
            (stage / release.INSTALLER).write_bytes(b"tampered")
            with self.assertRaisesRegex(ValueError, "checksum"):
                release.verify(stage, public_key, release.BASE_URL)

    def test_unsafe_archives_rejected(self):
        for name, kind in (("../escape", tarfile.REGTYPE), (release.INSTALLER, tarfile.SYMTYPE)):
            with self.subTest(name=name), tempfile.TemporaryDirectory() as directory:
                stream = io.BytesIO()
                with tarfile.open(fileobj=stream, mode="w") as archive:
                    member = tarfile.TarInfo(name)
                    member.type = kind
                    member.size = 1
                    archive.addfile(member, io.BytesIO(b"x"))
                stream.seek(0)
                with self.assertRaises(ValueError):
                    release.unpack(stream, Path(directory))
        with tempfile.TemporaryDirectory() as directory, self.assertRaisesRegex(ValueError, "Incomplete"):
            stream = io.BytesIO()
            with tarfile.open(fileobj=stream, mode="w"):
                pass
            stream.seek(0)
            release.unpack(stream, Path(directory))


@unittest.skipIf(os.name == "nt", "Publication uses the Linux host filesystem APIs")
class PublicationTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.directory = Path(self.temporary.name)
        self.root = self.directory / "public"
        self.root.mkdir()
        self.watermark = self.directory / "highest-version"

    def stage(self, version="0.1.2"):
        directory = Path(tempfile.mkdtemp(dir=self.directory))
        manifest = {"version": version, "platforms": {"windows-x86_64": {
            "url": f"{release.BASE_URL}/releases/{version}/{release.INSTALLER}", "signature": signature(version)}}}
        (directory / "latest.json").write_text(json.dumps(manifest))
        (directory / release.INSTALLER).write_bytes(b"synthetic installer")
        (directory / (release.INSTALLER + ".sig")).write_text(signature(version))
        (directory / "SHA256SUMS").write_text(f"{release.digest(directory / release.INSTALLER)}  {release.INSTALLER}\n")
        return directory, manifest

    def promote(self, directory, manifest, check=lambda url, checksum: None):
        release.promote(directory, self.root, manifest, check, self.watermark)

    def test_public_downloads_checked_before_manifest_appears(self):
        stage, manifest = self.stage()
        checks = []

        def inspect(url, checksum):
            self.assertFalse((self.root / "latest.json").exists())
            name = url.rsplit("/", 1)[1]
            self.assertEqual(release.digest(self.root / "releases/0.1.2" / name), checksum)
            checks.append(url)

        self.promote(stage, manifest, inspect)
        self.assertEqual(len(checks), 2)
        self.assertEqual(json.loads((self.root / "latest.json").read_text()), manifest)
        self.assertEqual(self.watermark.read_text(), "0.1.2\n")

    def test_failed_public_download_keeps_previous_manifest(self):
        old = b'{"version":"0.1.1"}'
        (self.root / "latest.json").write_bytes(old)
        stage, manifest = self.stage()
        with self.assertRaises(ValueError):
            self.promote(stage, manifest, lambda *_: (_ for _ in ()).throw(ValueError("bad public bytes")))
        self.assertEqual((self.root / "latest.json").read_bytes(), old)
        self.assertFalse(self.watermark.exists())
        # An identical interrupted release can resume without replacing immutable files.
        stage, manifest = self.stage()
        self.promote(stage, manifest)
        self.assertEqual(json.loads((self.root / "latest.json").read_text()), manifest)

    def test_repeat_and_rollback_rejected_even_after_withdrawal(self):
        stage, manifest = self.stage("0.2.0")
        self.promote(stage, manifest)
        for version in ("0.2.0", "0.1.9"):
            stage, manifest = self.stage(version)
            with self.assertRaisesRegex(ValueError, "rollback|repeat"):
                self.promote(stage, manifest)
        (self.root / "latest.json").unlink()
        stage, manifest = self.stage("0.1.9")
        with self.assertRaisesRegex(ValueError, "rollback"):
            self.promote(stage, manifest)

    def test_immutable_installer_cannot_be_replaced(self):
        stage, manifest = self.stage()
        with self.assertRaises(ValueError):
            self.promote(stage, manifest, lambda *_: (_ for _ in ()).throw(ValueError("offline")))
        stage, manifest = self.stage()
        (stage / release.INSTALLER).write_bytes(b"different installer")
        with self.assertRaisesRegex(ValueError, "Immutable"):
            self.promote(stage, manifest)

    def test_crash_after_watermark_can_resume_exact_release(self):
        stage, manifest = self.stage()
        real_replace = release.os.replace

        def fail_manifest(source, target):
            if target == self.root / "latest.json":
                raise OSError("simulated interruption")
            real_replace(source, target)

        with patch.object(release.os, "replace", side_effect=fail_manifest):
            with self.assertRaisesRegex(OSError, "simulated interruption"):
                self.promote(stage, manifest)
        self.assertEqual(self.watermark.read_text(), "0.1.2\n")
        self.assertFalse((self.root / "latest.json").exists())
        stage, manifest = self.stage()
        self.promote(stage, manifest)
        self.assertEqual(json.loads((self.root / "latest.json").read_text()), manifest)

    def test_receiver_rejects_overlapping_publish(self):
        import fcntl
        storage = self.directory / "host"
        (storage / "public/windows/x86_64").mkdir(parents=True)
        with (storage / ".publish.lock").open("a") as lock:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
            result = subprocess.run([sys.executable, str(Path(release.__file__)), "receive", "--root", str(storage),
                                     "--public-key", str(self.directory / "unused-key")], input=b"", capture_output=True)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn(b"Release refused", result.stderr)
        self.assertFalse((storage / "public/windows/x86_64/latest.json").exists())


if __name__ == "__main__":
    unittest.main()
