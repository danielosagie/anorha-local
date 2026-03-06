# Ollama for macOS and Windows

## Download

- [macOS](https://github.com/ollama/app/releases/download/latest/Ollama.dmg)
- [Windows](https://github.com/ollama/app/releases/download/latest/OllamaSetup.exe)

## Development

### Desktop App

```bash
go generate ./... &&
go run ./cmd/app
```

### One-command launcher (with flags)

From repository root:

```bash
./scripts/run-anorha-local.sh --help
```

Examples:

```bash
# Normal desktop app (combined shell)
./scripts/run-anorha-local.sh

# Dev mode with custom ports
./scripts/run-anorha-local.sh --dev --app-port 3002 --vite-port 5174 --runtime-port 7320
```

Windows PowerShell examples:

```powershell
# Normal desktop app
.\scripts\run-anorha-local.ps1

# Dev mode with custom ports
.\scripts\run-anorha-local.ps1 --dev --app-port 3002 --vite-port 5174 --runtime-port 7320
```

### Browser-Use Runtime Visibility

When browser control is enabled, runtime telemetry is streamed back into chat as tool events:

- Planned execution steps (`Step 1/4 ... Step 4/4`)
- Step status updates (`planned`, `running`, `success`, `failed`)
- Context checks (question + assumption used when task context is incomplete)
- Browser-use MCP tool traces and summarized results

This is emitted through existing chat stream events (`thinking`, `tool_result`) so no extra UI toggle is required.

### Workflow-Native API (TypeScript Gateway)

Anorha workflow orchestration now lives in the TypeScript runtime gateway (`app/agent-runtime`), while Ollama app/server concerns remain in Go.

Workflow endpoints (runtime server):

- `POST /v1/workflow-runs`
- `GET /v1/workflow-runs/{runId}`
- `GET /v1/workflow-runs/{runId}/items`
- `GET /v1/workflow-runs/{runId}/events` (SSE)
- `POST /v1/workflow-runs/{runId}/cancel`
- `POST /v1/workflow-runs/{runId}/retry`
- `GET /v1/workflow-metrics/daily`

Workflow Studio catalog/session endpoints:

- `GET /v1/workflow-catalog/tool-groups`
- `GET /v1/workflow-catalog/sites`
- `POST /v1/workflow-catalog/sites`
- `PATCH /v1/workflow-catalog/sites/{siteId}`
- `GET /v1/workflow-catalog/sites/{siteId}/tools`
- `POST /v1/workflow-catalog/tools`
- `PATCH /v1/workflow-catalog/tools/{toolId}`
- `DELETE /v1/workflow-catalog/tools/{toolId}`
- `POST /v1/workflow-catalog/tools/{toolId}/verify`
- `POST /v1/workflow-sessions`
- `GET /v1/workflow-sessions/{sessionId}`
- `GET /v1/workflow-sessions/{sessionId}/items`
- `GET /v1/workflow-sessions/{sessionId}/events` (SSE)
- `POST /v1/workflow-sessions/{sessionId}/cancel`
- `POST /v1/workflow-sessions/{sessionId}/retry`

Behavior highlights:

- Bulk best-effort item execution for `create|read|update|delete`
- Per-item stage telemetry: `navigate`, `fill_data`, `confirm`, `complete`, `verify`
- Clear missing-field diagnostics for failed items
- Self-healing policy:
  - dev: autonomous retry with adapted prompt/preset updates
  - prod: guarded candidate generation without auto-promotion

Auth for workflow endpoints (Clerk JWT):

```bash
export ANORHA_WORKFLOW_AUTH_MODE=clerk
export ANORHA_CLERK_ISSUER=https://<your-clerk-domain>
export ANORHA_CLERK_AUDIENCE=<optional-audience>
# optional override
export ANORHA_CLERK_JWKS_URL=https://<your-clerk-domain>/.well-known/jwks.json
```

Dev bypass:

```bash
export ANORHA_WORKFLOW_AUTH_MODE=off
```

Frontend auth + cloud provider setup:

```bash
# App auth UX (Clerk-first)
export VITE_ANORHA_AUTH_PROVIDER=clerk
export VITE_ANORHA_AUTH_SIGNIN_URL=https://<your-anorha-app>/sign-in
```

Supabase-backed workflow catalog (optional but recommended for shared state):

```bash
export SUPABASE_URL=https://<project-ref>.supabase.co
export SUPABASE_SERVICE_ROLE_KEY=<service-role-key>
# optional schema override
export ANORHA_WORKFLOW_SUPABASE_SCHEMA=public
```

If Supabase env vars are missing, Workflow Studio falls back to local in-memory seeded catalog (Facebook active + draft scaffolds).

Cloud model routes are key-driven from Settings (OpenRouter/Kimi/Ollama Cloud API keys) and do not require Ollama account sign-in when keys are configured.

For persistent login/session reuse in local Browser-Use MCP, set:

```bash
export BROWSER_USE_MCP_BROWSER=real
export BROWSER_USE_MCP_PROFILE=Default
export BROWSER_USE_MCP_SESSION=anorha
export BROWSER_USE_MCP_HEADED=1
```

Then start as usual:

```bash
./scripts/run-anorha-local.sh --fast-startup --runtime-port 7418
```

Note: Browser-Use MCP controls its own automation browser process. It may reuse a profile/session, but it does not directly attach to an arbitrary already-open Chrome window.

### Attach to Chrome + Hybrid Autonomous Runtime

`playwright_attached` now runs in hybrid mode:

- attaches to Chrome via CDP
- plans/actions/verifies in multi-step loop
- emits `runtime.step` status (`running`, `success`, `failed`, `paused`)
- pauses on login walls and resumes on `continue`
- remembers pinned tab per chat thread

1. Start Chrome with DevTools remote debugging and a non-default profile dir:

```bash
mkdir -p "$HOME/.anorha/chrome-cdp"
/Applications/Google\ Chrome.app/Contents/MacOS/Google\ Chrome \
  --remote-debugging-port=9222 \
  --user-data-dir="$HOME/.anorha/chrome-cdp"
```

2. Verify CDP is reachable:

```bash
curl http://127.0.0.1:9222/json/version
```

3. Run Anorha with attached backend:

```bash
ANORHA_RUNTIME_BACKEND=playwright_attached \
ANORHA_CHROME_CDP_URL=http://127.0.0.1:9222 \
./scripts/run-anorha-local.sh --fast-startup --runtime-port 7418
```

Or with launcher flags:

```bash
./scripts/run-anorha-local.sh \
  --runtime-backend playwright_attached \
  --chrome-cdp-url http://127.0.0.1:9222 \
  --chrome-tab-index 2 \
  --fast-startup \
  --runtime-port 7418
```

You can also select tab/window by prompt text:

- `tab 2` (index)
- `tab url contains facebook.com`
- `tab title contains Gmail`

Or by launcher env/flags:

```bash
ANORHA_CHROME_TAB_INDEX=2
ANORHA_CHROME_TAB_MATCH=facebook.com
```

In chat UI, Browser use now has a per-chat runtime popover for:

- runtime mode (`playwright_attached`, `browser_use_ts`, `playwright_direct`)
- CDP URL
- tab policy (`pinned`, `ask`, `active`)
- optional tab index/match
- max steps

### UI Development

#### Setup

Install required tools:

```bash
go install github.com/tkrajina/typescriptify-golang-structs/tscriptify@latest
```

#### Develop UI (Development Mode)

1. Start the React development server (with hot-reload):

```bash
cd ui/app
npm install
npm run dev
```

2. In a separate terminal, run the Ollama app with the `-dev` flag:

```bash
go generate ./... &&
OLLAMA_DEBUG=1 go run ./cmd/app -dev
```

The `-dev` flag enables:

- Loading the UI from the Vite dev server at http://localhost:5173
- Fixed UI server port at http://127.0.0.1:3001 for API requests
- CORS headers for cross-origin requests
- Hot-reload support for UI development

## Build

### Unified Packaging Entry Points

Use these wrappers for a single, predictable packaging workflow:

```bash
# macOS/Linux (auto-detect host OS)
./scripts/package_release.sh

# explicit
./scripts/package_release.sh darwin
./scripts/package_release.sh linux
```

```powershell
# Windows
powershell -ExecutionPolicy Bypass -File .\scripts\package_release.ps1
```

Output artifacts are written under `dist/`.


### Windows

- https://jrsoftware.org/isinfo.php


**Dependencies** - either build a local copy of ollama, or use a github release
```powershell
# Local dependencies
.\scripts\deps_local.ps1

# Release dependencies
.\scripts\deps_release.ps1 0.6.8
```

**Build**
```powershell
.\scripts\build_windows.ps1
```

Installer notes:

- Produces Windows release artifacts under `dist\windows-*`
- Inno Setup is used when available for installer packaging

### macOS

CI builds with Xcode 14.1 for OS compatibility prior to v13.  If you want to manually build v11+ support, you can download the older Xcode [here](https://developer.apple.com/services-account/download?path=/Developer_Tools/Xcode_14.1/Xcode_14.1.xip), extract, then `mv ./Xcode.app /Applications/Xcode_14.1.0.app` then activate with:

```
export CGO_CFLAGS="-O3 -mmacosx-version-min=12.0"
export CGO_CXXFLAGS="-O3 -mmacosx-version-min=12.0"
export CGO_LDFLAGS="-mmacosx-version-min=12.0"
export SDKROOT=/Applications/Xcode_14.1.0.app/Contents/Developer/Platforms/MacOSX.platform/Developer/SDKs/MacOSX.sdk
export DEVELOPER_DIR=/Applications/Xcode_14.1.0.app/Contents/Developer
```

**Dependencies** - either build a local copy of Ollama, or use a GitHub release:
```sh
# Local dependencies
./scripts/deps_local.sh

# Release dependencies
./scripts/deps_release.sh 0.6.8
```

**Build**
```sh
./scripts/build_darwin.sh
```

Installer notes:

- Produces `dist/Ollama.app` and signed/zipped artifacts
- DMG output (`dist/Ollama.dmg`) is generated when signing/notarization inputs are configured

### Linux

```sh
./scripts/build_linux.sh
```

Installer notes:

- Produces compressed Linux bundles in `dist/` (for supported architectures)
- Artifacts are suitable for packaging into distro-specific installers externally (deb/rpm/appimage)
