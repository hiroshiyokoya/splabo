# チャートゥーン (chartoon)

Nintendo アカウントから [nxapi](https://github.com/samuelthomas2774/nxapi) が解析した非公式 API 経由で Splatoon 3 のバトル履歴を取得し、グラフで可視化する OSS の PC アプリです。任天堂株式会社とは無関係です。

```
chartoon/
└── app/         # Tauri アプリ本体（Vite + React + recharts + Rust）
    ├── src/         # フロントエンド（React + TypeScript）
    └── src-tauri/   # Rust バックエンド（Tauri + SQLite）
```

## 機能

- **ダッシュボード** — 武器別・モード別・ステージ別の勝率をグラフで表示
- **バトルログ** — バトル履歴を一覧表示（ページング対応）
- **AI 分析** — 自然言語でグラフを生成（OpenAI / Google Gemini 対応）
- **自動取得** — 指定時刻に毎日バトルデータをバックグラウンドで取得
- **システムトレイ常駐** — ウィンドウを閉じてもバックグラウンドで動作

## 必要なもの

| ツール          | 用途                          |
| ------------ | ----------------------------- |
| Node.js 20+  | アプリ開発・ビルド              |
| Rust + Cargo | Tauri デスクトップアプリのビルド |

Windows / macOS / Linux 対応（WSL 不要）。
動作確認済みは Windows。macOS・Linux は未検証。

---

## アプリ起動（開発）

```bash
cd app
npm install        # 初回のみ
npx tauri dev      # アプリ起動（初回は Rust のコンパイルで数分かかります）
```

## ローカルビルド（インストーラー生成）

```bash
cd app
npx tauri build    # インストーラーを生成（初回は Rust のフルビルドで数分かかります）
```

生成物は `app/src-tauri/target/release/bundle/` に出力されます（Windows: `.msi` / `.exe`、macOS: `.dmg`）。

---

## 技術メモ

### SplatNet 3 とは

**SplatNet 3** は、Nintendo Switch Online スマートフォンアプリが内部で使用している任天堂のサービスです。バトル履歴・ギア情報などを取得できる GraphQL API を持ちますが、公式には公開されていません。

[**nxapi**](https://github.com/samuelthomas2774/nxapi)（Samuel Thomas 氏が開発する OSS）は、このフローを解析し、サードパーティ製ツールから SplatNet 3 へアクセスする方法を明らかにしました。chartoon の認証実装はこの nxapi のフローを Rust で再実装したものです。

### 認証

Nintendo Switch Online (NSO) OAuth2 (PKCE) フローを Rust で実装（`src-tauri/src/auth.rs`）。nxapi が明らかにした認証フローに基づいています。f-token の生成には nxapi が内部で使用する `nxapi-znca-api.fancy.org.uk` エンドポイントを使用。

認証フロー（nxapi が解析したフロー）:
```
Nintendo Account ログインURL → ブラウザで開く（deep-link で認可コードを受け取る）
→ session_token（長期保存）
→ id_token → f-token (nxapi-znca-api) → Coral login → gtoken
→ bulletToken（SplatNet3 アクセス用、約2時間有効）
```

### データ保存

バトルデータは SQLite（`chartoon.db`）に保存されます。
主要フィールド（モード・武器・ステージ・K/D/A・塗りポイント等）は個別カラムで保持し、レスポンス全体は `raw_json` カラムに格納します。

### AI 分析

OpenAI (gpt-4o-mini 等) または Google Gemini に集計データを渡し、recharts で描画できる JSON（`ChartSpec`）を生成します。API キーは `localStorage` に保存されます。

---

## 注意事項

- 本ツールは個人の利用を目的としています。
- SplatNet 3 は任天堂が公式に公開している API ではありません。任天堂側の仕様変更により、予告なく動作しなくなる可能性があります。
- 認証情報はアプリの AppData ディレクトリにのみ保存されます（Windows: `%APPDATA%\com.chartoon.app\`、macOS: `~/Library/Application Support/com.chartoon.app/`）。コミットしないでください。
- アプリの UI は現状日本語のみです。

## プライバシーポリシー

本ツールが収集・使用する情報は以下の通りです。

### 収集する情報

- **Nintendo アカウントのセッショントークン（session_token）**
  - ローカルの AppData ディレクトリにのみ保存されます。
  - 外部サーバーへ送信・アップロードすることはありません。
- **バトル履歴データ**
  - SplatNet 3 から取得したバトルデータはローカルの SQLite DB にのみ保存されます。

### 外部サービスへの送信

- **nxapi-znca-api（`nxapi-znca-api.fancy.org.uk`）**: Nintendo 認証フローで必要な f-token を生成するため、nxapi の内部処理として `id_token` がこのエンドポイントへ送信されます。これは nxapi の仕様に基づくものであり、chartoon 独自の送信ではありません。詳細は [nxapi](https://github.com/samuelthomas2774/nxapi) を参照してください。
- **OpenAI / Google Gemini API**: AI 分析機能を使用する場合、バトル集計データ（個人を特定できないサマリー統計）がリクエストに含まれます。設定した API キーはローカルにのみ保存され、外部へ転送されません。
- 上記以外に、本ツールが独自に情報を外部送信することはありません。

### 個人情報の収集について

本ツールは、氏名・メールアドレス・位置情報などの個人情報を収集・記録・送信しません。

## 参考リポジトリ

Nintendo Switch Online 認証・SplatNet 3 API アクセスの実装に際して以下を参照しました。

- [samuelthomas2774/nxapi](https://github.com/samuelthomas2774/nxapi) — Nintendo Switch Online の認証・API アクセスライブラリ。chartoon の認証フローはこのプロジェクトが明らかにした仕様に基づいています。f-token 生成も nxapi が内部で使用するエンドポイント（`nxapi-znca-api.fancy.org.uk`）を利用します。

## 免責事項

本ソフトウェアは MIT License の下で無保証で提供されます。詳細は `LICENSE` を参照してください。

This project is not affiliated with or endorsed by Nintendo. "Splatoon" is a trademark of Nintendo Co., Ltd.

## 関連リポジトリ

- [geartoon](https://github.com/hiroshiyokoya/geartoon) — Splatoon 3 ギア検索・構成共有アプリ（Tauri + React）
- [geartoon-viewer](https://github.com/hiroshiyokoya/geartoon-viewer) — Android ビューワー（Kotlin + Jetpack Compose）

## License

[MIT](LICENSE)
