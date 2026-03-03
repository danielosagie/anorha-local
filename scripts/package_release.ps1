param(
    [ValidateSet("windows")]
    [string]$Target = "windows"
)

$ErrorActionPreference = "Stop"

if ($Target -ne "windows") {
    Write-Error "Unsupported target '$Target'. Use: windows"
}

Write-Host "==> Packaging Windows app/installer"
powershell -ExecutionPolicy Bypass -File .\scripts\build_windows.ps1

