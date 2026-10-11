#!/usr/bin/env python3
"""Tiny clipboard helper (GTK, no xclip needed).

  clip.py get          -> prints the laptop clipboard text
  clip.py set  (stdin) -> sets the laptop clipboard text

Runs through XWayland/X11 so it also works under a Wayland session.
"""
import os
import sys
import time

os.environ["GDK_BACKEND"] = "x11"

import gi  # noqa: E402

gi.require_version("Gtk", "3.0")
gi.require_version("Gdk", "3.0")
from gi.repository import Gdk, GLib, Gtk  # noqa: E402


def main():
    cb = Gtk.Clipboard.get(Gdk.SELECTION_CLIPBOARD)
    mode = sys.argv[1] if len(sys.argv) > 1 else "get"
    if mode == "get":
        sys.stdout.write(cb.wait_for_text() or "")
    elif mode == "set":
        cb.set_text(sys.stdin.read(), -1)
        cb.store()  # hand over to GNOME's clipboard manager so it outlives us
        ctx = GLib.MainContext.default()
        end = time.time() + 0.4
        while time.time() < end:
            while ctx.iteration(False):
                pass
            time.sleep(0.01)


if __name__ == "__main__":
    main()
