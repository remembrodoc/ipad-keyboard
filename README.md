# ⌨ PadKeys — use your iPad as a Wi‑Fi keyboard for Linux

No app on the iPad. No pip installs. Just Python 3 + `python3-evdev` (already on Ubuntu).

## Start
```bash
./run.sh            # prints the URL + 6-digit PIN
./run.sh --new-pin  # rotate the PIN
```
On the iPad (same Wi‑Fi) open the printed URL in Safari, e.g. `http://192.168.1.13:8765/#pin=XXXXXX`.
Then **Share → Add to Home Screen** for a full-screen app.

## Features
- Native iPad keyboard, swipe typing and dictation → typed on the laptop
- Special keys: Esc, Tab, arrows, Home/End, PgUp/PgDn, Del, F1–F12
- Sticky modifiers: tap Ctrl/Alt/Shift/Super once = next key, double‑tap = lock
- One‑tap shortcuts (copy/paste/undo, tabs, Alt+Tab, terminal, volume, media)
- Hardware keyboard on the iPad works too (⌘ → Ctrl optional)
- Works on X11 and Wayland (kernel `uinput` virtual keyboard)

## Troubleshooting
| Problem | Fix |
|---|---|
| iPad can't load the page | `sudo ufw allow 8765/tcp` and check both are on the same Wi‑Fi |
| `No permission for /dev/uinput` | `sudo setfacl -m u:$USER:rw /dev/uinput` |
| Wrong symbols | Laptop layout must be **US** (Settings → Keyboard) |
| Laptop IP changed | Re-open the new URL printed by `./run.sh` |

## Tests
```bash
python3 -m unittest discover -s tests -v   # uses a fake keyboard; types nothing
```
