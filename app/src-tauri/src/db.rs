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
        "ALTER TABLE weapons ADD COLUMN sub_weapon_image     TEXT",
        "ALTER TABLE weapons ADD COLUMN special_weapon_image TEXT",
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
        name                TEXT PRIMARY KEY,
        category            TEXT NOT NULL DEFAULT '',
        sub_weapon          TEXT,
        special_weapon      TEXT,
        sub_weapon_image    TEXT,
        special_weapon_image TEXT
    );

    CREATE TABLE IF NOT EXISTS battle_players (
        battle_id      TEXT    NOT NULL,
        team           TEXT    NOT NULL,
        slot           INTEGER NOT NULL,
        is_myself      INTEGER NOT NULL DEFAULT 0,
        weapon         TEXT    NOT NULL DEFAULT '',
        sub_weapon     TEXT,
        special_weapon TEXT,
        kill           INTEGER NOT NULL DEFAULT 0,
        death          INTEGER NOT NULL DEFAULT 0,
        assist         INTEGER NOT NULL DEFAULT 0,
        special        INTEGER NOT NULL DEFAULT 0,
        paint          INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (battle_id, team, slot)
    );
    CREATE INDEX IF NOT EXISTS idx_bp_weapon ON battle_players(weapon);
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
    pub sub_weapon_image: Option<String>,
    pub special_weapon_image: Option<String>,
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
// battle_players
// ---------------------------------------------------------------------------

pub struct BattlePlayerRow {
    pub battle_id:      String,
    pub team:           String,   // "my" | "other"
    pub slot:           i64,
    pub is_myself:      bool,
    pub weapon:         String,
    pub sub_weapon:     Option<String>,
    pub special_weapon: Option<String>,
    pub kill:           i64,
    pub death:          i64,
    pub assist:         i64,
    pub special:        i64,
    pub paint:          i64,
}

fn stat_i64(result: Option<&serde_json::Value>, key: &str) -> i64 {
    result.and_then(|r| r.get(key)).and_then(|v| v.as_i64()).unwrap_or(0)
}

/// my_team / other_teams の JSON 文字列からプレイヤー行を生成する。
pub fn parse_players_from_json(
    battle_id: &str,
    my_team_json: Option<&str>,
    other_teams_json: Option<&str>,
) -> Vec<BattlePlayerRow> {
    let mut players: Vec<BattlePlayerRow> = Vec::new();

    if let Some(json) = my_team_json {
        if let Ok(arr) = serde_json::from_str::<serde_json::Value>(json) {
            if let Some(list) = arr.as_array() {
                for (slot, p) in list.iter().enumerate() {
                    let weapon = p.pointer("/weapon/name").and_then(|v| v.as_str()).unwrap_or("").to_string();
                    if weapon.is_empty() { continue; }
                    let res = p.get("result");
                    players.push(BattlePlayerRow {
                        battle_id:      battle_id.to_string(),
                        team:           "my".to_string(),
                        slot:           slot as i64,
                        is_myself:      p.get("isMyself").and_then(|v| v.as_bool()).unwrap_or(false),
                        weapon,
                        sub_weapon:     p.pointer("/weapon/subWeapon/name").and_then(|v| v.as_str()).map(|s| s.to_string()),
                        special_weapon: p.pointer("/weapon/specialWeapon/name").and_then(|v| v.as_str()).map(|s| s.to_string()),
                        kill:    stat_i64(res, "kill"),
                        death:   stat_i64(res, "death"),
                        assist:  stat_i64(res, "assist"),
                        special: stat_i64(res, "special"),
                        paint:   p.get("paint").and_then(|v| v.as_i64()).unwrap_or(0),
                    });
                }
            }
        }
    }

    if let Some(json) = other_teams_json {
        if let Ok(arr) = serde_json::from_str::<serde_json::Value>(json) {
            if let Some(teams) = arr.as_array() {
                let mut slot = 0i64;
                for team in teams {
                    if let Some(list) = team.pointer("/players").and_then(|v| v.as_array()) {
                        for p in list {
                            let weapon = p.pointer("/weapon/name").and_then(|v| v.as_str()).unwrap_or("").to_string();
                            if weapon.is_empty() { slot += 1; continue; }
                            let res = p.get("result");
                            players.push(BattlePlayerRow {
                                battle_id:      battle_id.to_string(),
                                team:           "other".to_string(),
                                slot,
                                is_myself:      false,
                                weapon,
                                sub_weapon:     p.pointer("/weapon/subWeapon/name").and_then(|v| v.as_str()).map(|s| s.to_string()),
                                special_weapon: p.pointer("/weapon/specialWeapon/name").and_then(|v| v.as_str()).map(|s| s.to_string()),
                                kill:    stat_i64(res, "kill"),
                                death:   stat_i64(res, "death"),
                                assist:  stat_i64(res, "assist"),
                                special: stat_i64(res, "special"),
                                paint:   p.get("paint").and_then(|v| v.as_i64()).unwrap_or(0),
                            });
                            slot += 1;
                        }
                    }
                }
            }
        }
    }

    players
}

