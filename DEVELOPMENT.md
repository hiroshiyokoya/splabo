# 開発環境セットアップ

## 必要なもの

| ツール | バージョン | 用途 |
|--------|-----------|------|
| Node.js | 20以上 | フロントエンド開発 |
| Rust | stable | Tauriバックエンド |
| Visual Studio C++ Build Tools | 2022 | Rustのコンパイルに必要（Windows） |

## セットアップ手順

### 1. Node.js

https://nodejs.org/ からインストール、またはwingetで：

```powershell
winget install OpenJS.NodeJS
```

### 2. Rust

https://rustup.rs/ からインストール、またはwingetで：

```powershell
winget install Rustlang.Rustup
```

インストール後、新しいターミナルを開いて確認：

```powershell
rustc --version
cargo --version
```

### 3. Visual Studio C++ Build Tools（Windowsのみ）

Visual Studio Installer を開き、**「C++によるデスクトップ開発」** ワークロードを追加。
または：

```powershell
winget install Microsoft.VisualStudio.2022.BuildTools
```

インストール後、VS Installer で「C++によるデスクトップ開発」を追加する。

### 4. 依存パッケージのインストール

```powershell
cd app
npm install
```

## 開発コマンド

すべて `app/` ディレクトリで実行する。

| コマンド | 用途 |
|---------|------|
| `npm run dev` | ブラウザで開発（Vite dev server） |
| `npm run build` | フロントエンドをビルド |
| `npm run tauri dev` | Tauriデスクトップアプリとして起動 |
| `npm run tauri build` | インストーラーを生成 |

### ブラウザ開発 vs Tauriアプリ開発

- **`npm run dev`**: ブラウザで動作確認。UIの開発はこちらで行う。`/data/*` → `tools/data/` のファイル配信がviteミドルウェアで動く。
- **`npm run tauri dev`**: デスクトップアプリとして起動。Tauriネイティブ機能（認証・ファイルアクセス等）の開発はこちら。

### macOS での認証テストについて

macOS の `tauri dev` では、Nintendo 認証の deep-link（`npf71b963c1b7b6d119://`）が OS に登録されないため、認証フローが完了しない。認証・データ更新のテストは `npm run tauri build` でビルドした本番アプリで行うこと。

## ビルド成果物

`npm run tauri build` を実行すると `app/src-tauri/target/release/bundle/` に生成される：

- `msi/geartoon_x.x.x_x64_en-US.msi` — Windows Installer
- `nsis/geartoon_x.x.x_x64-setup.exe` — NSISインストーラー

`target/` ディレクトリはgit管理外（`.gitignore`で除外済み）。

## ディレクトリ構成

```
geartoon/
├── app/
│   ├── src/              # Reactフロントエンド
│   ├── src-tauri/        # Tauriバックエンド（Rust）
│   │   ├── src/
│   │   │   ├── main.rs
│   │   │   ├── lib.rs
│   │   │   ├── auth.rs    # Nintendo OAuth 認証ロジック（純粋関数 + Tauriコマンド）
│   │   │   ├── nxapi.rs   # nxapi サイドカー呼び出し（Tauriコマンド群）
│   │   │   └── crypto.rs  # gear_db 暗号化・画像スクランブル（AES-256-GCM / XOR）
│   │   ├── examples/
│   │   │   └── auth_cli.rs  # 認証フローをCLIで対話テストするツール
│   │   ├── binaries/     # サイドカーバイナリ（git管理外・要ビルド）
│   │   ├── Cargo.toml
│   │   └── tauri.conf.json
│   ├── package.json
│   └── vite.config.ts
└── tools/                # データパイプライン
    ├── nxapi-wrapper/    # nxapi サイドカーのソース（Node.js）
    │   ├── wrapper.js    # IPC ラッパー本体
    │   ├── package.json  # npm スクリプト（build:win / build:mac-arm / build:linux）
    │   ├── build.bat     # Windows 向けビルドスクリプト
    │   └── build.sh      # macOS/Linux 向けビルドスクリプト
    ├── data/
    │   ├── gear_db.bin   # 暗号化済みギアデータ（git管理外・fetch後に生成）
    │   └── images/       # スクランブル済み画像 .gti（git管理外）
    └── nxapi-remote-config.json  # パッチ済み nxapi 設定
```

## nxapi サイドカーのビルド（必須）

`npm run tauri dev` / `npm run tauri build` の前に、nxapi サイドカーをビルドする必要があります。

```powershell
# Windows
cd tools/nxapi-wrapper
build.bat
```

```bash
# macOS (Apple Silicon)
cd tools/nxapi-wrapper
npm ci
npm run build:mac-arm
```

ビルドには数分かかります。出力先: `app/src-tauri/binaries/nxapi-sidecar-<target>`  
このバイナリは git 管理外（`.gitignore` で除外）。

## Rust 認証の CLI テスト

認証フローを Tauri アプリなしで対話的にテストできます：

```powershell
cd app
cargo run --example auth_cli
```

ブラウザでログイン URL を開き、リダイレクト URL を貼り付けると session_token まで取得できます。  
f-token 生成は nxapi サイドカー経由で実装済みです（[#39](https://github.com/hiroshiyokoya/geartoon/issues/39)）。
