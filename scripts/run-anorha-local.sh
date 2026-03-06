#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

DEV=0
HIDDEN=0
FAST=0

RUNTIME_HOST="${ANORHA_RUNTIME_HOST:-127.0.0.1}"
RUNTIME_PORT="${ANORHA_RUNTIME_PORT:-7318}"
APP_PORT="${ANORHA_APP_PORT:-3001}"
VITE_PORT="${ANORHA_VITE_PORT:-5173}"
BROWSER_USE_MODE="${BROWSER_USE_MODE:-mcp}"
BROWSER_USE_BASE_URL="${BROWSER_USE_BASE_URL:-http://127.0.0.1:9999}"
BROWSER_USE_CMD="${BROWSER_USE_CMD:-uvx --from browser-use browser-use server}"
BROWSER_USE_MCP_CMD="${BROWSER_USE_MCP_CMD:-}"
BROWSER_USE_MCP_BROWSER="${BROWSER_USE_MCP_BROWSER:-}"
BROWSER_USE_MCP_PROFILE="${BROWSER_USE_MCP_PROFILE:-}"
BROWSER_USE_MCP_SESSION="${BROWSER_USE_MCP_SESSION:-}"
BROWSER_USE_MCP_HEADED="${BROWSER_USE_MCP_HEADED:-}"
BROWSER_USE_LLM_TRANSPORT="${BROWSER_USE_LLM_TRANSPORT:-auto}"
BROWSER_USE_ENABLE_NATIVE_OLLAMA="${BROWSER_USE_ENABLE_NATIVE_OLLAMA:-0}"
BROWSER_USE_BUNDLED_RUNTIME_DIR="${BROWSER_USE_BUNDLED_RUNTIME_DIR:-}"
BROWSER_USE_BUNDLED_BROWSER_DIR="${BROWSER_USE_BUNDLED_BROWSER_DIR:-}"
BROWSER_USE_RUNTIME_SOURCE="${BROWSER_USE_RUNTIME_SOURCE:-dev-external}"
ANORHA_RUNTIME_BACKEND="${ANORHA_RUNTIME_BACKEND:-}"
ANORHA_CHROME_CDP_URL="${ANORHA_CHROME_CDP_URL:-http://127.0.0.1:9222}"
ANORHA_CHROME_TAB_INDEX="${ANORHA_CHROME_TAB_INDEX:-}"
ANORHA_CHROME_TAB_MATCH="${ANORHA_CHROME_TAB_MATCH:-}"
ANORHA_RUNTIME_FORCE_RESTART="${ANORHA_RUNTIME_FORCE_RESTART:-1}"
BROWSER_USE_AUTOSTART="${BROWSER_USE_AUTOSTART:-1}"
BROWSER_USE_WAIT_SECONDS="${BROWSER_USE_WAIT_SECONDS:-45}"
TRAY_ICON=""
ANORHA_SKIP_RUNTIME_BUILD="${ANORHA_SKIP_RUNTIME_BUILD:-0}"

EXTRA_ARGS=()