pub async fn insert_battle_players(pool: &DbPool, players: &[BattlePlayerRow]) -> Result<(), String> {
    for p in players {
        sqlx::query(
            "INSERT OR IGNORE INTO battle_players
             (battle_id, team, slot, is_myself, weapon, sub_weapon, special_weapon,
              kill, death, assist, special, paint)
             VALUES (?,?,?,?,?,?,?,?,?,?,?,?)",
        )
        .bind(&p.battle_id)
        .bind(&p.team)
        .bind(p.slot)
        .bind(p.is_myself as i64)
        .bind(&p.weapon)
        .bind(&p.sub_weapon)
        .bind(&p.special_weapon)
        .bind(p.kill)
        .bind(p.death)
        .bind(p.assist)
        .bind(p.special)
        .bind(p.paint)
        .execute(pool.as_ref())
        .await
        .map_err(|e| e.to_string())?;
    }
    Ok(())
}

/// 詳細取得済みで battle_players 未登録のバトルをバックフィルする。
#[tauri::command]
pub async fn backfill_battle_players(db: tauri::State<'_, DbPool>) -> Result<usize, String> {
    let rows = sqlx::query(
        "SELECT id, my_team, other_teams FROM battles
         WHERE detail_fetched = 1
           AND (my_team IS NOT NULL OR other_teams IS NOT NULL)
           AND id NOT IN (SELECT DISTINCT battle_id FROM battle_players)",
    )
    .fetch_all(db.as_ref())
    .await
    .map_err(|e| e.to_string())?;

    let mut count = 0usize;
    for row in &rows {
        let battle_id:   String         = row.get("id");
        let my_team:     Option<String> = row.get("my_team");
        let other_teams: Option<String> = row.get("other_teams");
        let players = parse_players_from_json(&battle_id, my_team.as_deref(), other_teams.as_deref());
        count += players.len();
        insert_battle_players(&*db, &players).await?;
    }
    Ok(count)
}

// ---------------------------------------------------------------------------
// Tauri コマンド
// ---------------------------------------------------------------------------

