//! battle_db エクスポート（splabo-viewer 連携・#325）。
//!
//! 直近バトルのサマリ行 + 集計を **versioned 暗号ファイル `battle_db.bin`** に書き出す。
//! - 暗号は `gear_crypto`（AES-256-GCM・共有鍵）をそのまま流用（`[nonce12][ct+tag]`）。
//! - 契約: `battle-export-v1`（トップに `{schema, version, generated_at, source_db_user_version}` を明示）。
//! - トリカラは一覧・集計とも除外（chartoon フロントと整合・#293）。
//! - win_rate の分母は decisive = total − draws（`db.rs` の定義に合わせる）。
//! - `battles[]` と `aggregates` は **同一の母集団（直近 N 戦）**（#361）。
//!   母集団は `recent_cte()` の 1 箇所だけで定義し、一覧・集計とも同じ CTE に JOIN する。
//!
//! 詳細契約: `D:\develop\splatoon-gear\splabo-viewer-battle-db-contract.md`（viewer #30 と対）。

use serde::Serialize;
use sqlx::Row;
use tauri::{AppHandle, Manager};

use crate::db::DbPool;
use crate::gear_crypto;

const SCHEMA: &str = "battle-export-v1";
const SCHEMA_VERSION: i64 = 1;
const DEFAULT_LIMIT: i64 = 50;

/// トリカラマッチ除外条件（`db_list_battles` と揃える）。
const TRIKOLOR_EXCLUDE: &str = "(json_extract(b.raw_json, '$.vsRule.rule') IS NULL \
     OR json_extract(b.raw_json, '$.vsRule.rule') <> 'TRI_COLOR')";

/// 直近バトルのサマリ行（viewer 表示用の軽量サブセット）。
/// `db_list_battles` の SELECT から重い列（raw_json / team / awards 等）を落としたもの。
#[derive(Debug, Serialize, sqlx::FromRow)]
pub struct BattleExportRow {
    pub id: String,
    pub played_at: String,
    /// lobby の旧 slug（regular / bankara_open / x …）。
    pub mode: String,
    /// rule の旧 slug（area / hoko / yagura / turf_war …）。null は '' に畳む。
    pub rule: String,
    pub stage: String,
    pub stage_name: Option<String>,
    pub weapon: String,
    /// アイコン解決鍵（`images/weapon/<sha256(name)>.gti`）に使うため name を必ず含める。
    pub weapon_name: Option<String>,
    pub result: String,
    pub knockout: Option<String>,
    pub kill: i64,
    pub assist: i64,
    pub death: i64,
    pub special: i64,
    pub inked: i64,
    pub duration: i64,
    pub x_power: Option<f64>,
    pub rank_before: Option<String>,
    pub rank_after: Option<String>,
    pub sub_weapon: Option<String>,
    pub special_weapon: Option<String>,
    /// 0 のバトルは avg_kill/avg_death 対象外（詳細未取得）。
    pub detail_fetched: i64,
}

#[derive(Debug, Serialize)]
pub struct BattleExportResult {
    pub path: String,
    pub battles: usize,
    pub generated_at: String,
}

/// PathBuf を Windows の \\?\ プレフィックスなし・スラッシュ区切りの文字列に変換。
fn path_to_slash(p: &std::path::Path) -> String {
    let s = p.to_string_lossy();
    let s = s.strip_prefix(r"\\?\").unwrap_or(&s);
    s.replace('\\', "/")
}

/// `battles[]` と `aggregates` が共有する「直近 N 戦」の母集団（CTE）。
///
/// `battles[]` の抽出条件（トリカラ除外・必須 JOIN・`played_at` 降順・件数上限）を
/// **ここ 1 箇所だけ**で定義する。集計側は独自に 50 件を取り直さず、この CTE に
/// JOIN するだけなので、一覧と集計で母集団がズレようがない。
///
/// バインドは `LIMIT ?` の 1 個。この CTE を使う各クエリは先頭で `limit` を 1 回 bind する。
fn recent_cte() -> String {
    format!(
        "WITH recent AS (
             SELECT b.id AS id
             FROM battle b
             JOIN lobby  l   ON l.id   = b.lobby_id
             JOIN result res ON res.id = b.result_id
             JOIN weapon w   ON w.id   = b.weapon_id
             JOIN map    m   ON m.id   = b.map_id
             WHERE {TRIKOLOR_EXCLUDE}
             ORDER BY b.played_at DESC
             LIMIT ?
         )"
    )
}