usage() {
  cat <<'EOF_USAGE'
Usage: ./scripts/run-anorha-local.sh [options] [-- extra-app-args]

Options:
  --dev                     Run desktop app in dev mode (-dev)
  --hidden                  Start app hidden (--hide)
  --fast-startup            Skip optional startup work
  --runtime-host <host>     Runtime sidecar host (default: 127.0.0.1)
  --runtime-port <port>     Runtime sidecar port (default: 7318)
  --app-port <port>         Desktop API port in --dev mode (default: 3001)
  --vite-port <port>        Vite dev server port in --dev mode (default: 5173)
  --browser-use-mode <m>    Browser-Use mode: mcp|http|auto (default: mcp)
  --browser-use-url <url>   Browser-Use service base URL for HTTP mode (default: http://127.0.0.1:9999)
  --browser-use-cmd <cmd>   Command to start Browser-Use service in HTTP mode (default: uvx --from browser-use browser-use server)
  --browser-use-mcp-cmd <c> Command to start Browser-Use MCP server (default: local wrapper in app/agent-runtime/dist)
  --browser-use-mcp-browser <b> Browser-Use MCP browser mode (chromium|real|remote)
  --browser-use-mcp-profile <p> Browser-Use MCP profile name/id
  --browser-use-mcp-session <s> Browser-Use MCP session name
  --browser-use-mcp-headed     Run Browser-Use MCP in headed mode
  --runtime-backend <name>     Runtime backend (browser_use_ts|playwright_attached|playwright_direct)
  --chrome-cdp-url <url>       Chrome DevTools URL for attached backend (default: http://127.0.0.1:9222)
  --chrome-tab-index <n>       Attached mode: choose tab index (1-based)
  --chrome-tab-match <text>    Attached mode: choose first tab where URL/title contains text
  --browser-use-wait <sec>  Max seconds to wait after starting Browser-Use in HTTP mode (default: 45)
  --tray-icon <path>        Replace tray icon assets from an image path
  -h, --help                Show this help
EOF_USAGE
}

browser_use_http_reachable() {
  local base="$1"
  local code

  for p in /health /api/health /api/v1/health; do
    code="$(curl -sS -m 1 -o /dev/null -w '%{http_code}' "${base}${p}" || true)"
    if [[ "$code" =~ ^2 ]]; then
      return 0
    fi
  done

  for p in /api/v1/agent/run /api/agent/run /agent/run; do
    code="$(curl -sS -m 1 -o /dev/null -w '%{http_code}' -X POST -H 'Content-Type: application/json' -d '{}' "${base}${p}" || true)"
    if [[ "$code" != "000" ]]; then
      return 0
    fi
  done

  return 1
}

ensure_browser_use_http_service() {
  local base="$1"
  local cmd="$2"
  local wait_s="$3"
  local normalized_cmd="$cmd"

  if browser_use_http_reachable "$base"; then
    echo "Browser-Use HTTP reachable at $base"
    return 0
  fi

  if [[ -z "$cmd" ]]; then
    echo "Browser-Use HTTP is not reachable at $base (and no --browser-use-cmd was provided)." >&2
    return 1
  fi

  normalized_cmd="$(printf '%s' "$normalized_cmd" | sed -E 's/(^|[[:space:]])browser-use[[:space:]]+serve([[:space:]]|$)/\1browser-use server\2/g')"
  if printf '%s' "$normalized_cmd" | grep -Eq '(^|[[:space:]])browser-use[[:space:]]+server([[:space:]]|$)'; then
    normalized_cmd="$(printf '%s' "$normalized_cmd" | sed -E 's/[[:space:]]+--host(=|[[:space:]]+)[^[:space:]]+//g; s/[[:space:]]+--port(=|[[:space:]]+)[^[:space:]]+//g; s/[[:space:]]+/ /g; s/^ //; s/ $//')"
  fi

  echo "[browser-use] mode=http"
  echo "[browser-use] command=$normalized_cmd"
  echo "[browser-use] log=/tmp/anorha-browser-use.log"
  {
    echo "[$(date -u '+%Y-%m-%dT%H:%M:%SZ')] mode=http command=$normalized_cmd"
  } >>/tmp/anorha-browser-use.log

  nohup bash -lc "$normalized_cmd" >>/tmp/anorha-browser-use.log 2>&1 &
  local browser_use_pid=$!
  echo "Browser-Use PID: $browser_use_pid"

  sleep 1
  if ! kill -0 "$browser_use_pid" 2>/dev/null; then
    echo "Browser-Use process exited immediately (pid=$browser_use_pid)." >&2
  fi

  local i
  for ((i = 0; i < wait_s; i++)); do
    if browser_use_http_reachable "$base"; then
      echo "Browser-Use HTTP reachable at $base"
      return 0
    fi
    sleep 1
  done

  echo "Browser-Use HTTP still not reachable at $base after ${wait_s}s. See /tmp/anorha-browser-use.log" >&2
  if [[ -f /tmp/anorha-browser-use.log ]]; then
    echo "--- /tmp/anorha-browser-use.log (tail) ---" >&2
    tail -n 40 /tmp/anorha-browser-use.log >&2 || true
    echo "--- end browser-use log ---" >&2
  fi
  return 1
}

ensure_browser_use_mcp_preflight() {
  local cmd="$1"

  if [[ -z "$cmd" ]]; then
    echo "Browser-Use MCP command is empty; set --browser-use-mcp-cmd or BROWSER_USE_MCP_CMD." >&2
    return 1
  fi

  echo "[browser-use] mode=mcp"
  echo "[browser-use] command=$cmd"
  echo "[browser-use] log=/tmp/anorha-browser-use.log"
  {
    echo "[$(date -u '+%Y-%m-%dT%H:%M:%SZ')] mode=mcp preflight command=$cmd"
  } >>/tmp/anorha-browser-use.log

  nohup bash -lc "$cmd" >>/tmp/anorha-browser-use.log 2>&1 &
  local browser_use_pid=$!
  echo "Browser-Use MCP preflight PID: $browser_use_pid"

  # Stdio MCP servers often exit quickly when detached without an active stdin client.
  # Treat quick exit as acceptable unless logs show a clear startup failure.
  sleep 1
  if kill -0 "$browser_use_pid" 2>/dev/null; then
    kill "$browser_use_pid" 2>/dev/null || true
    wait "$browser_use_pid" 2>/dev/null || true
    echo "Browser-Use MCP preflight passed."
    return 0
  fi

  local tail_output=""
  if [[ -f /tmp/anorha-browser-use.log ]]; then
    tail_output="$(tail -n 60 /tmp/anorha-browser-use.log 2>/dev/null || true)"
  fi

  if printf '%s' "$tail_output" | grep -Eiq '(command not found|no such file|traceback|module not found|error:|failed to|exception)'; then
    echo "Browser-Use MCP process exited during preflight." >&2
    if [[ -f /tmp/anorha-browser-use.log ]]; then
      echo "--- /tmp/anorha-browser-use.log (tail) ---" >&2
      tail -n 40 /tmp/anorha-browser-use.log >&2 || true
      echo "--- end browser-use log ---" >&2
    fi
    return 1
  fi

  echo "Browser-Use MCP process exited during detached preflight (normal for stdio MCP). Continuing."
  echo "Browser-Use MCP preflight passed."
  return 0
}

ensure_browser_use() {
  local mode="$1"
  local base="$2"
  local http_cmd="$3"
  local mcp_cmd="$4"
  local wait_s="$5"

  case "$mode" in
    mcp)
      ensure_browser_use_mcp_preflight "$mcp_cmd"
      ;;
    http)
      ensure_browser_use_http_service "$base" "$http_cmd" "$wait_s"
      ;;
    auto)
      if ensure_browser_use_mcp_preflight "$mcp_cmd"; then
        echo "Browser-Use auto mode selected MCP transport."
      else
        echo "Browser-Use MCP preflight failed; trying HTTP fallback checks." >&2
        ensure_browser_use_http_service "$base" "$http_cmd" "$wait_s"
      fi
      ;;
    *)
      echo "Invalid --browser-use-mode '$mode'. Expected mcp, http, or auto." >&2
      return 1
      ;;
  esac
}

