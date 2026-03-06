$ErrorActionPreference = "Stop"

$script:ROOT_DIR = Split-Path -Parent $PSScriptRoot
Set-Location $script:ROOT_DIR

$DEV = $false
$HIDDEN = $false
$FAST = $false

$RUNTIME_HOST = if ($env:ANORHA_RUNTIME_HOST) { $env:ANORHA_RUNTIME_HOST } else { "127.0.0.1" }
$RUNTIME_PORT = if ($env:ANORHA_RUNTIME_PORT) { $env:ANORHA_RUNTIME_PORT } else { "7318" }
$APP_PORT = if ($env:ANORHA_APP_PORT) { $env:ANORHA_APP_PORT } else { "3001" }
$VITE_PORT = if ($env:ANORHA_VITE_PORT) { $env:ANORHA_VITE_PORT } else { "5173" }
$BROWSER_USE_MODE = if ($env:BROWSER_USE_MODE) { $env:BROWSER_USE_MODE } else { "mcp" }
$BROWSER_USE_BASE_URL = if ($env:BROWSER_USE_BASE_URL) { $env:BROWSER_USE_BASE_URL } else { "http://127.0.0.1:9999" }
$BROWSER_USE_CMD = if ($env:BROWSER_USE_CMD) { $env:BROWSER_USE_CMD } else { "uvx --from browser-use browser-use server" }
$BROWSER_USE_MCP_CMD = if ($env:BROWSER_USE_MCP_CMD) { $env:BROWSER_USE_MCP_CMD } else { "" }
$BROWSER_USE_MCP_BROWSER = if ($env:BROWSER_USE_MCP_BROWSER) { $env:BROWSER_USE_MCP_BROWSER } else { "" }
$BROWSER_USE_MCP_PROFILE = if ($env:BROWSER_USE_MCP_PROFILE) { $env:BROWSER_USE_MCP_PROFILE } else { "" }
$BROWSER_USE_MCP_SESSION = if ($env:BROWSER_USE_MCP_SESSION) { $env:BROWSER_USE_MCP_SESSION } else { "" }
$BROWSER_USE_MCP_HEADED = if ($env:BROWSER_USE_MCP_HEADED) { $env:BROWSER_USE_MCP_HEADED } else { "" }
$BROWSER_USE_LLM_TRANSPORT = if ($env:BROWSER_USE_LLM_TRANSPORT) { $env:BROWSER_USE_LLM_TRANSPORT } else { "auto" }
$BROWSER_USE_ENABLE_NATIVE_OLLAMA = if ($env:BROWSER_USE_ENABLE_NATIVE_OLLAMA) { $env:BROWSER_USE_ENABLE_NATIVE_OLLAMA } else { "0" }
$BROWSER_USE_BUNDLED_RUNTIME_DIR = if ($env:BROWSER_USE_BUNDLED_RUNTIME_DIR) { $env:BROWSER_USE_BUNDLED_RUNTIME_DIR } else { "" }
$BROWSER_USE_BUNDLED_BROWSER_DIR = if ($env:BROWSER_USE_BUNDLED_BROWSER_DIR) { $env:BROWSER_USE_BUNDLED_BROWSER_DIR } else { "" }
$BROWSER_USE_RUNTIME_SOURCE = if ($env:BROWSER_USE_RUNTIME_SOURCE) { $env:BROWSER_USE_RUNTIME_SOURCE } else { "dev-external" }
$ANORHA_RUNTIME_BACKEND = if ($env:ANORHA_RUNTIME_BACKEND) { $env:ANORHA_RUNTIME_BACKEND } else { "" }
$ANORHA_CHROME_CDP_URL = if ($env:ANORHA_CHROME_CDP_URL) { $env:ANORHA_CHROME_CDP_URL } else { "http://127.0.0.1:9222" }
$ANORHA_CHROME_TAB_INDEX = if ($env:ANORHA_CHROME_TAB_INDEX) { $env:ANORHA_CHROME_TAB_INDEX } else { "" }
$ANORHA_CHROME_TAB_MATCH = if ($env:ANORHA_CHROME_TAB_MATCH) { $env:ANORHA_CHROME_TAB_MATCH } else { "" }
$ANORHA_RUNTIME_FORCE_RESTART = if ($env:ANORHA_RUNTIME_FORCE_RESTART) { $env:ANORHA_RUNTIME_FORCE_RESTART } else { "1" }
$BROWSER_USE_AUTOSTART = if ($env:BROWSER_USE_AUTOSTART) { $env:BROWSER_USE_AUTOSTART } else { "1" }
$BROWSER_USE_WAIT_SECONDS = if ($env:BROWSER_USE_WAIT_SECONDS) { $env:BROWSER_USE_WAIT_SECONDS } else { "45" }
$ANORHA_SKIP_RUNTIME_BUILD = if ($env:ANORHA_SKIP_RUNTIME_BUILD) { $env:ANORHA_SKIP_RUNTIME_BUILD } else { "0" }

$EXTRA_ARGS = New-Object System.Collections.Generic.List[string]

