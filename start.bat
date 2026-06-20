@echo off
REM ============================================================================
REM  DEVELOPER launcher — runs the app from SOURCE (needs Node.js + npm install).
REM
REM  Just want to PLAY? Do NOT use this file. Download the ready-to-run installer
REM  from the Releases page (no Node.js, no setup needed):
REM      https://github.com/Boisteroux/mnm-tools/releases
REM ============================================================================
cd /d "%~dp0"

REM Find Node.js on PATH; if it's not there, try the default install location.
where node >nul 2>nul
if errorlevel 1 (
  if exist "C:\Program Files\nodejs\node.exe" (
    set "PATH=C:\Program Files\nodejs;%PATH%"
  ) else (
    echo.
    echo   Node.js was not found, so this developer launcher can't run.
    echo.
    echo   If you just want to USE the app, download the installer here instead:
    echo       https://github.com/Boisteroux/mnm-tools/releases
    echo.
    pause
    exit /b 1
  )
)

start "" /b cmd /c "npm start"