/// 直近 N 戦のサマリ行を引く SQL（`recent` CTE の集合そのもの）。
fn battles_sql() -> String {
    format!(
        "{cte}
         SELECT b.id AS id,
                b.played_at AS played_at,
                CASE WHEN l.key LIKE 'bankara%' THEN l.key
                     ELSE (CASE l.key WHEN 'xmatch' THEN 'x' ELSE l.key END) END AS mode,
                COALESCE(CASE r.key WHEN 'nawabari' THEN 'turf_war' ELSE r.key END, '') AS rule,
                m.key AS stage,
                m.name_ja AS stage_name,
                w.key AS weapon,
                w.name_ja AS weapon_name,
                res.key AS result,
                b.knockout AS knockout,
                b.kill AS kill,
                b.assist AS assist,
                b.death AS death,
                b.special AS special,
                b.inked AS inked,
                b.duration AS duration,
                b.x_power_after AS x_power,
                b.rank_before AS rank_before,
                b.rank_after AS rank_after,
                b.sub_weapon AS sub_weapon,
                b.special_weapon AS special_weapon,
                COALESCE(b.detail_fetched, 0) AS detail_fetched
         FROM battle b
         JOIN      recent rc  ON rc.id  = b.id
         JOIN      lobby  l   ON l.id   = b.lobby_id
         LEFT JOIN rule   r   ON r.id   = b.rule_id
         JOIN      result res ON res.id = b.result_id
         JOIN      weapon w   ON w.id   = b.weapon_id
         JOIN      map    m   ON m.id   = b.map_id
         ORDER BY b.played_at DESC",
        cte = recent_cte()
    )
}

/// overall 集計 SQL（母集団は `recent`）。
fn overall_sql() -> String {
    format!(
        "{cte}
         SELECT COUNT(*) AS total,
                SUM(CASE WHEN res.key='win'  THEN 1 ELSE 0 END) AS wins,
                SUM(CASE WHEN res.key='draw' THEN 1 ELSE 0 END) AS draws,
                AVG(CASE WHEN b.detail_fetched=1 THEN b.kill  END) AS avg_kill,
                AVG(CASE WHEN b.detail_fetched=1 THEN b.death END) AS avg_death
         FROM battle b
         JOIN recent rc  ON rc.id  = b.id
         JOIN result res ON res.id = b.result_id",
        cte = recent_cte()
    )
}

/// ルール別集計 SQL（母集団は `recent`）。
/// `battles[]` の `rule` 列と同じく LEFT JOIN + COALESCE なので、
/// rule 未設定のバトルも '' グループとして必ず数え上げられる（総和が overall と一致する）。
fn by_rule_sql() -> String {
    format!(
        "{cte}
         SELECT COALESCE(CASE r.key WHEN 'nawabari' THEN 'turf_war' ELSE r.key END, '') AS name,
                COUNT(*) AS total,
                SUM(CASE WHEN res.key='win'  THEN 1 ELSE 0 END) AS wins,
                SUM(CASE WHEN res.key='draw' THEN 1 ELSE 0 END) AS draws
         FROM battle b
         JOIN      recent rc  ON rc.id  = b.id
         LEFT JOIN rule   r   ON r.id   = b.rule_id
         JOIN      result res ON res.id = b.result_id
         GROUP BY name ORDER BY total DESC",
        cte = recent_cte()
    )
}