function Show-Usage {
    @"
Usage: .\scripts\run-anorha-local.ps1 [options] [-- extra-app-args]

Options:
  --dev                     Run desktop app in dev mode (-dev)
  --hidden                  Start app hidden (--hide)
  --fast-startup            Skip optional startup work
  --runtime-host <host>     Runtime sidecar host (default: 127.0.0.1)
  --runtime-port <port>     Runtime sidecar port (default: 7318)
  --app-port <port>         Desktop API port in --dev mode (default: 3001)
  --vite-port <port>        Vite dev server port in --dev mode (default: 5173)
  --browser-use-mode <m>    Browser-Use mode: mcp|http|auto
  --browser-use-url <url>   Browser-Use service base URL for HTTP mode
  --browser-use-cmd <cmd>   Command to start Browser-Use service in HTTP mode
  --browser-use-mcp-cmd <c> Command to start Browser-Use MCP server
  --runtime-backend <name>  Runtime backend (browser_use_ts|playwright_attached|playwright_direct)
  --chrome-cdp-url <url>    Chrome DevTools URL for attached backend
  --chrome-tab-index <n>    Attached mode: choose tab index (1-based)
  --chrome-tab-match <text> Attached mode: choose first tab where URL/title contains text
  -h, --help                Show this help
"@ | Write-Output
}

function Ensure-AgentRuntimeBuilt {
    if ($ANORHA_SKIP_RUNTIME_BUILD -in @("1", "true", "True")) {
        return
    }
    $runtimeDir = Join-Path $script:ROOT_DIR "app\agent-runtime"
    if (!(Test-Path $runtimeDir)) {
        return
    }
    if (!(Get-Command npm -ErrorAction SilentlyContinue)) {
        throw "npm is required to build app/agent-runtime (sidecar)."
    }
    Push-Location $runtimeDir
    try {
        & npm run build | Out-Null
        if ($LASTEXITCODE -ne 0) {
            exit $LASTEXITCODE
        }
    } finally {
        Pop-Location
    }
}

