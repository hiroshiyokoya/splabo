# 保存コーデ エクスポート契約（splabo ⇄ splabo-viewer）

> 本体 splabo（Rust）が保存・配信し、splabo-viewer（Kotlin）が閲覧する「保存コーデ」のデータ契約。
> Issue: splabo #782 / splabo-viewer #137。
> 正本は両リポに同内容を置く（本ファイルと splabo-viewer の `docs/saved-coordinates-contract.md`）。契約変更時は両方を更新する。

## 保存先（デスクトップ）

- `<app_data>/saved_coordinates.json`（平文 JSON）。生成・更新は `app/src-tauri/src/saved_coordinates.rs`。
- `<app_data>/data/` には置かない（`gear_db.bin` は取得のたびに上書きされ、「ギアデータ削除」で `data/` ごと消えるため）。

## 配信

- `GET /coordinates.bin`（コンパニオンサーバー・`Authorization: Bearer <token>` 必須）。
- 本文は下記 JSON を **gear_db と同じ方式**（AES-256-GCM・`[nonce 12B][ciphertext+tag]`・`gear_crypto.rs` / `GearCrypto.kt` と同じ鍵）で暗号化したもの。
- **保存が 1 件も無くても 200 で空の一覧を返す**。404 は「このエンドポイントが無い古いデスクトップ」を意味するので、viewer は 404 なら保存コーデの表示自体を出さない。
- ETag は**暗号化前の JSON の sha256**（暗号文は nonce で毎回変わるため）。`If-None-Match` 一致なら 304。

## 契約（saved-coordinates-v1）

```
{ "schema": "saved-coordinates-v1", "version": 1,
  "coordinates": [
    { "id": "32桁hex",
      "title": "イカダッシュ速度アップ / インク効率アップ(メイン)",
      "memo": "",
      "created_at": "2026-10-10T12:34:56Z",
      "updated_at": "2026-10-10T12:34:56Z",
      "gears": {
        "head":     { "id": 21001, "name": "ギア名", "main": 4, "subs": [0, -1, 4] },
        "clothing": { ... },
        "shoes":    { ... } } } ] }
```

- `gears.<部位>.id`: gear_db の `GearItem.id`（SplatNet3 の `headGearId` / `clothingGearId` / `shoesGearId`）。**部位の中でだけ一意**なので、必ず同じ部位の一覧から引く。
- `main` / `subs`: **保存した時点の** gearPowerId（アキは -1）。表示は今の gear_db から引き直し、ここと食い違えば「ギアパワーが変わっている」と出す。
- `name`: 保存した時点のギア名（日本語）。gear_db にもう無い（手放した）ギアを「ギアなし」と出すときに使う。
- 3 部位は常にそろっている（3 部位そろったコーデだけを保存できる）。
- 時刻の書式は gear_db / battle_db の `generated_at` と同じ（UTC ISO8601・秒精度・末尾 Z）。
- 並び順の規定は無い。viewer は `created_at` の新しい順に並べる（デスクトップと同じ）。
- viewer は閲覧のみ。書き込み用のエンドポイントは無い。
- フィールド追加は後方互換として扱い、version は上げない。読む側は未知フィールドを無視する。