/// ロビー別集計 SQL（母集団は `recent`）。
fn by_lobby_sql() -> String {
    format!(
        "{cte}
         SELECT (CASE WHEN l.key LIKE 'bankara%' THEN 'bankara'
                      WHEN l.key LIKE 'splatfest%' THEN 'splatfest'
                      ELSE (CASE l.key WHEN 'xmatch' THEN 'x' ELSE l.key END) END) AS name,
                COUNT(*) AS total,
                SUM(CASE WHEN res.key='win'  THEN 1 ELSE 0 END) AS wins,
                SUM(CASE WHEN res.key='draw' THEN 1 ELSE 0 END) AS draws
         FROM battle b
         JOIN recent rc  ON rc.id  = b.id
         JOIN lobby  l   ON l.id   = b.lobby_id
         JOIN result res ON res.id = b.result_id
         GROUP BY name ORDER BY total DESC",
        cte = recent_cte()
    )
}

/// ブキ別集計 SQL（母集団は `recent`）。
fn by_weapon_sql() -> String {
    format!(
        "{cte}
         SELECT w.key AS name,
                COUNT(*) AS total,
                SUM(CASE WHEN res.key='win'  THEN 1 ELSE 0 END) AS wins,
                SUM(CASE WHEN res.key='draw' THEN 1 ELSE 0 END) AS draws
         FROM battle b
         JOIN recent rc  ON rc.id  = b.id
         JOIN weapon w   ON w.id   = b.weapon_id
         JOIN result res ON res.id = b.result_id
         GROUP BY w.id ORDER BY total DESC",
        cte = recent_cte()
    )
}

/// ステージ別集計 SQL（母集団は `recent`）。
fn by_stage_sql() -> String {
    format!(
        "{cte}
         SELECT m.key AS name,
                COUNT(*) AS total,
                SUM(CASE WHEN res.key='win'  THEN 1 ELSE 0 END) AS wins,
                SUM(CASE WHEN res.key='draw' THEN 1 ELSE 0 END) AS draws
         FROM battle b
         JOIN recent rc  ON rc.id  = b.id
         JOIN map    m   ON m.id   = b.map_id
         JOIN result res ON res.id = b.result_id
         GROUP BY m.id ORDER BY total DESC",
        cte = recent_cte()
    )
}

/// グループ集計 SQL を実行し `[{key,total,wins,draws,win_rate}]` を返す。
/// `limit` は `recent` CTE の `LIMIT ?` に bind される。
async fn grouped(
    pool: &sqlx::SqlitePool,
    sql: &str,
    limit: i64,
) -> Result<Vec<serde_json::Value>, String> {
    let rows = sqlx::query(sql)
        .bind(limit)
        .fetch_all(pool)
        .await
        .map_err(|e| e.to_string())?;
    Ok(rows
        .into_iter()
        .map(|r| {
            let name: String = r.try_get("name").unwrap_or_default();
            let total: i64 = r.try_get("total").unwrap_or(0);
            let wins: i64 = r.try_get("wins").unwrap_or(0);
            let draws: i64 = r.try_get("draws").unwrap_or(0);
            let decisive = total - draws;
            serde_json::json!({
                "key": name,
                "total": total,
                "wins": wins,
                "draws": draws,
                "win_rate": if decisive > 0 { wins as f64 / decisive as f64 } else { 0.0 },
            })
        })
        .collect())
}

