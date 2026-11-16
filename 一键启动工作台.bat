@echo off
cd /d "%~dp0"
title Laya Social Scout - http://localhost:3080

set "NODE_BIN="
where node >nul 2>nul
if not errorlevel 1 set "NODE_BIN=node"
if defined NODE_BIN goto CHECK_ARGS

if exist "D:\Program Files (x86)\node.exe" set "NODE_BIN=D:\Program Files (x86)\node.exe"
if defined NODE_BIN goto CHECK_ARGS

if exist "%ProgramFiles%\nodejs\node.exe" set "NODE_BIN=%ProgramFiles%\nodejs\node.exe"
if defined NODE_BIN goto CHECK_ARGS

if exist "%ProgramFiles(x86)%\nodejs\node.exe" set "NODE_BIN=%ProgramFiles(x86)%\nodejs\node.exe"
if defined NODE_BIN goto CHECK_ARGS

if exist "%USERPROFILE%\.workbuddy\binaries\node\versions\22.22.2-6\node.exe" set "NODE_BIN=%USERPROFILE%\.workbuddy\binaries\node\versions\22.22.2-6\node.exe"
if defined NODE_BIN goto CHECK_ARGS

echo [!] Node.js not found. Please install from: https://nodejs.org/zh-cn/download
pause
exit /b 1

:CHECK_ARGS
if "%~1"=="--dry-run" (
  "%NODE_BIN%" main.js --dry-run
  exit /b %errorlevel%
)
if "%~1"=="--stop" (
  "%NODE_BIN%" daemon_guardian.js --stop
  exit /b %errorlevel%
)

if exist "%~dp0scripts\silent_guardian.vbs" (
  start "" wscript.exe "%~dp0scripts\silent_guardian.vbs"
) else (
  start "" /b "%NODE_BIN%" "%~dp0daemon_guardian.js"
)

"%NODE_BIN%" -e "(async()=>{for(let i=0;i<24;i++){try{const r=await fetch('http://127.0.0.1:3080/api/health',{signal:AbortSignal.timeout(800)});if(r.ok)break;}catch(_){}await new Promise(r=>setTimeout(r,400));}console.log('Laya Social Scout guardian ready -> http://localhost:3080');})()"
start "" "http://localhost:3080"
ping 127.0.0.1 -n 3 >nul
exit /b 0