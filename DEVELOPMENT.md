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
│   │   │   └── auth.rs   # Nintendo OAuth 認証ロジック（純粋関数 + Tauriコマンド）
│   │   ├── examples/
│   │   │   └── auth_cli.rs  # 認証フローをCLIで対話テストするツール
│   │   ├── Cargo.toml
│   │   └── tauri.conf.json
│   ├── package.json
│   └── vite.config.ts
└── tools/                # データパイプライン（Docker + Python）
    ├── data/
    │   ├── gear_db.json  # ギアデータ（git管理外）
    │   └── images/       # ギア画像（git管理外）
    └── scripts/          # Pythonスクリプト
```

## Rust 認証の CLI テスト

認証フローを Tauri アプリなしで対話的にテストできます：

```powershell
cd app
cargo run --example auth_cli
```

ブラウザでログイン URL を開き、リダイレクト URL を貼り付けると session_token まで取得できます。  
f-token 生成（bulletToken 取得）は nxapi サイドカー経由で行う予定のため、現状は最終ステップでエラーになります（Issue [#39](https://github.com/hiroshiyokoya/geartoon/issues/39)）。
