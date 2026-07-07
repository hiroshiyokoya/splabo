# splabo monorepo - Claude 作業ルール（ルート）

このファイルは **splabo monorepo 全体に共通する作業ルール** を記述する。個人全体の共通ルール（実装前の構想確認・ブランチ/PR フロー・コミット前確認・イシューラベル付け・`cd && git` 回避・ファイル操作・git 安全則）は `~/.claude/CLAUDE.md` を参照。アプリ固有のルール（リリースルーチン・トラッキングイシュー番号・参照先など）は [`apps/splabo/CLAUDE.md`](apps/splabo/CLAUDE.md) を参照。

> **v0.8 統合済み:** 旧 chartoon（戦績）と geartoon（ギア）は 1 バイナリ **splabo**（識別子 `com.splabo.app`・単一 `apps/splabo`）に統合済み。旧 2 識別子（`com.chartoon.app` / `com.geartoon.app`）のデータは起動時に非破壊コピーで移行される。`gh -R` はすべて `hiroshiyokoya/splabo`。

---

## リポジトリ構成

```
splabo/
├─ package.json / package-lock.json   # npm workspaces（ルート一本化 lockfile）
├─ Cargo.toml / Cargo.lock            # Cargo workspace + [workspace.dependencies]
├─ apps/splabo/    # 統合アプリ（app/ + tools/ + docs/ + CHANGELOG.md + CLAUDE.md）
│                  #   戦績（chartoon 由来）＋ギア（geartoon 由来・「ギア」タブ）
├─ docs/            # GitHub Pages
└─ .github/workflows/  # ci.yml / splabo-release.yml
```

`gh` 操作は常に `-R hiroshiyokoya/splabo` を付ける。

---

## workspace ビルド

フロントエンドは npm workspaces、Rust は Cargo workspace で管理する。**依存インストールはルートで `npm ci` を一度だけ**（各 `apps/*/app` で個別 `npm ci` はしない）。

```bash
npm ci                            # ルートで workspace 全体
npm run build -w apps/splabo/app  # tsc + vite build
cargo check                       # workspace 全体の Rust 型チェック
```

- npm の script は `-w apps/splabo/app` で対象 workspace を指定して呼ぶ。
- 依存のバージョンは `Cargo.toml` の `[workspace.dependencies]`（tauri 2.11.1 系）に寄せる。crate 側は `{ workspace = true, features = [...] }` で参照する。

---

## CI とリリース（単一 splabo タグ）

### CI（`.github/workflows/ci.yml`）

develop への push / PR で走る。`dorny/paths-filter` で `apps/splabo/**` またはルート共通ファイル（`package.json` / `package-lock.json` / `Cargo.toml` / `Cargo.lock` / `ci.yml`）に変更があれば frontend build（tsc + vite）と `cargo check` を実行する。

### リリース

単一 splabo タグでリリースする。**develop へ直接タグを打たず、リリース準備は [`apps/splabo/CLAUDE.md`](apps/splabo/CLAUDE.md) のリリースルーチンに従う。** タグ push はユーザーが実施する。

| アプリ | タグ | ワークフロー |
|--------|------|--------------|
| splabo | `splabo-vX.Y.Z` | `splabo-release.yml` |

- 旧 per-app タグ（`chartoon-v*` / `geartoon-v*`）および monorepo 化以前の `vX.Y.Z` は凍結扱い。トリガーには含めない（WF も削除済み）。
- CHANGELOG は `apps/splabo/CHANGELOG.md`。

---

## deferred（未了・将来対応）

- **サイドカー統一**: nxapi サイドカーは `apps/splabo/tools/nxapi-wrapper` にある。ルート `tools/` への昇格（1 系統化）は未了（F #245 予定）。
- **完全サイドカー廃止**: ZNCA 3.4.0＋リクエスト暗号化による Rust 単独化は別件 stretch。

---

## 個別アプリの詳細

- 参照先・リリースルーチン・トラッキング #15 → [`apps/splabo/CLAUDE.md`](apps/splabo/CLAUDE.md)
