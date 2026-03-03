#!/usr/bin/env bash

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

TARGET="${1:-auto}"

usage() {
  cat <<'EOF'
Usage: ./scripts/package_release.sh [auto|darwin|linux]

Builds release installers/artifacts for this platform:
  auto   Detect current OS and run the matching packager (default)
  darwin Run ./scripts/build_darwin.sh
  linux  Run ./scripts/build_linux.sh

Windows packaging is driven by PowerShell:
  pwsh -File ./scripts/package_release.ps1
EOF
}

if [[ "$TARGET" == "-h" || "$TARGET" == "--help" ]]; then
  usage
  exit 0
fi

run_darwin() {
  echo "==> Packaging macOS app/installer"
  ./scripts/build_darwin.sh
}

run_linux() {
  echo "==> Packaging Linux artifacts"
  ./scripts/build_linux.sh
}

case "$TARGET" in
  auto)
    case "$(uname -s)" in
      Darwin) run_darwin ;;
      Linux) run_linux ;;
      *)
        echo "Unsupported host OS for auto mode: $(uname -s)"
        echo "Use darwin/linux explicitly or run scripts/package_release.ps1 on Windows."
        exit 1
        ;;
    esac
    ;;
  darwin)
    run_darwin
    ;;
  linux)
    run_linux
    ;;
  *)
    echo "Unknown target: $TARGET"
    usage
    exit 1
    ;;
esac

