# splabo - Claude 作業ルール

このファイルは **splabo リポジトリの splabo 固有の運用詳細**（CI・リリースルーチン・旧コード参照・最新状況確認・依存方針・deferred）を記述する。

- **エージェント共通の運用ルール**（実装前の方針確認・PR フロー・並行作業・イシュー/トラッキング #15 更新・リポ構成・ビルドコマンド・CHANGELOG 要点・実装ハマりどころ）は **[`AGENTS.md`](./AGENTS.md) に集約**。まずそちらを読む。
- **個人全体の共通ルール**（`cd && git` 回避・ファイル操作・git 安全則など）は `~/.claude/CLAUDE.md` を参照。

> **v0.8 統合済み:** 旧 chartoon（戦績）と geartoon（ギア）は 1 バイナリ **splabo**（識別子 `com.splabo.app`・単一リポ）に統合済み。ギア機能は「ギア」タブとして取り込み済み。旧 2 識別子（`com.chartoon.app` / `com.geartoon.app`）のデータは起動時に非破壊コピーで移行される（`app/src-tauri/src/migration.rs`）。`gh -R` はすべて `hiroshiyokoya/splabo`。
>
> **スマホで見る（スマホ Web 版・v0.12.0〜）:** 同じ LAN のスマホのブラウザに、PC から画面とデータを配る。サーバーは `app/src-tauri/src/companion.rs`（静的ファイル・Cookie 認証・更新命令）、コマンドの中継は `app/src-tauri/src/web_api.rs`（許可リスト）、画面は `app/mobile.html`・`app/src/mobile/`。設計は #784。旧 Android アプリ splabo-viewer はやめた（リポはアーカイブ済み・連携コードは #830 で削除）。

---

## workspace 依存の方針

リポ構成・ビルドコマンドは [`AGENTS.md`](./AGENTS.md) を参照。依存バージョンは splabo 固有の以下に従う。

- **Rust**: `Cargo.toml` の `[workspace.dependencies]`（tauri 2.11.1 系）に寄せる。crate 側は `{ workspace = true, features = [...] }` で参照する。
- **フロント**: npm workspaces（ルート一本化 lockfile）。依存インストールはルートで `npm ci` を一度だけ。
- **UI 文言**: 新規は `app/src/i18n/locales/{ja,en}.json` のキー経由（#688）。表示言語は設定の「表示言語」。

---

## CI とリリース（単一 splabo タグ）

### CI（`.github/workflows/ci.yml`）

develop への push / PR で走る。`dorny/paths-filter` で `app/**` / `tools/**` またはルート共通ファイル（`package.json` / `package-lock.json` / `Cargo.toml` / `Cargo.lock` / `ci.yml`）に変更があれば frontend build（tsc + vite）と、Rust の `cargo clippy --all-targets -- -D warnings`（警告で落とす）・`cargo test --lib` を実行する（#536）。

### リリース

単一 splabo タグでリリースする。**develop へ直接タグを打たず、下記リリースルーチンに従う。** タグ push はユーザーが実施する。

| タグ | ワークフロー |
|------|--------------|
| `splabo-vX.Y.Z` | `.github/workflows/splabo-release.yml` |

- 旧 per-app タグ（`chartoon-v*` / `geartoon-v*`）および monorepo 化以前の `vX.Y.Z` は凍結扱い。トリガーには含めない。
- **ライセンス（#534）**: 本体は MIT、`tools/nxapi-wrapper`（nxapi の改変版を含むサイドカー）は AGPL-3.0-or-later。配布物に入る部品のライセンス一覧 `app/public/third-party-licenses.txt` は、リリース WF が各 OS のビルドの前に `tools/licenses/generate.mjs` で作り直す。リポジトリの版は手元（Windows）で作ったもので、依存を大きく変えたときは手元でも作り直す（サイドカーのビルド済み `dist/bundle.cjs` が要る）。
- **古いリリースを消してもタグは消さない**。AGPL のサイドカーの「対応するソース」を、各版のタグで入手できるようにしておくため。
- CHANGELOG は ルート `CHANGELOG.md`。

---

## リリースルーチン

リリース作業を依頼されたとき（または「リリース準備して」と言われたとき）は、以下を順番に確認・実施する。

いつ・どの単位で出すか（定期リリースと緊急リリース・マイルストーンの運用）は [`AGENTS.md`](./AGENTS.md) の「リリースの区切り方」に従う。版を出したら、そのマイルストーンを閉じて次の版のマイルストーンを作る。

### 1. CHANGELOG.md を更新

CHANGELOG の書き方の要点は [`AGENTS.md`](./AGENTS.md) 参照。リリース時の手順は以下。

- **先に `[Unreleased]` を整理する**（版番号に切り替える前）
  - このバージョンの開発期間内で追加→修正まで完結した記述は削除する（前バージョン利用者には見えない変更）
  - 重複や細目は要約し、利用者に見える差分だけ残す
- `[Unreleased]` セクションをバージョン番号と日付に変更する
  ```
  ## [X.Y.Z] — YYYY-MM-DD
  ```
- 新しい `[Unreleased]` セクションを先頭に追加する
- **前回タグからの差分のみを書く**（既存の出荷済みエントリには触らない）。`git log <prev-tag>..develop` で粒度を確認
- **イシュー番号・PR 番号 (`#123` 等) は書かない**

### 2. README.md を確認

- 機能説明・注意事項が最新か確認
- 大きな変更があれば更新

### 2b. リリース前スモーク（#540）

タグを打つ前に、[`docs/release-checklist.md`](./docs/release-checklist.md) を出荷バイナリ（または同等の release ビルド）で確認する。開発ビルドだけでは足りない。

### 2c. リリース準備 PR では版を触らない（#900）