apply_tray_icon() {
  local icon_path="$1"
  if [[ -z "$icon_path" ]]; then
    return 0
  fi
  if [[ ! -f "$icon_path" ]]; then
    echo "Tray icon path not found: $icon_path" >&2
    exit 1
  fi

  local resources_dir="$ROOT_DIR/app/darwin/Ollama.app/Contents/Resources"
  local png_targets=(
    "$resources_dir/ollama.png"
    "$resources_dir/ollama@2x.png"
    "$resources_dir/ollamaDark.png"
    "$resources_dir/ollamaDark@2x.png"
    "$resources_dir/ollamaUpdate.png"
    "$resources_dir/ollamaUpdate@2x.png"
    "$resources_dir/ollamaUpdateDark.png"
    "$resources_dir/ollamaUpdateDark@2x.png"
  )

  for target in "${png_targets[@]}"; do
    cp "$icon_path" "$target"
  done

  if command -v ffmpeg >/dev/null 2>&1; then
    ffmpeg -y -loglevel error -i "$icon_path" -vf "scale=256:256:force_original_aspect_ratio=decrease,pad=256:256:(ow-iw)/2:(oh-ih)/2" "$ROOT_DIR/app/assets/tray.ico"
    ffmpeg -y -loglevel error -i "$icon_path" -vf "scale=256:256:force_original_aspect_ratio=decrease,pad=256:256:(ow-iw)/2:(oh-ih)/2" "$ROOT_DIR/app/assets/tray_upgrade.ico"
  fi
}

ensure_agent_runtime_built() {
  local runtime_dir="$ROOT_DIR/app/agent-runtime"
  if [[ "$ANORHA_SKIP_RUNTIME_BUILD" == "1" || "$ANORHA_SKIP_RUNTIME_BUILD" == "true" ]]; then
    return 0
  fi
  if [[ ! -d "$runtime_dir" ]]; then
    return 0
  fi
  if ! command -v npm >/dev/null 2>&1; then
    echo "npm is required to build app/agent-runtime (sidecar)." >&2
    exit 1
  fi

  # Build runtime sidecar so new backends (e.g. playwright_attached) are available.
  (cd "$runtime_dir" && npm run build >/dev/null)
}

