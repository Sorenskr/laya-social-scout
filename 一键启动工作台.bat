@echo off
chcp 65001 >nul
cd /d "%~dp0"
title Laya Social Scout - http://localhost:3080

set "NODE_BIN="
where node >nul 2>nul
if not errorlevel 1 set "NODE_BIN=node"
if defined NODE_BIN goto RUN_APP

if exist "D:\Program Files (x86)\node.exe" set "NODE_BIN=D:\Program Files (x86)\node.exe"
if defined NODE_BIN goto RUN_APP

if exist "%ProgramFiles%\nodejs\node.exe" set "NODE_BIN=%ProgramFiles%\nodejs\node.exe"
if defined NODE_BIN goto RUN_APP

if exist "%ProgramFiles(x86)%\nodejs\node.exe" set "NODE_BIN=%ProgramFiles(x86)%\nodejs\node.exe"
if defined NODE_BIN goto RUN_APP

if exist "%USERPROFILE%\.workbuddy\binaries\node\versions\22.22.2-6\node.exe" set "NODE_BIN=%USERPROFILE%\.workbuddy\binaries\node\versions\22.22.2-6\node.exe"
if defined NODE_BIN goto RUN_APP

echo.
echo [!] Node.js not found. Please install from:
echo     https://nodejs.org/zh-cn/download
echo.
pause
exit /b 1

:RUN_APP
"%NODE_BIN%" main.js --open %*
if "%~1"=="--dry-run" exit /b 0
echo.
pause
