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
        "ALTER TABLE battles ADD COLUMN stage_name     TEXT",
        "ALTER TABLE battles ADD COLUMN statink_uuid  TEXT",
        // historyGroups の親ノード（bankaraMatchChallenge or xMatchMeasurement）の JSON。
        // 各 group の最新バトル（idx==0）にのみセットされる。NULL も多い。
        "ALTER TABLE battles ADD COLUMN parent_json   TEXT",
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
        stage_name  TEXT,
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
// 新スキーマ（v6, stat.ink 互換の正規化形）
// ---------------------------------------------------------------------------
//
// 既存の battles / battle_players / weapons とは別テーブルとして共存させ、
// PR 90-B 以降で raw_json から段階的にデータ移行する。
//
// マスターの key は stat.ink のスラッグに揃える（連携・将来のマージ用）:
//   lobby:  regular / bankara_open / bankara_challenge / xmatch / splatfest_open / splatfest_challenge / event / private
//   rule:   nawabari / area / yagura / hoko / asari / tricolor
//   result: win / lose / draw
//   ability: abilities::ABILITY_HASHES の stat.ink キー（ink_saver_main 等）

const SCHEMA_V6: &str = r#"
    CREATE TABLE IF NOT EXISTS lobby (
        id  INTEGER PRIMARY KEY,
        key TEXT    NOT NULL UNIQUE
    );

    CREATE TABLE IF NOT EXISTS rule (
        id  INTEGER PRIMARY KEY,
        key TEXT    NOT NULL UNIQUE
    );

    CREATE TABLE IF NOT EXISTS result (
        id  INTEGER PRIMARY KEY,
        key TEXT    NOT NULL UNIQUE
    );

    CREATE TABLE IF NOT EXISTS ability (
        id        INTEGER PRIMARY KEY,
        key       TEXT    NOT NULL UNIQUE,
        image_key TEXT
    );

    CREATE TABLE IF NOT EXISTS map (
        id           INTEGER PRIMARY KEY AUTOINCREMENT,
        key          TEXT    NOT NULL UNIQUE,
        name_ja      TEXT,
        name_en      TEXT,
        splatnet3_id TEXT
    );

    CREATE TABLE IF NOT EXISTS weapon (
        id           INTEGER PRIMARY KEY AUTOINCREMENT,
        key          TEXT    NOT NULL UNIQUE,
        name_ja      TEXT,
        category_key TEXT,
        sub_key      TEXT,
        special_key  TEXT,
        image_key    TEXT
    );

    CREATE TABLE IF NOT EXISTS gear_configuration (
        id                 INTEGER PRIMARY KEY AUTOINCREMENT,
        primary_ability_id INTEGER NOT NULL REFERENCES ability(id),
        sub1_ability_id    INTEGER REFERENCES ability(id),
        sub2_ability_id    INTEGER REFERENCES ability(id),
        sub3_ability_id    INTEGER REFERENCES ability(id),
        UNIQUE(primary_ability_id, sub1_ability_id, sub2_ability_id, sub3_ability_id)
    );

    CREATE TABLE IF NOT EXISTS battle (
        id                 TEXT    PRIMARY KEY,
        uuid               TEXT,
        played_at          TEXT    NOT NULL,
        period             TEXT,
        lobby_id           INTEGER NOT NULL REFERENCES lobby(id),
        rule_id            INTEGER NOT NULL REFERENCES rule(id),
        map_id             INTEGER NOT NULL REFERENCES map(id),
        result_id          INTEGER NOT NULL REFERENCES result(id),
        weapon_id          INTEGER NOT NULL REFERENCES weapon(id),
        is_knockout        INTEGER,
        rank_in_team       INTEGER,
        kill               INTEGER NOT NULL DEFAULT 0,
        assist             INTEGER NOT NULL DEFAULT 0,
        kill_or_assist     INTEGER NOT NULL DEFAULT 0,
        death              INTEGER NOT NULL DEFAULT 0,
        special            INTEGER NOT NULL DEFAULT 0,
        inked              INTEGER NOT NULL DEFAULT 0,
        duration           INTEGER NOT NULL DEFAULT 0,
        our_team_inked     INTEGER,
        their_team_inked   INTEGER,
        our_team_percent   REAL,
        their_team_percent REAL,
        our_team_count     INTEGER,
        their_team_count   INTEGER,
        rank_before        TEXT,
        rank_after         TEXT,
        rank_before_s_plus INTEGER,
        rank_after_s_plus  INTEGER,
        x_power_before     REAL,
        x_power_after      REAL,
        raw_json           TEXT,
        fetched_at         TEXT    NOT NULL DEFAULT (datetime('now')),
        detail_fetched     INTEGER NOT NULL DEFAULT 0,
        statink_uuid       TEXT
    );
    CREATE INDEX IF NOT EXISTS battle_played_at ON battle(played_at);
    CREATE INDEX IF NOT EXISTS battle_lobby     ON battle(lobby_id);
    CREATE INDEX IF NOT EXISTS battle_rule      ON battle(rule_id);
    CREATE INDEX IF NOT EXISTS battle_map       ON battle(map_id);
    CREATE INDEX IF NOT EXISTS battle_weapon    ON battle(weapon_id);

    CREATE TABLE IF NOT EXISTS battle_player (
        battle_id      TEXT    NOT NULL REFERENCES battle(id) ON DELETE CASCADE,
        is_our_team    INTEGER NOT NULL,
        rank_in_team   INTEGER NOT NULL,
        is_me          INTEGER NOT NULL DEFAULT 0,
        name           TEXT,
        name_id        TEXT,
        weapon_id      INTEGER NOT NULL REFERENCES weapon(id),
        headgear_id    INTEGER REFERENCES gear_configuration(id),
        clothing_id    INTEGER REFERENCES gear_configuration(id),
        shoes_id       INTEGER REFERENCES gear_configuration(id),
        kill           INTEGER NOT NULL DEFAULT 0,
        assist         INTEGER NOT NULL DEFAULT 0,
        kill_or_assist INTEGER NOT NULL DEFAULT 0,
        death          INTEGER NOT NULL DEFAULT 0,
        special        INTEGER NOT NULL DEFAULT 0,
        inked          INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (battle_id, is_our_team, rank_in_team)
    );
    CREATE INDEX IF NOT EXISTS battle_player_weapon ON battle_player(weapon_id);
"#;

const LOBBY_SEED: &[(i64, &str)] = &[
    (1, "regular"),
    (2, "bankara_open"),
    (3, "bankara_challenge"),
    (4, "xmatch"),
    (5, "event"),
    (6, "splatfest_open"),
    (7, "splatfest_challenge"),
    (8, "private"),
];

const RULE_SEED: &[(i64, &str)] = &[
    (1, "nawabari"),
    (2, "area"),
    (3, "yagura"),
    (4, "hoko"),
    (5, "asari"),
    (6, "tricolor"),
];

