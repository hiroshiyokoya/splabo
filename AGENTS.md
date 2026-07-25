# AGENTS.md — splabo エージェント共通ガイド

このファイルは **Cursor・Claude Code など、リポジトリで作業するすべての AI エージェント向けの共通ルール** をまとめる。Cursor は `CLAUDE.md` を自動では読まないため、外しやすい要点をここに集約する。

- **Claude Code 向けの正典は [`CLAUDE.md`](./CLAUDE.md)**（＋個人共通の `~/.claude/CLAUDE.md`）。詳細・背景はそちらを必ず参照する。
- ここに書かれた要点と `CLAUDE.md` が食い違う場合は `CLAUDE.md` を優先する。

---

## 実装前に方針を確認する

ユーザーの発言が **提案・相談** なのか **実装依頼** なのかを判断する。曖昧なら実装を始めず、まず方針を確認する。「〜したらどう？」「〜って可能？」は相談。「やって」「実装して」「作って」と明示されたときだけ実装・PR に入る。

---

## ブランチ・PR フロー（最重要）

**`develop` への直接コミットは禁止。すべての作業はブランチを切って PR でマージする。**

1. 作業前に `git pull` で最新化してからブランチを切る
2. ブランチ命名: `feature/<イシュー番号>-<簡潔な名前>`（例: `feature/451-agents-md`）
3. 1 イシュー = 1 ブランチ = 1 PR。関連する小さな変更はまとめる
4. PR タイトルにイシュー番号を含める（例: `feat: ダッシュボード (#1)`）
5. **PR 本文に必ず `Closes #<イシュー番号>` を含める**（マージ時に自動クローズ）
6. **PR のマージはユーザーが行う。エージェントは `gh pr merge` を実行しない**
7. PR 作成後にコミットを追加したら、PR 本文を最新の変更内容へ更新する

`gh` は常に `-R hiroshiyokoya/splabo` を付ける。

### Cursor と Claude が同時に作業しうる（必須）

ユーザーは **Cursor と Claude Code を並行して** 同じリポジトリで使うことがある。片方の作業がもう片方のブランチ・ワーキングツリー・リモートを壊さないこと。

- **自分が切った feature ブランチだけ**を編集・コミットする。`develop` や他エージェントのブランチに直接触らない
- コミット／push／ブランチ切替の直前に必ず `git status` / `git branch` を確認する。想定外の変更・別ブランチにいたら止めてユーザーに確認する
- 他エージェントが作った未コミット変更・stash・別ブランチのコミットを **巻き戻さない・上書きしない・勝手に取り込み直さない**
- `git checkout` / `git pull` / `git rebase` / `git stash` は、今の作業ツリーを汚さないと確認してから。迷ったら実行前に聞く
- 同じイシューを両方が触っていないか、着手前にブランチ一覧と open PR を確認する

### PR / イシューの状態は記憶で語らず毎回 `gh` で確認する

ユーザーはターミナルで随時マージしている。「マージ待ち」と報告する前・次の作業に着手する前・マージ済み PR に追記しようとする前には、必ず現物を確認する。

```bash
gh pr list -R hiroshiyokoya/splabo --state open --json number,title
gh pr view <番号> -R hiroshiyokoya/splabo --json state,mergedAt
```

---

## イシュー管理

`gh issue create` 時は **`--label` と `--milestone` を必ず指定**する。主なラベル: `bug` / `feature` / `enhancement` / `refactor` / `ui` / `infra` / `docs` / `maintenance` / `tracking`。

### 新イシュー作成後の必須セット操作

新しいイシューを立てたら、同じ流れで **トラッキングイシュー #15** の該当マイルストーン節へ `- #<番号> タイトル` を追記する（子アイテムはチェックボックスではなく単純な箇条書き）。

```bash
gh issue view 15 -R hiroshiyokoya/splabo --json body --jq .body > /tmp/tracking.md
# 該当マイルストーン節に「- #<番号> タイトル」を追記
gh api repos/hiroshiyokoya/splabo/issues/15 -X PATCH -F body=@/tmp/tracking.md
```

---

## リポジトリ構成とビルド

```
splabo/
├─ package.json / package-lock.json   # npm workspaces（ルート一本化 lockfile）
├─ Cargo.toml / Cargo.lock            # Cargo workspace
├─ app/             # Tauri アプリ本体（src/ フロント + src-tauri/ Rust）
├─ tools/           # nxapi サイドカーのビルド環境
├─ docs/            # GitHub Pages
└─ .github/         # workflows + release-footer.md
```

依存インストールは **ルートで `npm ci` を一度だけ**（`app/` で個別 `npm ci` はしない）。

```bash
npm ci                     # ルートで workspace 全体
npm run build -w app       # フロント: tsc + vite build
cargo check                # workspace 全体の Rust 型チェック
```

- Windows では Node.js が PATH に無いことがある（`$env:ProgramFiles\nodejs` を前置する）。
- npm script は `-w app` で対象 workspace を指定して呼ぶ。

---

## CHANGELOG ルール

CHANGELOG は **前回リリースを使っていた人が、今回何が変わるか** を読むもの。ルート `CHANGELOG.md` に書く。

- **前回タグからの差分のみ**を書く（既存の出荷済みエントリには触らない）。
- **イシュー番号・PR 番号は書かない**（エンドユーザー向けに内部参照は不要）。
- **利用者が見ていない変更は書かない**: そのリリース内で追加した機能の不具合修正、リリースビルドで非表示の機能は載せない。
- 出荷済みリリースの項に後日談（「※この後 vX.Y で修正」等）を書き足さない。続報は新しいリリース項にだけ書く。
- **リリース準備時に `[Unreleased]` を整理する**: 開発中に積み上がった条目をそのまま版番号にしない。
  - **バージョン内で完結した話は消す**（例: 同バージョン開発中に入れた機能の不具合を、同じ Unreleased 期間内で直した場合。前バージョン利用者から見ると「何も起きていない」）。
  - 重複・細かすぎる条目は要約してまとめる。利用者に見える差分だけ残す。

---

## 実装メモ・ハマりどころ

コード上の非自明な落とし穴を記録する。追記歓迎。

- **Recharts v3 の `activeTooltipIndex` 型変更**: v3 で型が `number | string | null` に変わり、`type="number"` 軸では文字列/`null` が返る。`typeof idx === 'number'` でガードすると常に false になり、`onMouseMove` 連動の自前ツールチップが表示されなくなる（#443 の回帰原因）。実時間軸の折れ線では Recharts 標準の `<Tooltip content={...}>` を使うほうが堅牢。
- **Recharts v3 の `<Tooltip content>` の payload は readonly**（`ReadonlyArray`）。`Array<{...}>` 型に代入すると `TS2322`。props 型は `ReadonlyArray<...>` にする。

---

## その他

- ファイル確認・検索・編集は各エディタ/エージェントの専用ツールを優先（bash の `cat`/`find`/`grep` を避ける）。
- 破壊的な git 操作（`reset --hard` / `push --force` / `branch -D` / `clean -f` 等）はユーザーの明示指示があるまで行わない。
- `--no-verify` でフックを skip しない（フックが失敗したら根本原因を直す）。
