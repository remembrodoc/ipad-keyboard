#!/usr/bin/env python3
"""PadKeys server – turns an iPad (or any phone/tablet browser) into a
Wi-Fi keyboard for this Linux machine.

Pure standard library + python3-evdev. Run:  ./run.sh   (or python3 server.py)
"""

import argparse
import base64
import hashlib
import hmac
import json
import mimetypes
import os
import secrets
import socket
import struct
import subprocess
import sys
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlparse

from injector import VirtualKeyboard

ROOT = Path(__file__).resolve().parent
STATIC = ROOT / "static"
CONFIG_DIR = Path(os.environ.get("XDG_CONFIG_HOME", Path.home() / ".config")) / "padkeys"
PIN_FILE = CONFIG_DIR / "pin"
WS_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11"
MAX_FRAME = 64 * 1024

KEYBOARD: VirtualKeyboard = None  # created in main()
PIN = ""


# ----------------------------------------------------------------------------
# Helpers
# ----------------------------------------------------------------------------
def load_pin(regenerate=False):
    CONFIG_DIR.mkdir(parents=True, exist_ok=True)
    if PIN_FILE.exists() and not regenerate:
        pin = PIN_FILE.read_text().strip()
        if pin.isdigit() and len(pin) == 6:
            return pin
    pin = f"{secrets.randbelow(10**6):06d}"
    PIN_FILE.write_text(pin)
    PIN_FILE.chmod(0o600)
    return pin


def lan_ip():
    s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    try:
        s.connect(("8.8.8.8", 80))  # no packets sent; just picks the route
        return s.getsockname()[0]
    except OSError:
        return "127.0.0.1"
    finally:
        s.close()


def all_ips():
    ips = []
    try:
        res = subprocess.run(["ip", "-4", "addr", "show"], capture_output=True, text=True, timeout=2)
        if res.returncode == 0:
            for line in res.stdout.splitlines():
                line = line.strip()
                if line.startswith("inet ") and not line.startswith("inet 127."):
                    ip = line.split()[1].split("/")[0]
                    if ip not in ips:
                        ips.append(ip)
    except Exception:
        pass
    if not ips:
        ips.append(lan_ip())
    return ips


CLIP_HELPER = str(ROOT / "clip.py")


def get_laptop_clipboard():
    """Read the laptop's clipboard text via the GTK helper (no xclip needed)."""
    try:
        p = subprocess.run([sys.executable, CLIP_HELPER, "get"], capture_output=True,
                           text=True, timeout=3)
        return p.stdout if p.returncode == 0 else ""
    except Exception as exc:
        print(f"  ! clipboard read failed: {exc}")
        return ""


def set_laptop_clipboard(text):
    try:
        p = subprocess.run([sys.executable, CLIP_HELPER, "set"], input=text, text=True,
                           capture_output=True, timeout=3)
        return p.returncode == 0
    except Exception as exc:
        print(f"  ! clipboard write failed: {exc}")
        return False


def handle_message(ws_wfile, msg):
    """Apply one JSON message from the client to the virtual keyboard / mouse."""
    t = msg.get("t")
    if t == "text":
        KEYBOARD.type_text(str(msg.get("v", ""))[:4000])
    elif t == "bs":
        KEYBOARD.backspace(int(msg.get("n", 1)))
    elif t == "key":
        mods = [m for m in msg.get("m", []) if isinstance(m, str)]
        KEYBOARD.press(str(msg.get("k", "")), mods)
    elif t == "move":
        KEYBOARD.move_mouse(msg.get("dx", 0), msg.get("dy", 0))
    elif t == "click":
        KEYBOARD.click_mouse(msg.get("b", "left"))
    elif t == "scroll":
        KEYBOARD.scroll_mouse(msg.get("d", 0))
    elif t == "btn":
        KEYBOARD.button_mouse(msg.get("b", "left"), bool(msg.get("down")))
    elif t == "hscroll":
        KEYBOARD.hscroll_mouse(msg.get("d", 0))
    elif t == "copy_from_laptop":
        ws_send(ws_wfile, json.dumps({"t": "clipboard_data", "v": get_laptop_clipboard()}))
    elif t == "set_laptop_clipboard":
        set_laptop_clipboard(str(msg.get("v", ""))[:100000])
    elif t == "paste_to_laptop":
        text = str(msg.get("v", ""))[:20000]
        set_laptop_clipboard(text)
        KEYBOARD.type_text(text)



# ----------------------------------------------------------------------------
# Minimal RFC 6455 WebSocket
# ----------------------------------------------------------------------------
def ws_read_frame(rfile):
    head = rfile.read(2)
    if len(head) < 2:
        return None, None
    b1, b2 = head
    opcode, masked, length = b1 & 0x0F, b2 & 0x80, b2 & 0x7F
    if length == 126:
        length = struct.unpack(">H", rfile.read(2))[0]
    elif length == 127:
        length = struct.unpack(">Q", rfile.read(8))[0]
    if length > MAX_FRAME or not masked:
        return 0x8, b""
    mask = rfile.read(4)
    data = bytearray(rfile.read(length))
    for i in range(len(data)):
        data[i] ^= mask[i % 4]
    return opcode, bytes(data)


