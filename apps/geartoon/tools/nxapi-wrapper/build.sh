#!/bin/bash
# nxapi-sidecar をビルドする（macOS / Linux）
# 必要: Node.js 20+
# 使い方: ./build.sh [win|mac-arm|mac-x64|linux]

set -e

TARGET="${1:-mac-arm}"

echo "=== nxapi-sidecar ビルド（$TARGET） ==="

echo "[1/3] npm install..."
npm install

echo "[2/3] nxapi-remote-config.json をパッチ..."
cp ../nxapi-remote-config.json node_modules/nxapi/resources/common/remote-config.json

echo "[3/3] pkg でコンパイル..."
case "$TARGET" in
  win)
    npx @yao-pkg/pkg wrapper.mjs --target node20-win-x64 \
      --output ../../app/src-tauri/binaries/nxapi-sidecar-x86_64-pc-windows-msvc.exe
    ;;
  mac-arm)
    npx @yao-pkg/pkg wrapper.mjs --target node20-macos-arm64 \
      --output ../../app/src-tauri/binaries/nxapi-sidecar-aarch64-apple-darwin
    ;;
  mac-x64)
    npx @yao-pkg/pkg wrapper.mjs --target node20-macos-x64 \
      --output ../../app/src-tauri/binaries/nxapi-sidecar-x86_64-apple-darwin
    ;;
  linux)
    npx @yao-pkg/pkg wrapper.mjs --target node20-linux-x64 \
      --output ../../app/src-tauri/binaries/nxapi-sidecar-x86_64-unknown-linux-gnu
    ;;
  *)
    echo "不明なターゲット: $TARGET"
    echo "使い方: ./build.sh [win|mac-arm|mac-x64|linux]"
    exit 1
    ;;
esac

echo "=== ビルド完了 ==="
