# geartoon - Claude作業ルール

## ファイル確認は必ず Read ツールを使うこと

**bashでファイル内容を確認してはいけない。**

`mcp__workspace__bash` でマウントされたWindowsファイル（`/sessions/.../mnt/geartoon/`）を `cat`・`tail`・`xxd` 等で読むと、ホスト上の実際のファイルと内容が一致しないことがある（sync遅延・文字化け・バイナリ解釈の問題）。

これにより「ファイルが途中で切れている」「ファイルが壊れている」と誤判断し、正常なファイルに不要な編集を加えて実際に破損させてしまう事故が複数回発生した。

### ルール

| 操作 | 使うツール |
|------|-----------|
| ファイル内容の確認 | **Read**（絶対） |
| ファイルの編集 | **Edit / Write** |
| ファイル一覧・検索 | bash の `ls`・`find`・`grep` はOK |
| TypeScript型チェック | bash の `tsc --noEmit` はOK |
| コンパイル・ビルド | bash はOK |

ファイルの中身を見たいときは、bashを使わず必ず `Read` ツールを使う。

## イシュー管理ルール

### イシューを立てるときは必ずラベルを付ける

`gh issue create` 時に `--label` で適切なラベルを指定する。

| ラベル | 用途 |
|--------|------|
| `bug` | 不具合修正 |
| `feature` | 新機能 |
| `enhancement` | 既存機能の改善 |
| `refactor` | リファクタリング |
| `ui` | UI/UX の変更 |
| `infra` | CI/CD・ビルド |
| `docs` | ドキュメント |
| `tracking` | 複数イシューをまとめるトラッキングイシュー |
| `maintenance` | 保守・ライブラリ追従 |

### トラッキングイシューを常に最新に保つ

`tracking` ラベルのついたイシュー（現在: #52）は Claude が常に最新の状態に保つ。

**更新するタイミング:**
- イシューがクローズされたとき → チェックボックスを `[x]` にする
- 新しいイシューがマイルストーンに追加されたとき → リストに追記する
- セッション開始時にリポジトリ状況を確認したとき → ズレがあれば修正する

**更新方法:**
```bash
gh api repos/hiroshiyokoya/geartoon/issues/<番号> -X PATCH -f body="..."
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

以下の箇所が最新かチェックする：

| 箇所 | 確認内容 |
|------|---------|
| `できること` フィーチャーカード | 新機能が追加されていれば記載を更新 |
| スクリーンショット | 大きなUI変更があれば `docs/screenshots/` の画像を差し替え |
| 説明文 | 機能の説明が現状と合っているか |

変更なければスキップしてよい。

### 3. README.md を確認

- 機能説明・注意事項・技術メモが最新か確認
- 大きな変更があれば更新

### 4. ブランチ・PR を作成してマージ

```
git checkout -b release/vX.Y.Z
# ファイル編集後
git add CHANGELOG.md docs/index.html README.md  # 変更したもののみ
git commit -m "chore: リリース準備 vX.Y.Z"
git push origin release/vX.Y.Z
gh pr create --base develop --title "chore: リリース準備 vX.Y.Z" --body "..."
```

**PRのマージはユーザーが行う。**

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
- `https://hiroshiyokoya.github.io/geartoon/` を開いて確認

---

## ブランチ・PRのルール

**イシューに対する作業は、必ずブランチを切ってからPRでマージすること。`develop` への直接コミットは禁止。**

### フロー

1. イシュー番号に対応するブランチを作成: `feature/<番号>-<簡潔な名前>`
2. ブランチ上で作業・コミット
3. `gh pr create` でPRを作成し、`develop` へマージ
4. イシューをクローズ

```
git checkout -b feature/11-tauri-setup
# ... 作業 ...
git push origin feature/11-tauri-setup
gh pr create --base develop --title "..." --body "..."
```

### 注意

- 小さな作業でもブランチを切る
- PRのタイトルにイシュー番号を含める（例: `feat: Tauriセットアップ (#11)`）
- **PR の本文に必ず `Closes #<イシュー番号>` を含める。** マージ時にイシューが自動クローズされる。
- **PRのマージはユーザーが行う。** Claude は `gh pr merge` を実行しない。

### ブランチが切り替わっている問題への対策

**ユーザーはターミナルで `git checkout develop && git pull` を実行することがある。**
これにより、Claude が feature ブランチを作成した後でも、ローカルのカレントブランチが `develop` に戻ってしまう。

**コミット前に必ず以下を確認すること：**

```
git branch --show-current
```

`develop` と表示された場合は、目的の feature ブランチに切り替えてからコミットする：

```
git checkout feature/<ブランチ名>
git add ...
git commit ...
```

---

## git操作

git操作のルールは、作業環境によって異なる。

### Cowork（Windowsマウント経由）の場合

**bashからgitコマンドを実行してはいけない。**

bashのマウント経由でgitを実行すると、Windowsホスト上の実際のファイルと同期がズレた状態でコミットされることがある（編集済みのファイルが古い状態でコミットされるなど）。

| 操作 | 方法 |
|------|------|
| git add / commit / push | **ユーザーがWindowsターミナル（PowerShell）から実行** |
| git log / diff / status の確認 | **ユーザーがWindowsターミナル（PowerShell）から実行** |
| コミットメッセージの作成 | Claude が提案し、ユーザーが貼り付けて実行 |

### Claude Code（ローカルに直接アクセスする環境）の場合

Claude Code はホストのファイルシステムに直接アクセスするため、sync問題は発生しない。
bashからのgit操作（add・commit・push等）を Claude Code が直接実行してよい。

| 操作 | 方法 |
|------|------|
| git add / commit / push | Claude Code が bash から実行してよい |
| git log / diff / status | Claude Code が bash から実行してよい |
