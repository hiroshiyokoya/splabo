@echo off
REM nxapi-sidecar を Windows 向けにビルドする
REM 必要: Node.js 20+
REM 出力: app/src-tauri/binaries/nxapi-sidecar-x86_64-pc-windows-msvc.exe

echo === nxapi-sidecar ビルド（Windows x64） ===

echo [1/3] npm install...
call npm install
if %ERRORLEVEL% neq 0 exit /b %ERRORLEVEL%

echo [2/3] nxapi-remote-config.json をパッチ...
copy /Y ..\nxapi-remote-config.json node_modules\nxapi\resources\common\remote-config.json
if %ERRORLEVEL% neq 0 exit /b %ERRORLEVEL%

echo [3/3] pkg でコンパイル...
call npx @yao-pkg/pkg wrapper.mjs --target node20-win-x64 --output ..\..\app\src-tauri\binaries\nxapi-sidecar-x86_64-pc-windows-msvc.exe
if %ERRORLEVEL% neq 0 exit /b %ERRORLEVEL%

echo === ビルド完了 ===
echo 出力: app/src-tauri/binaries/nxapi-sidecar-x86_64-pc-windows-msvc.exe