default_browser_use_mcp_cmd() {
  local wrapper_js="$ROOT_DIR/app/agent-runtime/dist/browser-use-mcp-wrapper.js"
  if [[ -f "$wrapper_js" ]]; then
    printf "node %q" "$wrapper_js"
    return 0
  fi

  printf '%s' "uvx --from browser-use browser-use --mcp"
}

restart_existing_runtime_sidecar() {
  if [[ "$ANORHA_RUNTIME_FORCE_RESTART" != "1" && "$ANORHA_RUNTIME_FORCE_RESTART" != "true" ]]; then
    return 0
  fi

  if ! command -v lsof >/dev/null 2>&1; then
    return 0
  fi

  local pids
  pids="$(lsof -ti "tcp:${RUNTIME_PORT}" 2>/dev/null || true)"
  if [[ -z "$pids" ]]; then
    return 0
  fi

  local pid
  while IFS= read -r pid; do
    [[ -z "$pid" ]] && continue
    local cmdline
    cmdline="$(ps -p "$pid" -o command= 2>/dev/null || true)"
    if [[ "$cmdline" == *"agent-runtime"* || "$cmdline" == *"server.js"* || "$cmdline" == *"node"* ]]; then
      echo "[runtime] stopping existing sidecar pid=$pid on port ${RUNTIME_PORT}"
      kill "$pid" 2>/dev/null || true
    else
      echo "[runtime] process on port ${RUNTIME_PORT} is not recognized as sidecar (pid=$pid). Leaving it running."
    fi
  done <<< "$pids"
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --dev)
      DEV=1
      shift
      ;;
    --hidden)
      HIDDEN=1
      shift
      ;;
    --fast-startup)
      FAST=1
      shift
      ;;
    --runtime-host)
      RUNTIME_HOST="${2:-}"
      shift 2
      ;;
    --runtime-port)
      RUNTIME_PORT="${2:-}"
      shift 2
      ;;
    --app-port)
      APP_PORT="${2:-}"
      shift 2
      ;;
    --vite-port)
      VITE_PORT="${2:-}"
      shift 2
      ;;
    --browser-use-mode)
      BROWSER_USE_MODE="${2:-}"
      shift 2
      ;;
    --browser-use-url)
      BROWSER_USE_BASE_URL="${2:-}"
      shift 2
      ;;
    --browser-use-cmd)
      BROWSER_USE_CMD="${2:-}"
      shift 2
      ;;
    --browser-use-mcp-cmd)
      BROWSER_USE_MCP_CMD="${2:-}"
      shift 2
      ;;
    --browser-use-mcp-browser)
      BROWSER_USE_MCP_BROWSER="${2:-}"
      shift 2
      ;;
    --browser-use-mcp-profile)
      BROWSER_USE_MCP_PROFILE="${2:-}"
      shift 2
      ;;
    --browser-use-mcp-session)
      BROWSER_USE_MCP_SESSION="${2:-}"
      shift 2
      ;;
    --browser-use-mcp-headed)
      BROWSER_USE_MCP_HEADED="1"
      shift
      ;;
    --runtime-backend)
      ANORHA_RUNTIME_BACKEND="${2:-}"
      shift 2
      ;;
    --chrome-cdp-url)
      ANORHA_CHROME_CDP_URL="${2:-}"
      shift 2
      ;;
    --chrome-tab-index)
      ANORHA_CHROME_TAB_INDEX="${2:-}"
      shift 2
      ;;
    --chrome-tab-match)
      ANORHA_CHROME_TAB_MATCH="${2:-}"
      shift 2
      ;;
    --browser-use-wait)
      BROWSER_USE_WAIT_SECONDS="${2:-}"
      shift 2
      ;;
    --tray-icon)
      TRAY_ICON="${2:-}"
      shift 2
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    --)
      shift
      EXTRA_ARGS+=("$@")
      break
      ;;
    *)
      EXTRA_ARGS+=("$1")
      shift
      ;;
  esac
done

