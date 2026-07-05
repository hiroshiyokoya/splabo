# chartoon - Claude 作業ルール

このファイルは **chartoon 固有のルール** のみ記述する。共通ルール（実装前の構想確認・ブランチ/PR フロー・コミット前確認・イシューラベル付け・`cd && git` 回避・ファイル操作・git 安全則）は `~/.claude/CLAUDE.md` を参照。

> **リポジトリ名とアプリ名の乖離について:** GitHub リポジトリ名は `splabo` にリネーム済み（リポ参照 URL・`gh -R` はすべて `hiroshiyokoya/splabo`）。一方、アプリ名／プロダクト名（ウィンドウタイトル・ロゴ・README 見出しなど）および識別子 `com.chartoon.app` は当面 `chartoon` のまま据え置く。

---

## geartoon を参考にすること

chartoon と同じ作者が開発する Tauri + React アプリ。構成・実装・UI/UX のいずれも geartoon を第一の参考にし、転用できるものは積極的に転用する。

**リポジトリ:** `hiroshiyokoya/geartoon`（ローカルにない場合は GitHub API で取得）

```bash
# ファイル一覧
gh api repos/hiroshiyokoya/geartoon/contents/<path> | python3 -c "import sys,json; [print(x['name']) for x in json.load(sys.stdin)]"

# ファイル内容
gh api repos/hiroshiyokoya/geartoon/contents/<path> --jq '.content' | base64 -d
```

### 転用・参照の優先順位

| 判断 | ケース |
|------|--------|
| **そのまま転用** | ほぼ同じ課題（ビルドスクリプト・設定ファイル・CI など） |
| **改変して転用** | 目的は同じだが chartoon 向けに調整が必要（サイドカー・認証フローなど） |
| **参考にして独自実装** | UI コンポーネントや機能が chartoon 固有の場合 |

### 主な参照先

| 対象 | geartoon でのパス |
|------|-----------------|
| nxapi サイドカー | `tools/nxapi-wrapper/` |
| Tauri 設定 | `app/src-tauri/tauri.conf.json` |
| Rust バックエンド構成 | `app/src-tauri/src/` |
| React コンポーネント構成 | `app/src/components/` |
| CSS 設計・カラーパレット | `app/src/App.css` |

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
git -C D:/develop/splatoon-gear/chartoon checkout -b release/vX.Y.Z
# ファイル編集後
git -C D:/develop/splatoon-gear/chartoon add CHANGELOG.md README.md
git -C D:/develop/splatoon-gear/chartoon commit -m "chore: リリース準備 vX.Y.Z"
git -C D:/develop/splatoon-gear/chartoon push origin release/vX.Y.Z
gh pr create -R hiroshiyokoya/splabo --base develop --title "chore: リリース準備 vX.Y.Z" --body "..."
```

**PR のマージはユーザーが行う。**

### 4. タグ打ち（ユーザーが実施）

ユーザーが develop ブランチで以下を実行：
```
git tag vX.Y.Z
git push origin vX.Y.Z
```

---

## ブランチ命名

イシュー番号に対応するブランチを作成: `feature/<番号>-<簡潔な名前>`（例: `feature/1-dashboard`）。