#[tauri::command]
pub async fn db_battle_stats(
    db: tauri::State<'_, DbPool>,
    since: Option<String>,
    until: Option<String>,
    mode: Option<String>,
    rule: Option<String>,
    result_filter: Option<String>,  // JS: resultFilter
    weapon: Option<String>,
    stage: Option<String>,
) -> Result<serde_json::Value, String> {
    let row = sqlx::query(
        "SELECT
            COUNT(*) as total,
            SUM(CASE WHEN result='WIN'  THEN 1 ELSE 0 END) as wins,
            SUM(CASE WHEN result='DRAW' THEN 1 ELSE 0 END) as draws,
            COUNT(DISTINCT weapon) as weapon_count
         FROM battles
         WHERE (? IS NULL OR played_at >= ?)
           AND (? IS NULL OR played_at <= ?)
           AND (? IS NULL OR mode = ?)
           AND (? IS NULL OR rule = ?)
           AND (? IS NULL OR result = ?)
           AND (? IS NULL OR weapon = ?)
           AND (? IS NULL OR stage = ?)",
    )
    .bind(&since).bind(&since)
    .bind(&until).bind(&until)
    .bind(&mode).bind(&mode)
    .bind(&rule).bind(&rule)
    .bind(&result_filter).bind(&result_filter)
    .bind(&weapon).bind(&weapon)
    .bind(&stage).bind(&stage)
    .fetch_one(db.as_ref())
    .await
    .map_err(|e| e.to_string())?;

    let total: i64        = row.get("total");
    let wins: i64         = row.get("wins");
    let draws: i64        = row.get("draws");
    let weapon_count: i64 = row.get("weapon_count");
    Ok(serde_json::json!({
        "total": total,
        "wins": wins,
        "draws": draws,
        "win_rate": if total > 0 { wins as f64 / total as f64 } else { 0.0 },
        "weapon_count": weapon_count,
    }))
}

#[tauri::command]
pub async fn db_battle_count(
    db: tauri::State<'_, DbPool>,
    since: Option<String>,
    until: Option<String>,
    mode: Option<String>,
    rule: Option<String>,
    result_filter: Option<String>,  // JS: resultFilter
    weapon: Option<String>,
    stage: Option<String>,
) -> Result<i64, String> {
    let row = sqlx::query(
        "SELECT COUNT(*) as cnt FROM battles
         WHERE (? IS NULL OR played_at >= ?)
           AND (? IS NULL OR played_at <= ?)
           AND (? IS NULL OR mode = ?)
           AND (? IS NULL OR rule = ?)
           AND (? IS NULL OR result = ?)
           AND (? IS NULL OR weapon = ?)
           AND (? IS NULL OR stage = ?)",
    )
    .bind(&since).bind(&since)
    .bind(&until).bind(&until)
    .bind(&mode).bind(&mode)
    .bind(&rule).bind(&rule)
    .bind(&result_filter).bind(&result_filter)
    .bind(&weapon).bind(&weapon)
    .bind(&stage).bind(&stage)
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
    until: Option<String>,
    mode: Option<String>,
    rule: Option<String>,
    result_filter: Option<String>,  // JS: resultFilter
    weapon: Option<String>,
    stage: Option<String>,
    order_by: Option<String>,       // JS: orderBy
    order_asc: Option<bool>,        // JS: orderAsc
) -> Result<Vec<BattleRow>, String> {
    let order_col = match order_by.as_deref() {
        Some("kill")    => "kill",
        Some("death")   => "death",
        Some("special") => "special",
        Some("inked")   => "inked",
        _               => "played_at",
    };
    let order_dir = if order_asc.unwrap_or(false) { "ASC" } else { "DESC" };
    let sql = format!(
        "SELECT id, played_at, mode, rule, stage, weapon, result,
                kill, death, assist, special, inked, duration,
                rank_before, rank_after, x_power, raw_json, fetched_at,
                knockout, sub_weapon, special_weapon, awards, my_team, other_teams
         FROM battles
         WHERE (? IS NULL OR played_at >= ?)
           AND (? IS NULL OR played_at <= ?)
           AND (? IS NULL OR mode = ?)
           AND (? IS NULL OR rule = ?)
           AND (? IS NULL OR result = ?)
           AND (? IS NULL OR weapon = ?)
           AND (? IS NULL OR stage = ?)
         ORDER BY {order_col} {order_dir} LIMIT ? OFFSET ?"
    );
    let rows = sqlx::query_as::<_, BattleRow>(&sql)
        .bind(&since).bind(&since)
        .bind(&until).bind(&until)
        .bind(&mode).bind(&mode)
        .bind(&rule).bind(&rule)
        .bind(&result_filter).bind(&result_filter)
        .bind(&weapon).bind(&weapon)
        .bind(&stage).bind(&stage)
        .bind(limit)
        .bind(offset)
        .fetch_all(db.as_ref())
        .await
        .map_err(|e| e.to_string())?;
    Ok(rows)
}

