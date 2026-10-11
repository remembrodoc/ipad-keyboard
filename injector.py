"""Virtual keyboard backed by the Linux kernel's uinput interface.

Creates a real (virtual) input device, so typed keys work in every
application on both X11 and Wayland. Assumes a US keyboard layout on
the laptop side.
"""

import threading
import time

from evdev import UInput, ecodes as e

# --- Character -> (keycode, needs_shift) for the US layout -----------------
CHAR_MAP = {}

for c in "abcdefghijklmnopqrstuvwxyz":
    code = getattr(e, f"KEY_{c.upper()}")
    CHAR_MAP[c] = (code, False)
    CHAR_MAP[c.upper()] = (code, True)

for d in "0123456789":
    CHAR_MAP[d] = (getattr(e, f"KEY_{d}"), False)

_UNSHIFTED = {
    " ": e.KEY_SPACE, "\n": e.KEY_ENTER, "\t": e.KEY_TAB,
    "-": e.KEY_MINUS, "=": e.KEY_EQUAL, "[": e.KEY_LEFTBRACE,
    "]": e.KEY_RIGHTBRACE, "\\": e.KEY_BACKSLASH, ";": e.KEY_SEMICOLON,
    "'": e.KEY_APOSTROPHE, ",": e.KEY_COMMA, ".": e.KEY_DOT,
    "/": e.KEY_SLASH, "`": e.KEY_GRAVE,
}
_SHIFTED = {
    "~": e.KEY_GRAVE, "!": e.KEY_1, "@": e.KEY_2, "#": e.KEY_3,
    "$": e.KEY_4, "%": e.KEY_5, "^": e.KEY_6, "&": e.KEY_7,
    "*": e.KEY_8, "(": e.KEY_9, ")": e.KEY_0, "_": e.KEY_MINUS,
    "+": e.KEY_EQUAL, "{": e.KEY_LEFTBRACE, "}": e.KEY_RIGHTBRACE,
    "|": e.KEY_BACKSLASH, ":": e.KEY_SEMICOLON, '"': e.KEY_APOSTROPHE,
    "<": e.KEY_COMMA, ">": e.KEY_DOT, "?": e.KEY_SLASH,
}
CHAR_MAP.update({ch: (code, False) for ch, code in _UNSHIFTED.items()})
CHAR_MAP.update({ch: (code, True) for ch, code in _SHIFTED.items()})

# iOS "smart punctuation" substitutes – map back to plain ASCII.
SMART_PUNCT = {
    "\u2018": "'", "\u2019": "'", "\u201c": '"', "\u201d": '"',
    "\u2013": "-", "\u2014": "--", "\u2026": "...", "\u00a0": " ",
    "\r": "",
}

# --- Named keys (JS KeyboardEvent.key style) -> keycode ---------------------
NAMED_KEYS = {
    "Escape": e.KEY_ESC, "Tab": e.KEY_TAB, "Enter": e.KEY_ENTER,
    "Backspace": e.KEY_BACKSPACE, "Delete": e.KEY_DELETE,
    "Insert": e.KEY_INSERT, " ": e.KEY_SPACE, "Space": e.KEY_SPACE,
    "ArrowUp": e.KEY_UP, "ArrowDown": e.KEY_DOWN,
    "ArrowLeft": e.KEY_LEFT, "ArrowRight": e.KEY_RIGHT,
    "Home": e.KEY_HOME, "End": e.KEY_END,
    "PageUp": e.KEY_PAGEUP, "PageDown": e.KEY_PAGEDOWN,
    "PrintScreen": e.KEY_SYSRQ, "CapsLock": e.KEY_CAPSLOCK,
    "Meta": e.KEY_LEFTMETA, "Super": e.KEY_LEFTMETA,
    "AudioVolumeUp": e.KEY_VOLUMEUP, "AudioVolumeDown": e.KEY_VOLUMEDOWN,
    "AudioVolumeMute": e.KEY_MUTE, "MediaPlayPause": e.KEY_PLAYPAUSE,
    "MediaTrackNext": e.KEY_NEXTSONG, "MediaTrackPrevious": e.KEY_PREVIOUSSONG,
    "BrightnessUp": e.KEY_BRIGHTNESSUP, "BrightnessDown": e.KEY_BRIGHTNESSDOWN,
}
for i in range(1, 13):
    NAMED_KEYS[f"F{i}"] = getattr(e, f"KEY_F{i}")

MODIFIERS = {
    "ctrl": e.KEY_LEFTCTRL, "shift": e.KEY_LEFTSHIFT,
    "alt": e.KEY_LEFTALT, "meta": e.KEY_LEFTMETA,
}

_HEX_KEYS = {h: CHAR_MAP[h][0] for h in "0123456789abcdef"}


