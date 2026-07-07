# splabo

Splatoon 3 の非公式 API 系デスクトップアプリ **splabo**（戦績＋ギア）の monorepo です。任天堂株式会社とは無関係で、データ取得に [nxapi](https://github.com/samuelthomas2774/nxapi) を使用しています。

> **v0.8 統合済み:** 旧 **chartoon**（戦績）と **geartoon**（ギア）は 1 バイナリ **splabo**（識別子 `com.splabo.app`）に統合されました。ギア機能は「ギア」タブとして取り込み済みです。旧 2 アプリのデータ（戦績 DB・ギア DB）は splabo 初回起動時に**非破壊コピー**で自動移行されます。

## アプリ

| アプリ | 役割 | ディレクトリ | ダウンロード |
|--------|------|--------------|--------------|
| **splabo** | Splatoon 3 の戦績ダッシュボード（バトル履歴・勝率分析・stat.ink 連携・AI 分析）＋所持ギアの取得・表示・コーデ生成 | [`apps/splabo`](apps/splabo) | https://chartoon.pages.dev/ |

関連（本リポジトリ外・別管理）:
- [geartoon-viewer](https://github.com/hiroshiyokoya/geartoon-viewer) — Android ギアビューワー（Kotlin + Jetpack Compose）。splabo が出力する暗号化 JSON を読む契約（gear-export-v1）のみを共有し、コードは統合しません。

## 構成

```
splabo/
├─ package.json            # npm workspaces（apps/splabo/app）
├─ Cargo.toml              # Cargo workspace + [workspace.dependencies]
├─ package-lock.json       # ルート一本化した lockfile
├─ apps/
│  └─ splabo/              # 統合アプリ（app/ + tools/nxapi-wrapper + docs/ + CHANGELOG.md）
│     ├─ app/              #   Tauri アプリ本体（Vite + React + recharts + Rust/SQLite）
│     │  ├─ src/           #     戦績（components/）＋ギア（gear/・.gear-root スコープ）
│     │  └─ src-tauri/     #     Rust（戦績＋ gear.rs / gear_crypto.rs / migration.rs）
│     └─ tools/            #   nxapi サイドカーのビルド環境
├─ docs/                   # GitHub Pages（chartoon.pages.dev）
└─ .github/workflows/      # CI（ci.yml）+ リリース（splabo-release.yml）
```

**共有の現状**: 認証トークンは識別子非依存の共有ディレクトリ `<config>/splatoon-gear/` に保存されます（識別子変更後も再ログイン不要）。nxapi サイドカーは `apps/splabo/tools/nxapi-wrapper` にあり、ルート `tools/` への昇格は未了（deferred）です。

## ビルド

npm workspaces + Cargo workspace 構成です。フロントエンド依存はルートで一括インストールします。

```bash
# 依存インストール（ルートで workspace 全体）
npm ci

# フロントエンド（tsc 型チェック + vite build）
npm run build -w apps/splabo/app

# Rust（workspace 全体の型チェック）
cargo check
```

### サイドカー（nxapi-wrapper）

各アプリの Tauri バックエンドは `binaries/nxapi-sidecar` を externalBin として要求します。ローカルビルドやリリース前には各アプリのサイドカーをビルドしてください（プラットフォーム別スクリプト: `build:win` / `build:mac-arm` / `build:linux`）。

```bash
# 例: Windows 向けサイドカー
cd apps/splabo/tools/nxapi-wrapper && npm ci && npm run build:win
```

### 開発起動

```bash
cd apps/splabo/app && npm run tauri dev
```

## リリース

単一 splabo タグでリリースします。タグを push すると GitHub Actions が走り、ドラフトリリースを作成します。

| アプリ | タグ | ワークフロー |
|--------|------|--------------|
| splabo | `splabo-vX.Y.Z` | `.github/workflows/splabo-release.yml` |

旧 per-app タグ（`chartoon-v*` / `geartoon-v*`）および monorepo 化以前の `vX.Y.Z` は凍結扱いで、ワークフローのトリガーからは外しています。

CHANGELOG は `apps/splabo/CHANGELOG.md` で継続します。

## 開発ルール

作業ルールはルートの [`CLAUDE.md`](CLAUDE.md)、アプリ固有の詳細は [`apps/splabo/CLAUDE.md`](apps/splabo/CLAUDE.md) を参照してください。

## ライセンス

各アプリのライセンスは `apps/*/LICENSE` を参照してください。