export ANORHA_RUNTIME_HOST="$RUNTIME_HOST"
export ANORHA_RUNTIME_PORT="$RUNTIME_PORT"
export ANORHA_APP_PORT="$APP_PORT"
export ANORHA_VITE_PORT="$VITE_PORT"
export BROWSER_USE_MODE="$BROWSER_USE_MODE"
export BROWSER_USE_BASE_URL="$BROWSER_USE_BASE_URL"
export BROWSER_USE_CMD="$BROWSER_USE_CMD"
export BROWSER_USE_MCP_CMD="$BROWSER_USE_MCP_CMD"
export BROWSER_USE_MCP_BROWSER="$BROWSER_USE_MCP_BROWSER"
export BROWSER_USE_MCP_PROFILE="$BROWSER_USE_MCP_PROFILE"
export BROWSER_USE_MCP_SESSION="$BROWSER_USE_MCP_SESSION"
export BROWSER_USE_MCP_HEADED="$BROWSER_USE_MCP_HEADED"
export BROWSER_USE_LLM_TRANSPORT="$BROWSER_USE_LLM_TRANSPORT"
export BROWSER_USE_ENABLE_NATIVE_OLLAMA="$BROWSER_USE_ENABLE_NATIVE_OLLAMA"
export BROWSER_USE_BUNDLED_RUNTIME_DIR="$BROWSER_USE_BUNDLED_RUNTIME_DIR"
export BROWSER_USE_BUNDLED_BROWSER_DIR="$BROWSER_USE_BUNDLED_BROWSER_DIR"
export BROWSER_USE_RUNTIME_SOURCE="$BROWSER_USE_RUNTIME_SOURCE"
export ANORHA_RUNTIME_BACKEND="$ANORHA_RUNTIME_BACKEND"
export ANORHA_CHROME_CDP_URL="$ANORHA_CHROME_CDP_URL"
export ANORHA_CHROME_TAB_INDEX="$ANORHA_CHROME_TAB_INDEX"
export ANORHA_CHROME_TAB_MATCH="$ANORHA_CHROME_TAB_MATCH"
export BROWSER_USE_AUTOSTART="$BROWSER_USE_AUTOSTART"
export BROWSER_USE_WAIT_SECONDS="$BROWSER_USE_WAIT_SECONDS"

apply_tray_icon "$TRAY_ICON"
ensure_agent_runtime_built
if [[ -z "$BROWSER_USE_MCP_CMD" ]]; then
  BROWSER_USE_MCP_CMD="$(default_browser_use_mcp_cmd)"
  export BROWSER_USE_MCP_CMD
fi

echo "[browser-use] runtime-route selection happens per run in app logs (route/model)"
echo "[browser-use] mcp browser=${BROWSER_USE_MCP_BROWSER:-default} profile=${BROWSER_USE_MCP_PROFILE:-default} session=${BROWSER_USE_MCP_SESSION:-default} headed=${BROWSER_USE_MCP_HEADED:-0}"
echo "[browser-use] transport=${BROWSER_USE_LLM_TRANSPORT} native_ollama=${BROWSER_USE_ENABLE_NATIVE_OLLAMA} runtime_source=${BROWSER_USE_RUNTIME_SOURCE}"
echo "[browser-use] bundled_runtime_dir=${BROWSER_USE_BUNDLED_RUNTIME_DIR:-none} bundled_browser_dir=${BROWSER_USE_BUNDLED_BROWSER_DIR:-none}"
echo "[browser-use] mcp command=${BROWSER_USE_MCP_CMD}"
echo "[runtime] backend=${ANORHA_RUNTIME_BACKEND:-playwright_attached(default)} chrome_cdp_url=${ANORHA_CHROME_CDP_URL}"
echo "[runtime] attached tab index=${ANORHA_CHROME_TAB_INDEX:-auto} match=${ANORHA_CHROME_TAB_MATCH:-none}"
restart_existing_runtime_sidecar
autostart_lc="$(printf '%s' "$BROWSER_USE_AUTOSTART" | tr '[:upper:]' '[:lower:]')"
if [[ "$autostart_lc" != "0" && "$autostart_lc" != "false" && "$autostart_lc" != "off" && "$ANORHA_RUNTIME_BACKEND" != "playwright_attached" ]]; then
  ensure_browser_use "$BROWSER_USE_MODE" "$BROWSER_USE_BASE_URL" "$BROWSER_USE_CMD" "$BROWSER_USE_MCP_CMD" "$BROWSER_USE_WAIT_SECONDS"
fi

CMD=(go run ./app/cmd/app)
if [[ "$DEV" -eq 1 ]]; then
  CMD+=(-dev)
fi
if [[ "$HIDDEN" -eq 1 ]]; then
  CMD+=(--hide)
fi
if [[ "$FAST" -eq 1 ]]; then
  CMD+=(--fast-startup)
fi
if [[ "${#EXTRA_ARGS[@]}" -gt 0 ]]; then
  CMD+=("${EXTRA_ARGS[@]}")
fi

cd "$ROOT_DIR"
exec "${CMD[@]}"
