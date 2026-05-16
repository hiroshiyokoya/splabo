<img src="app/public/geartoon-logo.png" alt="geartoon" height="300">

これは、Splatoon 3 の所持ギアを閲覧・検索する非公式ファンツールです。任天堂株式会社とは無関係で、データ取得に [nxapi](https://github.com/samuelthomas2774/nxapi) を使用しています。

```
geartoon/
├── tools/   # データ取得パイプライン（Python）
└── app/     # ギア表示 UI（Vite + React + Tauri）
```

## スクリーンショット

| ギア一覧 | 絞り込み | コーデ生成 |
|---|---|---|
| ![ギア一覧](docs/screenshots/main.png) | ![絞り込み](docs/screenshots/filter.png) | ![コーデ生成](docs/screenshots/combo.png) |
| 614件のギアをタブ切り替えで一覧表示 | スキル・ブランド・アキ枠で絞り込み | 目標スキルからコーデ候補を自動生成 |

## 関連リポジトリ

- [geartoon-mobile](https://github.com/hiroshiyokoya/geartoon-mobile) — Android ビューワー（Kotlin + Jetpack Compose）

## 必要なもの

| ツール          | 用途                       |
| ------------ | -------------------------- |
| Node.js 20+  | アプリ開発・ビルド               |
| Rust + Cargo | Tauri デスクトップアプリのビルド     |

Windows / macOS / Linux 対応（WSL 不要）。
動作確認済みは Windows と macOS。Linux は未検証。

---

## tools/ — データパイプライン

Samuel Thomas 氏が開発する OSS である [nxapi](https://github.com/samuelthomas2774/nxapi)（任天堂非公式）を用いて、SplatNet 3 から所持ギア情報を取得します。

nxapi は Tauri サイドカーとしてアプリに同梱されており、**アプリ内の「データ更新」ボタンから直接データを取得できます**（Docker 不要）。`tools/` 配下のスクリプトは開発・デバッグ用です。

### セットアップ

```bash
cd tools

# Docker イメージをビルド
docker compose build

# Nintendo Account 認証（初回のみ）
python3 scripts/nxapi.py nso auth
```

### ギア DB を更新する（1コマンド）

```bash
cd tools
python3 scripts/update.py
```

内部で以下の 3 ステップを順番に実行します：

1. SplatNet 3 API から所持ギアデータを取得 → `data/data/splatnet3/splatnet3-equipment.json`
2. ギア・スキル画像をダウンロード → `data/images/`
3. 構造化 DB JSON を生成 → `data/gear_db.json`

### CLI ツール

```bash
cd tools

# ギア検索（スキル・ブランド・カテゴリ・レアリティで絞り込み）
# スタック型スキルは「スキル名:最低AP」形式で AP 閾値を指定可能（AP 高い順に表示）
python3 scripts/find_gear.py --skill インク回復力アップ
python3 scripts/find_gear.py --skill "インク回復力アップ:13"
python3 scripts/find_gear.py --skill "インク回復力アップ:10" --category clothing
python3 scripts/find_gear.py --skill インク回復力アップ --main
python3 scripts/find_gear.py --brand アナアキ --category clothing
python3 scripts/find_gear.py --category head --list

# スキル構成の自動生成（目標 AP を満たす頭・服・靴の組み合わせを探索）
# スタック型は「スキル名:目標AP」。発動型（メイン専用・カムバック等）は名前のみ（10AP 固定として解釈）
python3 scripts/find_combo.py --list-skills
python3 scripts/find_combo.py "カムバック" "スペシャル増加量アップ:6"
python3 scripts/find_combo.py "インク回復力アップ:20" --limit 5

# nxapi コマンドのラッパ
python3 scripts/nxapi.py nso user
python3 scripts/nxapi.py splatnet3 dump-records data/splatnet3
```

### ギアパワー（AP）

ギアパワーは **57 点法**で数えます（1 着あたりメイン 10 + サブ 3×3 = 19AP、頭・服・靴で最大 57AP）。`find_combo` やアプリの絞り込みはこの前提に合わせています。

### gear_db.json のフォーマット

```json
{
  "head":     [ { "id", "name", "rarity", "brand", "image", "primary_skill", "additional_skills", "exp" }, ... ],
  "clothing": [ ... ],
  "shoes":    [ ... ]
}
```

---

## app/ — Web UI

所持ギアの一覧・絞り込み・スキル構成生成を GUI で操作できるアプリです。表示用データは `tools/data/` に置かれた `gear_db.json` と画像を参照します（未生成なら先に tools を実行）。

### 機能

- ギア一覧（頭 / 服 / 靴タブ切り替え）
- 並び替え（ブランド / メインパワー / 名前 / レアリティ / EXP）
- 絞り込みドロワー（右スライド、すりガラス風半透明UI）
  - **発動型**: タブ対応スキルをシングルセレクト（カムバック・ステルスジャンプ等）
  - **スタック型**: 最低 pt をステッパーで指定
  - **ブランド**: マルチセレクト
- **コーデ機能**（画面下部ボトムシート、ドラッグで開閉）
  - 頭 / 服 / 靴ギアをそれぞれ選択してスロットにセット
  - 選択ギアの合計 AP を自動集計・表示
  - 目標スキルを指定してコーデ生成（AP プール制約を考慮した候補探索）
    - 発動型スキル（メインスロット専用）の選択数に応じて、スタック型の割り当て可能 AP が自動調整される
    - 達成可能な AP 値のみステッパーで選択できる（`stepUp` / `stepDown` が `aAvail` を考慮）
  - 候補リストからワンタップでスロットに適用
- デザイントークン管理（`index.css` の `:root` にぼかし・透明度・レイアウト値を集約）
  - ボトムシートのカラーテーマを変数で切り替え可能（A=パープル / B=ネイビー+オレンジ / C=グリーン / D=ダークオレンジ）

### 開発サーバー起動

```bash
cd app
npm install
npm run dev
```

---

## 参考リポジトリ

Nintendo Switch Online 認証・SplatNet 3 API アクセスの実装に際して以下を参照しました。

- [samuelthomas2774/nxapi](https://github.com/samuelthomas2774/nxapi) — Nintendo Switch Online の認証・API アクセスライブラリ。本プロジェクトの認証基盤として使用。
- [misenhower/splatoon3.ink](https://github.com/misenhower/splatoon3.ink) — nxapi + Docker による SplatNet 3 データ取得の実装例として参照。
- [imink-app/f-API](https://github.com/imink-app/f-API) — Nintendo 認証に必要な f-token 生成 API。nxapi はかつてこの API を使用していたが、現在は独自エンドポイント（nxapi-znca-api）へ移行済み。

## 技術メモ

- **nxapi バージョン**: `1.6.1-next.254`（プレリリース）を使用。安定版では f-token 生成エンドポイント（nxapi-znca-api）への認証ができないため。
- **`nxapi-remote-config.json`**: Nintendo が Coral 3.3.0 に更新したことで、公式の live remote-config が `coral: null` となり認証をブロックするようになった。そのためパッチ済み設定を Docker イメージに同梱している。
- **f-token 生成**: nxapi が内部で使用する `nxapi-znca-api.fancy.org.uk` エンドポイントで生成。かつて使用されていた imink API（`api.imink.app`）は現在サービスが停止している。
- **所有ギア取得**: nxapi CLI に直接のコマンドはないため、`MyOutfitCommonDataEquipmentsQuery` を Node.js スクリプトから直接呼び出している。
- **Tauri 認証実装**: Nintendo OAuth (PKCE) は Rust で実装（`app/src-tauri/src/auth.rs`）。f-token 生成は nxapi サイドカー経由で行う（Issue [#39](https://github.com/hiroshiyokoya/geartoon/issues/39) 実装済み）。

## 注意事項

- 本ツールは個人の利用を目的としています。
- SplatNet 3 は任天堂が公式に公開している API ではありません。任天堂側の仕様変更により、予告なく動作しなくなる可能性があります。
- SplatNet 3 からダウンロードされるギア・スキル画像の著作権は任天堂株式会社に帰属します。これらの画像は個人利用の範囲内でのみ使用し、再配布・商用利用・二次創作物への無断使用は行わないでください。
- `tools/data/persist/` 配下の認証情報ファイルにはトークン類が含まれるため、コミットしないでください（`.gitignore` で除外済み）。
- 認証に使用する Nintendo アカウントの情報はローカルにのみ保存されます。外部サーバーへの送信は nxapi の仕様に準じます。
- アプリのUIは、現状日本語のみです。

## プライバシーポリシー

本ツールが収集・使用する情報は以下の通りです。

### 収集する情報

- **Nintendo アカウントのセッショントークン（session_token）および各種アクセストークン**
  - ローカルの `tools/data/persist/` ディレクトリにのみ保存されます。
  - 外部サーバーへ送信・アップロードすることはありません。

### 外部サービスへの送信

- **nxapi-znca-api（`nxapi-znca-api.fancy.org.uk`）**：Nintendo 認証フローで必要な f-token を生成するため、nxapi の内部処理として `id_token` がこのエンドポイントへ送信されます。これは nxapi の仕様に基づくものであり、geartoon 独自の送信ではありません。詳細は [nxapi](https://github.com/samuelthomas2774/nxapi) を参照してください。
- 上記以外に、本ツールが独自に情報を外部送信することはありません。

### 個人情報の収集について

本ツールは、氏名・メールアドレス・位置情報などの個人情報を収集・記録・送信しません。

## 免責事項

本ソフトウェアは MIT License の下で無保証で提供されます。詳細は `LICENSE` を参照してください。

This project is not affiliated with or endorsed by Nintendo. "Splatoon" is a trademark of Nintendo Co., Ltd.

## License

[MIT](LICENSE)
