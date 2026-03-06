#!/bin/sh

set -eu

SCRIPT_DIR="$(CDPATH= cd -- "$(dirname "$0")" && pwd)"
ROOT_DIR="$(CDPATH= cd -- "$SCRIPT_DIR/.." && pwd)"

RUNTIME_DIR="${1:-$ROOT_DIR/dist/browser-use-runtime}"
BROWSER_DIR="${2:-$ROOT_DIR/dist/browser-use-browsers}"
SOURCE_DIR="$ROOT_DIR/app/browser-use-runtime"

if ! command -v python3 >/dev/null 2>&1; then
  echo "python3 is required to bundle the Browser-Use runtime" >&2
  exit 1
fi

rm -rf "$RUNTIME_DIR" "$BROWSER_DIR"
mkdir -p "$RUNTIME_DIR" "$BROWSER_DIR"

python3 -m venv "$RUNTIME_DIR"

mkdir -p "$RUNTIME_DIR/python"
cp "$SOURCE_DIR/manifest.json" "$RUNTIME_DIR/manifest.json"
cp "$SOURCE_DIR/README.md" "$RUNTIME_DIR/README.md"
cp "$SOURCE_DIR/requirements.lock.txt" "$RUNTIME_DIR/requirements.lock.txt"
cp "$SOURCE_DIR/python/browser_use_mcp_wrapper.py" "$RUNTIME_DIR/python/browser_use_mcp_wrapper.py"

"$RUNTIME_DIR/bin/python3" -m pip install --upgrade pip
"$RUNTIME_DIR/bin/python3" -m pip install -r "$RUNTIME_DIR/requirements.lock.txt"
PLAYWRIGHT_BROWSERS_PATH="$BROWSER_DIR" "$RUNTIME_DIR/bin/python3" -m playwright install chromium

if [ ! -x "$RUNTIME_DIR/bin/browser-use" ]; then
  echo "Bundled Browser-Use executable not found at $RUNTIME_DIR/bin/browser-use" >&2
  exit 1
fi
