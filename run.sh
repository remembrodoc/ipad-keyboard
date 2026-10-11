#!/usr/bin/env bash
# Start PadKeys. Usage: ./run.sh [--port 8765] [--new-pin]
cd "$(dirname "$0")"
exec python3 server.py "$@"