def ws_send(wfile, payload, opcode=0x1):
    if isinstance(payload, str):
        payload = payload.encode()
    n = len(payload)
    if n < 126:
        header = struct.pack(">BB", 0x80 | opcode, n)
    elif n < 65536:
        header = struct.pack(">BBH", 0x80 | opcode, 126, n)
    else:
        header = struct.pack(">BBQ", 0x80 | opcode, 127, n)
    wfile.write(header + payload)
    wfile.flush()


# ----------------------------------------------------------------------------
# HTTP handler
# ----------------------------------------------------------------------------
class Handler(BaseHTTPRequestHandler):
    server_version = "PadKeys/1.0"
    protocol_version = "HTTP/1.1"  # Safari needs 1.1 for the WebSocket upgrade

    def log_message(self, fmt, *args):  # keep the terminal tidy
        pass

    def do_GET(self):
        url = urlparse(self.path)
        if url.path == "/ws":
            return self.websocket()
        if url.path == "/api/info":
            return self.send_json({"host": socket.gethostname()})
        self.serve_static(url.path)

    # -- static files --------------------------------------------------------
    def serve_static(self, path):
        rel = "index.html" if path in ("", "/") else path.lstrip("/")
        file = (STATIC / rel).resolve()
        if STATIC not in file.parents or not file.is_file():
            self.send_error(404)
            return
        body = file.read_bytes()
        ctype = mimetypes.guess_type(file.name)[0] or "application/octet-stream"
        if file.suffix == ".webmanifest":
            ctype = "application/manifest+json"
        self.send_response(200)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-cache")
        self.end_headers()
        self.wfile.write(body)

    def send_json(self, obj, code=200):
        body = json.dumps(obj).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    # -- websocket -----------------------------------------------------------
    def websocket(self):
        key = self.headers.get("Sec-WebSocket-Key")
        if not key or self.headers.get("Upgrade", "").lower() != "websocket":
            self.send_error(400)
            return

        accept = base64.b64encode(hashlib.sha1((key + WS_GUID).encode()).digest()).decode()
        self.send_response(101, "Switching Protocols")
        self.send_header("Upgrade", "websocket")
        self.send_header("Connection", "Upgrade")
        self.send_header("Sec-WebSocket-Accept", accept)
        self.end_headers()
        self.wfile.flush()
        try:
            self.connection.setsockopt(socket.IPPROTO_TCP, socket.TCP_NODELAY, 1)
            if hasattr(socket, "TCP_QUICKACK"):
                self.connection.setsockopt(socket.IPPROTO_TCP, socket.TCP_QUICKACK, 1)
        except OSError:
            pass

        who = self.client_address[0]
        print(f"  ✓ Connected: {who}")
        ws_send(self.wfile, json.dumps({"t": "hello", "host": socket.gethostname()}))
        try:
            while True:
                opcode, data = ws_read_frame(self.rfile)
                if opcode is None or opcode == 0x8:
                    break
                if hasattr(socket, "TCP_QUICKACK"):
                    try:
                        self.connection.setsockopt(socket.IPPROTO_TCP, socket.TCP_QUICKACK, 1)
                    except OSError:
                        pass
                if opcode == 0x9:  # ping
                    ws_send(self.wfile, data, 0xA)
                elif opcode == 0x1:
                    try:
                        msg = json.loads(data)
                    except ValueError:
                        continue
                    if msg.get("t") == "ping":
                        ws_send(self.wfile, json.dumps({"t": "pong", "id": msg.get("id")}))
                    else:
                        handle_message(self.wfile, msg)
        except (ConnectionError, OSError):
            pass
        finally:
            KEYBOARD.button_mouse("left", False)  # never leave a drag stuck if the iPad drops
            print(f"  · Disconnected: {who}")
        self.close_connection = True


# ----------------------------------------------------------------------------
class QuietServer(ThreadingHTTPServer):
    daemon_threads = True

    def handle_error(self, request, client_address):
        if isinstance(sys.exc_info()[1], (ConnectionError, TimeoutError)):
            return  # Safari often drops idle keep-alive sockets; not an error
        super().handle_error(request, client_address)


def main():
    global KEYBOARD
    ap = argparse.ArgumentParser(description="Use your iPad as a Wi-Fi keyboard & trackpad.")
    ap.add_argument("--port", type=int, default=8765)
    args = ap.parse_args()

    try:
        KEYBOARD = VirtualKeyboard()
    except PermissionError:
        sys.exit("✗ No permission for /dev/uinput. Fix with:\n"
                 "  sudo setfacl -m u:$USER:rw /dev/uinput   (or add a udev rule)")

    httpd = QuietServer(("0.0.0.0", args.port), Handler)
    ip = lan_ip()
    url = f"http://{ip}:{args.port}"
    bar = "─" * 52
    print(f"\n  ⌨  PadKeys is running\n  {bar}")
    print(f"  On your iPad (same Wi-Fi), open in Safari:\n\n     \033[1;36m{url}\033[0m\n")
    print(f"  Tip: Share → 'Add to Home Screen' for a full-screen app.")
    print(f"  {bar}\n  Press Ctrl+C to stop.\n")
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        print("\n  Bye 👋")
    finally:
        httpd.server_close()
        KEYBOARD.close()


if __name__ == "__main__":
    main()
