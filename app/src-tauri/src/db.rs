//! SQLite によるバトルデータの永続化。
//!
//! テーブル設計方針:
//! - 主要フィールドはクエリ・集計用に個別カラムで保持
//! - 全生データは raw_json に格納し、将来の分析に備える

use serde::{Deserialize, Serialize};
use sqlx::{Pool, Sqlite, SqlitePool, Row, FromRow};
use std::sync::Arc;
use tauri::{AppHandle, Manager};

pub type DbPool = Arc<Pool<Sqlite>>;

// ---------------------------------------------------------------------------
// 初期化
// ---------------------------------------------------------------------------

pub async fn init_db(app: &AppHandle) -> Result<DbPool, String> {
    let data_dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    std::fs::create_dir_all(&data_dir).map_err(|e| e.to_string())?;
    let db_path = data_dir.join("chartoon.db");
    let url = format!("sqlite://{}?mode=rwc", db_path.to_string_lossy());

    let pool = SqlitePool::connect(&url).await.map_err(|e| e.to_string())?;
    sqlx::query(SCHEMA).execute(&pool).await.map_err(|e| e.to_string())?;
    // 既存 DB への追加カラム（失敗は無視 = 既存カラムなら OK）
    for sql in [
        "ALTER TABLE battles ADD COLUMN detail_fetched INTEGER NOT NULL DEFAULT 0",
        "ALTER TABLE battles ADD COLUMN knockout       TEXT",
        "ALTER TABLE battles ADD COLUMN sub_weapon     TEXT",
        "ALTER TABLE battles ADD COLUMN special_weapon TEXT",
        "ALTER TABLE battles ADD COLUMN awards         TEXT",
        "ALTER TABLE battles ADD COLUMN my_team        TEXT",
        "ALTER TABLE battles ADD COLUMN other_teams    TEXT",
    ] {
        let _ = sqlx::query(sql).execute(&pool).await;
    }
    Ok(Arc::new(pool))
}

