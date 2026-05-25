# geartoon - Claude 作業ルール

このファイルは **geartoon 固有のルール** のみ記述する。共通ルール（実装前の構想確認・ブランチ/PR フロー・コミット前確認・イシューラベル付け・`cd && git` 回避・ファイル操作・git 安全則）は `~/.claude/CLAUDE.md` を参照。

---

## 作業環境別の git 操作

geartoon は Cowork（Windows マウント経由）と Claude Code（ローカル直接アクセス）の両方で作業されうる。**環境によって bash の git 操作可否が変わる**ので注意。

### Cowork（Windows マウント経由）

**bash から git コマンドを実行してはいけない。**

bash のマウント経由で git を実行すると、Windows ホスト上の実際のファイルと同期がズレた状態でコミットされることがある（編集済みのファイルが古い状態でコミットされるなど）。

| 操作 | 方法 |
|------|------|
| git add / commit / push | **ユーザーが Windows ターミナル（PowerShell）から実行** |
| git log / diff / status の確認 | **ユーザーが Windows ターミナル（PowerShell）から実行** |
| コミットメッセージの作成 | Claude が提案し、ユーザーが貼り付けて実行 |

### Claude Code（ローカルに直接アクセスする環境）

Claude Code はホストのファイルシステムに直接アクセスするため sync 問題は発生しない。bash からの git 操作（add・commit・push 等）を Claude Code が直接実行してよい（共通ルール「`cd && git` 回避」に従い `git -C <path>` 形式を使う）。

---

## Cowork でのファイル確認の注意

Cowork で `mcp__workspace__bash` 経由でマウントされたファイル（`/sessions/.../mnt/geartoon/`）を `cat`・`tail`・`xxd` 等で読むと、ホスト上の実際のファイルと内容が一致しないことがある（sync 遅延・文字化け・バイナリ解釈）。

「ファイルが途中で切れている」「壊れている」と誤判断して正常なファイルを破損させる事故が複数回発生したので、**ファイル内容の確認は必ず Read ツール**を使う（共通ルールでも記載済みだが、Cowork では特に厳守）。

---

## トラッキングイシュー

`tracking` ラベルのついたイシュー（**#101**）は Claude が常に最新の状態に保つ。

**運用方針:**
- **単一のトラッキングイシューに全マイルストーンを統合**する。マイルストーン（v1.0 / v1.1 / v1.2 / v1.3 / maintenance など）ごとにセクションを分け、過去の完了マイルストーンも履歴として残す。
- イシューの状態は GitHub が自動で付けるオープン／クローズのマークで判別するため、本文中に **アイコンやチェックボックスは付けない**。
- クローズされたイシューも履歴として残す。

新しい Issue を立てたら、直後にトラッキング #101 へ追記すること（共通ルール「`gh issue create` とトラッキング更新はセット」参照）。

```bash
gh issue view 101 -R hiroshiyokoya/geartoon --json body --jq .body > /tmp/tracking.md
# 編集して該当マイルストーンに「- #<番号> タイトル」を追記
gh api repos/hiroshiyokoya/geartoon/issues/101 -X PATCH -F body=@/tmp/tracking.md
```

---

## リリースルーチン

リリース作業を依頼されたとき（または「リリース準備して」と言われたとき）は、以下を順番に確認・実施する。

### 1. CHANGELOG.md を更新

- `[Unreleased]` セクションをバージョン番号と日付に変更する
  ```
  ## [X.Y.Z] — YYYY-MM-DD
  ```
- 新しい `[Unreleased]` セクションを先頭に追加する

### 2. docs/index.html（GitHub Pages）を確認・更新

| 箇所 | 確認内容 |
|------|---------|
| `できること` フィーチャーカード | 新機能が追加されていれば記載を更新 |
| スクリーンショット | 大きな UI 変更があれば `docs/screenshots/` の画像を差し替え |
| 説明文 | 機能の説明が現状と合っているか |

変更なければスキップしてよい。

### 3. README.md を確認

- 機能説明・注意事項・技術メモが最新か確認
- 大きな変更があれば更新

### 4. ブランチ・PR を作成してマージ

```
git -C D:/develop/splatoon-gear/geartoon checkout -b release/vX.Y.Z
# ファイル編集後
git -C D:/develop/splatoon-gear/geartoon add CHANGELOG.md docs/index.html README.md  # 変更したもののみ
git -C D:/develop/splatoon-gear/geartoon commit -m "chore: リリース準備 vX.Y.Z"
git -C D:/develop/splatoon-gear/geartoon push origin release/vX.Y.Z
gh pr create -R hiroshiyokoya/geartoon --base develop --title "chore: リリース準備 vX.Y.Z" --body "..."
```

**PR のマージはユーザーが行う。**

### 5. タグ打ち（ユーザーが実施）

ユーザーが develop ブランチで以下を実行：
```
git tag vX.Y.Z
git push origin vX.Y.Z
```

→ GitHub Actions が自動でビルド・ドラフトリリース作成まで行う。

### 6. ドラフトリリースの確認（ユーザーが実施）

- GitHub の Releases ページでドラフトを確認
- リリースノートの内容を確認
- 問題なければ「Publish release」を押す

### 7. GitHub Pages の確認

- マージ後、数分で GitHub Pages が更新される
- `https://geartoon.pages.dev/` を開いて確認

---

## ブランチ命名

イシュー番号に対応するブランチを作成: `feature/<番号>-<簡潔な名前>`（例: `feature/11-tauri-setup`）。