/// 直近バトルのサマリ行 + 集計を暗号化して `battle_db.bin` に書き出す。
///
/// viewer は同期でこのファイルを引き、`gear_crypto` と同一方式で復号する。
#[tauri::command]
pub async fn export_battle_db(
    app: AppHandle,
    db: tauri::State<'_, DbPool>,
    limit: Option<i64>,
) -> Result<BattleExportResult, String> {
    let pool = db.as_ref();
    let limit = limit.unwrap_or(DEFAULT_LIMIT);

    // --- 直近サマリ行（母集団 = recent CTE） ---
    let battles = sqlx::query_as::<_, BattleExportRow>(&battles_sql())
        .bind(limit)
        .fetch_all(pool)
        .await
        .map_err(|e| e.to_string())?;

    // --- 集計（母集団は battles[] と同一の直近 N 戦・トリカラ除外） ---
    let overall_row = sqlx::query(&overall_sql())
        .bind(limit)
        .fetch_one(pool)
        .await
        .map_err(|e| e.to_string())?;
    let total: i64 = overall_row.try_get("total").unwrap_or(0);
    let wins: i64 = overall_row.try_get("wins").unwrap_or(0);
    let draws: i64 = overall_row.try_get("draws").unwrap_or(0);
    let avg_kill: Option<f64> = overall_row.try_get("avg_kill").ok();
    let avg_death: Option<f64> = overall_row.try_get("avg_death").ok();
    let decisive = total - draws;
    let overall = serde_json::json!({
        "total": total,
        "wins": wins,
        "losses": decisive - wins,
        "draws": draws,
        "win_rate": if decisive > 0 { wins as f64 / decisive as f64 } else { 0.0 },
        "avg_kill": avg_kill,
        "avg_death": avg_death,
    });

    let by_rule = grouped(pool, &by_rule_sql(), limit).await?;
    let by_lobby = grouped(pool, &by_lobby_sql(), limit).await?;
    let by_weapon = grouped(pool, &by_weapon_sql(), limit).await?;
    let by_stage = grouped(pool, &by_stage_sql(), limit).await?;

    // --- メタ（生成時刻 UTC ISO8601・スキーマバージョン） ---
    let generated_at: String = sqlx::query("SELECT strftime('%Y-%m-%dT%H:%M:%SZ','now') AS now")
        .fetch_one(pool)
        .await
        .map_err(|e| e.to_string())?
        .try_get("now")
        .unwrap_or_default();
    let user_version: i64 = sqlx::query("PRAGMA user_version")
        .fetch_one(pool)
        .await
        .map_err(|e| e.to_string())?
        .try_get(0)
        .unwrap_or(0);

    // --- エンベロープ構築 → 暗号化 → 書き出し ---
    let envelope = serde_json::json!({
        "schema": SCHEMA,
        "version": SCHEMA_VERSION,
        "generated_at": generated_at,
        "source_db_user_version": user_version,
        "battles": battles,
        "aggregates": {
            "overall": overall,
            "by_rule": by_rule,
            "by_lobby": by_lobby,
            "by_weapon": by_weapon,
            "by_stage": by_stage,
        },
    });

    let json = serde_json::to_vec(&envelope).map_err(|e| e.to_string())?;
    let encrypted = gear_crypto::encrypt_db(&json)?;

    let out_dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("アプリデータディレクトリ解決失敗: {e}"))?
        .join("data");
    std::fs::create_dir_all(&out_dir).map_err(|e| e.to_string())?;
    let bin_path = out_dir.join("battle_db.bin");
    std::fs::write(&bin_path, &encrypted).map_err(|e| e.to_string())?;

    log::info!(
        "[battle_export] {} 戦を書き出し → {}",
        battles.len(),
        path_to_slash(&bin_path)
    );

    Ok(BattleExportResult {
        path: path_to_slash(&bin_path),
        battles: battles.len(),
        generated_at,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    /// battle-export-v1 の代表的なエンベロープ（viewer 契約テスト用フィクスチャの元）。
    fn sample_envelope() -> serde_json::Value {
        serde_json::json!({
            "schema": SCHEMA,
            "version": SCHEMA_VERSION,
            "generated_at": "2026-07-15T12:00:00Z",
            "source_db_user_version": 19,
            "battles": [
                {
                    "id": "b1", "played_at": "2026-07-15T11:30:00Z", "mode": "bankara_challenge",
                    "rule": "area", "stage": "yunohana", "stage_name": "ユノハナ大渓谷",
                    "weapon": "splattershot", "weapon_name": "スプラシューター", "result": "win",
                    "knockout": null, "kill": 9, "assist": 2, "death": 4, "special": 3,
                    "inked": 1200, "duration": 300, "x_power": null,
                    "rank_before": "S+0", "rank_after": "S+0",
                    "sub_weapon": "splat_bomb", "special_weapon": "trizooka", "detail_fetched": 1
                },
                {
                    "id": "b2", "played_at": "2026-07-15T11:10:00Z", "mode": "regular",
                    "rule": "turf_war", "stage": "gonzui", "stage_name": "ゴンズイ地区",
                    "weapon": "wakaba", "weapon_name": "わかばシューター", "result": "lose",
                    "knockout": null, "kill": 5, "assist": 1, "death": 8, "special": 2,
                    "inked": 900, "duration": 180, "x_power": null,
                    "rank_before": null, "rank_after": null,
                    "sub_weapon": "splash_wall", "special_weapon": "big_bubbler", "detail_fetched": 1
                }
            ],
            "aggregates": {
                "overall": { "total": 2, "wins": 1, "losses": 1, "draws": 0,
                             "win_rate": 0.5, "avg_kill": 7.0, "avg_death": 6.0 },
                "by_rule": [
                    { "key": "area", "total": 1, "wins": 1, "draws": 0, "win_rate": 1.0 },
                    { "key": "turf_war", "total": 1, "wins": 0, "draws": 0, "win_rate": 0.0 }
                ],
                "by_lobby": [
                    { "key": "bankara", "total": 1, "wins": 1, "draws": 0, "win_rate": 1.0 },
                    { "key": "regular", "total": 1, "wins": 0, "draws": 0, "win_rate": 0.0 }
                ],
                "by_weapon": [
                    { "key": "splattershot", "total": 1, "wins": 1, "draws": 0, "win_rate": 1.0 },
                    { "key": "wakaba", "total": 1, "wins": 0, "draws": 0, "win_rate": 0.0 }
                ],
                "by_stage": [
                    { "key": "yunohana", "total": 1, "wins": 1, "draws": 0, "win_rate": 1.0 },
                    { "key": "gonzui", "total": 1, "wins": 0, "draws": 0, "win_rate": 0.0 }
                ]
            }
        })
    }

    /// gear_crypto を流用した暗号ラウンドトリップ + 契約スキーマの検証。
    /// あわせて viewer #30 が読む共有フィクスチャ（平文 JSON + 暗号 bin）を tests/fixtures に生成する。
    #[test]
    fn roundtrip_and_write_fixture() {
        let env = sample_envelope();
        let plaintext = serde_json::to_vec(&env).unwrap();
        let encrypted = gear_crypto::encrypt_db(&plaintext).unwrap();
        let decrypted = gear_crypto::decrypt_db(&encrypted).unwrap();
        let parsed: serde_json::Value = serde_json::from_slice(&decrypted).unwrap();

        assert_eq!(parsed["schema"], "battle-export-v1");
        assert_eq!(parsed["version"], 1);
        assert_eq!(parsed["battles"].as_array().unwrap().len(), 2);
        assert_eq!(parsed["battles"][0]["result"], "win");
        assert_eq!(parsed["aggregates"]["overall"]["win_rate"], 0.5);
        // by_stage は by_rule 等と同じ GroupStat 形（key/total/wins/draws/win_rate）で入る。
        let by_stage = parsed["aggregates"]["by_stage"].as_array().unwrap();
        assert_eq!(by_stage.len(), 2);
        assert_eq!(by_stage[0]["key"], "yunohana");
        assert_eq!(by_stage[0]["win_rate"], 1.0);
        assert_eq!(by_stage[1]["key"], "gonzui");
        assert_eq!(by_stage[1]["win_rate"], 0.0);

        // 共有フィクスチャ生成（平文は決定的なので毎回上書き・暗号は nonce が乱数なので未存在時のみ）。
        let dir = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("tests")
            .join("fixtures");
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(
            dir.join("battle_db_v1.json"),
            serde_json::to_vec_pretty(&env).unwrap(),
        )
        .unwrap();
        let bin = dir.join("battle_db_v1.bin");
        if !bin.exists() {
            std::fs::write(&bin, &encrypted).unwrap();
        }
    }

    /// 非トリカラの raw_json（json_extract('$.vsRule.rule') = NULL → 集計対象）。
    const NON_TRI: &str = "{}";
    /// トリカラの raw_json（TRIKOLOR_EXCLUDE で除外される）。
    const TRI: &str = r#"{"vsRule":{"rule":"TRI_COLOR"}}"#;

    /// 本番 SQL が参照する最小スキーマを持つ in-memory SQLite を用意する。
    async fn test_pool() -> sqlx::SqlitePool {
        let pool = sqlx::sqlite::SqlitePoolOptions::new()
            .max_connections(1)
            .connect("sqlite::memory:")
            .await
            .unwrap();

        sqlx::query(
            "CREATE TABLE map    (id INTEGER PRIMARY KEY, key TEXT, name_ja TEXT);
             CREATE TABLE result (id INTEGER PRIMARY KEY, key TEXT);
             CREATE TABLE lobby  (id INTEGER PRIMARY KEY, key TEXT);
             CREATE TABLE weapon (id INTEGER PRIMARY KEY, key TEXT, name_ja TEXT);
             CREATE TABLE rule   (id INTEGER PRIMARY KEY, key TEXT);
             CREATE TABLE battle (
                 id TEXT PRIMARY KEY, played_at TEXT,
                 map_id INTEGER, result_id INTEGER, lobby_id INTEGER,
                 weapon_id INTEGER, rule_id INTEGER,
                 kill INTEGER DEFAULT 0, death INTEGER DEFAULT 0,
                 assist INTEGER DEFAULT 0, special INTEGER DEFAULT 0,
                 inked INTEGER DEFAULT 0, duration INTEGER DEFAULT 0,
                 knockout TEXT, x_power_after REAL,
                 rank_before TEXT, rank_after TEXT,
                 sub_weapon TEXT, special_weapon TEXT,
                 detail_fetched INTEGER DEFAULT 1, raw_json TEXT);
             INSERT INTO map    (id, key, name_ja) VALUES (1,'yunohana','ユノハナ'), (2,'gonzui','ゴンズイ');
             INSERT INTO result (id, key) VALUES (1,'win'), (2,'lose'), (3,'draw');
             INSERT INTO lobby  (id, key) VALUES (1,'regular'), (2,'bankara_challenge');
             INSERT INTO weapon (id, key, name_ja) VALUES (1,'splattershot','スシ'), (2,'wakaba','わかば');
             INSERT INTO rule   (id, key) VALUES (1,'area'), (2,'nawabari');",
        )
        .execute(&pool)
        .await
        .unwrap();

        pool
    }

    /// バトルを 1 件挿入する。`played_at` は連番から生成（大きい seq ほど新しい）。
    #[allow(clippy::too_many_arguments)]
    async fn insert_battle(
        pool: &sqlx::SqlitePool,
        id: &str,
        seq: i64,
        map_id: i64,
        result_id: i64,
        lobby_id: i64,
        weapon_id: i64,
        rule_id: Option<i64>,
        raw: &str,
    ) {
        sqlx::query(
            "INSERT INTO battle (id, played_at, map_id, result_id, lobby_id, weapon_id, rule_id, kill, death, detail_fetched, raw_json)
             VALUES (?,?,?,?,?,?,?,3,2,1,?)",
        )
        .bind(id)
        .bind(format!("2026-07-15T{:02}:{:02}:00Z", seq / 60, seq % 60))
        .bind(map_id)
        .bind(result_id)
        .bind(lobby_id)
        .bind(weapon_id)
        .bind(rule_id)
        .bind(raw)
        .execute(pool)
        .await
        .unwrap();
    }

    /// overall 集計を実行して (total, wins, draws) を返す。
    async fn overall_totals(pool: &sqlx::SqlitePool, limit: i64) -> (i64, i64, i64) {
        let row = sqlx::query(&overall_sql())
            .bind(limit)
            .fetch_one(pool)
            .await
            .unwrap();
        (
            row.try_get("total").unwrap_or(0),
            row.try_get("wins").unwrap_or(0),
            row.try_get("draws").unwrap_or(0),
        )
    }

    /// グループ集計の total 合計。
    fn sum_total(groups: &[serde_json::Value]) -> i64 {
        groups.iter().map(|g| g["total"].as_i64().unwrap()).sum()
    }

    /// 合成データを in-memory SQLite に投入し、by_stage 集計 SQL が
    /// ステージ別の total / wins / draws / win_rate を正しく出すことを検証する。
    /// - win_rate の分母は decisive = total − draws（overall と揃える）。
    /// - TRI_COLOR のバトルは TRIKOLOR_EXCLUDE で除外されることも確認する。
    #[tokio::test]
    async fn by_stage_win_rates() {
        let pool = test_pool().await;

        // yunohana: win, win, lose        → total 3, wins 2, draws 0, decisive 3, win_rate 2/3
        // gonzui:   win, draw             → total 2, wins 1, draws 1, decisive 1, win_rate 1.0
        // yunohana の TRI_COLOR 1 件は除外され、上記の集計に影響しない。
        let rows: &[(&str, i64, i64, &str)] = &[
            ("y1", 1, 1, NON_TRI),
            ("y2", 1, 1, NON_TRI),
            ("y3", 1, 2, NON_TRI),
            ("g1", 2, 1, NON_TRI),
            ("g2", 2, 3, NON_TRI),
            ("t1", 1, 1, TRI),
        ];
        for (i, (id, map_id, result_id, raw)) in rows.iter().enumerate() {
            insert_battle(&pool, id, i as i64, *map_id, *result_id, 1, 1, Some(1), raw).await;
        }

        // 本番と同一の by_stage SQL（母集団は十分大きい limit なので全 5 件が対象）。
        let by_stage = grouped(&pool, &by_stage_sql(), 100).await.unwrap();

        assert_eq!(by_stage.len(), 2);

        let yunohana = &by_stage[0];
        assert_eq!(yunohana["key"], "yunohana");
        assert_eq!(yunohana["total"], 3);
        assert_eq!(yunohana["wins"], 2);
        assert_eq!(yunohana["draws"], 0);
        assert!((yunohana["win_rate"].as_f64().unwrap() - 2.0 / 3.0).abs() < 1e-9);

        let gonzui = &by_stage[1];
        assert_eq!(gonzui["key"], "gonzui");
        assert_eq!(gonzui["total"], 2);
        assert_eq!(gonzui["wins"], 1);
        assert_eq!(gonzui["draws"], 1);
        // 分母は decisive = total − draws = 1 なので win_rate = 1.0（引き分けを除外）。
        assert_eq!(gonzui["win_rate"], 1.0);
    }

    /// #361: 50 戦を超えるデータでも aggregates の母集団は直近 50 戦に収まる。
    /// - overall.total == 50（51 以上にならない）
    /// - by_rule / by_weapon / by_stage / by_lobby の total 合計が overall と一致する
    /// - battles[] の件数とも一致する（一覧と集計が同じ母集団）
    #[tokio::test]
    async fn aggregates_scoped_to_recent_limit() {
        let pool = test_pool().await;

        // 120 戦（+ トリカラ 5 戦）を投入。ステージ/ブキ/ルール/ロビーはばらけさせる。
        for i in 0..120i64 {
            insert_battle(
                &pool,
                &format!("b{i}"),
                i,
                (i % 2) + 1,
                (i % 3) + 1,
                (i % 2) + 1,
                (i % 2) + 1,
                Some((i % 2) + 1),
                NON_TRI,
            )
            .await;
        }
        for i in 0..5i64 {
            // played_at が最新側に来るトリカラ（除外されないと直近 50 に混入する）。
            insert_battle(&pool, &format!("t{i}"), 200 + i, 1, 1, 1, 1, Some(1), TRI).await;
        }

        let limit = DEFAULT_LIMIT;

        let battles = sqlx::query_as::<_, BattleExportRow>(&battles_sql())
            .bind(limit)
            .fetch_all(&pool)
            .await
            .unwrap();
        assert_eq!(battles.len(), 50, "battles[] は直近 50 戦");

        let (total, _wins, _draws) = overall_totals(&pool, limit).await;
        assert_eq!(total, 50, "overall も直近 50 戦（全期間の 120 にならない）");

        for (label, sql) in [
            ("by_rule", by_rule_sql()),
            ("by_lobby", by_lobby_sql()),
            ("by_weapon", by_weapon_sql()),
            ("by_stage", by_stage_sql()),
        ] {
            let groups = grouped(&pool, &sql, limit).await.unwrap();
            assert_eq!(
                sum_total(&groups),
                total,
                "{label} の total 合計は overall と一致する（母集団が同一）"
            );
        }

        // 直近 50 戦なので、最新の非トリカラ b119..b70 が入っているはず。
        assert_eq!(battles[0].id, "b119");
        assert_eq!(battles[49].id, "b70");
    }

    /// #361: 50 戦未満でも壊れない（10 戦なら overall.total は 10）。
    #[tokio::test]
    async fn aggregates_with_fewer_than_limit() {
        let pool = test_pool().await;

        for i in 0..10i64 {
            insert_battle(
                &pool,
                &format!("b{i}"),
                i,
                (i % 2) + 1,
                (i % 3) + 1,
                (i % 2) + 1,
                (i % 2) + 1,
                Some((i % 2) + 1),
                NON_TRI,
            )
            .await;
        }

        let limit = DEFAULT_LIMIT;
        let (total, _wins, _draws) = overall_totals(&pool, limit).await;
        assert_eq!(total, 10);

        for (label, sql) in [
            ("by_rule", by_rule_sql()),
            ("by_lobby", by_lobby_sql()),
            ("by_weapon", by_weapon_sql()),
            ("by_stage", by_stage_sql()),
        ] {
            let groups = grouped(&pool, &sql, limit).await.unwrap();
            assert_eq!(sum_total(&groups), 10, "{label} の total 合計");
        }
    }

    /// #361: rule 未設定（rule_id NULL）のバトルも by_rule で '' グループとして数えられ、
    /// overall との総和一致が崩れないこと（battles[] の LEFT JOIN と揃える）。
    #[tokio::test]
    async fn by_rule_includes_null_rule() {
        let pool = test_pool().await;

        insert_battle(&pool, "r1", 1, 1, 1, 1, 1, Some(1), NON_TRI).await;
        insert_battle(&pool, "r2", 2, 1, 2, 1, 1, None, NON_TRI).await;

        let limit = DEFAULT_LIMIT;
        let (total, _, _) = overall_totals(&pool, limit).await;
        assert_eq!(total, 2);

        let by_rule = grouped(&pool, &by_rule_sql(), limit).await.unwrap();
        assert_eq!(sum_total(&by_rule), 2);
        assert!(
            by_rule.iter().any(|g| g["key"] == ""),
            "rule 未設定は '' グループになる"
        );
    }
}
