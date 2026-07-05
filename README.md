# splabo

Splatoon 3 の非公式 API 系デスクトップアプリ **chartoon**（戦績）と **geartoon**（ギア）を束ねた monorepo です。任天堂株式会社とは無関係で、データ取得に [nxapi](https://github.com/samuelthomas2774/nxapi) を使用しています。

> **リポジトリ名とアプリ名について:** GitHub リポジトリ名は `splabo` ですが、アプリ名／プロダクト名・識別子（`com.chartoon.app` / `com.geartoon.app`）は当面 **chartoon・geartoon の個別名のまま**据え置きます。両アプリを 1 バイナリ `splabo` に統合するのは将来（v2.0）の予定です。

## アプリ

| アプリ | 役割 | ディレクトリ | ダウンロード |
|--------|------|--------------|--------------|
| **chartoon** | Splatoon 3 の戦績ダッシュボード（バトル履歴・勝率分析・stat.ink 連携・AI 分析） | [`apps/chartoon`](apps/chartoon) | https://chartoon.pages.dev/ |
| **geartoon** | 所持ギアの取得・表示・コーデ生成 | [`apps/geartoon`](apps/geartoon) | https://geartoon.pages.dev/ |

関連（本リポジトリ外・別管理）:
- [geartoon-viewer](https://github.com/hiroshiyokoya/geartoon-viewer) — Android ギアビューワー（Kotlin + Jetpack Compose）。geartoon が出力する暗号化 JSON を読む契約のみを共有し、コードは統合しません。

## 構成

```
splabo/
├─ package.json            # npm workspaces（apps/*/app）
├─ Cargo.toml              # Cargo workspace + [workspace.dependencies]
├─ package-lock.json       # ルート一本化した lockfile
├─ apps/
│  ├─ chartoon/            # 戦績アプリ（app/ + tools/nxapi-wrapper + docs/ + CHANGELOG.md）
│  │  ├─ app/              #   Tauri アプリ本体（Vite + React + recharts + Rust/SQLite）
│  │  └─ tools/            #   nxapi サイドカーのビルド環境
│  └─ geartoon/            # ギアアプリ（app/ + tools/nxapi-wrapper + docs/ + CHANGELOG.md）
│     ├─ app/              #   Tauri アプリ本体（Vite + React + Rust）
│     └─ tools/            #   nxapi サイドカーのビルド環境
├─ docs/                   # chartoon の GitHub Pages（chartoon.pages.dev）
└─ .github/workflows/      # CI（ci.yml）+ per-app リリース（chartoon-release.yml / geartoon-release.yml）
```

**共有の現状**: 認証トークンは識別子非依存の共有ディレクトリ `<config>/splatoon-gear/` を両アプリで共用します。Rust の認証コード・nxapi サイドカーは現状まだ各 `apps/*/tools/` に重複しており、**共有 crate 化・サイドカー統一は未了（deferred）** です（設計上は `crates/splatnet-client` へ抽出予定）。

## ビルド

npm workspaces + Cargo workspace 構成です。フロントエンド依存はルートで一括インストールします。

```bash
# 依存インストール（ルートで workspace 全体）
npm ci

# フロントエンド（tsc 型チェック + vite build）
npm run build -w apps/chartoon/app
npm run build -w apps/geartoon/app

# Rust（workspace 全体の型チェック）
cargo check
```

### サイドカー（nxapi-wrapper）

各アプリの Tauri バックエンドは `binaries/nxapi-sidecar` を externalBin として要求します。ローカルビルドやリリース前には各アプリのサイドカーをビルドしてください（プラットフォーム別スクリプト: `build:win` / `build:mac-arm` / `build:linux`）。

```bash
# 例: chartoon の Windows 向けサイドカー
cd apps/chartoon/tools/nxapi-wrapper && npm ci && npm run build:win
```

### 開発起動

```bash
# 例: chartoon
cd apps/chartoon/app && npm run tauri dev
```

## リリース

per-app のタグ prefix でリリースします。タグを push すると対応アプリの GitHub Actions が走り、ドラフトリリースを作成します。

| アプリ | タグ | ワークフロー |
|--------|------|--------------|
| chartoon | `chartoon-vX.Y.Z` | `.github/workflows/chartoon-release.yml` |
| geartoon | `geartoon-vX.Y.Z` | `.github/workflows/geartoon-release.yml` |

旧 `vX.Y.Z` タグ（monorepo 化以前の chartoon リリース）は凍結扱いで、ワークフローのトリガーからは外しています。

CHANGELOG は各アプリで継続します（`apps/chartoon/CHANGELOG.md` / `apps/geartoon/CHANGELOG.md`）。

## 開発ルール

作業ルールはルートの [`CLAUDE.md`](CLAUDE.md)、アプリ固有の詳細は各 [`apps/chartoon/CLAUDE.md`](apps/chartoon/CLAUDE.md) / [`apps/geartoon/CLAUDE.md`](apps/geartoon/CLAUDE.md) を参照してください。

## ライセンス

各アプリのライセンスは `apps/*/LICENSE` を参照してください。