const SCHEMA: &str = r#"
    CREATE TABLE IF NOT EXISTS battles (
        id          TEXT PRIMARY KEY,
        played_at   TEXT NOT NULL,
        mode        TEXT NOT NULL,
        rule        TEXT NOT NULL,
        stage       TEXT NOT NULL,
        weapon      TEXT NOT NULL,
        result      TEXT NOT NULL,
        kill        INTEGER NOT NULL DEFAULT 0,
        death       INTEGER NOT NULL DEFAULT 0,
        assist      INTEGER NOT NULL DEFAULT 0,
        special     INTEGER NOT NULL DEFAULT 0,
        inked       INTEGER NOT NULL DEFAULT 0,
        duration    INTEGER NOT NULL DEFAULT 0,
        rank_before TEXT,
        rank_after  TEXT,
        x_power     REAL,
        raw_json    TEXT NOT NULL,
        fetched_at  TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS battles_played_at ON battles(played_at);
    CREATE INDEX IF NOT EXISTS battles_mode      ON battles(mode);
    CREATE INDEX IF NOT EXISTS battles_weapon    ON battles(weapon);

    CREATE TABLE IF NOT EXISTS weapons (
        name           TEXT PRIMARY KEY,
        category       TEXT NOT NULL DEFAULT '',
        sub_weapon     TEXT,
        special_weapon TEXT
    );
"#;

// ---------------------------------------------------------------------------
// 型
// ---------------------------------------------------------------------------

#[derive(Debug, Serialize, Deserialize, FromRow)]
pub struct BattleRow {
    pub id: String,
    pub played_at: String,
    pub mode: String,
    pub rule: String,
    pub stage: String,
    pub weapon: String,
    pub result: String,
    pub kill: i64,
    pub death: i64,
    pub assist: i64,
    pub special: i64,
    pub inked: i64,
    pub duration: i64,
    pub rank_before: Option<String>,
    pub rank_after: Option<String>,
    pub x_power: Option<f64>,
    pub raw_json: String,
    pub fetched_at: String,
    pub knockout: Option<String>,
    pub sub_weapon: Option<String>,
    pub special_weapon: Option<String>,
    pub awards: Option<String>,
    pub my_team: Option<String>,
    pub other_teams: Option<String>,
}

#[derive(Debug, Serialize, Deserialize, FromRow)]
pub struct WeaponRecord {
    pub name: String,
    pub category: String,
    pub sub_weapon: Option<String>,
    pub special_weapon: Option<String>,
    pub total: i64,
    pub wins: i64,
}

// ---------------------------------------------------------------------------
// 書き込み
// ---------------------------------------------------------------------------

pub async fn insert_battles(pool: &DbPool, rows: Vec<BattleRow>) -> Result<usize, String> {
    let mut inserted = 0usize;
    for row in rows {
        let result = sqlx::query(
            "INSERT OR IGNORE INTO battles
             (id, played_at, mode, rule, stage, weapon, result,
              kill, death, assist, special, inked, duration,
              rank_before, rank_after, x_power, raw_json, fetched_at)
             VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
        )
        .bind(&row.id)
        .bind(&row.played_at)
        .bind(&row.mode)
        .bind(&row.rule)
        .bind(&row.stage)
        .bind(&row.weapon)
        .bind(&row.result)
        .bind(row.kill)
        .bind(row.death)
        .bind(row.assist)
        .bind(row.special)
        .bind(row.inked)
        .bind(row.duration)
        .bind(&row.rank_before)
        .bind(&row.rank_after)
        .bind(row.x_power)
        .bind(&row.raw_json)
        .bind(&row.fetched_at)
        .execute(pool.as_ref())
        .await
        .map_err(|e| e.to_string())?;
        inserted += result.rows_affected() as usize;
    }
    Ok(inserted)
}

/// 詳細取得が未完了のバトル ID 一覧を返す。
pub async fn get_battles_without_detail(pool: &DbPool) -> Result<Vec<String>, String> {
    let rows = sqlx::query("SELECT id FROM battles WHERE detail_fetched = 0 ORDER BY played_at DESC")
        .fetch_all(pool.as_ref())
        .await
        .map_err(|e| e.to_string())?;
    Ok(rows.into_iter().map(|r| r.get::<String, _>("id")).collect())
}

/// バトル詳細データをすべて更新し detail_fetched=1 にする。
pub async fn update_battle_detail(
    pool: &DbPool,
    id: &str,
    kill: i64,
    death: i64,
    assist: i64,
    special: i64,
    inked: i64,
    raw_json: &str,
    knockout: Option<&str>,
    sub_weapon: Option<&str>,
    special_weapon: Option<&str>,
    awards: Option<&str>,
    my_team: Option<&str>,
    other_teams: Option<&str>,
) -> Result<(), String> {
    sqlx::query(
        "UPDATE battles SET kill=?, death=?, assist=?, special=?, inked=?,
                            raw_json=?, detail_fetched=1,
                            knockout=?, sub_weapon=?, special_weapon=?,
                            awards=?, my_team=?, other_teams=?
         WHERE id=?",
    )
    .bind(kill)
    .bind(death)
    .bind(assist)
    .bind(special)
    .bind(inked)
    .bind(raw_json)
    .bind(knockout)
    .bind(sub_weapon)
    .bind(special_weapon)
    .bind(awards)
    .bind(my_team)
    .bind(other_teams)
    .bind(id)
    .execute(pool.as_ref())
    .await
    .map_err(|e| e.to_string())?;
    Ok(())
}

// ---------------------------------------------------------------------------
// Tauri コマンド
// ---------------------------------------------------------------------------

#[tauri::command]
pub async fn db_battle_stats(
    db: tauri::State<'_, DbPool>,
    since: Option<String>,
    mode: Option<String>,
    rule: Option<String>,
    result_filter: Option<String>,  // JS: resultFilter
    weapon: Option<String>,
) -> Result<serde_json::Value, String> {
    let row = sqlx::query(
        "SELECT
            COUNT(*) as total,
            SUM(CASE WHEN result='WIN' THEN 1 ELSE 0 END) as wins,
            COUNT(DISTINCT weapon) as weapon_count
         FROM battles
         WHERE (? IS NULL OR played_at >= ?)
           AND (? IS NULL OR mode = ?)
           AND (? IS NULL OR rule = ?)
           AND (? IS NULL OR result = ?)
           AND (? IS NULL OR weapon = ?)",
    )
    .bind(&since).bind(&since)
    .bind(&mode).bind(&mode)
    .bind(&rule).bind(&rule)
    .bind(&result_filter).bind(&result_filter)
    .bind(&weapon).bind(&weapon)
    .fetch_one(db.as_ref())
    .await
    .map_err(|e| e.to_string())?;

    let total: i64 = row.get("total");
    let wins: i64  = row.get("wins");
    let weapon_count: i64 = row.get("weapon_count");
    Ok(serde_json::json!({
        "total": total,
        "wins": wins,
        "win_rate": if total > 0 { wins as f64 / total as f64 } else { 0.0 },
        "weapon_count": weapon_count,
    }))
}

#[tauri::command]
pub async fn db_battle_count(
    db: tauri::State<'_, DbPool>,
    since: Option<String>,
    mode: Option<String>,
    rule: Option<String>,
    result_filter: Option<String>,  // JS: resultFilter
    weapon: Option<String>,
) -> Result<i64, String> {
    let row = sqlx::query(
        "SELECT COUNT(*) as cnt FROM battles
         WHERE (? IS NULL OR played_at >= ?)
           AND (? IS NULL OR mode = ?)
           AND (? IS NULL OR rule = ?)
           AND (? IS NULL OR result = ?)
           AND (? IS NULL OR weapon = ?)",
    )
    .bind(&since).bind(&since)
    .bind(&mode).bind(&mode)
    .bind(&rule).bind(&rule)
    .bind(&result_filter).bind(&result_filter)
    .bind(&weapon).bind(&weapon)
    .fetch_one(db.as_ref())
    .await
    .map_err(|e| e.to_string())?;
    Ok(row.get::<i64, _>("cnt"))
}

#[tauri::command]
pub async fn db_list_battles(
    db: tauri::State<'_, DbPool>,
    limit: i64,
    offset: i64,
    since: Option<String>,
    mode: Option<String>,
    rule: Option<String>,
    result_filter: Option<String>,  // JS: resultFilter
    weapon: Option<String>,
    order_by: Option<String>,       // JS: orderBy
    order_asc: Option<bool>,        // JS: orderAsc
) -> Result<Vec<BattleRow>, String> {
    let order_col = match order_by.as_deref() {
        Some("kill")  => "kill",
        Some("death") => "death",
        Some("inked") => "inked",
        _             => "played_at",
    };
    let order_dir = if order_asc.unwrap_or(false) { "ASC" } else { "DESC" };
    let sql = format!(
        "SELECT id, played_at, mode, rule, stage, weapon, result,
                kill, death, assist, special, inked, duration,
                rank_before, rank_after, x_power, raw_json, fetched_at,
                knockout, sub_weapon, special_weapon, awards, my_team, other_teams
         FROM battles
         WHERE (? IS NULL OR played_at >= ?)
           AND (? IS NULL OR mode = ?)
           AND (? IS NULL OR rule = ?)
           AND (? IS NULL OR result = ?)
           AND (? IS NULL OR weapon = ?)
         ORDER BY {order_col} {order_dir} LIMIT ? OFFSET ?"
    );
    let rows = sqlx::query_as::<_, BattleRow>(&sql)
        .bind(&since).bind(&since)
        .bind(&mode).bind(&mode)
        .bind(&rule).bind(&rule)
        .bind(&result_filter).bind(&result_filter)
        .bind(&weapon).bind(&weapon)
        .bind(limit)
        .bind(offset)
        .fetch_all(db.as_ref())
        .await
        .map_err(|e| e.to_string())?;
    Ok(rows)
}

/// 使用済み武器の一覧を試合数の多い順で返す。
#[tauri::command]
pub async fn db_weapons_used(db: tauri::State<'_, DbPool>) -> Result<Vec<String>, String> {
    let rows = sqlx::query(
        "SELECT weapon FROM battles GROUP BY weapon ORDER BY COUNT(*) DESC",
    )
    .fetch_all(db.as_ref())
    .await
    .map_err(|e| e.to_string())?;
    Ok(rows.into_iter().map(|r| r.get::<String, _>("weapon")).collect())
}

#[tauri::command]
pub async fn db_summary(
    db: tauri::State<'_, DbPool>,
    since: Option<String>,
    mode: Option<String>,
    rule: Option<String>,
    result_filter: Option<String>,  // JS: resultFilter
    weapon: Option<String>,
) -> Result<serde_json::Value, String> {
    let filter_where =
        "(? IS NULL OR played_at >= ?)
           AND (? IS NULL OR mode = ?)
           AND (? IS NULL OR rule = ?)
           AND (? IS NULL OR result = ?)
           AND (? IS NULL OR weapon = ?)";

    macro_rules! bind_filters {
        ($q:expr) => {
            $q.bind(&since).bind(&since)
              .bind(&mode).bind(&mode)
              .bind(&rule).bind(&rule)
              .bind(&result_filter).bind(&result_filter)
              .bind(&weapon).bind(&weapon)
        };
    }

    let by_weapon = bind_filters!(sqlx::query(&format!(
        "SELECT weapon as name, COUNT(*) as total,
                SUM(CASE WHEN result='WIN' THEN 1 ELSE 0 END) as wins
         FROM battles WHERE {filter_where} GROUP BY weapon ORDER BY total DESC"
    )))
    .fetch_all(db.as_ref())
    .await
    .map_err(|e| e.to_string())?;

    let by_mode = bind_filters!(sqlx::query(&format!(
        "SELECT mode as name, COUNT(*) as total,
                SUM(CASE WHEN result='WIN' THEN 1 ELSE 0 END) as wins
         FROM battles WHERE {filter_where} GROUP BY mode ORDER BY total DESC"
    )))
    .fetch_all(db.as_ref())
    .await
    .map_err(|e| e.to_string())?;

    let by_stage = bind_filters!(sqlx::query(&format!(
        "SELECT stage as name, COUNT(*) as total,
                SUM(CASE WHEN result='WIN' THEN 1 ELSE 0 END) as wins
         FROM battles WHERE {filter_where} GROUP BY stage ORDER BY total DESC"
    )))
    .fetch_all(db.as_ref())
    .await
    .map_err(|e| e.to_string())?;

    let by_rule = bind_filters!(sqlx::query(&format!(
        "SELECT rule as name, COUNT(*) as total,
                SUM(CASE WHEN result='WIN' THEN 1 ELSE 0 END) as wins
         FROM battles WHERE {filter_where} GROUP BY rule ORDER BY total DESC"
    )))
    .fetch_all(db.as_ref())
    .await
    .map_err(|e| e.to_string())?;

    fn to_json(rows: Vec<sqlx::sqlite::SqliteRow>) -> Vec<serde_json::Value> {
        rows.into_iter().map(|r| {
            let total: i64 = r.get("total");
            let wins: i64 = r.get("wins");
            serde_json::json!({
                "name": r.get::<String, _>("name"),
                "total": total,
                "wins": wins,
                "win_rate": if total > 0 { wins as f64 / total as f64 } else { 0.0 }
            })
        }).collect()
    }

    Ok(serde_json::json!({
        "by_weapon": to_json(by_weapon),
        "by_mode": to_json(by_mode),
        "by_stage": to_json(by_stage),
        "by_rule": to_json(by_rule),
    }))
}

// ---------------------------------------------------------------------------
// 武器マスター
// ---------------------------------------------------------------------------

pub async fn upsert_weapon(
    pool: &DbPool,
    name: &str,
    category: &str,
    sub_weapon: Option<&str>,
    special_weapon: Option<&str>,
) -> Result<(), String> {
    sqlx::query(
        "INSERT INTO weapons (name, category, sub_weapon, special_weapon)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(name) DO UPDATE SET
             category       = excluded.category,
             sub_weapon     = excluded.sub_weapon,
             special_weapon = excluded.special_weapon",
    )
    .bind(name)
    .bind(category)
    .bind(sub_weapon)
    .bind(special_weapon)
    .execute(pool.as_ref())
    .await
    .map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub async fn db_list_weapons(db: tauri::State<'_, DbPool>) -> Result<Vec<WeaponRecord>, String> {
    let rows = sqlx::query_as::<_, WeaponRecord>(
        "SELECT w.name, w.category, w.sub_weapon, w.special_weapon,
                COUNT(b.id) as total,
                COALESCE(SUM(CASE WHEN b.result='WIN' THEN 1 ELSE 0 END), 0) as wins
         FROM weapons w
         LEFT JOIN battles b ON b.weapon = w.name
         GROUP BY w.name
         ORDER BY w.category, total DESC, w.name",
    )
    .fetch_all(db.as_ref())
    .await
    .map_err(|e| e.to_string())?;
    Ok(rows)
}
