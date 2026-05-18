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