/// 使用済みステージの一覧を試合数の多い順で返す。
#[tauri::command]
pub async fn db_stages_used(db: tauri::State<'_, DbPool>) -> Result<Vec<String>, String> {
    let rows = sqlx::query(
        "SELECT stage FROM battles GROUP BY stage ORDER BY COUNT(*) DESC",
    )
    .fetch_all(db.as_ref())
    .await
    .map_err(|e| e.to_string())?;
    Ok(rows.into_iter().map(|r| r.get::<String, _>("stage")).collect())
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
    until: Option<String>,
    mode: Option<String>,
    rule: Option<String>,
    result_filter: Option<String>,  // JS: resultFilter
    weapon: Option<String>,
    stage: Option<String>,
) -> Result<serde_json::Value, String> {
    let filter_where =
        "(? IS NULL OR played_at >= ?)
           AND (? IS NULL OR played_at <= ?)
           AND (? IS NULL OR mode = ?)
           AND (? IS NULL OR rule = ?)
           AND (? IS NULL OR result = ?)
           AND (? IS NULL OR weapon = ?)
           AND (? IS NULL OR stage = ?)";

    macro_rules! bind_filters {
        ($q:expr) => {
            $q.bind(&since).bind(&since)
              .bind(&until).bind(&until)
              .bind(&mode).bind(&mode)
              .bind(&rule).bind(&rule)
              .bind(&result_filter).bind(&result_filter)
              .bind(&weapon).bind(&weapon)
              .bind(&stage).bind(&stage)
        };
    }

    let by_weapon = bind_filters!(sqlx::query(&format!(
        "SELECT weapon as name, COUNT(*) as total,
                SUM(CASE WHEN result='WIN'  THEN 1 ELSE 0 END) as wins,
                SUM(CASE WHEN result='DRAW' THEN 1 ELSE 0 END) as draws
         FROM battles WHERE {filter_where} GROUP BY weapon ORDER BY total DESC"
    )))
    .fetch_all(db.as_ref())
    .await
    .map_err(|e| e.to_string())?;

    let by_mode = bind_filters!(sqlx::query(&format!(
        "SELECT mode as name, COUNT(*) as total,
                SUM(CASE WHEN result='WIN'  THEN 1 ELSE 0 END) as wins,
                SUM(CASE WHEN result='DRAW' THEN 1 ELSE 0 END) as draws
         FROM battles WHERE {filter_where} GROUP BY mode ORDER BY total DESC"
    )))
    .fetch_all(db.as_ref())
    .await
    .map_err(|e| e.to_string())?;

    let by_stage = bind_filters!(sqlx::query(&format!(
        "SELECT stage as name, COUNT(*) as total,
                SUM(CASE WHEN result='WIN'  THEN 1 ELSE 0 END) as wins,
                SUM(CASE WHEN result='DRAW' THEN 1 ELSE 0 END) as draws
         FROM battles WHERE {filter_where} GROUP BY stage ORDER BY total DESC"
    )))
    .fetch_all(db.as_ref())
    .await
    .map_err(|e| e.to_string())?;

    let by_rule = bind_filters!(sqlx::query(&format!(
        "SELECT rule as name, COUNT(*) as total,
                SUM(CASE WHEN result='WIN'  THEN 1 ELSE 0 END) as wins,
                SUM(CASE WHEN result='DRAW' THEN 1 ELSE 0 END) as draws
         FROM battles WHERE {filter_where} GROUP BY rule ORDER BY total DESC"
    )))
    .fetch_all(db.as_ref())
    .await
    .map_err(|e| e.to_string())?;

    fn to_json(rows: Vec<sqlx::sqlite::SqliteRow>) -> Vec<serde_json::Value> {
        rows.into_iter().map(|r| {
            let total: i64 = r.get("total");
            let wins: i64  = r.get("wins");
            let draws: i64 = r.get("draws");
            serde_json::json!({
                "name": r.get::<String, _>("name"),
                "total": total,
                "wins": wins,
                "draws": draws,
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
             category       = CASE WHEN excluded.category != '' THEN excluded.category ELSE weapons.category END,
             sub_weapon     = COALESCE(excluded.sub_weapon, weapons.sub_weapon),
             special_weapon = COALESCE(excluded.special_weapon, weapons.special_weapon)",
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

/// サブ・スペシャルウェポンの画像 URL を weapons テーブルに保存する。
/// 既存の値がある場合は上書きしない。
pub async fn update_weapon_sub_special_images(
    pool: &DbPool,
    weapon_name: &str,
    sub_image: Option<&str>,
    special_image: Option<&str>,
) -> Result<(), String> {
    sqlx::query(
        "UPDATE weapons SET
             sub_weapon_image     = COALESCE(sub_weapon_image, ?),
             special_weapon_image = COALESCE(special_weapon_image, ?)
         WHERE name = ?",
    )
    .bind(sub_image)
    .bind(special_image)
    .bind(weapon_name)
    .execute(pool.as_ref())
    .await
    .map_err(|e| e.to_string())?;
    Ok(())
}

/// バトル詳細の my_team / other_teams JSON を全件返す（画像キャッシュ用）。
pub async fn get_battles_team_json(pool: &DbPool) -> Result<Vec<(Option<String>, Option<String>)>, String> {
    let rows = sqlx::query(
        "SELECT my_team, other_teams FROM battles
         WHERE my_team IS NOT NULL OR other_teams IS NOT NULL",
    )
    .fetch_all(pool.as_ref())
    .await
    .map_err(|e| e.to_string())?;
    Ok(rows.into_iter().map(|r| (r.get("my_team"), r.get("other_teams"))).collect())
}

/// battle_players テーブルから sub/special を weapons テーブルに補完する。
/// 自分の武器だけでなく、同じバトルの味方・敵の武器も対象になる。
pub async fn populate_weapons_from_battles(pool: &DbPool) -> Result<usize, String> {
    // battle_players から全プレイヤーの sub/special をアップサート
    sqlx::query(
        "INSERT INTO weapons (name, category, sub_weapon, special_weapon)
         SELECT weapon, '', sub_weapon, special_weapon
         FROM (
             SELECT weapon, sub_weapon, special_weapon,
                    ROW_NUMBER() OVER (PARTITION BY weapon ORDER BY battle_id DESC) AS rn
             FROM battle_players
             WHERE weapon != '' AND sub_weapon IS NOT NULL
         ) WHERE rn = 1
         ON CONFLICT(name) DO UPDATE SET
             sub_weapon     = COALESCE(excluded.sub_weapon, weapons.sub_weapon),
             special_weapon = COALESCE(excluded.special_weapon, weapons.special_weapon)",
    )
    .execute(pool.as_ref())
    .await
    .map_err(|e| e.to_string())?;

    // 詳細未取得で battle_players にもない武器を name だけ登録
    sqlx::query(
        "INSERT OR IGNORE INTO weapons (name, category, sub_weapon, special_weapon)
         SELECT DISTINCT weapon, '', NULL, NULL FROM battles WHERE weapon != ''",
    )
    .execute(pool.as_ref())
    .await
    .map_err(|e| e.to_string())?;

    let row = sqlx::query("SELECT COUNT(*) as cnt FROM weapons")
        .fetch_one(pool.as_ref())
        .await
        .map_err(|e| e.to_string())?;
    Ok(row.get::<i64, _>("cnt") as usize)
}

#[tauri::command]
pub async fn db_list_weapons(db: tauri::State<'_, DbPool>) -> Result<Vec<WeaponRecord>, String> {
    let rows = sqlx::query_as::<_, WeaponRecord>(
        "SELECT w.name, w.category, w.sub_weapon, w.special_weapon,
                w.sub_weapon_image, w.special_weapon_image,
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