const RESULT_SEED: &[(i64, &str)] = &[
    (1, "win"),
    (2, "lose"),
    (3, "draw"),
];

/// 旧 `battles.mode` の slug を新 `lobby.id` に変換する。
/// 未知の値は `None` を返し、呼び出し元で migration をスキップする。
fn old_mode_to_lobby_id(mode: &str) -> Option<i64> {
    match mode {
        "regular"           => Some(1),
        "bankara_open"      => Some(2),
        "bankara_challenge" => Some(3),
        "x" | "xmatch"      => Some(4),
        "event"             => Some(5),
        "splatfest_open"    => Some(6),
        "splatfest_challenge" => Some(7),
        "private"           => Some(8),
        _ => None,
    }
}

/// 旧 `battles.rule` の slug を新 `rule.id` に変換する。
fn old_rule_to_rule_id(rule: &str) -> Option<i64> {
    match rule {
        "turf_war" | "nawabari" => Some(1),
        "area"                  => Some(2),
        "yagura"                => Some(3),
        "hoko"                  => Some(4),
        "asari"                 => Some(5),
        "tricolor"              => Some(6),
        _ => None,
    }
}

/// 旧 `battles.result` の slug を新 `result.id` に変換する。
fn old_result_to_result_id(result: &str) -> Option<i64> {
    match result {
        "win"  => Some(1),
        "lose" => Some(2),
        "draw" => Some(3),
        _ => None,
    }
}

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
    pub stage_name: Option<String>,
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
    pub statink_uuid: Option<String>,
    /// 履歴クエリの親ノード（bankaraMatchChallenge / xMatchMeasurement）の JSON。
    /// 各 historyGroup の最新バトルのみ非 NULL。stat.ink へのアップロード時に使用。
    pub parent_json: Option<String>,
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
    pub draws: i64,
}

// ---------------------------------------------------------------------------
// 書き込み
// ---------------------------------------------------------------------------

