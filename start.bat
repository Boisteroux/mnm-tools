@echo off
cd /d "%~dp0"
set "PATH=C:\Program Files\nodejs;%PATH%"
start "" /b cmd /c "npm start"
