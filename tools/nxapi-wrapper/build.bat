@echo off
REM nxapi-sidecar を Windows 向けにビルドする
REM 必要: Node.js 20+
REM 出力: app/src-tauri/binaries/nxapi-sidecar-x86_64-pc-windows-msvc.exe

echo === nxapi-sidecar ビルド（Windows x64） ===

echo [1/2] npm install...
call npm install
if %ERRORLEVEL% neq 0 exit /b %ERRORLEVEL%

echo [2/2] ビルド...
call npm run build:win
if %ERRORLEVEL% neq 0 exit /b %ERRORLEVEL%

echo === ビルド完了 ===
echo 出力: app/src-tauri/binaries/nxapi-sidecar-x86_64-pc-windows-msvc.exe