pub async fn insert_battles(pool: &DbPool, rows: Vec<BattleRow>) -> Result<usize, String> {
    let mut inserted = 0usize;
    for row in rows {
        let result = sqlx::query(
            "INSERT OR IGNORE INTO battles
             (id, played_at, mode, rule, stage, stage_name, weapon, result,
              kill, death, assist, special, inked, duration,
              rank_before, rank_after, x_power, raw_json, fetched_at, parent_json)
             VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
        )
        .bind(&row.id)
        .bind(&row.played_at)
        .bind(&row.mode)
        .bind(&row.rule)
        .bind(&row.stage)
        .bind(&row.stage_name)
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
        .bind(&row.parent_json)
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
/// rule / mode もここで詳細クエリ由来の値で上書きする（リスト取り込み時の
/// 取りこぼし・誤分類を救済するため）。
#[allow(clippy::too_many_arguments)]
pub async fn update_battle_detail(
    pool: &DbPool,
    id: &str,
    kill: i64,
    death: i64,
    assist: i64,
    special: i64,
    inked: i64,
    raw_json: &str,
    rule: &str,
    mode: &str,
    knockout: Option<&str>,
    sub_weapon: Option<&str>,
    special_weapon: Option<&str>,
    awards: Option<&str>,
    my_team: Option<&str>,
    other_teams: Option<&str>,
) -> Result<(), String> {
    sqlx::query(
        "UPDATE battles SET kill=?, death=?, assist=?, special=?, inked=?,
                            raw_json=?, rule=?, mode=?, detail_fetched=1,
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
    .bind(rule)
    .bind(mode)
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
                        kill:    stat_i64(res, "kill") - stat_i64(res, "assist"),
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

/// 詳細取得済みで battle_players 未登録のバトルをバックフィルする（内部実装）。
pub async fn backfill_battle_players_inner(pool: &DbPool) -> Result<usize, String> {
    let rows = sqlx::query(
        "SELECT id, my_team, other_teams FROM battles
         WHERE detail_fetched = 1
           AND (my_team IS NOT NULL OR other_teams IS NOT NULL)
           AND id NOT IN (SELECT DISTINCT battle_id FROM battle_players)",
    )
    .fetch_all(pool.as_ref())
    .await
    .map_err(|e| e.to_string())?;

    let mut count = 0usize;
    for row in &rows {
        let battle_id:   String         = row.get("id");
        let my_team:     Option<String> = row.get("my_team");
        let other_teams: Option<String> = row.get("other_teams");
        let players = parse_players_from_json(&battle_id, my_team.as_deref(), other_teams.as_deref());
        count += players.len();
        insert_battle_players(pool, &players).await?;
    }
    Ok(count)
}

/// 詳細取得済みで battle_players 未登録のバトルをバックフィルする。
#[tauri::command]
pub async fn backfill_battle_players(db: tauri::State<'_, DbPool>) -> Result<usize, String> {
    backfill_battle_players_inner(&db).await
}

// ---------------------------------------------------------------------------
// フィルターヘルパー
// ---------------------------------------------------------------------------

/// モードフィルターを正規化する。
/// 'bankara' は 'bankara_challenge|bankara_open' に展開し、
/// instr パイプフィルターでどちらにもマッチさせる。
fn normalize_mode_filter(mode: Option<String>) -> Option<String> {
    mode.map(|m| {
        if m == "bankara" {
            "bankara_challenge|bankara_open".to_string()
        } else {
            m
        }
    })
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
    let mode = normalize_mode_filter(mode);
    let row = sqlx::query(
        "SELECT
            COUNT(*) as total,
            SUM(CASE WHEN result='win'  THEN 1 ELSE 0 END) as wins,
            SUM(CASE WHEN result='draw' THEN 1 ELSE 0 END) as draws,
            COUNT(DISTINCT weapon) as weapon_count,
            AVG(CASE WHEN detail_fetched = 1 THEN kill  END) as avg_kill,
            AVG(CASE WHEN detail_fetched = 1 THEN death END) as avg_death
         FROM battles
         WHERE (? IS NULL OR played_at >= ?)
           AND (? IS NULL OR played_at <= ?)
           AND (? IS NULL OR instr('|' || ? || '|', '|' || mode || '|') > 0)
           AND (? IS NULL OR rule = ?)
           AND (? IS NULL OR result = ?)
           AND (? IS NULL OR instr('|' || ? || '|', '|' || weapon || '|') > 0)
           AND (? IS NULL OR instr('|' || ? || '|', '|' || stage || '|') > 0)",
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

    let total: i64                 = row.get("total");
    let wins: i64                  = row.get("wins");
    let draws: i64                 = row.get("draws");
    let weapon_count: i64          = row.get("weapon_count");
    // detail_fetched=1 のバトルのみで平均を取る（CASE で NULL にして AVG が無視）
    let avg_kill:  Option<f64>     = row.try_get("avg_kill").ok();
    let avg_death: Option<f64>     = row.try_get("avg_death").ok();
    let decisive                   = total - draws;
    Ok(serde_json::json!({
        "total": total,
        "wins": wins,
        "draws": draws,
        "win_rate": if decisive > 0 { wins as f64 / decisive as f64 } else { 0.0 },
        "weapon_count": weapon_count,
        "avg_kill":  avg_kill,
        "avg_death": avg_death,
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
    let mode = normalize_mode_filter(mode);
    let row = sqlx::query(
        "SELECT COUNT(*) as cnt FROM battles
         WHERE (? IS NULL OR played_at >= ?)
           AND (? IS NULL OR played_at <= ?)
           AND (? IS NULL OR instr('|' || ? || '|', '|' || mode || '|') > 0)
           AND (? IS NULL OR rule = ?)
           AND (? IS NULL OR result = ?)
           AND (? IS NULL OR instr('|' || ? || '|', '|' || weapon || '|') > 0)
           AND (? IS NULL OR instr('|' || ? || '|', '|' || stage || '|') > 0)",
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
    let mode = normalize_mode_filter(mode);
    // kill_ratio は death=0 のとき大きなセンチネルに置換することで
    // DESC で上端 / ASC で下端 に配置（フロント側 ∞ 表示と整合）。
    let order_expr: &str = match order_by.as_deref() {
        Some("kill")       => "kill",
        Some("assist")     => "assist",
        Some("death")      => "death",
        Some("special")    => "special",
        Some("inked")      => "inked",
        Some("kill_ratio") => "COALESCE(CAST(kill AS REAL) / NULLIF(death, 0), 999999.0)",
        _                  => "played_at",
    };
    let order_dir = if order_asc.unwrap_or(false) { "ASC" } else { "DESC" };
    let sql = format!(
        "SELECT id, played_at, mode, rule, stage, stage_name, weapon, result,
                kill, death, assist, special, inked, duration,
                rank_before, rank_after, x_power, raw_json, fetched_at,
                knockout, sub_weapon, special_weapon, awards, my_team, other_teams,
                statink_uuid, parent_json
         FROM battles
         WHERE (? IS NULL OR played_at >= ?)
           AND (? IS NULL OR played_at <= ?)
           AND (? IS NULL OR instr('|' || ? || '|', '|' || mode || '|') > 0)
           AND (? IS NULL OR rule = ?)
           AND (? IS NULL OR result = ?)
           AND (? IS NULL OR instr('|' || ? || '|', '|' || weapon || '|') > 0)
           AND (? IS NULL OR instr('|' || ? || '|', '|' || stage || '|') > 0)
         ORDER BY {order_expr} {order_dir} LIMIT ? OFFSET ?"
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

/// 使用済みステージの一覧を試合数の多い順で返す。{id, name} 形式。
#[tauri::command]
pub async fn db_stages_used(db: tauri::State<'_, DbPool>) -> Result<Vec<serde_json::Value>, String> {
    let rows = sqlx::query(
        "SELECT stage, stage_name FROM battles GROUP BY stage ORDER BY COUNT(*) DESC",
    )
    .fetch_all(db.as_ref())
    .await
    .map_err(|e| e.to_string())?;
    Ok(rows.into_iter().map(|r| {
        let id: String          = r.get("stage");
        let name: Option<String> = r.get("stage_name");
        serde_json::json!({ "id": id, "name": name.unwrap_or_else(|| id.clone()) })
    }).collect())
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
    let mode = normalize_mode_filter(mode);
    let filter_where =
        "(? IS NULL OR played_at >= ?)
           AND (? IS NULL OR played_at <= ?)
           AND (? IS NULL OR instr('|' || ? || '|', '|' || mode || '|') > 0)
           AND (? IS NULL OR rule = ?)
           AND (? IS NULL OR result = ?)
           AND (? IS NULL OR instr('|' || ? || '|', '|' || weapon || '|') > 0)
           AND (? IS NULL OR instr('|' || ? || '|', '|' || stage || '|') > 0)";

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
                SUM(CASE WHEN result='win'  THEN 1 ELSE 0 END) as wins,
                SUM(CASE WHEN result='draw' THEN 1 ELSE 0 END) as draws
         FROM battles WHERE {filter_where} GROUP BY weapon ORDER BY total DESC"
    )))
    .fetch_all(db.as_ref())
    .await
    .map_err(|e| e.to_string())?;

    let by_mode = bind_filters!(sqlx::query(&format!(
        "SELECT
                CASE WHEN mode LIKE 'bankara%' THEN 'bankara' ELSE mode END as name,
                COUNT(*) as total,
                SUM(CASE WHEN result='win'  THEN 1 ELSE 0 END) as wins,
                SUM(CASE WHEN result='draw' THEN 1 ELSE 0 END) as draws
         FROM battles WHERE {filter_where}
         GROUP BY CASE WHEN mode LIKE 'bankara%' THEN 'bankara' ELSE mode END
         ORDER BY total DESC"
    )))
    .fetch_all(db.as_ref())
    .await
    .map_err(|e| e.to_string())?;

    let by_stage = bind_filters!(sqlx::query(&format!(
        "SELECT stage as name,
                COALESCE(MAX(stage_name), stage) as display_name,
                COUNT(*) as total,
                SUM(CASE WHEN result='win'  THEN 1 ELSE 0 END) as wins,
                SUM(CASE WHEN result='draw' THEN 1 ELSE 0 END) as draws
         FROM battles WHERE {filter_where} GROUP BY stage ORDER BY total DESC"
    )))
    .fetch_all(db.as_ref())
    .await
    .map_err(|e| e.to_string())?;

    let by_rule = bind_filters!(sqlx::query(&format!(
        "SELECT rule as name, COUNT(*) as total,
                SUM(CASE WHEN result='win'  THEN 1 ELSE 0 END) as wins,
                SUM(CASE WHEN result='draw' THEN 1 ELSE 0 END) as draws
         FROM battles WHERE {filter_where} GROUP BY rule ORDER BY total DESC"
    )))
    .fetch_all(db.as_ref())
    .await
    .map_err(|e| e.to_string())?;

    fn to_json(rows: Vec<sqlx::sqlite::SqliteRow>, use_display_name: bool) -> Vec<serde_json::Value> {
        rows.into_iter().map(|r| {
            let total: i64 = r.get("total");
            let wins: i64  = r.get("wins");
            let draws: i64 = r.get("draws");
            let decisive   = total - draws;
            let name: String = if use_display_name {
                r.try_get("display_name").unwrap_or_else(|_| r.get::<String, _>("name"))
            } else {
                r.get("name")
            };
            serde_json::json!({
                "name": name,
                "total": total,
                "wins": wins,
                "draws": draws,
                "win_rate": if decisive > 0 { wins as f64 / decisive as f64 } else { 0.0 }
            })
        }).collect()
    }

    Ok(serde_json::json!({
        "by_weapon": to_json(by_weapon, false),
        "by_mode": to_json(by_mode, false),
        "by_stage": to_json(by_stage, true),
        "by_rule": to_json(by_rule, false),
    }))
}

/// 任意の `group_by` キーで集計し、平均キル/デス/アシスト/SP/塗り/バトル時間まで返す汎用集計コマンド。
///
/// カスタムグラフ（#86）の供給元として使う。`db_summary` が「勝率と件数」しか返さないのに対し、
/// こちらは平均系メトリクスを含むため、シンプル棒・攻撃 vs デスチャートの両方を 1 回のクエリで賄える。
///
/// `group_by` の許容値:
/// - `weapon` / `stage` / `rule` / `mode` / `sub_weapon` / `special_weapon` / `weapon_category` / `result`
///
/// 平均系は `detail_fetched=1` のバトルだけを母数にする（詳細未取得は K/D 等が 0 で記録されるため）。
/// `weapon_category` は battles → weapons の LEFT JOIN を経由し、category が NULL/空のバトルは
/// `category` 列が `'(未分類)'` として 1 グループにまとめる。
#[tauri::command]
pub async fn db_grouped_stats(
    db: tauri::State<'_, DbPool>,
    group_by: String,
    since: Option<String>,
    until: Option<String>,
    mode: Option<String>,
    rule: Option<String>,
    result_filter: Option<String>,  // JS: resultFilter
    weapon: Option<String>,
    stage: Option<String>,
) -> Result<Vec<serde_json::Value>, String> {
    let mode = normalize_mode_filter(mode);

    // group_by を SQL の (テーブル/JOIN, GROUP BY 式, display 用列) に翻訳する。
    // ここで JOIN を分岐させているのは weapon_category だけ weapons テーブルが必要なため。
    let (from_clause, group_expr, display_expr): (&str, &str, &str) = match group_by.as_str() {
        "weapon"          => ("battles",                                              "weapon",                                                          "weapon"),
        "stage"           => ("battles",                                              "stage",                                                           "COALESCE(MAX(stage_name), stage)"),
        "rule"            => ("battles",                                              "rule",                                                            "rule"),
        "mode"            => ("battles",                                              "CASE WHEN mode LIKE 'bankara%' THEN 'bankara' ELSE mode END",     "CASE WHEN mode LIKE 'bankara%' THEN 'bankara' ELSE mode END"),
        "sub_weapon"      => ("battles",                                              "COALESCE(sub_weapon, '(不明)')",                                   "COALESCE(sub_weapon, '(不明)')"),
        "special_weapon"  => ("battles",                                              "COALESCE(special_weapon, '(不明)')",                               "COALESCE(special_weapon, '(不明)')"),
        "weapon_category" => ("battles LEFT JOIN weapons ON weapons.name = battles.weapon",
                                                                                       "COALESCE(NULLIF(weapons.category, ''), '(未分類)')",                "COALESCE(NULLIF(weapons.category, ''), '(未分類)')"),
        "result"          => ("battles",                                              "result",                                                          "result"),
        _ => return Err(format!("未対応の group_by: {group_by}")),
    };

    let filter_where =
        "(? IS NULL OR played_at >= ?)
           AND (? IS NULL OR played_at <= ?)
           AND (? IS NULL OR instr('|' || ? || '|', '|' || mode || '|') > 0)
           AND (? IS NULL OR rule = ?)
           AND (? IS NULL OR result = ?)
           AND (? IS NULL OR instr('|' || ? || '|', '|' || weapon || '|') > 0)
           AND (? IS NULL OR instr('|' || ? || '|', '|' || stage || '|') > 0)";

    let sql = format!(
        "SELECT
            {group_expr} as key,
            {display_expr} as display_name,
            COUNT(*)                                                  as total,
            SUM(CASE WHEN result='win'  THEN 1 ELSE 0 END)            as wins,
            SUM(CASE WHEN result='draw' THEN 1 ELSE 0 END)            as draws,
            AVG(CASE WHEN detail_fetched = 1 THEN kill     END)       as avg_kill,
            AVG(CASE WHEN detail_fetched = 1 THEN death    END)       as avg_death,
            AVG(CASE WHEN detail_fetched = 1 THEN assist   END)       as avg_assist,
            AVG(CASE WHEN detail_fetched = 1 THEN special  END)       as avg_special,
            AVG(CASE WHEN detail_fetched = 1 THEN inked    END)       as avg_inked,
            AVG(CASE WHEN detail_fetched = 1 THEN duration END)       as avg_duration
         FROM {from_clause}
         WHERE {filter_where}
         GROUP BY {group_expr}
         ORDER BY total DESC"
    );

    let rows = sqlx::query(&sql)
        .bind(&since).bind(&since)
        .bind(&until).bind(&until)
        .bind(&mode).bind(&mode)
        .bind(&rule).bind(&rule)
        .bind(&result_filter).bind(&result_filter)
        .bind(&weapon).bind(&weapon)
        .bind(&stage).bind(&stage)
        .fetch_all(db.as_ref())
        .await
        .map_err(|e| e.to_string())?;

    Ok(rows.into_iter().map(|r| {
        let total: i64                = r.get("total");
        let wins: i64                 = r.get("wins");
        let draws: i64                = r.get("draws");
        let decisive                  = total - draws;
        let win_rate                  = if decisive > 0 { wins as f64 / decisive as f64 } else { 0.0 };
        let name: String              = r.try_get("display_name").unwrap_or_else(|_| r.get::<String, _>("key"));
        serde_json::json!({
            "key":          r.get::<String, _>("key"),
            "name":         name,
            "total":        total,
            "wins":         wins,
            "draws":        draws,
            "win_rate":     win_rate,
            "avg_kill":     r.try_get::<f64, _>("avg_kill").ok(),
            "avg_death":    r.try_get::<f64, _>("avg_death").ok(),
            "avg_assist":   r.try_get::<f64, _>("avg_assist").ok(),
            "avg_special":  r.try_get::<f64, _>("avg_special").ok(),
            "avg_inked":    r.try_get::<f64, _>("avg_inked").ok(),
            "avg_duration": r.try_get::<f64, _>("avg_duration").ok(),
        })
    }).collect())
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

// ---------------------------------------------------------------------------
// stat.ink ID 正規化マイグレーション
// ---------------------------------------------------------------------------

/// DB マイグレーションを必要なバージョンまで実行する。
/// PRAGMA user_version でどこまで完了したかを管理する。
///
/// version 1: mode/rule/stage/result を stat.ink ID 形式に変換（初回実装・バグあり）
/// version 2: mode 判定バグ修正版で全件再処理
/// version 3: kill カウントを kill_or_assist から実キル数に修正
/// version 4: rule を raw_json から再パースして修復
/// version 5: バンカラ mode を raw_json から再パースして修復
/// version 6: stat.ink 互換の正規化スキーマ（battle / battle_player / マスター各種）を追加
/// version 7: 既存 battles / battle_players から新スキーマへデータ移行
pub async fn migrate_battle_ids(pool: &DbPool) -> Result<usize, String> {
    let ver_row = sqlx::query("PRAGMA user_version")
        .fetch_one(pool.as_ref())
        .await
        .map_err(|e| e.to_string())?;
    let current_version: i64 = ver_row.get(0);

    if current_version >= 7 {
        return Ok(0); // 最新バージョンに達している
    }

    let mut updated = 0usize;

    // version 2 未適用なら mode/rule/stage/result を正規化する
    if current_version < 2 {
    let rows = sqlx::query("SELECT id, raw_json FROM battles")
        .fetch_all(pool.as_ref())
        .await
        .map_err(|e| e.to_string())?;
    for row in &rows {
        let id:       String = row.get("id");
        let raw_json: String = row.get("raw_json");

        let Ok(json) = serde_json::from_str::<serde_json::Value>(&raw_json) else { continue };

        // mode 判定
        // 優先順位:
        //   1. vsMode.mode（vsHistoryDetail の raw_json に含まれる）
        //   2. bankaraMatch が非 null → bankara
        //   3. xMatch が非 null → x
        //   4. それ以外 → regular
        let vsmode = json.pointer("/vsMode/mode").and_then(|v| v.as_str()).unwrap_or("");
        let new_mode: &str = if !vsmode.is_empty() {
            match vsmode {
                "REGULAR" => "regular",
                "BANKARA" => {
                    let bm = json.pointer("/bankaraMatch/mode")
                        .and_then(|v| v.as_str()).unwrap_or("");
                    if bm == "CHALLENGE" { "bankara_challenge" } else { "bankara_open" }
                }
                "X_MATCH" => "x",
                _ => "regular",
            }
        } else {
            // リストクエリの raw_json（vsMode なし）
            // bankaraMatch / xMatch が null でないことを確認してから判定
            let has_bankara = json.get("bankaraMatch").map(|v| !v.is_null()).unwrap_or(false);
            let has_xmatch  = json.get("xMatch").map(|v| !v.is_null()).unwrap_or(false);
            if has_bankara {
                let bm = json.pointer("/bankaraMatch/bankaraMode")
                    .and_then(|v| v.as_str()).unwrap_or("");
                if bm == "CHALLENGE" { "bankara_challenge" } else { "bankara_open" }
            } else if has_xmatch {
                "x"
            } else {
                "regular"
            }
        };

        // rule
        let rule_raw = json.pointer("/vsRule/rule").and_then(|v| v.as_str()).unwrap_or("");
        let new_rule = match rule_raw {
            "TURF_WAR" => "turf_war",
            "AREA"     => "area",
            "LOFT"     => "yagura",
            "GOAL"     => "hoko",
            "CLAM"     => "asari",
            other      => other,
        };

        // stage
        let stage_b64 = json.pointer("/vsStage/id").and_then(|v| v.as_str()).unwrap_or("");
        let new_stage = extract_stage_numeric_id(stage_b64);
        let new_stage_name = json.pointer("/vsStage/name")
            .and_then(|v| v.as_str()).unwrap_or("").to_string();

        // result（小文字に統一）
        let result_raw = json.get("judgement").and_then(|v| v.as_str()).unwrap_or("");
        let new_result = match result_raw {
            "WIN"                        => "win",
            "LOSE" | "DEEMED_LOSE"       => "lose",
            "DRAW" | "EXEMPTED_LOSE"     => "draw",
            _                            => "lose",
        };

        let _ = sqlx::query(
            "UPDATE battles SET mode=?, rule=?, stage=?, stage_name=?, result=? WHERE id=?",
        )
        .bind(new_mode)
        .bind(new_rule)
        .bind(&new_stage)
        .bind(if new_stage_name.is_empty() { None } else { Some(new_stage_name) })
        .bind(new_result)
        .bind(&id)
        .execute(pool.as_ref())
        .await;

        updated += 1;
    }

    // v2 マイグレーション完了を記録
    sqlx::query("PRAGMA user_version = 2")
        .execute(pool.as_ref())
        .await
        .map_err(|e| e.to_string())?;

    log::info!("migrate v2: mode/rule/stage/result 正規化 {} 件", updated);
    } // end if current_version < 2

    // version 3: Nintendo の result["kill"] は kill+assist（kill_or_assist）であり、
    //            実キル数は kill_or_assist - assist。既存レコードを修正する。
    if current_version < 3 {
        sqlx::query(
            "UPDATE battles SET kill = kill - assist WHERE detail_fetched = 1 AND assist > 0 AND kill >= assist",
        )
        .execute(pool.as_ref())
        .await
        .map_err(|e| e.to_string())?;

        sqlx::query(
            "UPDATE battle_players SET kill = kill - assist WHERE assist > 0 AND kill >= assist",
        )
        .execute(pool.as_ref())
        .await
        .map_err(|e| e.to_string())?;

        sqlx::query("PRAGMA user_version = 3")
            .execute(pool.as_ref())
            .await
            .map_err(|e| e.to_string())?;

        log::info!("migrate v3: kill カウント（kill_or_assist → 実キル）修正完了");
    }

    // version 4: rule_to_slug の旧フォールバック（_ => "turf_war"）で
    //            未知ルールが全部 "turf_war" になっていた問題の修復。
    //            全バトルの raw_json から rule を再パースして DB を更新する。
    //            （冪等：正しい値はそのまま、間違った値だけ直る）
    if current_version < 4 {
        let rows = sqlx::query("SELECT id, raw_json, rule FROM battles")
            .fetch_all(pool.as_ref())
            .await
            .map_err(|e| e.to_string())?;

        let mut fixed = 0usize;
        for row in &rows {
            let id:        String = row.get("id");
            let raw_json:  String = row.get("raw_json");
            let cur_rule:  String = row.get("rule");

            let Ok(json) = serde_json::from_str::<serde_json::Value>(&raw_json) else { continue };
            let rule_raw = json.pointer("/vsRule/rule").and_then(|v| v.as_str()).unwrap_or("");
            if rule_raw.is_empty() { continue; }  // raw_json に rule が無いものは触らない

            let new_rule = match rule_raw {
                "TURF_WAR" => "turf_war",
                "AREA"     => "area",
                "LOFT"     => "yagura",
                "GOAL"     => "hoko",
                "CLAM"     => "asari",
                other      => other,
            };

            if cur_rule != new_rule {
                let _ = sqlx::query("UPDATE battles SET rule=? WHERE id=?")
                    .bind(new_rule)
                    .bind(&id)
                    .execute(pool.as_ref())
                    .await;
                fixed += 1;
            }
        }

        sqlx::query("PRAGMA user_version = 4")
            .execute(pool.as_ref())
            .await
            .map_err(|e| e.to_string())?;

        log::info!("migrate v4: rule を raw_json から再パース、{} 件修正", fixed);
    }

    // version 5: bankaraMatch.mode のパス間違い（旧 bankaraMatch/bankaraMode）で
    //            バンカラが全部 bankara_open に倒れていた問題の修復。
    //            全バトルの raw_json から正しいパスで mode を再パースする（冪等）。
    if current_version < 5 {
        let rows = sqlx::query("SELECT id, raw_json, mode FROM battles")
            .fetch_all(pool.as_ref())
            .await
            .map_err(|e| e.to_string())?;

        let mut fixed = 0usize;
        for row in &rows {
            let id:        String = row.get("id");
            let raw_json:  String = row.get("raw_json");
            let cur_mode:  String = row.get("mode");

            let Ok(json) = serde_json::from_str::<serde_json::Value>(&raw_json) else { continue };

            // 詳細クエリ（vsMode あり）/ リストクエリ（vsMode なし）両対応
            let vsmode = json.pointer("/vsMode/mode").and_then(|v| v.as_str()).unwrap_or("");
            let new_mode: &str = if !vsmode.is_empty() {
                match vsmode {
                    "REGULAR" => "regular",
                    "BANKARA" => {
                        let bm = json.pointer("/bankaraMatch/mode")
                            .and_then(|v| v.as_str()).unwrap_or("");
                        if bm == "CHALLENGE" { "bankara_challenge" } else { "bankara_open" }
                    }
                    "X_MATCH" => "x",
                    _ => continue,
                }
            } else {
                let has_bankara = json.get("bankaraMatch").map(|v| !v.is_null()).unwrap_or(false);
                let has_xmatch  = json.get("xMatch").map(|v| !v.is_null()).unwrap_or(false);
                if has_bankara {
                    let bm = json.pointer("/bankaraMatch/mode")
                        .and_then(|v| v.as_str()).unwrap_or("");
                    if bm == "CHALLENGE" { "bankara_challenge" } else { "bankara_open" }
                } else if has_xmatch {
                    "x"
                } else {
                    "regular"
                }
            };

            if cur_mode != new_mode {
                let _ = sqlx::query("UPDATE battles SET mode=? WHERE id=?")
                    .bind(new_mode)
                    .bind(&id)
                    .execute(pool.as_ref())
                    .await;
                fixed += 1;
            }
        }

        sqlx::query("PRAGMA user_version = 5")
            .execute(pool.as_ref())
            .await
            .map_err(|e| e.to_string())?;

        log::info!("migrate v5: mode を raw_json から再パース、{} 件修正", fixed);
    }

    // version 6: stat.ink 互換の正規化スキーマを追加。
    //            新テーブル（battle / battle_player / マスター各種）を作成し、
    //            固定 ID のマスター（lobby / rule / result / ability）を seed する。
    //            既存テーブル（battles / battle_players / weapons）はそのまま残し、
    //            後続 PR で raw_json からのデータ移行を行う。
    if current_version < 6 {
        // 新スキーマ作成
        sqlx::query(SCHEMA_V6)
            .execute(pool.as_ref())
            .await
            .map_err(|e| format!("v6 schema 作成失敗: {e}"))?;

        // lobby seed
        for (id, key) in LOBBY_SEED {
            sqlx::query("INSERT OR IGNORE INTO lobby (id, key) VALUES (?, ?)")
                .bind(id)
                .bind(key)
                .execute(pool.as_ref())
                .await
                .map_err(|e| format!("lobby seed 失敗 ({key}): {e}"))?;
        }

        // rule seed
        for (id, key) in RULE_SEED {
            sqlx::query("INSERT OR IGNORE INTO rule (id, key) VALUES (?, ?)")
                .bind(id)
                .bind(key)
                .execute(pool.as_ref())
                .await
                .map_err(|e| format!("rule seed 失敗 ({key}): {e}"))?;
        }

        // result seed
        for (id, key) in RESULT_SEED {
            sqlx::query("INSERT OR IGNORE INTO result (id, key) VALUES (?, ?)")
                .bind(id)
                .bind(key)
                .execute(pool.as_ref())
                .await
                .map_err(|e| format!("result seed 失敗 ({key}): {e}"))?;
        }

        // ability seed: abilities::ABILITY_HASHES の Some(key) を順に固定 ID で投入
        let ability_keys: Vec<&'static str> = crate::abilities::ABILITY_HASHES
            .iter()
            .filter_map(|(_, key)| *key)
            .collect();
        for (i, key) in ability_keys.iter().enumerate() {
            let id = (i as i64) + 1;
            sqlx::query("INSERT OR IGNORE INTO ability (id, key, image_key) VALUES (?, ?, ?)")
                .bind(id)
                .bind(key)
                .bind(key)
                .execute(pool.as_ref())
                .await
                .map_err(|e| format!("ability seed 失敗 ({key}): {e}"))?;
        }

        sqlx::query("PRAGMA user_version = 6")
            .execute(pool.as_ref())
            .await
            .map_err(|e| e.to_string())?;

        log::info!(
            "migrate v6: 正規化スキーマ追加 (lobby {}, rule {}, result {}, ability {})",
            LOBBY_SEED.len(),
            RULE_SEED.len(),
            RESULT_SEED.len(),
            ability_keys.len(),
        );
    }

    // version 7: 既存 battles / battle_players から新スキーマ（battle / battle_player）へ
    //            データを移行する。weapon と map マスターも既存データから populate する。
    //            gear_configuration は本 PR では populate せず、後続 PR で raw_json から抽出する。
    //            既存テーブルはそのまま残し、後続 PR で旧テーブルを drop する。
    if current_version < 7 {
        // ---- 1. weapon マスター populate ----
        // 旧 weapons テーブル / battles.weapon / battle_players.weapon の DISTINCT 集合を投入
        let weapon_master_rows = sqlx::query(
            "SELECT name AS key, category, sub_weapon, special_weapon FROM weapons WHERE name != ''",
        )
        .fetch_all(pool.as_ref())
        .await
        .map_err(|e| format!("v7 weapons 読込失敗: {e}"))?;
        for r in &weapon_master_rows {
            let key: String = r.get("key");
            let category: String = r.get("category");
            let sub: Option<String> = r.try_get("sub_weapon").ok().flatten();
            let special: Option<String> = r.try_get("special_weapon").ok().flatten();
            sqlx::query(
                "INSERT OR IGNORE INTO weapon (key, name_ja, category_key, sub_key, special_key, image_key)
                 VALUES (?, ?, ?, ?, ?, ?)",
            )
            .bind(&key)
            .bind(&key)
            .bind(if category.is_empty() { None } else { Some(category) })
            .bind(sub)
            .bind(special)
            .bind(&key)
            .execute(pool.as_ref())
            .await
            .map_err(|e| format!("v7 weapon insert 失敗 ({key}): {e}"))?;
        }
        for row in sqlx::query("SELECT DISTINCT weapon AS key FROM battle_players WHERE weapon != ''")
            .fetch_all(pool.as_ref())
            .await
            .map_err(|e| e.to_string())?
            .iter()
            .chain(
                sqlx::query("SELECT DISTINCT weapon AS key FROM battles WHERE weapon != ''")
                    .fetch_all(pool.as_ref())
                    .await
                    .map_err(|e| e.to_string())?
                    .iter(),
            )
        {
            let key: String = row.get("key");
            sqlx::query("INSERT OR IGNORE INTO weapon (key, name_ja, image_key) VALUES (?, ?, ?)")
                .bind(&key)
                .bind(&key)
                .bind(&key)
                .execute(pool.as_ref())
                .await
                .map_err(|e| e.to_string())?;
        }

        let weapon_lookup = sqlx::query("SELECT id, key FROM weapon")
            .fetch_all(pool.as_ref())
            .await
            .map_err(|e| e.to_string())?;
        let weapon_id_map: std::collections::HashMap<String, i64> = weapon_lookup
            .iter()
            .map(|r| (r.get::<String, _>("key"), r.get::<i64, _>("id")))
            .collect();

        // ---- 2. map マスター populate ----
        // 旧 battles.stage / stage_name の DISTINCT 集合を投入（同一 stage で複数の name がある場合は MAX で選択）
        let stage_rows = sqlx::query(
            "SELECT stage AS key, MAX(stage_name) AS name_ja
             FROM battles WHERE stage != '' GROUP BY stage",
        )
        .fetch_all(pool.as_ref())
        .await
        .map_err(|e| e.to_string())?;
        for r in &stage_rows {
            let key: String = r.get("key");
            let name: Option<String> = r.try_get("name_ja").ok().flatten();
            sqlx::query("INSERT OR IGNORE INTO map (key, name_ja) VALUES (?, ?)")
                .bind(&key)
                .bind(name)
                .execute(pool.as_ref())
                .await
                .map_err(|e| e.to_string())?;
        }

        let map_lookup = sqlx::query("SELECT id, key FROM map")
            .fetch_all(pool.as_ref())
            .await
            .map_err(|e| e.to_string())?;
        let map_id_map: std::collections::HashMap<String, i64> = map_lookup
            .iter()
            .map(|r| (r.get::<String, _>("key"), r.get::<i64, _>("id")))
            .collect();

        // ---- 3. battle テーブル migrate ----
        let battles = sqlx::query(
            "SELECT id, played_at, mode, rule, stage, weapon, result,
                    kill, death, assist, special, inked, duration,
                    rank_before, rank_after, x_power, raw_json, fetched_at,
                    detail_fetched, statink_uuid, knockout
             FROM battles",
        )
        .fetch_all(pool.as_ref())
        .await
        .map_err(|e| e.to_string())?;

        let mut battle_inserted = 0usize;
        let mut battle_skipped = 0usize;
        for row in &battles {
            let id:     String = row.get("id");
            let mode:   String = row.get("mode");
            let rule:   String = row.get("rule");
            let stage:  String = row.get("stage");
            let weapon: String = row.get("weapon");
            let result: String = row.get("result");

            let lobby_id  = old_mode_to_lobby_id(&mode);
            let rule_id   = old_rule_to_rule_id(&rule);
            let result_id = old_result_to_result_id(&result);
            let map_id    = map_id_map.get(&stage).copied();
            let weapon_id = weapon_id_map.get(&weapon).copied();

            let (Some(lobby_id), Some(rule_id), Some(result_id), Some(map_id), Some(weapon_id)) =
                (lobby_id, rule_id, result_id, map_id, weapon_id)
            else {
                log::warn!(
                    "[v7] battle スキップ id={} (mode={mode} rule={rule} stage={stage} weapon={weapon} result={result})",
                    &id[..id.len().min(20)],
                );
                battle_skipped += 1;
                continue;
            };

            let played_at:      String         = row.get("played_at");
            let kill:           i64            = row.get("kill");
            let death:          i64            = row.get("death");
            let assist:         i64            = row.get("assist");
            let special:        i64            = row.get("special");
            let inked:          i64            = row.get("inked");
            let duration:       i64            = row.get("duration");
            let kill_or_assist                 = kill + assist;
            let rank_before:    Option<String> = row.try_get("rank_before").ok().flatten();
            let rank_after:     Option<String> = row.try_get("rank_after").ok().flatten();
            let x_power:        Option<f64>    = row.try_get("x_power").ok().flatten();
            let raw_json:       String         = row.get("raw_json");
            let fetched_at:     String         = row.get("fetched_at");
            let detail_fetched: i64            = row.get("detail_fetched");
            let statink_uuid:   Option<String> = row.try_get("statink_uuid").ok().flatten();
            let knockout:       Option<String> = row.try_get("knockout").ok().flatten();
            let is_knockout:    Option<i64>    =
                knockout.as_deref().map(|k| if k == "WIN" { 1 } else { 0 });

            let r = sqlx::query(
                "INSERT OR IGNORE INTO battle
                    (id, played_at, lobby_id, rule_id, map_id, result_id, weapon_id,
                     is_knockout, kill, assist, kill_or_assist, death, special, inked, duration,
                     rank_before, rank_after, x_power_after, raw_json, fetched_at,
                     detail_fetched, statink_uuid)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
            )
            .bind(&id)
            .bind(played_at)
            .bind(lobby_id)
            .bind(rule_id)
            .bind(map_id)
            .bind(result_id)
            .bind(weapon_id)
            .bind(is_knockout)
            .bind(kill)
            .bind(assist)
            .bind(kill_or_assist)
            .bind(death)
            .bind(special)
            .bind(inked)
            .bind(duration)
            .bind(rank_before)
            .bind(rank_after)
            .bind(x_power)
            .bind(raw_json)
            .bind(fetched_at)
            .bind(detail_fetched)
            .bind(statink_uuid)
            .execute(pool.as_ref())
            .await
            .map_err(|e| format!("v7 battle insert 失敗 id={id}: {e}"))?;
            if r.rows_affected() > 0 {
                battle_inserted += 1;
            }
        }

        // ---- 4. battle_player テーブル migrate ----
        let players = sqlx::query(
            "SELECT battle_id, team, slot, is_myself, weapon, kill, assist, death, special, paint
             FROM battle_players",
        )
        .fetch_all(pool.as_ref())
        .await
        .map_err(|e| e.to_string())?;

        let mut player_inserted = 0usize;
        let mut player_skipped = 0usize;
        for row in &players {
            let battle_id: String = row.get("battle_id");

            // 親 battle が新スキーマに居ない（スキップされた）レコードは無視
            let exists = sqlx::query("SELECT 1 FROM battle WHERE id = ? LIMIT 1")
                .bind(&battle_id)
                .fetch_optional(pool.as_ref())
                .await
                .map_err(|e| e.to_string())?;
            if exists.is_none() {
                player_skipped += 1;
                continue;
            }

            let team:      String = row.get("team");
            let slot:      i64    = row.get("slot");
            let is_myself: i64    = row.get("is_myself");
            let weapon:    String = row.get("weapon");
            let Some(weapon_id) = weapon_id_map.get(&weapon).copied() else {
                player_skipped += 1;
                continue;
            };

            let is_our_team    = if team == "my" { 1 } else { 0 };
            let kill:    i64   = row.get("kill");
            let assist:  i64   = row.get("assist");
            let death:   i64   = row.get("death");
            let special: i64   = row.get("special");
            let inked:   i64   = row.get("paint");
            let kill_or_assist = kill + assist;

            let r = sqlx::query(
                "INSERT OR IGNORE INTO battle_player
                    (battle_id, is_our_team, rank_in_team, is_me, weapon_id,
                     kill, assist, kill_or_assist, death, special, inked)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
            )
            .bind(&battle_id)
            .bind(is_our_team)
            .bind(slot)
            .bind(is_myself)
            .bind(weapon_id)
            .bind(kill)
            .bind(assist)
            .bind(kill_or_assist)
            .bind(death)
            .bind(special)
            .bind(inked)
            .execute(pool.as_ref())
            .await
            .map_err(|e| format!("v7 battle_player insert 失敗 battle={battle_id}: {e}"))?;
            if r.rows_affected() > 0 {
                player_inserted += 1;
            }
        }

        sqlx::query("PRAGMA user_version = 7")
            .execute(pool.as_ref())
            .await
            .map_err(|e| e.to_string())?;

        log::info!(
            "migrate v7: weapon {} 件, map {} 件, battle {} 件 (skip {}), battle_player {} 件 (skip {}) を新スキーマへ移行",
            weapon_id_map.len(),
            map_id_map.len(),
            battle_inserted,
            battle_skipped,
            player_inserted,
            player_skipped,
        );
    }

    Ok(updated)
}

// ---------------------------------------------------------------------------
// stat.ink アップロード管理
// ---------------------------------------------------------------------------

/// statink_uuid が未設定のバトル一覧を返す（古い順）。
pub async fn get_battles_not_uploaded(pool: &DbPool) -> Result<Vec<BattleRow>, String> {
    let rows = sqlx::query_as::<_, BattleRow>(
        "SELECT id, played_at, mode, rule, stage, stage_name, weapon, result,
                kill, death, assist, special, inked, duration,
                rank_before, rank_after, x_power, raw_json, fetched_at,
                knockout, sub_weapon, special_weapon, awards, my_team, other_teams,
                statink_uuid, parent_json
         FROM battles
         WHERE statink_uuid IS NULL
           AND detail_fetched = 1
         ORDER BY played_at ASC",
    )
    .fetch_all(pool.as_ref())
    .await
    .map_err(|e| e.to_string())?;
    Ok(rows)
}

/// statink_uuid が設定済みのバトル一覧を返す（id, statink_uuid のペア）。
pub async fn get_battles_uploaded(pool: &DbPool) -> Result<Vec<(String, String)>, String> {
    let rows = sqlx::query("SELECT id, statink_uuid FROM battles WHERE statink_uuid IS NOT NULL ORDER BY played_at ASC")
        .fetch_all(pool.as_ref())
        .await
        .map_err(|e| e.to_string())?;
    Ok(rows.into_iter().map(|r| (r.get::<String, _>("id"), r.get::<String, _>("statink_uuid"))).collect())
}

/// バトルの statink_uuid を NULL にリセットする（削除後の再アップロード用）。
pub async fn reset_statink_uuid(pool: &DbPool, id: &str) -> Result<(), String> {
    sqlx::query("UPDATE battles SET statink_uuid = NULL WHERE id = ?")
        .bind(id)
        .execute(pool.as_ref())
        .await
        .map_err(|e| e.to_string())?;
    Ok(())
}

/// バトルを stat.ink アップロード済みとしてマークする。
pub async fn mark_statink_uploaded(pool: &DbPool, id: &str, uuid: &str) -> Result<(), String> {
    sqlx::query("UPDATE battles SET statink_uuid=? WHERE id=?")
        .bind(uuid)
        .bind(id)
        .execute(pool.as_ref())
        .await
        .map_err(|e| e.to_string())?;
    Ok(())
}

/// ステージ ID（base64 エンコード "VsStage-N"）から数値部分を抽出する。
pub fn extract_stage_numeric_id(b64_id: &str) -> String {
    use base64::Engine;
    let decoded = base64::engine::general_purpose::STANDARD
        .decode(b64_id)
        .unwrap_or_default();
    let s = String::from_utf8_lossy(&decoded);
    // "VsStage-11" → "11"
    if let Some(pos) = s.rfind('-') {
        let num = &s[pos + 1..];
        if !num.is_empty() && num.chars().all(|c| c.is_ascii_digit()) {
            return num.to_string();
        }
    }
    // フォールバック: 数字だけならそのまま
    if !b64_id.is_empty() && b64_id.chars().all(|c| c.is_ascii_digit()) {
        return b64_id.to_string();
    }
    b64_id.to_string()
}

#[tauri::command]
pub async fn db_list_weapons(db: tauri::State<'_, DbPool>) -> Result<Vec<WeaponRecord>, String> {
    let rows = sqlx::query_as::<_, WeaponRecord>(
        "SELECT w.name, w.category, w.sub_weapon, w.special_weapon,
                w.sub_weapon_image, w.special_weapon_image,
                COUNT(b.id) as total,
                COALESCE(SUM(CASE WHEN b.result='win'  THEN 1 ELSE 0 END), 0) as wins,
                COALESCE(SUM(CASE WHEN b.result='draw' THEN 1 ELSE 0 END), 0) as draws
         FROM weapons w
         LEFT JOIN battles b ON b.weapon = w.name
         GROUP BY w.name
         ORDER BY CASE WHEN w.category = '' OR w.category IS NULL THEN 1 ELSE 0 END,
                  w.category, total DESC, w.name",
    )
    .fetch_all(db.as_ref())
    .await
    .map_err(|e| e.to_string())?;
    Ok(rows)
}
