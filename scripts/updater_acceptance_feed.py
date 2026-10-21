#!/usr/bin/env python3
"""Runner-local HTTPS delivery for real installed Windows updater acceptance.

Never deployed or imported by the application. Uses actual signed release bytes,
with explicit failure modes, on a disposable Windows runner only.
"""
import argparse
import base64
import copy
import http.server
import json
from pathlib import Path
import socket
import ssl
import threading
import time
from urllib.parse import urlsplit

import updater_release as release

# Public upstream throwaway signature. Its key is not WorkTrack's trust anchor.
OTHER_SIGNATURE = base64.b64encode((
    "untrusted comment: signature from tauri secret key\n"
    "RUTX5qZvdPSepPF2zsjvP/L/TQtBLRnWRvaq+4omK1UEugtQp/USrGiI1v762sDy3id3aor7bRC9ETyeot6lMHHrWoZ5hjUM1Qc=\n"
    "trusted comment: timestamp:1791649051\tfile:payload\tversion:2.0.0\n"
    "DDq2CLOEl5cQmC2eJRHlnZPVViOZsu1CjpPKQoei4A/XBfkDqGO0B+QMrcrHgEQ5qV3mne75tdFWhJpqUXh9AA=="
).encode()).decode()


class Feed(http.server.ThreadingHTTPServer):
    daemon_threads = True

    def __init__(self, address, root, artifacts, manifest):
        self.root = root
        self.artifacts = artifacts
        self.manifest = manifest
        self.installer_path = urlsplit(manifest["platforms"]["windows-x86_64"]["url"]).path
        self.log_lock = threading.Lock()
        super().__init__(address, Handler)

    def mode(self):
        path = self.root / "mode"
        return path.read_text(encoding="utf-8-sig").strip() if path.exists() else "valid"


class Handler(http.server.BaseHTTPRequestHandler):
    def log_message(self, *_):
        pass  # Do not log headers, authentication tokens or request bodies.

    def respond(self, status, body=b"", content_type="application/octet-stream", mode=None):
        # Empty responses can complete as soon as headers arrive, including on Windows.
        with self.server.log_lock:
            with (self.server.root / "access.jsonl").open("a", encoding="utf-8") as log:
                log.write(json.dumps({"path": self.path, "status": status, "mode": mode}) + "\n")
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("Connection", "close")
        self.end_headers()
        self.close_connection = True
        return body

    def do_POST(self):
        # Offline fixture credentials must never reach a real API.
        self.wfile.write(self.respond(503))

    def do_GET(self):
        mode = self.server.mode()
        path = urlsplit(self.path).path
        if path.startswith("/api/"):
            self.wfile.write(self.respond(503, mode=mode))
            return
        if path == "/updates/windows/x86_64/latest.json":
            if mode == "missing":
                self.wfile.write(self.respond(404, mode=mode))
                return
            if mode == "invalid":
                body = b'{"version":'
            else:
                manifest = copy.deepcopy(self.server.manifest)
                if mode == "wrong-key":
                    manifest["platforms"]["windows-x86_64"]["signature"] = OTHER_SIGNATURE
                if mode == "future-stalled":
                    major, minor, patch = release.version_tuple(manifest["version"])
                    manifest["version"] = f"{major}.{minor}.{patch + 1}"
                body = json.dumps(manifest).encode()
            self.wfile.write(self.respond(200, body, "application/json", mode))
            return
        if path == self.server.installer_path:
            body = (self.server.artifacts / release.INSTALLER).read_bytes()
            if mode == "tampered":
                body = bytes([body[0] ^ 1]) + body[1:]
            self.respond(200, body, mode=mode)
            if mode == "future-stalled":
                # The new installed application's actual ten-minute timeout must fire.
                time.sleep(700)
            elif mode == "interrupted":
                self.wfile.write(body[: max(1, len(body) // 2)])
                self.wfile.flush()
                self.connection.shutdown(socket.SHUT_RDWR)
                return
            self.wfile.write(body)
            return
        self.wfile.write(self.respond(404, mode=mode))


def prepare(archive, root):
    root.mkdir(parents=True, exist_ok=True)
    artifacts = root / "artifacts"
    artifacts.mkdir()
    with archive.open("rb") as source:
        release.unpack(source, artifacts)
    manifest = json.loads((artifacts / "latest.json").read_text())
    version = manifest["version"]
    release.version_tuple(version)
    expected = f"{release.BASE_URL}/releases/{version}/{release.INSTALLER}"
    if manifest["platforms"]["windows-x86_64"]["url"] != expected:
        raise ValueError("Acceptance requires an exact production-channel candidate URL")
    return artifacts, manifest


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--archive", type=Path, required=True)
    parser.add_argument("--root", type=Path, required=True)
    parser.add_argument("--cert", type=Path, required=True, help="Disposable runner certificate and private key PEM")
    parser.add_argument("--port", type=int, default=443)
    args = parser.parse_args()
    artifacts, manifest = prepare(args.archive, args.root)
    context = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
    context.minimum_version = ssl.TLSVersion.TLSv1_2
    context.load_cert_chain(args.cert)
    with Feed(("127.0.0.1", args.port), args.root, artifacts, manifest) as server:
        server.socket = context.wrap_socket(server.socket, server_side=True)
        (args.root / "ready.json").write_text(json.dumps({"version": manifest["version"], "port": server.server_port}))
        server.serve_forever()


if __name__ == "__main__":
    main()
