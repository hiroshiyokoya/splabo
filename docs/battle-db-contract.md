# battle_db エクスポート契約（splabo ⇄ splabo-viewer）

> 本体 splabo（Rust）が生成し、splabo-viewer（Kotlin）が読む「直近バトル」データ契約。
> 2026-07-15 に splabo リポを読み取り調査して確定した提案。viewer 設計書 `docs/design.md`（splabo-viewer リポ）§2/§6、Issue: splabo-viewer #30 / splabo #325。
> 正本は両リポに同内容を置く（本ファイルと splabo-viewer の `docs/battle-db-contract.md`）。契約変更時は両方を更新する。

## 既存 gear エクスポート（流用元）

- 生成: `splabo/app/src-tauri/src/gear.rs` `build_gear_db()`。トップレベル `generated_at/head/clothing/shoes/skills`。**version フィールドは暗黙**（"gear-export-v1" はコード規約名のみ）。
  - `generated_at`（splabo #396・追加のみ）: gear_db を作った時刻。**書式は battle_db の `generated_at` と同一**（UTC ISO8601・秒精度・末尾 Z）。viewer はこれをギアの鮮度として出す（端末の最終同期時刻はバトルだけ引いても更新されるのでギアの鮮度にならない）。古い viewer は未知フィールドとして無視し、新しい viewer × 古いデスクトップでは欠落＝「未取得」表示にフォールバックする。
- 出力: `<app_data>/data/gear_db.bin` + `images/**/*.gti`。
- 暗号 `gear_crypto.rs`: **AES-256-GCM**、鍵 `b"geartoon-gear-db-key-2025-v1!!!!"`（32B 固定）、形式 `[nonce 12B][ciphertext+GCM tag 16B]`。画像は **XOR 0x5A**。
- Kotlin `GearCrypto.kt` と鍵・モード・nonce・タグすべて一致 → **battle_db は GearCrypto をそのまま流用可**（追加暗号実装ゼロ・復号関数を汎用名にするだけ）。

## バトルデータ元（chartoon.db・SQLite・WAL）

- `battle`（自分視点1バトル/行）: `id, played_at(ISO8601), lobby_id, rule_id(nullable), map_id, result_id, weapon_id, kill/assist/death/special/inked/duration, is_knockout(1=KO勝/0=KO負/NULL=時間切れ), x_power_after, rank_before/after, sub_weapon, special_weapon, detail_fetched`。
- ルックアップ: `lobby/rule/result(key)`, `map(key,name_ja,...)`, `weapon(key,name_ja,category_key,...)`。
- `battle_player`（8人詳細・ブキ内訳用）。`env_battles`（540万行・**viewer に持ち込まない**）。
- 既存流用クエリ: 一覧 `db_list_battles`（db.rs:1159・トリカラ除外）、集計 `db_battle_stats`/`db_summary`。

## 契約（battle-export-v1）

復号後 JSON（トップに明示エンベロープ）:
```
{ "schema":"battle-export-v1", "version":1, "generated_at":"ISO8601",
  "source_db_user_version":19, "battles":[...], "aggregates":{...} }
```

### battles[]（直近N戦・生サマリ行）
`id, played_at, lobby, rule|null, stage, stage_name|null, weapon, weapon_name|null, sub_weapon|null, special_weapon|null, result(win/lose/draw), is_knockout(int|null), kill, assist, death, special, inked, duration, x_power|null, rank_before|null, rank_after|null, detail_fetched`
- 元 = `db_list_battles` の JOIN 結果 + `ORDER BY played_at DESC LIMIT N`。`raw_json`/team 詳細は除外。
- **アイコン解決鍵は `name_ja`（sha256(name)→ images/<kind>/<...>.gti）なので name を必ず含める**。

### aggregates（本体計算・端末再集計も可）
`overall{total,wins,losses,draws,win_rate,avg_kill,avg_death}` / `by_rule[] / by_lobby[] / by_weapon[]`（各 `{key,total,wins,draws,win_rate}`）。
- **win_rate の分母は decisive = total − draws**（db.rs:1104）。viewer も同式で再計算し食い違い防止。

### 暗号・出力
- JSON→UTF-8→`gear_crypto::encrypt_db()` で `battle_db.bin`。鍵・モード共通。viewer は `GearCrypto` を汎用名（`decryptDb`）で流用。

### 共有フィクスチャ
- 本体 Rust `#[test]` で固定サンプルを encrypt → `tests/fixtures/battle_db_v1.bin` + 対の平文 JSON。viewer テストが decrypt してスキーマ/型/version を assert。

## gotcha
- **WAL**: ファイルコピー不可。読み出し前に `PRAGMA wal_checkpoint(TRUNCATE)` か既存プール経由。
- **NULL 多発**: rule_id/x_power/rank/is_knockout/name 各所 → JSON は null 許容で明示。
- **TZ**: played_at は文字列、fetched_at は UTC。サーバー側は変換せず ISO8601 のまま渡す。
- **is_knockout 三値**（0/NULL 混同で過去に KO負け3.5倍膨張バグ・db.rs:277）。
- **トリカラ除外**をサマリ/集計で揃える。
- **detail_fetched=0** 行は avg_kill/death 対象外 → K/D が 0 になり得る。契約で扱いを決める。
- アイコンは「まずテキスト → 後で同期ペイロード追加」の段階実装（設計書 §6・splabo #327）。