リポジトリの版（`X.Y.Z-dev`）は、**リリース準備 PR では上げない**。上げるのはタグを push したあと（下の「5. リリースのあと」）。準備 PR の中で上げると、準備 PR だけ先にマージしてタグを打たないあいだ、まだ出していない版の次を dev 版が名乗ってしまう。

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

**リリース準備の PR を出したら、タグ打ちのコマンドを毎回コピペできる形で出す。** 版番号は実際の値で埋め、develop に切り替えて最新にする行から書く（リリース準備のあと、メインのフォルダは `release/vX.Y.Z` のままになっているため）。そのまま貼って実行できるように、1 つのコードブロックにまとめる。

```bash
git -C D:/develop/splatoon-gear/splabo checkout develop
git -C D:/develop/splatoon-gear/splabo pull
git -C D:/develop/splatoon-gear/splabo tag splabo-v0.12.2
git -C D:/develop/splatoon-gear/splabo push origin splabo-v0.12.2
```

定期リリースなら、このコマンドと一緒に「タグを push したら、版上げの PR（下の 5）を出す」ことも伝える。

ビルドが終わったら GitHub でドラフトを **Publish** する。Publish すると Slack に X 用の告知文が届く（#648）。2 通目のコードブロックをコピーして X に貼る（改行付き、#704）。プレリリースでは飛ばない。タグ push や CI 完了だけでは飛ばない。

**英語版の投稿も作る（#688 以降、英語 UI 対応済みのため）。** CHANGELOG.md は日本語一本のまま維持し（英語版 CHANGELOG は作らない）、Slack に届いた日本語の投稿文をその都度英訳する。自動化はせず、リリースのたびに Claude が訳す。

- 見出し・CTA・ハッシュタグは固定で対応させる：「更新内容」→「What's new」、「ダウンロードはプロフィールからどうぞ。」→「Download link in profile.」、`#スプラトゥーン3 #Splatoon3 #SpLabo` → `#Splatoon3 #SpLabo`（日本語タグは落とす）
- 箇条書きは日本語版の要約と同じ粒度で英訳する（Query 名等の実装詳細は出さない）
- X の加重文字数 280 に収める（`.github/scripts/x_release_post.py` の `tweet_weight()` と同じ考え方：ASCII は 1、非 ASCII は 2）
- 日本語版と同じ投稿にスレッド返信として続ける、または独立した投稿として出す（アカウント運用次第、ユーザーに確認）

### 5. リリースのあと（#900・定期リリースのみ）

**定期リリースのタグを push したら、すぐに次の 2 つをする。** 緊急リリース（パッチ）ではしない（develop はすでに次の定期リリースの版を名乗っているため）。

#### 5a. dev 版の版を次のマイナーの `-dev` に上げる

リポジトリの版は「次に出す版-dev」（#898）。`X.Y.0` を出したら `X.(Y+1).0-dev` にする（例: 1.0.0 を出したら `1.1.0-dev`、1.1.0 を出したら `1.2.0-dev`）。dev 版はこの版を名乗り、stat.ink にもコミット ID を付けた版（`v1.1.0-dev+c0d78c3`・#904）で送る。出荷物の版はタグからリリース WF が書き込むので、ここでの版は出荷物に影響しない。

- 書き換える 3 つ: `app/src-tauri/Cargo.toml` の `[package] version`・`app/src-tauri/tauri.conf.json` の `version`・`app/package.json` の `version`
- ロックファイルは手で直さず、ツールで作り直す（`package-lock.json` と `Cargo.lock` の splabo の行が 1 行ずつ変わる）
- Issue は立てない（リリース準備 PR と同じ扱い）。ブランチは `chore/dev-version-X.Y.0`、PR タイトルは `chore: dev 版の版を X.Y.0-dev に上げる`
- **差分は上の 5 ファイルだけ**。CHANGELOG には書かない（利用者に見えない）

エージェントが作業するときの手順（例: 1.0.0 を出したあと）:

```bash
git fetch origin develop
git checkout -b chore/dev-version-1.1.0 origin/develop
# 3 ファイルの "1.0.0-dev" を "1.1.0-dev" に置き換える
npm install --package-lock-only --ignore-scripts          # ルートで。package-lock.json を作り直す
cargo metadata --format-version 1 --offline > /dev/null   # Cargo.lock を作り直す（PowerShell では > $null）
git diff --stat   # 5 ファイル・各 1 行だけ変わっていることを確かめる
git commit -am "chore: dev 版の版を 1.1.0-dev に上げる"
git push -u origin chore/dev-version-1.1.0
```

マージ後、dev 版を起動し直すと版表示が `1.1.0-dev (コミット ID)` になる。

#### 5b. マイルストーンを切り替える

- 出した版のマイルストーンを閉じる（開いた Issue が残っていたら、次の版かバックログへ移してから）
- 次の版のマイルストーン（例: `v1.1.0`）を作り、説明にテーマ 1 行、締め日（due date）を入れる。中身はバックログから 3〜6 件を選ぶ（AGENTS.md「リリースの区切り方」）
- トラッキング #15 に、出した版の節（リリース日）と次の版の節を足す

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

トラッキング #15 の更新手順は [`AGENTS.md`](./AGENTS.md) 参照。クローズ済みイシューは GitHub が自動的に取り消し線を引くため、トラッキング側で `[x]` を付ける必要はない。

---

## deferred（未了・将来対応）

- **完全サイドカー廃止**: nxapi サイドカー（`tools/nxapi-wrapper`）は bullet_token 生成に必要。ZNCA 3.4.0 ＋リクエスト暗号化による Rust 単独化（サイドカー完全撤廃）は別件 stretch（Phase 0b）。※置き場所のルート昇格（`app` と同階層 `tools/`）は #264 で完了済み。