class VirtualKeyboard:
    """Thread-safe wrapper around a uinput keyboard device."""

    KEY_DELAY = 0.004  # seconds between events; keeps X11/Wayland happy

    def __init__(self, name="PadKeys Virtual Keyboard"):
        keys = set(NAMED_KEYS.values()) | set(MODIFIERS.values())
        keys |= {code for code, _ in CHAR_MAP.values()}
        keys |= {e.BTN_LEFT, e.BTN_RIGHT, e.BTN_MIDDLE}
        rel_events = {e.REL_X, e.REL_Y, e.REL_WHEEL, e.REL_HWHEEL}
        self._ui = UInput({e.EV_KEY: sorted(keys), e.EV_REL: sorted(rel_events)}, name=name)
        self._lock = threading.Lock()
        time.sleep(1.0)  # let the display server pick up the new device (else 1st key can be lost)

    # -- low level ---------------------------------------------------------
    def _emit(self, code, value):
        self._ui.write(e.EV_KEY, code, value)
        self._ui.syn()

    def _tap(self, code, modifiers=(), hold=None):
        for m in modifiers:
            self._emit(m, 1)
        self._emit(code, 1)
        time.sleep(self.KEY_DELAY if hold is None else hold)
        self._emit(code, 0)
        for m in reversed(modifiers):
            self._emit(m, 0)
        time.sleep(self.KEY_DELAY)

    def _unicode(self, ch):
        """Type any unicode char via GTK/IBus Ctrl+Shift+U <hex> <space>."""
        self._tap(e.KEY_U, (e.KEY_LEFTCTRL, e.KEY_LEFTSHIFT))
        for h in format(ord(ch), "x"):
            self._tap(_HEX_KEYS[h])
        self._tap(e.KEY_SPACE)

    # -- public API ----------------------------------------------------------
    def type_text(self, text):
        for src, dst in SMART_PUNCT.items():
            text = text.replace(src, dst)
        with self._lock:
            for ch in text:
                if ch in CHAR_MAP:
                    code, shift = CHAR_MAP[ch]
                    self._tap(code, (e.KEY_LEFTSHIFT,) if shift else ())
                elif ch.isprintable():
                    self._unicode(ch)

    def press(self, key, modifiers=()):
        """Press a named key or single character with optional modifiers."""
        mods = [MODIFIERS[m] for m in modifiers if m in MODIFIERS]
        if key in NAMED_KEYS:
            code, shift = NAMED_KEYS[key], False
        elif key.lower() in CHAR_MAP and len(key) == 1:
            # With modifiers, use the base key (Ctrl+C, not Ctrl+Shift+c).
            code, shift = CHAR_MAP[key if not mods else key.lower()]
        elif key in MODIFIERS:  # lone modifier tap, e.g. Super
            code, shift = MODIFIERS[key], False
        else:
            return False
        if shift and MODIFIERS["shift"] not in mods:
            mods.append(MODIFIERS["shift"])
        with self._lock:
            # A lone modifier tap (e.g. Super → Activities) gets a realistic hold time.
            lone_mod = code in MODIFIERS.values() and not mods
            self._tap(code, tuple(mods), hold=0.04 if lone_mod else None)
        return True

    def move_mouse(self, dx, dy):
        with self._lock:
            if dx:
                self._ui.write(e.EV_REL, e.REL_X, int(dx))
            if dy:
                self._ui.write(e.EV_REL, e.REL_Y, int(dy))
            self._ui.syn()

    def click_mouse(self, button="left"):
        btn_code = e.BTN_LEFT if button == "left" else (e.BTN_RIGHT if button == "right" else e.BTN_MIDDLE)
        with self._lock:
            self._emit(btn_code, 1)
            time.sleep(self.KEY_DELAY)
            self._emit(btn_code, 0)

    def scroll_mouse(self, delta):
        with self._lock:
            self._ui.write(e.EV_REL, e.REL_WHEEL, int(delta))
            self._ui.syn()

    def hscroll_mouse(self, delta):
        with self._lock:
            self._ui.write(e.EV_REL, e.REL_HWHEEL, int(delta))
            self._ui.syn()

    def button_mouse(self, button="left", down=True):
        """Press or release a mouse button (used for tap-and-drag text selection)."""
        code = {"left": e.BTN_LEFT, "right": e.BTN_RIGHT, "middle": e.BTN_MIDDLE}.get(button, e.BTN_LEFT)
        with self._lock:
            self._emit(code, 1 if down else 0)

    def backspace(self, count=1):
        with self._lock:
            for _ in range(max(0, min(count, 500))):
                self._tap(e.KEY_BACKSPACE)

    def close(self):
        self._ui.close()