function Get-DefaultBrowserUseMcpCmd {
    $wrapperJs = Join-Path $script:ROOT_DIR "app\agent-runtime\dist\browser-use-mcp-wrapper.js"
    if (Test-Path $wrapperJs) {
        return "node `"$wrapperJs`""
    }
    return "uvx --from browser-use browser-use --mcp"
}

function Restart-ExistingRuntimeSidecar {
    if ($ANORHA_RUNTIME_FORCE_RESTART -notin @("1", "true", "True")) {
        return
    }
    $pids = @()
    try {
        $pids = @(Get-NetTCPConnection -LocalPort ([int]$RUNTIME_PORT) -State Listen -ErrorAction Stop | Select-Object -ExpandProperty OwningProcess -Unique)
    } catch {
        return
    }
    foreach ($pid in $pids) {
        if ($pid) {
            Write-Host "[runtime] stopping existing sidecar pid=$pid on port $RUNTIME_PORT"
            Stop-Process -Id $pid -Force -ErrorAction SilentlyContinue
        }
    }
}

function Coalesce([string]$Value, [string]$Fallback) {
    if ([string]::IsNullOrWhiteSpace($Value)) {
        return $Fallback
    }
    return $Value
}

for ($i = 0; $i -lt $args.Count; $i++) {
    switch ($args[$i]) {
        "--dev" { $DEV = $true }
        "--hidden" { $HIDDEN = $true }
        "--fast-startup" { $FAST = $true }
        "--runtime-host" { $i++; $RUNTIME_HOST = $args[$i] }
        "--runtime-port" { $i++; $RUNTIME_PORT = $args[$i] }
        "--app-port" { $i++; $APP_PORT = $args[$i] }
        "--vite-port" { $i++; $VITE_PORT = $args[$i] }
        "--browser-use-mode" { $i++; $BROWSER_USE_MODE = $args[$i] }
        "--browser-use-url" { $i++; $BROWSER_USE_BASE_URL = $args[$i] }
        "--browser-use-cmd" { $i++; $BROWSER_USE_CMD = $args[$i] }
        "--browser-use-mcp-cmd" { $i++; $BROWSER_USE_MCP_CMD = $args[$i] }
        "--browser-use-mcp-browser" { $i++; $BROWSER_USE_MCP_BROWSER = $args[$i] }
        "--browser-use-mcp-profile" { $i++; $BROWSER_USE_MCP_PROFILE = $args[$i] }
        "--browser-use-mcp-session" { $i++; $BROWSER_USE_MCP_SESSION = $args[$i] }
        "--browser-use-mcp-headed" { $BROWSER_USE_MCP_HEADED = "1" }
        "--runtime-backend" { $i++; $ANORHA_RUNTIME_BACKEND = $args[$i] }
        "--chrome-cdp-url" { $i++; $ANORHA_CHROME_CDP_URL = $args[$i] }
        "--chrome-tab-index" { $i++; $ANORHA_CHROME_TAB_INDEX = $args[$i] }
        "--chrome-tab-match" { $i++; $ANORHA_CHROME_TAB_MATCH = $args[$i] }
        "--browser-use-wait" { $i++; $BROWSER_USE_WAIT_SECONDS = $args[$i] }
        "-h" { Show-Usage; exit 0 }
        "--help" { Show-Usage; exit 0 }
        "--" {
            for ($j = $i + 1; $j -lt $args.Count; $j++) {
                $EXTRA_ARGS.Add($args[$j])
            }
            break
        }
        default { $EXTRA_ARGS.Add($args[$i]) }
    }
}

$env:ANORHA_RUNTIME_HOST = $RUNTIME_HOST
$env:ANORHA_RUNTIME_PORT = $RUNTIME_PORT
$env:ANORHA_APP_PORT = $APP_PORT
$env:ANORHA_VITE_PORT = $VITE_PORT
$env:BROWSER_USE_MODE = $BROWSER_USE_MODE
$env:BROWSER_USE_BASE_URL = $BROWSER_USE_BASE_URL
$env:BROWSER_USE_CMD = $BROWSER_USE_CMD
$env:BROWSER_USE_MCP_BROWSER = $BROWSER_USE_MCP_BROWSER
$env:BROWSER_USE_MCP_PROFILE = $BROWSER_USE_MCP_PROFILE
$env:BROWSER_USE_MCP_SESSION = $BROWSER_USE_MCP_SESSION
$env:BROWSER_USE_MCP_HEADED = $BROWSER_USE_MCP_HEADED
$env:BROWSER_USE_LLM_TRANSPORT = $BROWSER_USE_LLM_TRANSPORT
$env:BROWSER_USE_ENABLE_NATIVE_OLLAMA = $BROWSER_USE_ENABLE_NATIVE_OLLAMA
$env:BROWSER_USE_BUNDLED_RUNTIME_DIR = $BROWSER_USE_BUNDLED_RUNTIME_DIR
$env:BROWSER_USE_BUNDLED_BROWSER_DIR = $BROWSER_USE_BUNDLED_BROWSER_DIR
$env:BROWSER_USE_RUNTIME_SOURCE = $BROWSER_USE_RUNTIME_SOURCE
$env:ANORHA_RUNTIME_BACKEND = $ANORHA_RUNTIME_BACKEND
$env:ANORHA_CHROME_CDP_URL = $ANORHA_CHROME_CDP_URL
$env:ANORHA_CHROME_TAB_INDEX = $ANORHA_CHROME_TAB_INDEX
$env:ANORHA_CHROME_TAB_MATCH = $ANORHA_CHROME_TAB_MATCH
$env:BROWSER_USE_AUTOSTART = $BROWSER_USE_AUTOSTART
$env:BROWSER_USE_WAIT_SECONDS = $BROWSER_USE_WAIT_SECONDS

Ensure-AgentRuntimeBuilt
if ([string]::IsNullOrWhiteSpace($BROWSER_USE_MCP_CMD)) {
    $BROWSER_USE_MCP_CMD = Get-DefaultBrowserUseMcpCmd
}
$env:BROWSER_USE_MCP_CMD = $BROWSER_USE_MCP_CMD

Write-Host "[browser-use] runtime-route selection happens per run in app logs (route/model)"
Write-Host "[browser-use] mcp browser=$(Coalesce $BROWSER_USE_MCP_BROWSER 'default') profile=$(Coalesce $BROWSER_USE_MCP_PROFILE 'default') session=$(Coalesce $BROWSER_USE_MCP_SESSION 'default') headed=$(Coalesce $BROWSER_USE_MCP_HEADED '0')"
Write-Host "[browser-use] transport=$BROWSER_USE_LLM_TRANSPORT native_ollama=$BROWSER_USE_ENABLE_NATIVE_OLLAMA runtime_source=$BROWSER_USE_RUNTIME_SOURCE"
Write-Host "[browser-use] bundled_runtime_dir=$(Coalesce $BROWSER_USE_BUNDLED_RUNTIME_DIR 'none') bundled_browser_dir=$(Coalesce $BROWSER_USE_BUNDLED_BROWSER_DIR 'none')"
Write-Host "[browser-use] mcp command=$BROWSER_USE_MCP_CMD"
Write-Host "[runtime] backend=$(if ([string]::IsNullOrWhiteSpace($ANORHA_RUNTIME_BACKEND)) { 'playwright_attached(default)' } else { $ANORHA_RUNTIME_BACKEND }) chrome_cdp_url=$ANORHA_CHROME_CDP_URL"
Write-Host "[runtime] attached tab index=$(Coalesce $ANORHA_CHROME_TAB_INDEX 'auto') match=$(Coalesce $ANORHA_CHROME_TAB_MATCH 'none')"

Restart-ExistingRuntimeSidecar

$cmdArgs = New-Object System.Collections.Generic.List[string]
$cmdArgs.Add("run")
$cmdArgs.Add("./app/cmd/app")
if ($DEV) { $cmdArgs.Add("-dev") }
if ($HIDDEN) { $cmdArgs.Add("--hide") }
if ($FAST) { $cmdArgs.Add("--fast-startup") }
foreach ($arg in $EXTRA_ARGS) {
    $cmdArgs.Add($arg)
}

& go @cmdArgs
exit $LASTEXITCODE
