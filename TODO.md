# TODO

## 完了

### データパイプライン（`tools/`）
- SplatNet 3 からギアデータ取得（nxapi + Docker）
- ギア・スキル画像のダウンロード（`scripts/download_gear_images.py`）
- 構造化 DB JSON の生成（`scripts/build_gear_db.py`）
- データ更新の 1 コマンド化（`scripts/update.py`）
- ギア検索スクリプト（`scripts/find_gear.py`）— スキル・ブランド・カテゴリ・レアリティで絞り込み
- スキル構成の自動生成（`scripts/find_combo.py`）— 目標 AP を指定して全探索、枝刈りで高速化

---

## 未着手

### 1. PC アプリ / Web UI（Vite + React → Tauri）

**技術スタック**: Vite + React をフロントエンド、Tauri でデスクトップアプリ化
- ブラウザでも開けるし、Tauri をかぶせれば単体の PC アプリとして配布できる
- **配布方針: GitHub でソース公開**

#### 機能
- `gear_db.json` と `images/` を使って所持ギアを一覧表示
- カテゴリ（頭・服・靴）・スキル・ブランド・レアリティで絞り込み・ソート
- スキル構成の自動生成（目標 AP を入力 → 組み合わせ候補を表示）
- データ更新ボタン（`update.py` を UI から実行）

#### 開発ステップ
1. Vite + React でブラウザ版を作る（`app/` に着手）
2. Tauri を追加して PC アプリ版にする（フロントエンドのコード変更はほぼ不要）

### 2. Android アプリ化（Kotlin + Jetpack Compose）

**方針**: 認証・データ取得は PC 側（tools）に完全に任せる。Android アプリはローカルに置いた `gear_db.json` と画像を読むだけのビューワー。

```
[PC: splatoon-gear/tools]         [Android アプリ]
 Nintendo 認証                        ↑
 SplatNet 3 API アクセス              │ ユーザーが手動でコピー
 gear_db.json 生成           ──────→  gear_db.json + images/
 画像ダウンロード                     を端末ストレージに配置
```

- アプリはインターネット通信不要（ローカルファイルのみ）
- Play Store 公式配信予定（認証コードなし・通信なし）

---

## 保留・検討中

### `find_combo.py` のメイン専用スキル対応
- カムバックのようなスキルを `"カムバック"` だけで指定できるようにしたい（`:10` は不自然）
- `GearPower` にメイン専用フラグが JSON に載っていないため、マスターリスト同梱か明示フラグで対応予定

### nxapi のアップデート追従
- nxapi 安定版が Coral 3.x に対応したら `1.6.1-next.254` から切り替える
- SplatNet 3 側のアップデートで `map_queries` が変わったら `nxapi-remote-config.json` を再取得する
