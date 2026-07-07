# splabo - Claude 作業ルール

このファイルは **splabo アプリ固有のルール** のみ記述する。共通ルール（実装前の構想確認・ブランチ/PR フロー・コミット前確認・イシューラベル付け・`cd && git` 回避・ファイル操作・git 安全則）は `~/.claude/CLAUDE.md` を参照。

> **v0.8 統合済み:** 旧 chartoon（戦績）と geartoon（ギア）を 1 バイナリ **splabo**（識別子 `com.splabo.app`）に統合した。ギア機能は「ギア」タブとして splabo に取り込み済み。旧 `com.chartoon.app` / `com.geartoon.app` のデータは起動時に非破壊コピーで移行される（`src-tauri/src/migration.rs`）。

---

## 旧 geartoon コードの参照

ギア機能は splabo に移植済み（フロント `app/src/gear/`・Rust `gear.rs` / `gear_crypto.rs`）。移植元の旧 geartoon 単体アプリの実装を参照したい場合は GitHub API で取得できる。

**リポジトリ:** `hiroshiyokoya/geartoon`（統合済みのアーカイブ扱い）

```bash
# ファイル一覧
gh api repos/hiroshiyokoya/geartoon/contents/<path> | python3 -c "import sys,json; [print(x['name']) for x in json.load(sys.stdin)]"

# ファイル内容
gh api repos/hiroshiyokoya/geartoon/contents/<path> --jq '.content' | base64 -d
```

### 主な構成

| 対象 | パス |
|------|-----------------|
| nxapi サイドカー | `tools/nxapi-wrapper/` |
| Tauri 設定 | `app/src-tauri/tauri.conf.json` |
| Rust バックエンド構成 | `app/src-tauri/src/`（戦績＋ `gear.rs` / `gear_crypto.rs`） |
| React コンポーネント構成 | `app/src/components/`（戦績）・`app/src/gear/`（ギア） |
| CSS 設計・カラーパレット | `app/src/App.css`・`app/src/gear/gear.css`（`.gear-root` スコープ） |

---

## 最新状況確認

「最新状況を確認して」「現状どう？」など状態確認を依頼されたら、**必ず最初にローカルとリモートを同期**してから答える。stale なローカル状態で答えると古いタグ・ブランチを見落として、二度手間になる。

```bash
git fetch --all --tags --prune
git checkout develop && git pull origin develop
```

その上で:
- `git tag --list`（リモートから fetch 済みのタグ含む）
- GitHub MCP で open な PR / Issue を取得
- トラッキング #15 を読み直す

`~/.claude/CLAUDE.md` の共通ルールに集約予定（要転記）。

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

```
git -C D:/develop/splatoon-gear/splabo checkout -b release/vX.Y.Z
# ファイル編集後（CHANGELOG は apps/splabo/CHANGELOG.md）
git -C D:/develop/splatoon-gear/splabo add apps/splabo/CHANGELOG.md apps/splabo/README.md
git -C D:/develop/splatoon-gear/splabo commit -m "chore: リリース準備 vX.Y.Z"
git -C D:/develop/splatoon-gear/splabo push origin release/vX.Y.Z
gh pr create -R hiroshiyokoya/splabo --base develop --title "chore: リリース準備 vX.Y.Z" --body "..."
```

**PR のマージはユーザーが行う。**

### 4. タグ打ち（ユーザーが実施）

リリースは単一 `splabo-vX.Y.Z` タグ（`.github/workflows/splabo-release.yml` がトリガー）。ユーザーが develop ブランチで以下を実行：
```
git tag splabo-vX.Y.Z
git push origin splabo-vX.Y.Z
```

---

## ブランチ命名

イシュー番号に対応するブランチを作成: `feature/<番号>-<簡潔な名前>`（例: `feature/1-dashboard`）。
