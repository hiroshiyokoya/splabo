//! battle_db エクスポート（splabo-viewer 連携・#325）。
//!
//! 直近バトルのサマリ行 + 集計を **versioned 暗号ファイル `battle_db.bin`** に書き出す。
//! - 暗号は `gear_crypto`（AES-256-GCM・共有鍵）をそのまま流用（`[nonce12][ct+tag]`）。
//! - 契約: `battle-export-v1`（トップに `{schema, version, generated_at, source_db_user_version}` を明示）。
//! - トリカラは一覧・集計とも除外（chartoon フロントと整合・#293）。
//! - win_rate の分母は decisive = total − draws（`db.rs` の定義に合わせる）。
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

/// グループ集計 SQL を実行し `[{key,total,wins,draws,win_rate}]` を返す。
async fn grouped(pool: &sqlx::SqlitePool, sql: &str) -> Result<Vec<serde_json::Value>, String> {
    let rows = sqlx::query(sql)
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

    // --- 直近サマリ行 ---
    let battles_sql = format!(
        "SELECT b.id AS id,
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
         JOIN      lobby  l   ON l.id   = b.lobby_id
         LEFT JOIN rule   r   ON r.id   = b.rule_id
         JOIN      result res ON res.id = b.result_id
         JOIN      weapon w   ON w.id   = b.weapon_id
         JOIN      map    m   ON m.id   = b.map_id
         WHERE {TRIKOLOR_EXCLUDE}
         ORDER BY b.played_at DESC
         LIMIT ?"
    );
    let battles = sqlx::query_as::<_, BattleExportRow>(&battles_sql)
        .bind(limit)
        .fetch_all(pool)
        .await
        .map_err(|e| e.to_string())?;

    // --- 集計（全期間・トリカラ除外） ---
    let overall_row = sqlx::query(&format!(
        "SELECT COUNT(*) AS total,
                SUM(CASE WHEN res.key='win'  THEN 1 ELSE 0 END) AS wins,
                SUM(CASE WHEN res.key='draw' THEN 1 ELSE 0 END) AS draws,
                AVG(CASE WHEN b.detail_fetched=1 THEN b.kill  END) AS avg_kill,
                AVG(CASE WHEN b.detail_fetched=1 THEN b.death END) AS avg_death
         FROM battle b
         JOIN result res ON res.id = b.result_id
         WHERE {TRIKOLOR_EXCLUDE}"
    ))
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

    let by_rule = grouped(pool, &format!(
        "SELECT (CASE r.key WHEN 'nawabari' THEN 'turf_war' ELSE r.key END) AS name,
                COUNT(*) AS total,
                SUM(CASE WHEN res.key='win'  THEN 1 ELSE 0 END) AS wins,
                SUM(CASE WHEN res.key='draw' THEN 1 ELSE 0 END) AS draws
         FROM battle b
         JOIN rule   r   ON r.id   = b.rule_id
         JOIN result res ON res.id = b.result_id
         WHERE {TRIKOLOR_EXCLUDE}
         GROUP BY r.id ORDER BY total DESC"
    ))
    .await?;

    let by_lobby = grouped(pool, &format!(
        "SELECT (CASE WHEN l.key LIKE 'bankara%' THEN 'bankara'
                      WHEN l.key LIKE 'splatfest%' THEN 'splatfest'
                      ELSE (CASE l.key WHEN 'xmatch' THEN 'x' ELSE l.key END) END) AS name,
                COUNT(*) AS total,
                SUM(CASE WHEN res.key='win'  THEN 1 ELSE 0 END) AS wins,
                SUM(CASE WHEN res.key='draw' THEN 1 ELSE 0 END) AS draws
         FROM battle b
         JOIN lobby  l   ON l.id   = b.lobby_id
         JOIN result res ON res.id = b.result_id
         WHERE {TRIKOLOR_EXCLUDE}
         GROUP BY name ORDER BY total DESC"
    ))
    .await?;

    let by_weapon = grouped(pool, &format!(
        "SELECT w.key AS name,
                COUNT(*) AS total,
                SUM(CASE WHEN res.key='win'  THEN 1 ELSE 0 END) AS wins,
                SUM(CASE WHEN res.key='draw' THEN 1 ELSE 0 END) AS draws
         FROM battle b
         JOIN weapon w   ON w.id   = b.weapon_id
         JOIN result res ON res.id = b.result_id
         WHERE {TRIKOLOR_EXCLUDE}
         GROUP BY w.id ORDER BY total DESC"
    ))
    .await?;

    let by_stage = grouped(pool, &format!(
        "SELECT m.key AS name,
                COUNT(*) AS total,
                SUM(CASE WHEN res.key='win'  THEN 1 ELSE 0 END) AS wins,
                SUM(CASE WHEN res.key='draw' THEN 1 ELSE 0 END) AS draws
         FROM battle b
         JOIN map    m   ON m.id   = b.map_id
         JOIN result res ON res.id = b.result_id
         WHERE {TRIKOLOR_EXCLUDE}
         GROUP BY m.id ORDER BY total DESC"
    ))
    .await?;

    // --- メタ（生成時刻 UTC ISO8601・スキーマバージョン） ---
    let generated_at: String =
        sqlx::query("SELECT strftime('%Y-%m-%dT%H:%M:%SZ','now') AS now")
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

    /// 合成データを in-memory SQLite に投入し、by_stage 集計 SQL が
    /// ステージ別の total / wins / draws / win_rate を正しく出すことを検証する。
    /// - win_rate の分母は decisive = total − draws（overall と揃える）。
    /// - TRI_COLOR のバトルは TRIKOLOR_EXCLUDE で除外されることも確認する。
    #[tokio::test]
    async fn by_stage_win_rates() {
        let pool = sqlx::sqlite::SqlitePoolOptions::new()
            .max_connections(1)
            .connect("sqlite::memory:")
            .await
            .unwrap();

        // 集計 SQL が参照する最小スキーマ（map / result / battle）。
        sqlx::query(
            "CREATE TABLE map    (id INTEGER PRIMARY KEY, key TEXT);
             CREATE TABLE result (id INTEGER PRIMARY KEY, key TEXT);
             CREATE TABLE battle (id TEXT PRIMARY KEY, map_id INTEGER, result_id INTEGER, raw_json TEXT);
             INSERT INTO map    (id, key) VALUES (1,'yunohana'), (2,'gonzui');
             INSERT INTO result (id, key) VALUES (1,'win'), (2,'lose'), (3,'draw');",
        )
        .execute(&pool)
        .await
        .unwrap();

        // yunohana: win, win, lose        → total 3, wins 2, draws 0, decisive 3, win_rate 2/3
        // gonzui:   win, draw             → total 2, wins 1, draws 1, decisive 1, win_rate 1.0
        // yunohana の TRI_COLOR 1 件は除外され、上記の集計に影響しない。
        let non_tri = "{}"; // json_extract('$.vsRule.rule') = NULL → 対象
        let tri = r#"{"vsRule":{"rule":"TRI_COLOR"}}"#; // 除外対象
        let rows: &[(&str, i64, i64, &str)] = &[
            ("y1", 1, 1, non_tri),
            ("y2", 1, 1, non_tri),
            ("y3", 1, 2, non_tri),
            ("g1", 2, 1, non_tri),
            ("g2", 2, 3, non_tri),
            ("t1", 1, 1, tri),
        ];
        for (id, map_id, result_id, raw) in rows {
            sqlx::query("INSERT INTO battle (id, map_id, result_id, raw_json) VALUES (?,?,?,?)")
                .bind(id)
                .bind(map_id)
                .bind(result_id)
                .bind(raw)
                .execute(&pool)
                .await
                .unwrap();
        }

        // 本番と同一の by_stage SQL。
        let by_stage = grouped(
            &pool,
            &format!(
                "SELECT m.key AS name,
                        COUNT(*) AS total,
                        SUM(CASE WHEN res.key='win'  THEN 1 ELSE 0 END) AS wins,
                        SUM(CASE WHEN res.key='draw' THEN 1 ELSE 0 END) AS draws
                 FROM battle b
                 JOIN map    m   ON m.id   = b.map_id
                 JOIN result res ON res.id = b.result_id
                 WHERE {TRIKOLOR_EXCLUDE}
                 GROUP BY m.id ORDER BY total DESC"
            ),
        )
        .await
        .unwrap();

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
}
