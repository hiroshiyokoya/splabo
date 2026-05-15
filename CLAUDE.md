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

### Claude Code（Mac上で直接アクセス）の場合

Claude CodeはMacのファイルシステムに直接アクセスするため、sync問題は発生しない。
bashからのgit操作（add・commit・push等）を Claude Code が直接実行してよい。

| 操作 | 方法 |
|------|------|
| git add / commit / push | Claude Code が bash から実行してよい |
| git log / diff / status | Claude Code が bash から実行してよい |
