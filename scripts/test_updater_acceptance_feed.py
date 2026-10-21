"""Local tests for the runner-only feed, not Windows upgrade acceptance."""
import http.client
import json
from pathlib import Path
import shutil
import ssl
import subprocess
import tempfile
import threading
import unittest
import urllib.error
import urllib.request

import updater_acceptance_feed as feed
import updater_release as release
from test_updater_signature import SIGNATURE, encoded


@unittest.skipUnless(shutil.which("openssl"), "HTTPS fixture needs openssl")
class AcceptanceFeedTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.temporary = tempfile.TemporaryDirectory()
        cls.directory = Path(cls.temporary.name)
        cls.cert = cls.directory / "cert.pem"
        key = cls.directory / "key.pem"
        subprocess.run([
            "openssl", "req", "-x509", "-newkey", "rsa:2048", "-nodes",
            "-keyout", str(key), "-out", str(cls.cert), "-days", "1",
            "-subj", "/CN=localhost", "-addext", "subjectAltName=DNS:localhost",
        ], check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        cls.server_context = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
        cls.server_context.load_cert_chain(cls.cert, key)
        cls.client_context = ssl.create_default_context(cafile=str(cls.cert))

    @classmethod
    def tearDownClass(cls):
        cls.temporary.cleanup()

    def setUp(self):
        self.root = Path(tempfile.mkdtemp(dir=self.directory))
        artifacts = self.root / "artifacts"
        artifacts.mkdir()
        self.payload = b"MZsigned-candidate-fixture"
        (artifacts / release.INSTALLER).write_bytes(self.payload)
        self.path = "/updates/windows/x86_64/releases/0.1.6/worktrack-setup.exe"
        self.manifest = {"version": "0.1.6", "platforms": {"windows-x86_64": {
            "url": "https://worktrack.178.156.213.40.sslip.io" + self.path,
            "signature": "fixture",
        }}}
        self.server = feed.Feed(("127.0.0.1", 0), self.root, artifacts, self.manifest)
        self.server.socket = self.server_context.wrap_socket(self.server.socket, server_side=True)
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()
        self.addCleanup(self.server.server_close)
        self.addCleanup(self.server.shutdown)
        self.base = f"https://localhost:{self.server.server_port}"
        self.opener = urllib.request.build_opener(
            urllib.request.ProxyHandler({}), urllib.request.HTTPSHandler(context=self.client_context))

    def get(self, path):
        return self.opener.open(self.base + path, timeout=3)

    def mode(self, value):
        (self.root / "mode").write_text(value, encoding="utf-8")

    def test_exact_manifest_and_installer_over_verified_tls(self):
        with self.get("/updates/windows/x86_64/latest.json") as response:
            self.assertEqual(json.load(response), self.manifest)
            self.assertEqual(response.headers["Cache-Control"], "no-store")
        with self.get(self.path) as response:
            self.assertEqual(response.read(), self.payload)
        with self.assertRaises(urllib.error.HTTPError) as caught:
            self.get("/updates/windows/x86_64/.private")
        self.assertEqual(caught.exception.code, 404)

    def test_missing_and_invalid_manifest_are_distinct_failures(self):
        self.mode("missing")
        with self.assertRaises(urllib.error.HTTPError) as caught:
            self.get("/updates/windows/x86_64/latest.json")
        self.assertEqual(caught.exception.code, 404)
        self.mode("invalid")
        with self.get("/updates/windows/x86_64/latest.json") as response:
            with self.assertRaises(json.JSONDecodeError):
                json.load(response)

    def test_tampering_wrong_key_and_interrupted_download_reach_client(self):
        self.mode("tampered")
        with self.get(self.path) as response:
            self.assertNotEqual(response.read(), self.payload)
        self.mode("wrong-key")
        with self.get("/updates/windows/x86_64/latest.json") as response:
            signature = json.load(response)["platforms"]["windows-x86_64"]["signature"]
        self.assertEqual(signature, encoded(SIGNATURE))
        self.mode("interrupted")
        with self.get(self.path) as response:
            with self.assertRaises(http.client.IncompleteRead):
                response.read()

    def test_offline_api_never_proxies_or_logs_credentials(self):
        request = urllib.request.Request(self.base + "/api/agent-logs", data=b"private body",
                                         headers={"Authorization": "Bearer private credential"})
        with self.assertRaises(urllib.error.HTTPError) as caught:
            self.opener.open(request, timeout=3)
        self.assertEqual(caught.exception.code, 503)
        log = (self.root / "access.jsonl").read_text()
        self.assertNotIn("private", log)
        self.assertEqual(json.loads(log)["path"], "/api/agent-logs")

    def test_future_stall_announces_newer_version_but_keeps_candidate_bytes_path(self):
        self.mode("future-stalled")
        with self.get("/updates/windows/x86_64/latest.json") as response:
            manifest = json.load(response)
        self.assertEqual(manifest["version"], "0.1.7")
        self.assertEqual(manifest["platforms"], self.manifest["platforms"])


if __name__ == "__main__":
    unittest.main()
