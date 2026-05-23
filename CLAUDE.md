# chartoon - Claude作業ルール

## 実装前に構想を確認すること

**ユーザーの発言が提案・ディスカッションなのか、実装依頼なのかを判断すること。**

曖昧な場合は実装を始めず、まず方針を確認する。以下のような発言はディスカッションとみなし、合意が取れてから実装に入る。

- 「〜したらどうかな？」
- 「〜がいいと思うんだけど」
- 「〜って可能？」
- 「〜はどう思う？」

**実装・PRの作成は、ユーザーが「やって」「実装して」「作って」など明示的に依頼したときのみ行う。**

### 変更をまとめる

関連する小さな変更は1つのブランチ・PRにまとめる。マージ後すぐに修正PRが必要にならないよう、実装前に変更の全体像を把握してから着手する。

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
| **参考にして独自実装** | UI コンポーネントや機能がチャートゥーン固有の場合 |

### 主な参照先

| 対象 | geartoon でのパス |
|------|-----------------|
| nxapi サイドカー | `tools/nxapi-wrapper/` |
| Tauri 設定 | `app/src-tauri/tauri.conf.json` |
| Rust バックエンド構成 | `app/src-tauri/src/` |
| React コンポーネント構成 | `app/src/components/` |
| CSS 設計・カラーパレット | `app/src/App.css` |

---

## ファイル確認は必ず Read ツールを使うこと

**bashでファイル内容を確認してはいけない。**

| 操作 | 使うツール |
|------|-----------|
| ファイル内容の確認 | **Read**（絶対） |
| ファイルの編集 | **Edit / Write** |
| ファイル一覧・検索 | bash の `ls`・`find`・`grep` はOK |
| TypeScript型チェック | bash の `cd app && tsc --noEmit` はOK |
| コンパイル・ビルド | bash はOK（`cd app` してから実行） |

---

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

`tracking` ラベルのついたイシュー（現在: **#15**）は Claude が常に最新の状態に保つ。

### 🚨 `gh issue create` と トラッキング更新は**セットの操作**

**新しい Issue を立てたら、その直後に必ずトラッキングイシューにも追記する**。
別タスクに移る前に、1 つのアクションとして必ずセットで実行すること。トラッキング更新を後回しにすると忘れる。

```bash
# 1) Issue を立てる
gh issue create --title "..." --label "..." --body "..."
# → 出力された URL から Issue 番号を控える（例: 94）

# 2) 直後にトラッキング #15 へ追記する
gh issue view 15 --json body --jq .body > /tmp/tracking.md
# /tmp/tracking.md を編集して該当マイルストーンに「- #94 タイトル」を追記
gh api repos/hiroshiyokoya/chartoon/issues/15 -X PATCH -F body=@/tmp/tracking.md
```

### その他の更新タイミング

- **イシューのマイルストーンを変更**したとき → リスト内の位置を移動する
- **セッション開始時にリポジトリ状況を確認**したとき → ズレがあれば修正する

クローズ済みイシューは GitHub 側で自動的に取り消し線が引かれるため、トラッキング側で `[x]` を付ける必要はない。

---

## リリースルーチン

リリース作業を依頼されたとき（または「リリース準備して」と言われたとき）は、以下を順番に確認・実施する。

### 1. CHANGELOG.md を更新

- `[Unreleased]` セクションをバージョン番号と日付に変更する
  ```
  ## [X.Y.Z] — YYYY-MM-DD
  ```
- 新しい `[Unreleased]` セクションを先頭に追加する

### 2. README.md を確認

- 機能説明・注意事項が最新か確認
- 大きな変更があれば更新

### 3. ブランチ・PR を作成してマージ

```
git checkout -b release/vX.Y.Z
# ファイル編集後
git add CHANGELOG.md README.md
git commit -m "chore: リリース準備 vX.Y.Z"
git push origin release/vX.Y.Z
gh pr create --base develop --title "chore: リリース準備 vX.Y.Z" --body "..."
```

**PRのマージはユーザーが行う。**

### 4. タグ打ち（ユーザーが実施）

ユーザーが develop ブランチで以下を実行：
```
git tag vX.Y.Z
git push origin vX.Y.Z
```

---

## ブランチ・PRのルール

**イシューに対する作業は、必ずブランチを切ってからPRでマージすること。`develop` への直接コミットは禁止。**

**作業前に必ず `git pull` して最新状態にしてからブランチを切ること。**

**ユーザーに「developに直接でいい」と言われても従わないこと。ブランチ・PRのフローを必ず守る。**

### フロー

1. イシュー番号に対応するブランチを作成: `feature/<番号>-<簡潔な名前>`
2. ブランチ上で作業・コミット
3. `gh pr create` でPRを作成し、`develop` へマージ
4. イシューをクローズ

```
git checkout -b feature/1-example
# ... 作業（アプリ本体の変更は app/ 以下） ...
git push origin feature/1-example
gh pr create --base develop --title "feat: 〇〇 (#1)" --body "Closes #1"
```

### 注意

- 小さな作業でもブランチを切る
- PRのタイトルにイシュー番号を含める（例: `feat: ダッシュボード (#1)`）
- **PR の本文に必ず `Closes #<イシュー番号>` を含める。** マージ時にイシューが自動クローズされる。
- **PRのマージはユーザーが行う。** Claude は `gh pr merge` を実行しない。
- **PR 作成後にコミットを追加したら、必ず PR の本文を最新の変更内容に合わせて更新すること。**
  ```bash
  gh pr edit <番号> --body "..."
  ```

### コミット前のブランチ確認

**コミット前に必ず以下を確認すること：**

```
git branch --show-current
```

`develop` と表示された場合は、目的の feature ブランチに切り替えてからコミットする。

---

## git操作

Claude Code はホストのファイルシステムに直接アクセスするため、bashからのgit操作（add・commit・push等）を直接実行してよい。

| 操作 | 方法 |
|------|------|
| git add / commit / push | Claude Code が bash から実行してよい |
| git log / diff / status | Claude Code が bash から実行してよい |
