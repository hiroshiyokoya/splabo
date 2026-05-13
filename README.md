<img src="app/public/geartoon-logo.png" alt="geartoon" height="300">

Splatoon 3 の所持ギアを管理・検索するデスクトップアプリです。

```
geartoon/
├── tools/   # データ取得パイプライン（Docker + Python）
└── app/     # ギア管理 UI（Vite + React → Tauri）
```

## 関連リポジトリ

- [geartoon-mobile](https://github.com/hiroshiyokoya/geartoon-mobile) — Android ビューワー（Kotlin + Jetpack Compose）

## 必要なもの

| ツール | 用途 |
|---|---|
| Docker Desktop | SplatNet 3 API アクセス（nxapi） |
| Python 3.10+ | データ処理スクリプト |
| Node.js 18+ | Web UI の開発・ビルド |
| Rust + Cargo | Tauri デスクトップアプリ化（後で追加） |

Windows / macOS / Linux 対応（WSL 不要）。

---

## tools/ — データパイプライン

SplatNet 3 から所持ギア情報を取得し、ローカルに JSON DB と画像を揃えます。

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
python3 scripts/update.py
```

内部で以下の 3 ステップを順番に実行します：

1. SplatNet 3 API から所持ギアデータを取得 → `data/data/splatnet3/splatnet3-equipment.json`
2. ギア・スキル画像をダウンロード → `data/images/`
3. 構造化 DB JSON を生成 → `data/gear_db.json`

### CLI ツール

```bash
# ギア検索（スキル・ブランド・カテゴリ・レアリティで絞り込み）
python3 scripts/find_gear.py --skill カムバック
python3 scripts/find_gear.py --skill カムバック --main
python3 scripts/find_gear.py --brand アナアキ --category clothing
python3 scripts/find_gear.py --category head --list

# スキル構成の自動生成（目標 AP を満たす頭・服・靴の組み合わせを探索）
python3 scripts/find_combo.py --list-skills
python3 scripts/find_combo.py "カムバック:10" "スペシャル増加量アップ:6"
python3 scripts/find_combo.py "インク回復力アップ:20" --limit 5

# nxapi コマンドのラッパ
python3 scripts/nxapi.py nso user
python3 scripts/nxapi.py splatnet3 dump-records data/splatnet3
```

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

所持ギアの一覧・検索・スキル構成生成を GUI で操作できるアプリです。

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
- [imink-app/f-API](https://github.com/imink-app/f-API) — Nintendo 認証に必要な f-token 生成 API（nxapi が内部で利用）。

## 技術メモ

- **nxapi バージョン**: `1.6.1-next.254`（プレリリース）を使用。安定版では `nxapi-znca-api` への認証ができないため。
- **`nxapi-remote-config.json`**: Nintendo が Coral 3.3.0 に更新したことで、公式の live remote-config が `coral: null` となり認証をブロックするようになった。そのためパッチ済み設定を Docker イメージに同梱し、`NXAPI_ENABLE_REMOTE_CONFIG=0` で使用している。
- **所有ギア取得**: nxapi CLI に直接のコマンドはないため、`MyOutfitCommonDataEquipmentsQuery` を Node.js スクリプトから直接呼び出している。

## 注意事項

- SplatNet 3 は任天堂が公式に公開している API ではありません。任天堂側の仕様変更により、予告なく動作しなくなる可能性があります。
- 本ツールは個人の所持ギア管理を目的としています。過度なアクセスや商用利用はしないでください。
- `tools/data/persist/` 配下の認証情報ファイルにはトークン類が含まれるため、コミットしないでください（`.gitignore` で除外済み）。
- 認証に使用する Nintendo アカウントの情報はローカルにのみ保存されます。外部サーバーへの送信は nxapi・imink の仕様に準じます。
