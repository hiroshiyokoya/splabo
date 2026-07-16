# splabo - Claude 作業ルール

このファイルは **splabo リポジトリの作業ルール** を記述する。個人全体の共通ルール（実装前の構想確認・ブランチ/PR フロー・コミット前確認・イシューラベル付け・`cd && git` 回避・ファイル操作・git 安全則）は `~/.claude/CLAUDE.md` を参照。

> **v0.8 統合済み:** 旧 chartoon（戦績）と geartoon（ギア）は 1 バイナリ **splabo**（識別子 `com.splabo.app`・単一リポ）に統合済み。ギア機能は「ギア」タブとして取り込み済み。旧 2 識別子（`com.chartoon.app` / `com.geartoon.app`）のデータは起動時に非破壊コピーで移行される（`app/src-tauri/src/migration.rs`）。`gh -R` はすべて `hiroshiyokoya/splabo`。
>
> **モバイルコンパニオン対応:** 同一 LAN のモバイルアプリ [splabo-viewer](https://github.com/hiroshiyokoya/splabo-viewer)（別リポ・Android/Kotlin）へギア・直近バトルを配信する。コンパニオン同期サーバー（`app/src-tauri/src/companion.rs`）と battle_db エクスポート（`app/src-tauri/src/battle_export.rs`）を担当。連携はエクスポート契約（gear-export-v1 / battle-export-v1）＋共有フィクスチャのみで、コードは統合しない。設計の正典は `splabo-viewer-design.md`、トラッキングは #15 の「モバイルコンパニオン対応」節。

---

## リポジトリ構成

```
splabo/
├─ package.json / package-lock.json   # npm workspaces（ルート一本化 lockfile）
├─ Cargo.toml / Cargo.lock            # Cargo workspace + [workspace.dependencies]
├─ app/             # Tauri アプリ本体（src/ フロント + src-tauri/ Rust）
│                   #   戦績（chartoon 由来）＋ギア（geartoon 由来・「ギア」タブ）
├─ tools/           # nxapi サイドカーのビルド環境（nxapi-wrapper）
├─ docs/            # GitHub Pages（chartoon.pages.dev）
└─ .github/         # workflows（ci.yml / splabo-release.yml）+ release-footer.md
```

`gh` 操作は常に `-R hiroshiyokoya/splabo` を付ける。

---

## workspace ビルド

フロントエンドは npm workspaces、Rust は Cargo workspace で管理する。**依存インストールはルートで `npm ci` を一度だけ**（`app/` で個別 `npm ci` はしない）。

```bash
npm ci                     # ルートで workspace 全体
npm run build -w app       # tsc + vite build
cargo check                # workspace 全体の Rust 型チェック
```

- npm の script は `-w app` で対象 workspace を指定して呼ぶ。
- 依存のバージョンは `Cargo.toml` の `[workspace.dependencies]`（tauri 2.11.1 系）に寄せる。crate 側は `{ workspace = true, features = [...] }` で参照する。

---

## CI とリリース（単一 splabo タグ）

### CI（`.github/workflows/ci.yml`）

develop への push / PR で走る。`dorny/paths-filter` で `app/**` / `tools/**` またはルート共通ファイル（`package.json` / `package-lock.json` / `Cargo.toml` / `Cargo.lock` / `ci.yml`）に変更があれば frontend build（tsc + vite）と `cargo check` を実行する。

### リリース

単一 splabo タグでリリースする。**develop へ直接タグを打たず、下記リリースルーチンに従う。** タグ push はユーザーが実施する。

| タグ | ワークフロー |
|------|--------------|
| `splabo-vX.Y.Z` | `.github/workflows/splabo-release.yml` |

- 旧 per-app タグ（`chartoon-v*` / `geartoon-v*`）および monorepo 化以前の `vX.Y.Z` は凍結扱い。トリガーには含めない。
- CHANGELOG は ルート `CHANGELOG.md`。

---

## リリースルーチン

リリース作業を依頼されたとき（または「リリース準備して」と言われたとき）は、以下を順番に確認・実施する。

### 1. CHANGELOG.md を更新

- `[Unreleased]` セクションをバージョン番号と日付に変更する
  ```
  ## [X.Y.Z] — YYYY-MM-DD
  ```
- 新しい `[Unreleased]` セクションを先頭に追加する
- **前回タグからの差分のみを書く**（既存のリリースエントリには触らない）。`git log <prev-tag>..develop` で粒度を確認
- **イシュー番号・PR 番号 (`#123` 等) は書かない**。エンドユーザー向け release notes に内部リファレンスは不要

### 2. README.md を確認

- 機能説明・注意事項が最新か確認
- 大きな変更があれば更新

### 3. ブランチ・PR を作成してマージ

```bash
git -C D:/develop/splatoon-gear/splabo checkout -b release/vX.Y.Z
git -C D:/develop/splatoon-gear/splabo add CHANGELOG.md README.md
git -C D:/develop/splatoon-gear/splabo commit -m "chore: リリース準備 vX.Y.Z"
git -C D:/develop/splatoon-gear/splabo push origin release/vX.Y.Z
gh pr create -R hiroshiyokoya/splabo --base develop --title "chore: リリース準備 vX.Y.Z" --body "..."
```

**PR のマージはユーザーが行う。**

### 4. タグ打ち（ユーザーが実施）

リリースは単一 `splabo-vX.Y.Z` タグ（`splabo-release.yml` がトリガー）。ユーザーが develop ブランチで以下を実行：
```bash
git tag splabo-vX.Y.Z
git push origin splabo-vX.Y.Z
```

---

## 旧 geartoon コードの参照

ギア機能は splabo に移植済み（フロント `app/src/gear/`・Rust `app/src-tauri/src/gear.rs` / `gear_crypto.rs`）。移植元の旧 geartoon 単体アプリの実装を参照したい場合は GitHub API で取得できる。

**リポジトリ:** `hiroshiyokoya/geartoon`（統合済みのアーカイブ扱い）

```bash
# ファイル一覧
gh api repos/hiroshiyokoya/geartoon/contents/<path> | python3 -c "import sys,json; [print(x['name']) for x in json.load(sys.stdin)]"
# ファイル内容
gh api repos/hiroshiyokoya/geartoon/contents/<path> --jq '.content' | base64 -d
```

---

## 最新状況確認

「最新状況を確認して」「現状どう？」など状態確認を依頼されたら、**必ず最初にローカルとリモートを同期**してから答える。stale なローカル状態で答えると古いタグ・ブランチを見落として、二度手間になる。

```bash
git fetch --all --tags --prune
git checkout develop && git pull origin develop
```

その上で: `git tag --list` / open な PR・Issue の取得 / トラッキング #15 の読み直し。

---

## トラッキングイシュー

`tracking` ラベルのついたイシュー（**#15**）は Claude が常に最新の状態に保つ。

新しい Issue を立てたら、直後にトラッキング #15 へ追記すること（共通ルール「`gh issue create` とトラッキング更新はセット」参照）。

```bash
gh issue view 15 -R hiroshiyokoya/splabo --json body --jq .body > /tmp/tracking.md
# 編集して該当マイルストーンに「- #<番号> タイトル」を追記
gh api repos/hiroshiyokoya/splabo/issues/15 -X PATCH -F body=@/tmp/tracking.md
```

クローズ済みイシューは GitHub が自動的に取り消し線を引くため、トラッキング側で `[x]` を付ける必要はない。

---

## ブランチ命名

イシュー番号に対応するブランチを作成: `feature/<番号>-<簡潔な名前>`（例: `feature/1-dashboard`）。

---

## deferred（未了・将来対応）

- **完全サイドカー廃止**: nxapi サイドカー（`tools/nxapi-wrapper`）は bullet_token 生成に必要。ZNCA 3.4.0 ＋リクエスト暗号化による Rust 単独化（サイドカー完全撤廃）は別件 stretch（Phase 0b）。※置き場所のルート昇格（`app` と同階層 `tools/`）は #264 で完了済み。
