$ErrorActionPreference = "Stop"

param(
    [string]$RuntimeDir = "",
    [string]$BrowserDir = ""
)

$repoRoot = Split-Path -Parent $PSScriptRoot
if ([string]::IsNullOrWhiteSpace($RuntimeDir)) {
    $RuntimeDir = Join-Path $repoRoot "dist\browser-use-runtime"
}
if ([string]::IsNullOrWhiteSpace($BrowserDir)) {
    $BrowserDir = Join-Path $repoRoot "dist\browser-use-browsers"
}

$sourceDir = Join-Path $repoRoot "app\browser-use-runtime"
$pythonCmd = Get-Command python -ErrorAction SilentlyContinue
if ($null -eq $pythonCmd) {
    $pythonCmd = Get-Command py -ErrorAction SilentlyContinue
}
if ($null -eq $pythonCmd) {
    throw "Python is required to bundle the Browser-Use runtime"
}

if (Test-Path $RuntimeDir) { Remove-Item $RuntimeDir -Recurse -Force }
if (Test-Path $BrowserDir) { Remove-Item $BrowserDir -Recurse -Force }
New-Item -ItemType Directory -Force -Path $RuntimeDir | Out-Null
New-Item -ItemType Directory -Force -Path $BrowserDir | Out-Null

& $pythonCmd.Path -m venv $RuntimeDir
if ($LASTEXITCODE -ne 0) { exit($LASTEXITCODE) }

New-Item -ItemType Directory -Force -Path (Join-Path $RuntimeDir "python") | Out-Null
Copy-Item (Join-Path $sourceDir "manifest.json") -Destination (Join-Path $RuntimeDir "manifest.json") -Force
Copy-Item (Join-Path $sourceDir "README.md") -Destination (Join-Path $RuntimeDir "README.md") -Force
Copy-Item (Join-Path $sourceDir "requirements.lock.txt") -Destination (Join-Path $RuntimeDir "requirements.lock.txt") -Force
Copy-Item (Join-Path $sourceDir "python\browser_use_mcp_wrapper.py") -Destination (Join-Path $RuntimeDir "python\browser_use_mcp_wrapper.py") -Force

$venvPython = Join-Path $RuntimeDir "Scripts\python.exe"
& $venvPython -m pip install --upgrade pip
if ($LASTEXITCODE -ne 0) { exit($LASTEXITCODE) }
& $venvPython -m pip install -r (Join-Path $RuntimeDir "requirements.lock.txt")
if ($LASTEXITCODE -ne 0) { exit($LASTEXITCODE) }
$env:PLAYWRIGHT_BROWSERS_PATH = $BrowserDir
& $venvPython -m playwright install chromium
if ($LASTEXITCODE -ne 0) { exit($LASTEXITCODE) }

$browserUseExe = Join-Path $RuntimeDir "Scripts\browser-use.exe"
if (!(Test-Path $browserUseExe)) {
    throw "Bundled Browser-Use executable not found at $browserUseExe"
}
