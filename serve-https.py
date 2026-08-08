#!/usr/bin/env python3
"""Serve CalamityVille over HTTPS on all interfaces for Mac + phone LAN preview."""
from http.server import ThreadingHTTPServer, SimpleHTTPRequestHandler
from pathlib import Path
import ssl
import sys

ROOT = Path(__file__).resolve().parent
DEFAULT_PORT = 8765
CERT = ROOT / ".local-cert.pem"
KEY = ROOT / ".local-key.pem"


class Handler(SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(ROOT), **kwargs)

    def end_headers(self):
        path = (self.path or "").split("?", 1)[0].lower()
        if path.endswith(
            (
                ".png",
                ".jpg",
                ".jpeg",
                ".webp",
                ".ico",
                ".webmanifest",
                ".svg",
            )
        ) or path.endswith("manifest.webmanifest"):
            # Globe textures change in place during polish — avoid sticky local cache.
            if "normal" in path or path.rstrip("/").endswith(
                (
                    "moon-2k.jpg",
                    "moon-8k.jpg",
                    "sun-2k.jpg",
                    "sun-8k.jpg",
                    "stars-8k.jpg",
                )
            ):
                self.send_header("Cache-Control", "no-cache, must-revalidate")
            else:
                self.send_header("Cache-Control", "public, max-age=86400")
        else:
            self.send_header("Cache-Control", "no-cache, no-store, must-revalidate")
        super().end_headers()

    def log_message(self, fmt, *args):
        sys.stderr.write("%s - %s\n" % (self.address_string(), fmt % args))


def _lan_ips():
    ips = []
    try:
        import socket

        hostname = socket.gethostname()
        for info in socket.getaddrinfo(hostname, None, socket.AF_INET):
            ip = info[4][0]
            if ip and not ip.startswith("127.") and ip not in ips:
                ips.append(ip)
    except Exception:
        pass
    # Prefer en0 / en1 when available (common Mac Wi‑Fi / Ethernet)
    try:
        import subprocess

        for iface in ("en0", "en1", "en2"):
            out = subprocess.check_output(
                ["ipconfig", "getifaddr", iface], stderr=subprocess.DEVNULL, text=True
            ).strip()
            if out and out not in ips:
                ips.insert(0, out)
    except Exception:
        pass
    return ips


def main():
    mode = "https"
    argv = [a for a in sys.argv[1:] if a]
    port = DEFAULT_PORT
    if argv and argv[0] in ("--http", "http"):
        mode = "http"
        argv = argv[1:]
    if argv:
        port = int(argv[0])

    httpd = ThreadingHTTPServer(("0.0.0.0", port), Handler)
    lan = _lan_ips()
    lan_hint = lan[0] if lan else "<this-mac-ip>"

    if mode == "https":
        if not CERT.exists() or not KEY.exists():
            print("Missing .local-cert.pem / .local-key.pem", file=sys.stderr)
            print("Generate with:", file=sys.stderr)
            print(
                '  openssl req -x509 -newkey rsa:2048 -nodes '
                '-keyout .local-key.pem -out .local-cert.pem -days 825 '
                '-subj "/CN=localhost"',
                file=sys.stderr,
            )
            sys.exit(1)
        ctx = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
        ctx.load_cert_chain(certfile=str(CERT), keyfile=str(KEY))
        httpd.socket = ctx.wrap_socket(httpd.socket, server_side=True)
        print("CalamityVille HTTPS", flush=True)
        print(f"  Mac:    https://127.0.0.1:{port}/", flush=True)
        for ip in lan:
            print(f"  device: https://{ip}:{port}/", flush=True)
        if not lan:
            print(f"  device: https://{lan_hint}:{port}/", flush=True)
        print("  Self-signed: Advanced → proceed on first visit.", flush=True)
    else:
        print("CalamityVille HTTP", flush=True)
        print(f"  Mac:    http://127.0.0.1:{port}/", flush=True)
        for ip in lan:
            print(f"  device: http://{ip}:{port}/", flush=True)

    print(f"  Dir:    {ROOT}", flush=True)
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        print("\nstopped")


if __name__ == "__main__":
    main()
