"""Tests for PadKeys. Uses fakes, so nothing is actually typed on your machine.

Run:  python3 -m unittest discover -s tests -v
"""

import base64
import json
import os
import socket
import struct
import sys
import threading
import time
import unittest
from http.server import ThreadingHTTPServer
from unittest import mock

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

import injector  # noqa: E402
import server  # noqa: E402
from evdev import ecodes as e  # noqa: E402


class FakeUInput:
    def __init__(self, *a, **kw):
        self.events = []

    def write(self, etype, code, value):
        self.events.append((code, value))

    def syn(self):
        pass

    def close(self):
        pass


def make_keyboard():
    with mock.patch.object(injector, "UInput", FakeUInput), mock.patch.object(injector.time, "sleep"):
        kb = injector.VirtualKeyboard()
    kb.KEY_DELAY = 0
    return kb


def presses(kb):
    """Return list of key-down codes in order."""
    return [c for c, v in kb._ui.events if v == 1]


class InjectorTests(unittest.TestCase):
    def test_lowercase_and_space(self):
        kb = make_keyboard()
        kb.type_text("hi there")
        self.assertEqual(presses(kb), [e.KEY_H, e.KEY_I, e.KEY_SPACE, e.KEY_T, e.KEY_H,
                                       e.KEY_E, e.KEY_R, e.KEY_E])

    def test_shifted_symbols(self):
        kb = make_keyboard()
        kb.type_text('A@"')
        self.assertEqual(presses(kb), [e.KEY_LEFTSHIFT, e.KEY_A, e.KEY_LEFTSHIFT, e.KEY_2,
                                       e.KEY_LEFTSHIFT, e.KEY_APOSTROPHE])

    def test_every_event_released(self):
        kb = make_keyboard()
        kb.type_text("Hello, World! ~{}|<>?\n\t")
        downs = [c for c, v in kb._ui.events if v == 1]
        ups = [c for c, v in kb._ui.events if v == 0]
        self.assertEqual(sorted(downs), sorted(ups))

    def test_smart_quotes_normalised(self):
        kb = make_keyboard()
        kb.type_text("\u201cok\u201d")
        self.assertEqual(presses(kb)[0:2], [e.KEY_LEFTSHIFT, e.KEY_APOSTROPHE])

    def test_unicode_fallback(self):
        kb = make_keyboard()
        kb.type_text("é")  # U+00E9 -> Ctrl+Shift+U e 9 space
        self.assertEqual(presses(kb), [e.KEY_LEFTCTRL, e.KEY_LEFTSHIFT, e.KEY_U,
                                       e.KEY_E, e.KEY_9, e.KEY_SPACE])

    def test_combo_ctrl_shift_t(self):
        kb = make_keyboard()
        self.assertTrue(kb.press("t", ["ctrl", "shift"]))
        self.assertEqual(presses(kb), [e.KEY_LEFTCTRL, e.KEY_LEFTSHIFT, e.KEY_T])

    def test_named_keys(self):
        kb = make_keyboard()
        kb.press("ArrowLeft", ["ctrl"])
        kb.press("F5")
        kb.press("Meta")
        self.assertEqual(presses(kb), [e.KEY_LEFTCTRL, e.KEY_LEFT, e.KEY_F5, e.KEY_LEFTMETA])

    def test_unknown_key_ignored(self):
        kb = make_keyboard()
        self.assertFalse(kb.press("NotAKey"))

    def test_backspace_count_clamped(self):
        kb = make_keyboard()
        kb.backspace(3)
        self.assertEqual(presses(kb), [e.KEY_BACKSPACE] * 3)


# --------------------------------------------------------------------------- server
def ws_connect(port, pin):
    s = socket.create_connection(("127.0.0.1", port), timeout=3)
    key = base64.b64encode(os.urandom(16)).decode()
    s.sendall((f"GET /ws?pin={pin} HTTP/1.1\r\nHost: x\r\nUpgrade: websocket\r\n"
               f"Connection: Upgrade\r\nSec-WebSocket-Key: {key}\r\n"
               f"Sec-WebSocket-Version: 13\r\n\r\n").encode())
    resp = b""
    while b"\r\n\r\n" not in resp:
        chunk = s.recv(1024)
        if not chunk:
            break
        resp += chunk
    head, _, rest = resp.partition(b"\r\n\r\n")
    return s, head.decode(), rest


def ws_send_json(s, obj):
    data = json.dumps(obj).encode()
    mask = os.urandom(4)
    masked = bytes(b ^ mask[i % 4] for i, b in enumerate(data))
    n = len(data)
    hdr = struct.pack(">BB", 0x81, 0x80 | n) if n < 126 else struct.pack(">BBH", 0x81, 0x80 | 126, n)
    s.sendall(hdr + mask + masked)


class ServerTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.kb = mock.MagicMock()
        server.KEYBOARD = cls.kb
        server.PIN = "123456"
        cls.httpd = ThreadingHTTPServer(("127.0.0.1", 0), server.Handler)
        cls.httpd.daemon_threads = True
        cls.port = cls.httpd.server_address[1]
        threading.Thread(target=cls.httpd.serve_forever, daemon=True).start()

    @classmethod
    def tearDownClass(cls):
        cls.httpd.shutdown()

    def test_wrong_pin_rejected(self):
        s, head, _ = ws_connect(self.port, "000000")
        self.assertIn("403", head.splitlines()[0])
        s.close()

    def test_messages_reach_keyboard(self):
        self.kb.reset_mock()
        s, head, _ = ws_connect(self.port, "123456")
        self.assertIn("101", head.splitlines()[0])
        self.assertIn("HTTP/1.1", head.splitlines()[0])
        ws_send_json(s, {"t": "text", "v": "hello"})
        ws_send_json(s, {"t": "bs", "n": 2})
        ws_send_json(s, {"t": "key", "k": "c", "m": ["ctrl"]})
        time.sleep(0.3)
        s.close()
        self.kb.type_text.assert_called_with("hello")
        self.kb.backspace.assert_called_with(2)
        self.kb.press.assert_called_with("c", ["ctrl"])

    def test_static_index_served(self):
        s = socket.create_connection(("127.0.0.1", self.port), timeout=3)
        s.sendall(b"GET / HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n")
        data = b""
        while True:
            chunk = s.recv(65536)
            if not chunk:
                break
            data += chunk
        s.close()
        self.assertIn(b"200", data.split(b"\r\n")[0])
        self.assertIn(b"PadKeys", data)

    def test_path_traversal_blocked(self):
        s = socket.create_connection(("127.0.0.1", self.port), timeout=3)
        s.sendall(b"GET /../server.py HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n")
        first = s.recv(1024).split(b"\r\n")[0]
        s.close()
        self.assertIn(b"404", first)


if __name__ == "__main__":
    unittest.main()
