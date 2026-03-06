@echo off
setlocal

set "SCRIPT_DIR=%~dp0"
set "BASH_EXE="

if exist "%ProgramFiles%\Git\bin\bash.exe" set "BASH_EXE=%ProgramFiles%\Git\bin\bash.exe"
if not defined BASH_EXE if exist "%ProgramFiles(x86)%\Git\bin\bash.exe" set "BASH_EXE=%ProgramFiles(x86)%\Git\bin\bash.exe"

if not defined BASH_EXE (
  where bash.exe >nul 2>nul
  if %ERRORLEVEL%==0 set "BASH_EXE=bash.exe"
)

if not defined BASH_EXE (
  echo Git Bash was not found.
  echo Install Git for Windows or run the PowerShell launcher directly:
  echo   powershell -ExecutionPolicy Bypass -File "%SCRIPT_DIR%run-anorha-local.ps1" --fast-startup
  exit /b 1
)

"%BASH_EXE%" "%SCRIPT_DIR%run-anorha-local.sh" %*
exit /b %ERRORLEVEL%
