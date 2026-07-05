# splabo monorepo - Claude 作業ルール（ルート）

このファイルは **splabo monorepo 全体に共通する作業ルール** を記述する。個人全体の共通ルール（実装前の構想確認・ブランチ/PR フロー・コミット前確認・イシューラベル付け・`cd && git` 回避・ファイル操作・git 安全則）は `~/.claude/CLAUDE.md` を参照。アプリ固有のルール（リリースルーチン・トラッキングイシュー番号・参照先など）は各 [`apps/chartoon/CLAUDE.md`](apps/chartoon/CLAUDE.md) / [`apps/geartoon/CLAUDE.md`](apps/geartoon/CLAUDE.md) を参照。

> **リポジトリ名とアプリ名の乖離:** GitHub リポジトリ名は `splabo`（リポ参照 URL・`gh -R` はすべて `hiroshiyokoya/splabo`）。アプリ名／プロダクト名・識別子（`com.chartoon.app` / `com.geartoon.app`）は当面 chartoon・geartoon の個別名のまま据え置く。1 バイナリ `splabo` への統合（識別子 `com.splabo.app`）は v2.0 の予定。

---

## リポジトリ構成

```
splabo/
├─ package.json / package-lock.json   # npm workspaces（ルート一本化 lockfile）
├─ Cargo.toml / Cargo.lock            # Cargo workspace + [workspace.dependencies]
├─ apps/chartoon/   # 戦績アプリ（app/ + tools/ + docs/ + CHANGELOG.md + CLAUDE.md）
├─ apps/geartoon/   # ギアアプリ（app/ + tools/ + docs/ + CHANGELOG.md + CLAUDE.md）
├─ docs/            # chartoon の GitHub Pages
└─ .github/workflows/  # ci.yml / chartoon-release.yml / geartoon-release.yml
```

`gh` 操作は常に `-R hiroshiyokoya/splabo` を付ける。

---

## workspace ビルド

フロントエンドは npm workspaces、Rust は Cargo workspace で管理する。**依存インストールはルートで `npm ci` を一度だけ**（各 `apps/*/app` で個別 `npm ci` はしない）。

```bash
npm ci                              # ルートで workspace 全体
npm run build -w apps/chartoon/app  # tsc + vite build
npm run build -w apps/geartoon/app  # tsc -b + vite build
cargo check                         # workspace 全体の Rust 型チェック
```

- npm の script は `-w apps/<app>/app` で対象 workspace を指定して呼ぶ。
- 共有依存のバージョンは `Cargo.toml` の `[workspace.dependencies]`（tauri 2.11.1 系）に寄せる。crate 側は `{ workspace = true, features = [...] }` で参照する。

---

## CI とリリース（per-app タグ prefix）

### CI（`.github/workflows/ci.yml`）

develop への push / PR で走る。`dorny/paths-filter` で変更のあったアプリのみ frontend build（tsc + vite）と `cargo check` を実行する。ルート共通ファイル（`package.json` / `package-lock.json` / `Cargo.toml` / `Cargo.lock` / `ci.yml`）の変更時は両アプリともチェックする。

### リリース（per-app）

アプリごとにタグ prefix を分けてリリースする。**develop へ直接タグを打たず、リリース準備は各アプリの CLAUDE.md のリリースルーチンに従う。** タグ push はユーザーが実施する。

| アプリ | タグ | ワークフロー |
|--------|------|--------------|
| chartoon | `chartoon-vX.Y.Z` | `chartoon-release.yml` |
| geartoon | `geartoon-vX.Y.Z` | `geartoon-release.yml` |

- 旧 `vX.Y.Z` タグ（monorepo 化以前の chartoon）は凍結扱い。ワークフローのトリガーには含めない。
- v2.0 統合後は単一 `vX.Y.Z`（splabo）へ移行予定。
- CHANGELOG は各 `apps/*/CHANGELOG.md` で継続（v2.0 でルート 1 本へ統合予定）。

---

## deferred（未了・将来対応）

以下は monorepo 化 Phase 2 の対象外。設計書（`splabo-phase1-design.md`）の Phase 3 以降で対応する。

- **サイドカー統一**: nxapi サイドカーは現状まだ各 `apps/*/tools/nxapi-wrapper` に重複。ルート `tools/` の 1 系統への統一は未了。
- **共有 crate 抽出**: 認証（auth.rs）・GraphQL（splatnet3.rs）を `crates/splatnet-client` へ抽出するのは未了。両アプリの Rust 認証コードは現状フォーク状態。
- **識別子統一 / 単一バイナリ化**: `com.splabo.app` / 統合シェル `apps/splabo` は v2.0。

---

## 個別アプリの詳細

- 戦績アプリの参照先・リリースルーチン・トラッキング #15 → [`apps/chartoon/CLAUDE.md`](apps/chartoon/CLAUDE.md)
- ギアアプリの作業環境別 git 注意・リリースルーチン・トラッキング #101 → [`apps/geartoon/CLAUDE.md`](apps/geartoon/CLAUDE.md)
