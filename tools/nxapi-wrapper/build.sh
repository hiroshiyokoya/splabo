#!/bin/bash
# nxapi-sidecar をビルドする（macOS / Linux）
# 必要: Node.js 20+
# 使い方: ./build.sh [win|mac-arm|mac-x64|linux]

set -e

TARGET="${1:-mac-arm}"

echo "=== nxapi-sidecar ビルド（$TARGET） ==="

echo "[1/3] npm install..."
npm install

echo "[2/3] ビルド..."
case "$TARGET" in
  win)
    npm run build:win
    ;;
  mac-arm)
    npm run build:mac-arm
    ;;
  mac-x64)
    npm run build:mac-x64
    ;;
  linux)
    npm run build:linux
    ;;
  *)
    echo "不明なターゲット: $TARGET"
    echo "使い方: ./build.sh [win|mac-arm|mac-x64|linux]"
    exit 1
    ;;
esac

echo "=== ビルド完了 ==="
