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

/// 新スキーマの `weapon` マスターに key を upsert し、id を返す。
/// PR 90-D で書き込みパスを完全切替する前のシャドウライト用ヘルパー。
async fn upsert_weapon_id(pool: &DbPool, key: &str) -> Result<Option<i64>, String> {
    if key.is_empty() {
        return Ok(None);
    }
    sqlx::query("INSERT OR IGNORE INTO weapon (key, name_ja, image_key) VALUES (?, ?, ?)")
        .bind(key)
        .bind(key)
        .bind(key)
        .execute(pool.as_ref())
        .await
        .map_err(|e| e.to_string())?;
    let row = sqlx::query("SELECT id FROM weapon WHERE key = ?")
        .bind(key)
        .fetch_optional(pool.as_ref())
        .await
        .map_err(|e| e.to_string())?;
    Ok(row.map(|r| r.get("id")))
}

/// 新スキーマの `map` マスターに key を upsert し、id を返す。
async fn upsert_map_id(pool: &DbPool, key: &str, name: Option<&str>) -> Result<Option<i64>, String> {
    if key.is_empty() {
        return Ok(None);
    }
    sqlx::query("INSERT OR IGNORE INTO map (key, name_ja) VALUES (?, ?)")
        .bind(key)
        .bind(name)
        .execute(pool.as_ref())
        .await
        .map_err(|e| e.to_string())?;
    let row = sqlx::query("SELECT id FROM map WHERE key = ?")
        .bind(key)
        .fetch_optional(pool.as_ref())
        .await
        .map_err(|e| e.to_string())?;
    Ok(row.map(|r| r.get("id")))
}

/// 新スキーマの `battle` テーブルに INSERT OR REPLACE する。
/// rule が空 (list クエリ取り込み直後) なら rule_id = NULL で挿入し、後段の
/// `shadow_update_battle_detail` (詳細取得後) で正しい rule_id に更新される。
/// rule 以外の必須 FK (lobby / result / weapon / map) が解決できない場合は warn + スキップ。
async fn shadow_write_battle(pool: &DbPool, row: &BattleRow) -> Result<(), String> {
    let lobby_id  = old_mode_to_lobby_id(&row.mode);
    // rule は list クエリでは空文字。詳細クエリで埋まる前提で NULL を許容する。
    let rule_id   = if row.rule.is_empty() { None } else { old_rule_to_rule_id(&row.rule) };
    let result_id = old_result_to_result_id(&row.result);
    let weapon_id = upsert_weapon_id(pool, &row.weapon).await?;
    let map_id    = upsert_map_id(pool, &row.stage, row.stage_name.as_deref()).await?;

    // rule 以外の必須 FK が落ちる場合のみスキップ。rule_id は None でも続行。
    let (Some(lobby_id), Some(result_id), Some(weapon_id), Some(map_id)) =
        (lobby_id, result_id, weapon_id, map_id)
    else {
        log::warn!(
            "[shadow] battle スキップ id={} (mode={} result={} weapon={} stage={})",
            &row.id[..row.id.len().min(20)],
            row.mode,
            row.result,
            row.weapon,
            row.stage,
        );
        return Ok(());
    };
    // rule が指定されているのに未知 slug の場合は warn しておく (引き続き NULL で挿入)。
    if !row.rule.is_empty() && rule_id.is_none() {
        log::warn!(
            "[shadow] 未知 rule={} のためバトル {} の rule_id を NULL で挿入",
            row.rule,
            &row.id[..row.id.len().min(20)],
        );
    }

    let kill_or_assist = row.kill + row.assist;
    let is_knockout: Option<i64> = row
        .knockout
        .as_deref()
        .map(|k| if k == "WIN" { 1 } else { 0 });

    sqlx::query(
        "INSERT OR REPLACE INTO battle
            (id, played_at, lobby_id, rule_id, map_id, result_id, weapon_id,
             is_knockout, kill, assist, kill_or_assist, death, special, inked, duration,
             rank_before, rank_after, x_power_after, raw_json, fetched_at, statink_uuid, parent_json,
             knockout, sub_weapon, special_weapon, awards, my_team, other_teams)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    )
    .bind(&row.id)
    .bind(&row.played_at)
    .bind(lobby_id)
    .bind(rule_id)
    .bind(map_id)
    .bind(result_id)
    .bind(weapon_id)
    .bind(is_knockout)
    .bind(row.kill)
    .bind(row.assist)
    .bind(kill_or_assist)
    .bind(row.death)
    .bind(row.special)
    .bind(row.inked)
    .bind(row.duration)
    .bind(&row.rank_before)
    .bind(&row.rank_after)
    .bind(row.x_power)
    .bind(&row.raw_json)
    .bind(&row.fetched_at)
    .bind(&row.statink_uuid)
    .bind(&row.parent_json)
    .bind(&row.knockout)
    .bind(&row.sub_weapon)
    .bind(&row.special_weapon)
    .bind(&row.awards)
    .bind(&row.my_team)
    .bind(&row.other_teams)
    .execute(pool.as_ref())
    .await
    .map_err(|e| format!("shadow battle insert 失敗 id={}: {e}", row.id))?;

    Ok(())
}

/// 新スキーマの `battle_player` テーブルに INSERT OR REPLACE する（シャドウライト）。
/// 親 `battle` が新スキーマに居ない場合（FK 違反）はスキップ。
async fn shadow_write_battle_player(pool: &DbPool, p: &BattlePlayerRow) -> Result<(), String> {
    let Some(weapon_id) = upsert_weapon_id(pool, &p.weapon).await? else {
        return Ok(());
    };

    let exists = sqlx::query("SELECT 1 FROM battle WHERE id = ? LIMIT 1")
        .bind(&p.battle_id)
        .fetch_optional(pool.as_ref())
        .await
        .map_err(|e| e.to_string())?;
    if exists.is_none() {
        return Ok(());
    }

    let is_our_team    = if p.team == "my" { 1 } else { 0 };
    let kill_or_assist = p.kill + p.assist;

    sqlx::query(
        "INSERT OR REPLACE INTO battle_player
            (battle_id, is_our_team, rank_in_team, is_me, weapon_id,
             kill, assist, kill_or_assist, death, special, inked)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    )
    .bind(&p.battle_id)
    .bind(is_our_team)
    .bind(p.slot)
    .bind(p.is_myself as i64)
    .bind(weapon_id)
    .bind(p.kill)
    .bind(p.assist)
    .bind(kill_or_assist)
    .bind(p.death)
    .bind(p.special)
    .bind(p.paint)
    .execute(pool.as_ref())
    .await
    .map_err(|e| format!("shadow battle_player insert 失敗 battle={}: {e}", p.battle_id))?;

    Ok(())
}

pub async fn insert_battles(pool: &DbPool, rows: Vec<BattleRow>) -> Result<usize, String> {
    // 旧 battles テーブルは v11 で drop 済み。新 battle テーブルへ直接書く。
    let mut inserted = 0usize;
    for row in rows {
        // INSERT OR REPLACE なので既存行は上書き。既存判定は別途必要なら id 存在チェックを追加する。
        let existed = sqlx::query("SELECT 1 FROM battle WHERE id = ? LIMIT 1")
            .bind(&row.id)
            .fetch_optional(pool.as_ref())
            .await
            .map_err(|e| e.to_string())?
            .is_some();

        if let Err(e) = shadow_write_battle(pool, &row).await {
            log::warn!("[battle insert] {e}");
            continue;
        }

        if !existed {
            inserted += 1;
        }
    }
    Ok(inserted)
}

/// 詳細取得が未完了のバトル ID 一覧を返す。新スキーマから読む。
pub async fn get_battles_without_detail(pool: &DbPool) -> Result<Vec<String>, String> {
    let rows = sqlx::query("SELECT id FROM battle WHERE detail_fetched = 0 ORDER BY played_at DESC")
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
    // 旧 battles は v11 で drop 済み。新 battle テーブルのみ UPDATE する。
    shadow_update_battle_detail(
        pool, id, kill, death, assist, special, inked, raw_json, rule, mode,
        knockout, sub_weapon, special_weapon, awards, my_team, other_teams,
    )
    .await
}

/// 詳細取得結果を新スキーマの `battle` 行に反映する。FK 翻訳に失敗したらスキップ。
#[allow(clippy::too_many_arguments)]
async fn shadow_update_battle_detail(
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
    let lobby_id = old_mode_to_lobby_id(mode);
    let rule_id  = old_rule_to_rule_id(rule);
    let (Some(lobby_id), Some(rule_id)) = (lobby_id, rule_id) else {
        return Ok(());
    };
    let is_knockout: Option<i64> = knockout.map(|k| if k == "WIN" { 1 } else { 0 });
    let kill_or_assist = kill + assist;

    sqlx::query(
        "UPDATE battle
            SET kill=?, assist=?, kill_or_assist=?, death=?, special=?, inked=?,
                raw_json=?, rule_id=?, lobby_id=?, is_knockout=?, detail_fetched=1,
                knockout=?, sub_weapon=?, special_weapon=?, awards=?, my_team=?, other_teams=?
          WHERE id=?",
    )
    .bind(kill)
    .bind(assist)
    .bind(kill_or_assist)
    .bind(death)
    .bind(special)
    .bind(inked)
    .bind(raw_json)
    .bind(rule_id)
    .bind(lobby_id)
    .bind(is_knockout)
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

// ---------------------------------------------------------------------------
// gear_configuration populate
// ---------------------------------------------------------------------------

/// ability マスターの key → id 対応表をロードする。
async fn load_ability_id_map(pool: &DbPool) -> Result<std::collections::HashMap<String, i64>, String> {
    let rows = sqlx::query("SELECT id, key FROM ability")
        .fetch_all(pool.as_ref())
        .await
        .map_err(|e| e.to_string())?;
    Ok(rows
        .iter()
        .map(|r| (r.get::<String, _>("key"), r.get::<i64, _>("id")))
        .collect())
}

/// プレイヤー JSON から 1 つのギア (headGear / clothingGear / shoesGear) の
/// (primary_id, sub1_id, sub2_id, sub3_id) を抽出する。primary が抽出できなければ None。
fn extract_gear_ability_ids(
    player: &serde_json::Value,
    gear_key: &str,
    ability_id_map: &std::collections::HashMap<String, i64>,
) -> Option<(i64, Option<i64>, Option<i64>, Option<i64>)> {
    let gear = player.get(gear_key)?;
    let primary_url = gear.pointer("/primaryGearPower/image/url").and_then(|v| v.as_str())?;
    let primary_key = match crate::abilities::ability_key_from_url(primary_url) {
        Some(Some(k)) => k,
        _             => return None, // 未知 or empty
    };
    let primary_id = *ability_id_map.get(primary_key)?;

    let mut subs: [Option<i64>; 3] = [None, None, None];
    if let Some(arr) = gear.pointer("/additionalGearPowers").and_then(|v| v.as_array()) {
        for (i, sub) in arr.iter().enumerate().take(3) {
            if let Some(url) = sub.pointer("/image/url").and_then(|v| v.as_str()) {
                if let Some(Some(key)) = crate::abilities::ability_key_from_url(url) {
                    subs[i] = ability_id_map.get(key).copied();
                }
                // empty スロット (Some(None)) / 未知 (None) はそのまま None
            }
        }
    }

    Some((primary_id, subs[0], subs[1], subs[2]))
}

type GearKey = (i64, Option<i64>, Option<i64>, Option<i64>);

/// gear_configuration を find-or-create で取得し、ID を返す。cache は同一バッチ内で再利用する。
async fn find_or_create_gear_config(
    pool: &DbPool,
    primary: i64,
    sub1: Option<i64>,
    sub2: Option<i64>,
    sub3: Option<i64>,
    cache: &mut std::collections::HashMap<GearKey, i64>,
) -> Result<i64, String> {
    let key = (primary, sub1, sub2, sub3);
    if let Some(&id) = cache.get(&key) {
        return Ok(id);
    }

    // NULL 比較は IFNULL で 0 をセンチネルに（ability ID は >= 1）
    let existing = sqlx::query(
        "SELECT id FROM gear_configuration
         WHERE primary_ability_id = ?
           AND IFNULL(sub1_ability_id, 0) = IFNULL(?, 0)
           AND IFNULL(sub2_ability_id, 0) = IFNULL(?, 0)
           AND IFNULL(sub3_ability_id, 0) = IFNULL(?, 0)
         LIMIT 1",
    )
    .bind(primary)
    .bind(sub1)
    .bind(sub2)
    .bind(sub3)
    .fetch_optional(pool.as_ref())
    .await
    .map_err(|e| e.to_string())?;

    let id = if let Some(row) = existing {
        row.get::<i64, _>("id")
    } else {
        let result = sqlx::query(
            "INSERT INTO gear_configuration
                (primary_ability_id, sub1_ability_id, sub2_ability_id, sub3_ability_id)
             VALUES (?, ?, ?, ?)",
        )
        .bind(primary)
        .bind(sub1)
        .bind(sub2)
        .bind(sub3)
        .execute(pool.as_ref())
        .await
        .map_err(|e| e.to_string())?;
        result.last_insert_rowid()
    };

    cache.insert(key, id);
    Ok(id)
}

/// 1 バトル分の my_team / other_teams JSON からギア情報を抽出し、
/// 対応する battle_player 行の headgear_id / clothing_id / shoes_id を埋める。
async fn populate_gear_for_battle(
    pool: &DbPool,
    battle_id: &str,
    ability_id_map: &std::collections::HashMap<String, i64>,
    gear_cache: &mut std::collections::HashMap<GearKey, i64>,
) -> Result<(), String> {
    let row = sqlx::query("SELECT my_team, other_teams FROM battle WHERE id = ?")
        .bind(battle_id)
        .fetch_optional(pool.as_ref())
        .await
        .map_err(|e| e.to_string())?;
    let Some(row) = row else { return Ok(()); };
    let my_team:     Option<String> = row.try_get("my_team").ok().flatten();
    let other_teams: Option<String> = row.try_get("other_teams").ok().flatten();

    // 各プレイヤー: (is_our_team, rank_in_team, head_id, clothing_id, shoes_id)
    let mut updates: Vec<(i64, i64, Option<i64>, Option<i64>, Option<i64>)> = Vec::new();

    if let Some(json) = &my_team {
        if let Ok(arr) = serde_json::from_str::<serde_json::Value>(json) {
            if let Some(list) = arr.as_array() {
                for (slot, p) in list.iter().enumerate() {
                    let mut ids: [Option<i64>; 3] = [None, None, None];
                    for (i, gear_key) in ["headGear", "clothingGear", "shoesGear"].iter().enumerate() {
                        if let Some((pr, s1, s2, s3)) = extract_gear_ability_ids(p, gear_key, ability_id_map) {
                            ids[i] = Some(find_or_create_gear_config(pool, pr, s1, s2, s3, gear_cache).await?);
                        }
                    }
                    updates.push((1, slot as i64, ids[0], ids[1], ids[2]));
                }
            }
        }
    }

    if let Some(json) = &other_teams {
        if let Ok(arr) = serde_json::from_str::<serde_json::Value>(json) {
            if let Some(teams) = arr.as_array() {
                let mut slot = 0i64;
                for team in teams {
                    if let Some(list) = team.pointer("/players").and_then(|v| v.as_array()) {
                        for p in list {
                            let mut ids: [Option<i64>; 3] = [None, None, None];
                            for (i, gear_key) in ["headGear", "clothingGear", "shoesGear"].iter().enumerate() {
                                if let Some((pr, s1, s2, s3)) = extract_gear_ability_ids(p, gear_key, ability_id_map) {
                                    ids[i] = Some(find_or_create_gear_config(pool, pr, s1, s2, s3, gear_cache).await?);
                                }
                            }
                            updates.push((0, slot, ids[0], ids[1], ids[2]));
                            slot += 1;
                        }
                    }
                }
            }
        }
    }

    for (is_our_team, rank_in_team, head, cloth, shoes) in updates {
        sqlx::query(
            "UPDATE battle_player
                SET headgear_id = COALESCE(?, headgear_id),
                    clothing_id = COALESCE(?, clothing_id),
                    shoes_id    = COALESCE(?, shoes_id)
              WHERE battle_id = ? AND is_our_team = ? AND rank_in_team = ?",
        )
        .bind(head)
        .bind(cloth)
        .bind(shoes)
        .bind(battle_id)
        .bind(is_our_team)
        .bind(rank_in_team)
        .execute(pool.as_ref())
        .await
        .map_err(|e| e.to_string())?;
    }

    Ok(())
}

// ---------------------------------------------------------------------------

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
    // 旧 battle_players は v11 で drop 済み。新 battle_player のみへ書く。
    for p in players {
        if let Err(e) = shadow_write_battle_player(pool, p).await {
            log::warn!("[battle_player insert] {e}");
        }
    }

    // ギア情報を新スキーマの battle_player にも紐付ける（バトル単位で重複処理）。
    let battle_ids: std::collections::HashSet<&String> = players.iter().map(|p| &p.battle_id).collect();
    if !battle_ids.is_empty() {
        let ability_id_map = match load_ability_id_map(pool).await {
            Ok(m) => m,
            Err(e) => {
                log::warn!("[gear] ability マスター読込失敗、ギア populate スキップ: {e}");
                return Ok(());
            }
        };
        let mut gear_cache: std::collections::HashMap<GearKey, i64> = std::collections::HashMap::new();
        for bid in battle_ids {
            if let Err(e) = populate_gear_for_battle(pool, bid, &ability_id_map, &mut gear_cache).await {
                log::warn!("[gear] populate 失敗 battle={bid}: {e}");
            }
        }
    }

    Ok(())
}

/// 詳細取得済みで battle_players 未登録のバトルをバックフィルする（内部実装）。
/// 新スキーマの battle / battle_player から判定する。
pub async fn backfill_battle_players_inner(pool: &DbPool) -> Result<usize, String> {
    let rows = sqlx::query(
        "SELECT id, my_team, other_teams FROM battle
         WHERE detail_fetched = 1
           AND (my_team IS NOT NULL OR other_teams IS NOT NULL)
           AND id NOT IN (SELECT DISTINCT battle_id FROM battle_player)",
    )
    .fetch_all(pool.as_ref())
    .await
    .map_err(|e| e.to_string())?;

    let mut count = 0usize;
    for row in &rows {
        let battle_id:   String         = row.get("id");
        let my_team:     Option<String> = row.try_get("my_team").ok().flatten();
        let other_teams: Option<String> = row.try_get("other_teams").ok().flatten();
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

/// 新スキーマの `lobby` マスター向けにフロントから来た mode slug を翻訳する。
/// 'bankara' は展開、'x' は新マスター key の 'xmatch' に置換する。
fn translate_mode_filter(mode: Option<String>) -> Option<String> {
    mode.map(|m| match m.as_str() {
        "bankara" => "bankara_challenge|bankara_open".to_string(),
        "x"       => "xmatch".to_string(),
        _         => m,
    })
}

/// 新スキーマの `rule` マスター向けにフロントから来た rule slug を翻訳する。
/// 'turf_war' は stat.ink スラッグの 'nawabari' に置換する。
fn translate_rule_filter(rule: Option<String>) -> Option<String> {
    rule.map(|r| match r.as_str() {
        "turf_war" => "nawabari".to_string(),
        _          => r,
    })
}

/// SELECT 句で `lobby.key` を返すときに、フロントが期待する旧 slug へ逆翻訳する SQL 式。
/// 新マスターは stat.ink スラッグ ('xmatch') を使うが、chartoon フロントの
/// MODE_LABELS は 'x' をキーにしているため整合させる。
const LOBBY_KEY_AS_OLD: &str = "CASE l.key WHEN 'xmatch' THEN 'x' ELSE l.key END";

/// SELECT 句で `rule.key` を返すときに、フロントが期待する旧 slug へ逆翻訳する SQL 式。
/// 'nawabari' (新マスター) → 'turf_war' (chartoon フロント `RULE_LABELS` キー)。
const RULE_KEY_AS_OLD: &str = "CASE r.key WHEN 'nawabari' THEN 'turf_war' ELSE r.key END";

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
    let mode = translate_mode_filter(mode);
    let rule = translate_rule_filter(rule);
    let row = sqlx::query(
        "SELECT
            COUNT(*) as total,
            SUM(CASE WHEN res.key='win'  THEN 1 ELSE 0 END) as wins,
            SUM(CASE WHEN res.key='draw' THEN 1 ELSE 0 END) as draws,
            COUNT(DISTINCT b.weapon_id) as weapon_count,
            AVG(CASE WHEN b.detail_fetched = 1 THEN b.kill  END) as avg_kill,
            AVG(CASE WHEN b.detail_fetched = 1 THEN b.death END) as avg_death
         FROM battle b
         JOIN lobby  l   ON l.id   = b.lobby_id
         JOIN rule   r   ON r.id   = b.rule_id
         JOIN result res ON res.id = b.result_id
         JOIN weapon w   ON w.id   = b.weapon_id
         JOIN map    m   ON m.id   = b.map_id
         WHERE (? IS NULL OR b.played_at >= ?)
           AND (? IS NULL OR b.played_at <= ?)
           AND (? IS NULL OR instr('|' || ? || '|', '|' || l.key || '|') > 0)
           AND (? IS NULL OR r.key = ?)
           AND (? IS NULL OR res.key = ?)
           AND (? IS NULL OR instr('|' || ? || '|', '|' || w.key || '|') > 0)
           AND (? IS NULL OR instr('|' || ? || '|', '|' || m.key || '|') > 0)",
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
    let mode = translate_mode_filter(mode);
    let rule = translate_rule_filter(rule);
    let row = sqlx::query(
        "SELECT COUNT(*) as cnt
         FROM battle b
         JOIN lobby  l   ON l.id   = b.lobby_id
         JOIN rule   r   ON r.id   = b.rule_id
         JOIN result res ON res.id = b.result_id
         JOIN weapon w   ON w.id   = b.weapon_id
         JOIN map    m   ON m.id   = b.map_id
         WHERE (? IS NULL OR b.played_at >= ?)
           AND (? IS NULL OR b.played_at <= ?)
           AND (? IS NULL OR instr('|' || ? || '|', '|' || l.key || '|') > 0)
           AND (? IS NULL OR r.key = ?)
           AND (? IS NULL OR res.key = ?)
           AND (? IS NULL OR instr('|' || ? || '|', '|' || w.key || '|') > 0)
           AND (? IS NULL OR instr('|' || ? || '|', '|' || m.key || '|') > 0)",
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
    let mode = translate_mode_filter(mode);
    let rule = translate_rule_filter(rule);
    // kill_ratio は death=0 のとき大きなセンチネルに置換することで
    // DESC で上端 / ASC で下端 に配置（フロント側 ∞ 表示と整合）。
    let order_expr: &str = match order_by.as_deref() {
        Some("kill")       => "b.kill",
        Some("assist")     => "b.assist",
        Some("death")      => "b.death",
        Some("special")    => "b.special",
        Some("inked")      => "b.inked",
        Some("kill_ratio") => "COALESCE(CAST(b.kill AS REAL) / NULLIF(b.death, 0), 999999.0)",
        _                  => "b.played_at",
    };
    let order_dir = if order_asc.unwrap_or(false) { "ASC" } else { "DESC" };
    // フロントが期待する旧 slug 形式へ逆翻訳して BattleRow に詰める。
    let sql = format!(
        "SELECT b.id                     AS id,
                b.played_at              AS played_at,
                CASE WHEN l.key LIKE 'bankara%' THEN l.key ELSE {LOBBY_KEY_AS_OLD} END AS mode,
                COALESCE({RULE_KEY_AS_OLD}, '') AS rule,
                m.key                    AS stage,
                m.name_ja                AS stage_name,
                w.key                    AS weapon,
                res.key                  AS result,
                b.kill                   AS kill,
                b.death                  AS death,
                b.assist                 AS assist,
                b.special                AS special,
                b.inked                  AS inked,
                b.duration               AS duration,
                b.rank_before            AS rank_before,
                b.rank_after             AS rank_after,
                b.x_power_after          AS x_power,
                COALESCE(b.raw_json, '') AS raw_json,
                b.fetched_at             AS fetched_at,
                b.knockout               AS knockout,
                b.sub_weapon             AS sub_weapon,
                b.special_weapon         AS special_weapon,
                b.awards                 AS awards,
                b.my_team                AS my_team,
                b.other_teams            AS other_teams,
                b.statink_uuid           AS statink_uuid,
                b.parent_json            AS parent_json
         FROM battle b
         JOIN      lobby  l   ON l.id   = b.lobby_id
         LEFT JOIN rule   r   ON r.id   = b.rule_id
         JOIN      result res ON res.id = b.result_id
         JOIN      weapon w   ON w.id   = b.weapon_id
         JOIN      map    m   ON m.id   = b.map_id
         WHERE (? IS NULL OR b.played_at >= ?)
           AND (? IS NULL OR b.played_at <= ?)
           AND (? IS NULL OR instr('|' || ? || '|', '|' || l.key || '|') > 0)
           AND (? IS NULL OR r.key = ?)
           AND (? IS NULL OR res.key = ?)
           AND (? IS NULL OR instr('|' || ? || '|', '|' || w.key || '|') > 0)
           AND (? IS NULL OR instr('|' || ? || '|', '|' || m.key || '|') > 0)
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
        "SELECT m.key as id, MAX(m.name_ja) as name
         FROM battle b
         JOIN map m ON m.id = b.map_id
         GROUP BY m.id
         ORDER BY COUNT(*) DESC",
    )
    .fetch_all(db.as_ref())
    .await
    .map_err(|e| e.to_string())?;
    Ok(rows.into_iter().map(|r| {
        let id: String           = r.get("id");
        let name: Option<String> = r.try_get("name").ok().flatten();
        serde_json::json!({ "id": id, "name": name.unwrap_or_else(|| id.clone()) })
    }).collect())
}

/// 使用済み武器の一覧を試合数の多い順で返す。
#[tauri::command]
pub async fn db_weapons_used(db: tauri::State<'_, DbPool>) -> Result<Vec<String>, String> {
    let rows = sqlx::query(
        "SELECT w.key as weapon
         FROM battle b
         JOIN weapon w ON w.id = b.weapon_id
         GROUP BY w.id
         ORDER BY COUNT(*) DESC",
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
    let mode = translate_mode_filter(mode);
    let rule = translate_rule_filter(rule);

    let common_joins =
        "FROM battle b
         JOIN lobby  l   ON l.id   = b.lobby_id
         JOIN rule   r   ON r.id   = b.rule_id
         JOIN result res ON res.id = b.result_id
         JOIN weapon w   ON w.id   = b.weapon_id
         JOIN map    m   ON m.id   = b.map_id";
    let filter_where =
        "(? IS NULL OR b.played_at >= ?)
           AND (? IS NULL OR b.played_at <= ?)
           AND (? IS NULL OR instr('|' || ? || '|', '|' || l.key || '|') > 0)
           AND (? IS NULL OR r.key = ?)
           AND (? IS NULL OR res.key = ?)
           AND (? IS NULL OR instr('|' || ? || '|', '|' || w.key || '|') > 0)
           AND (? IS NULL OR instr('|' || ? || '|', '|' || m.key || '|') > 0)";

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
        "SELECT w.key as name, COUNT(*) as total,
                SUM(CASE WHEN res.key='win'  THEN 1 ELSE 0 END) as wins,
                SUM(CASE WHEN res.key='draw' THEN 1 ELSE 0 END) as draws
         {common_joins} WHERE {filter_where} GROUP BY w.id ORDER BY total DESC"
    )))
    .fetch_all(db.as_ref())
    .await
    .map_err(|e| e.to_string())?;

    let by_mode = bind_filters!(sqlx::query(&format!(
        "SELECT
                CASE WHEN l.key LIKE 'bankara%' THEN 'bankara' ELSE {LOBBY_KEY_AS_OLD} END as name,
                COUNT(*) as total,
                SUM(CASE WHEN res.key='win'  THEN 1 ELSE 0 END) as wins,
                SUM(CASE WHEN res.key='draw' THEN 1 ELSE 0 END) as draws
         {common_joins} WHERE {filter_where}
         GROUP BY CASE WHEN l.key LIKE 'bankara%' THEN 'bankara' ELSE l.key END
         ORDER BY total DESC"
    )))
    .fetch_all(db.as_ref())
    .await
    .map_err(|e| e.to_string())?;

    let by_stage = bind_filters!(sqlx::query(&format!(
        "SELECT m.key as name,
                COALESCE(MAX(m.name_ja), m.key) as display_name,
                COUNT(*) as total,
                SUM(CASE WHEN res.key='win'  THEN 1 ELSE 0 END) as wins,
                SUM(CASE WHEN res.key='draw' THEN 1 ELSE 0 END) as draws
         {common_joins} WHERE {filter_where} GROUP BY m.id ORDER BY total DESC"
    )))
    .fetch_all(db.as_ref())
    .await
    .map_err(|e| e.to_string())?;

    let by_rule = bind_filters!(sqlx::query(&format!(
        "SELECT {RULE_KEY_AS_OLD} as name, COUNT(*) as total,
                SUM(CASE WHEN res.key='win'  THEN 1 ELSE 0 END) as wins,
                SUM(CASE WHEN res.key='draw' THEN 1 ELSE 0 END) as draws
         {common_joins} WHERE {filter_where} GROUP BY r.id ORDER BY total DESC"
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
///
/// 新スキーマ（v6 で追加した `battle` + マスター各種）から読む。フロントが送る
/// 旧 slug は `translate_mode_filter` / `translate_rule_filter` で新マスターの key に
/// 翻訳してから WHERE 句に渡す。返す JSON 形式は従来と同一。
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
    let mode = translate_mode_filter(mode);
    let rule = translate_rule_filter(rule);

    // 味方武器 / 相手武器の集計は battle_player 経由なので別 SQL に分岐する。
    if group_by == "ally_weapon" || group_by == "enemy_weapon" {
        return db_grouped_stats_by_player_weapon(
            &db, &group_by, &since, &until, &mode, &rule,
            &result_filter, &weapon, &stage,
        ).await;
    }

    // group_by を新スキーマ用の (GROUP BY 式, display 用列) に翻訳する。
    // FROM 句は全 group_by 共通で battle + 5 マスター JOIN。
    // rule/mode はフロント期待値（'turf_war' / 'x' ...）へ逆翻訳して返す。
    // 時系列キー (day/three_day/week/month) は全粒度で「9 時境界の Splatoon 日」基準。
    // SplatNet 3 の playedTime は UTC で来るので、UTC 0:00 = JST 9:00 = Splatoon 日境界
    // となり、追加シフトせず strftime で日付抽出すれば 9 時境界バケットが得られる。
    // three_day だけは「今日基準で 3 日ごとに遡る」ためバケット開始日を計算する。
    const THREE_DAY_BUCKET: &str =
        "DATE(DATE('now'), \
              '-' || (3 * CAST((julianday(DATE('now')) - julianday(DATE(b.played_at))) / 3 AS INTEGER) + 2) || ' days')";
    let (group_expr, display_expr): (&str, &str) = match group_by.as_str() {
        "weapon"          => ("w.key",                                                                                "COALESCE(w.name_ja, w.key)"),
        "stage"           => ("m.key",                                                                                "COALESCE(MAX(m.name_ja), m.key)"),
        "rule"            => (RULE_KEY_AS_OLD,                                                                        RULE_KEY_AS_OLD),
        "mode"            => ("CASE WHEN l.key LIKE 'bankara%' THEN 'bankara' ELSE (CASE l.key WHEN 'xmatch' THEN 'x' ELSE l.key END) END",
                              "CASE WHEN l.key LIKE 'bankara%' THEN 'bankara' ELSE (CASE l.key WHEN 'xmatch' THEN 'x' ELSE l.key END) END"),
        "sub_weapon"      => ("COALESCE(w.sub_key, '(不明)')",                                                         "COALESCE(w.sub_key, '(不明)')"),
        "special_weapon"  => ("COALESCE(w.special_key, '(不明)')",                                                     "COALESCE(w.special_key, '(不明)')"),
        "weapon_category" => ("COALESCE(NULLIF(w.category_key, ''), '(未分類)')",                                      "COALESCE(NULLIF(w.category_key, ''), '(未分類)')"),
        "result"          => ("res.key",                                                                              "res.key"),
        // 時系列バケット（線グラフ / カレンダー用）。すべて返値は ISO 日付 or `YYYY-Www` / `YYYY-MM` 文字列。
        "day"             => ("strftime('%Y-%m-%d', b.played_at)",                                                    "strftime('%Y-%m-%d', b.played_at)"),
        "three_day"       => (THREE_DAY_BUCKET,                                                                       THREE_DAY_BUCKET),
        "week"            => ("strftime('%Y-W%W', b.played_at)",                                                      "strftime('%Y-W%W', b.played_at)"),
        "month"           => ("strftime('%Y-%m', b.played_at)",                                                       "strftime('%Y-%m', b.played_at)"),
        _ => return Err(format!("未対応の group_by: {group_by}")),
    };

    // 時系列キーは古い → 新しいの順、それ以外はバトル数の多い順。
    let order_by: &str = match group_by.as_str() {
        "day" | "three_day" | "week" | "month" => "key ASC",
        _ => "total DESC",
    };

    let filter_where =
        "(? IS NULL OR b.played_at >= ?)
           AND (? IS NULL OR b.played_at <= ?)
           AND (? IS NULL OR instr('|' || ? || '|', '|' || l.key || '|') > 0)
           AND (? IS NULL OR r.key = ?)
           AND (? IS NULL OR res.key = ?)
           AND (? IS NULL OR instr('|' || ? || '|', '|' || w.key || '|') > 0)
           AND (? IS NULL OR instr('|' || ? || '|', '|' || m.key || '|') > 0)";

    let sql = format!(
        "SELECT
            {group_expr} as key,
            {display_expr} as display_name,
            COUNT(*)                                                  as total,
            SUM(CASE WHEN res.key='win'  THEN 1 ELSE 0 END)           as wins,
            SUM(CASE WHEN res.key='draw' THEN 1 ELSE 0 END)           as draws,
            AVG(CASE WHEN b.detail_fetched = 1 THEN b.kill     END)   as avg_kill,
            AVG(CASE WHEN b.detail_fetched = 1 THEN b.death    END)   as avg_death,
            AVG(CASE WHEN b.detail_fetched = 1 THEN b.assist   END)   as avg_assist,
            AVG(CASE WHEN b.detail_fetched = 1 THEN b.special  END)   as avg_special,
            AVG(CASE WHEN b.detail_fetched = 1 THEN b.inked    END)   as avg_inked,
            AVG(CASE WHEN b.detail_fetched = 1 THEN b.duration END)   as avg_duration
         FROM battle b
         JOIN lobby  l   ON l.id   = b.lobby_id
         JOIN rule   r   ON r.id   = b.rule_id
         JOIN result res ON res.id = b.result_id
         JOIN weapon w   ON w.id   = b.weapon_id
         JOIN map    m   ON m.id   = b.map_id
         WHERE {filter_where}
         GROUP BY {group_expr}
         ORDER BY {order_by}"
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

/// `ally_weapon` / `enemy_weapon` 専用の集計。
///
/// 通常の `db_grouped_stats` は `battle.weapon_id`（自分の武器）でグループ化するが、
/// こちらは `battle_player` を経由してチームメイト / 対戦相手の武器でグループ化する。
///
/// セマンティクス（#118）：
/// - **同一バトル内で同一武器が複数いた場合は 1 として数える**
///   → 内側のサブクエリで `DISTINCT (battle_id, weapon_key)` を取り、外側で COUNT
/// - **ally_weapon は自分を除く**（`is_me=0`）
/// - **1 バトルが複数バケットに寄与する**：味方 3 人が A/B/C なら A・B・C の 3 バケット
///   それぞれに +1 する（=「武器ごとのバトル数合計」は実バトル数の最大 3 〜 4 倍）
///
/// 平均系メトリクス（K/D/A/SP/塗り/時間）はバトルテーブルの自分のスタッツを
/// (battle, weapon) ペア単位で平均する：同じバトルに複数の対象武器がいると
/// その武器バケットごとに重複カウントされるが、これは「その武器がいた時の自分の戦績」を
/// 表す意味で正しい（バケット内では各バトル 1 回ずつなので DISTINCT 不要）。
async fn db_grouped_stats_by_player_weapon(
    db: &tauri::State<'_, DbPool>,
    group_by: &str,
    since: &Option<String>,
    until: &Option<String>,
    mode: &Option<String>,
    rule: &Option<String>,
    result_filter: &Option<String>,
    weapon: &Option<String>,
    stage: &Option<String>,
) -> Result<Vec<serde_json::Value>, String> {
    // ally → is_our_team=1 かつ is_me=0、enemy → is_our_team=0
    let (is_our_team_val, exclude_self) = if group_by == "ally_weapon" {
        (1i64, true)
    } else {
        (0i64, false)
    };
    let bp_where = if exclude_self {
        "bp.is_our_team = ? AND bp.is_me = 0"
    } else {
        "bp.is_our_team = ?"
    };

    let filter_where =
        "(? IS NULL OR b.played_at >= ?)
           AND (? IS NULL OR b.played_at <= ?)
           AND (? IS NULL OR instr('|' || ? || '|', '|' || l.key || '|') > 0)
           AND (? IS NULL OR r.key = ?)
           AND (? IS NULL OR res.key = ?)
           AND (? IS NULL OR instr('|' || ? || '|', '|' || w.key || '|') > 0)
           AND (? IS NULL OR instr('|' || ? || '|', '|' || m.key || '|') > 0)";

    // 内側サブクエリ d：(battle_id, weapon_key, weapon_display) を DISTINCT で取得。
    // これで「同一バトル内で同一武器が複数」は 1 にまとめられる。
    let sql = format!(
        "SELECT
            d.bp_w_key                                                as key,
            MAX(d.bp_w_name)                                          as display_name,
            COUNT(*)                                                  as total,
            SUM(CASE WHEN res.key='win'  THEN 1 ELSE 0 END)           as wins,
            SUM(CASE WHEN res.key='draw' THEN 1 ELSE 0 END)           as draws,
            AVG(CASE WHEN b.detail_fetched = 1 THEN b.kill     END)   as avg_kill,
            AVG(CASE WHEN b.detail_fetched = 1 THEN b.death    END)   as avg_death,
            AVG(CASE WHEN b.detail_fetched = 1 THEN b.assist   END)   as avg_assist,
            AVG(CASE WHEN b.detail_fetched = 1 THEN b.special  END)   as avg_special,
            AVG(CASE WHEN b.detail_fetched = 1 THEN b.inked    END)   as avg_inked,
            AVG(CASE WHEN b.detail_fetched = 1 THEN b.duration END)   as avg_duration
         FROM (
             SELECT DISTINCT
                 bp.battle_id,
                 w_bp.key as bp_w_key,
                 -- 表示名にもスラッグ（key）を使う。
                 -- weaponImages がスラッグでキー付けされており、Japanese 名にすると一部しか
                 -- マッチせずアイコンとテキストが混在してしまうため、ここで揃える。
                 w_bp.key as bp_w_name
             FROM battle_player bp
             JOIN weapon w_bp ON w_bp.id = bp.weapon_id
             WHERE {bp_where}
         ) d
         JOIN battle b   ON b.id   = d.battle_id
         JOIN lobby  l   ON l.id   = b.lobby_id
         JOIN rule   r   ON r.id   = b.rule_id
         JOIN result res ON res.id = b.result_id
         JOIN weapon w   ON w.id   = b.weapon_id
         JOIN map    m   ON m.id   = b.map_id
         WHERE {filter_where}
         GROUP BY d.bp_w_key
         ORDER BY total DESC"
    );

    let rows = sqlx::query(&sql)
        .bind(is_our_team_val)
        .bind(since).bind(since)
        .bind(until).bind(until)
        .bind(mode).bind(mode)
        .bind(rule).bind(rule)
        .bind(result_filter).bind(result_filter)
        .bind(weapon).bind(weapon)
        .bind(stage).bind(stage)
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

/// 2 軸でクロス集計する。ヒートマップ用。
///
/// 返す JSON 形式: `[{ key_x, key_y, name_x, name_y, total, wins, draws, win_rate,
/// avg_kill, avg_death, avg_assist, avg_special, avg_inked, avg_duration }, ...]`
///
/// X / Y どちらかが `weapon` のときは武器のバトル数 Top N で絞り込む。
/// それ以外のカテゴリはそのまま全件返す。
#[tauri::command]
pub async fn db_grouped_stats_2d(
    db: tauri::State<'_, DbPool>,
    group_by_x: String,
    group_by_y: String,
    since: Option<String>,
    until: Option<String>,
    mode: Option<String>,
    rule: Option<String>,
    result_filter: Option<String>,  // JS: resultFilter
    weapon: Option<String>,
    stage: Option<String>,
    top_n: Option<i64>,             // 武器軸の Top N。指定なければ 20。
    // 数値メトリクス軸（"numeric:kill" 等）のとき、X 軸の bin 幅。
    x_bin_width: Option<f64>,
    // 数値メトリクス軸のとき、Y 軸の bin 幅。
    y_bin_width: Option<f64>,
) -> Result<Vec<serde_json::Value>, String> {
    if group_by_x == group_by_y {
        return Err(format!("X 軸と Y 軸に同じカテゴリを指定できません: {group_by_x}"));
    }

    // 味方武器 / 相手武器が片方でも軸に指定されたら専用パスへ分岐（#118）。
    if matches!(group_by_x.as_str(), "ally_weapon" | "enemy_weapon")
       || matches!(group_by_y.as_str(), "ally_weapon" | "enemy_weapon") {
        return db_grouped_stats_2d_with_bp(
            &db, &group_by_x, &group_by_y, &since, &until, &mode, &rule,
            &result_filter, &weapon, &stage, top_n,
        ).await;
    }

    let mode = translate_mode_filter(mode);
    let rule = translate_rule_filter(rule);

    /// 数値メトリクス軸用の SQL 式を作る (#134)。
    /// 軸キーが "numeric:foo" のとき、battle カラム foo を bin_w 幅で離散化する式を返す。
    /// 例: bin_w=1, foo=kill → CAST(b.kill / 1.0 AS INTEGER) * 1.0 = 「キル数の bin 開始値」
    fn numeric_axis_expr(metric: &str, bin_w: f64) -> Result<String, String> {
        let col = match metric {
            "kill"           => "b.kill",
            "death"          => "b.death",
            "assist"         => "b.assist",
            "kill_or_assist" => "(b.kill + b.assist)",
            "special"        => "b.special",
            "inked"          => "b.inked",
            "duration"       => "b.duration",
            _ => return Err(format!("未対応の数値メトリクス: {metric}")),
        };
        // bin_w は f64 リテラルとして埋め込む。負・ゼロは弾く。
        if !(bin_w.is_finite()) || bin_w <= 0.0 {
            return Err(format!("無効な bin 幅: {bin_w}"));
        }
        // SQLite は数値リテラルとして 1 や 1.5 を受け取る。Rust の {} は f64=1.0 → "1"
        // となるが整数として解釈されるだけなので問題ない。
        Ok(format!("CAST({col} * 1.0 / {bin_w} AS INTEGER) * {bin_w}"))
    }

    fn axis_expr_dyn(axis: &str, bin_w: Option<f64>) -> Result<String, String> {
        if let Some(metric) = axis.strip_prefix("numeric:") {
            let w = bin_w.ok_or_else(|| format!("数値軸 {axis} には bin_width が必要"))?;
            return numeric_axis_expr(metric, w);
        }
        Ok(match axis {
            "weapon"          => "w.key".to_string(),
            "stage"           => "m.key".to_string(),
            "rule"            => RULE_KEY_AS_OLD.to_string(),
            "mode"            => "CASE WHEN l.key LIKE 'bankara%' THEN 'bankara' ELSE (CASE l.key WHEN 'xmatch' THEN 'x' ELSE l.key END) END".to_string(),
            "sub_weapon"      => "COALESCE(w.sub_key, '(不明)')".to_string(),
            "special_weapon"  => "COALESCE(w.special_key, '(不明)')".to_string(),
            "weapon_category" => "COALESCE(NULLIF(w.category_key, ''), '(未分類)')".to_string(),
            "result"          => "res.key".to_string(),
            _ => return Err(format!("未対応の group_by: {axis}")),
        })
    }

    /// 表示用ラベル (name_x / name_y) を返す SQL 式。weapon / stage はマスターの
    /// 日本語名を、それ以外は key と同じ値を使う。GROUP BY 集約のため MAX で包む。
    /// 数値軸は GROUP BY 式そのものを文字列化して MAX で包む。
    fn axis_display_expr(axis: &str, group_expr: &str) -> Result<String, String> {
        if axis.starts_with("numeric:") {
            return Ok(format!("CAST(MAX({group_expr}) AS TEXT)"));
        }
        Ok(match axis {
            "weapon" => "COALESCE(MAX(w.name_ja), w.key)".to_string(),
            "stage"  => "COALESCE(MAX(m.name_ja), m.key)".to_string(),
            _        => group_expr.to_string(),  // 他は key そのまま
        })
    }

    let x_expr     = axis_expr_dyn(&group_by_x, x_bin_width)?;
    let y_expr     = axis_expr_dyn(&group_by_y, y_bin_width)?;
    let x_display  = axis_display_expr(&group_by_x, &x_expr)?;
    let y_display  = axis_display_expr(&group_by_y, &y_expr)?;

    let filter_where =
        "(? IS NULL OR b.played_at >= ?)
           AND (? IS NULL OR b.played_at <= ?)
           AND (? IS NULL OR instr('|' || ? || '|', '|' || l.key || '|') > 0)
           AND (? IS NULL OR r.key = ?)
           AND (? IS NULL OR res.key = ?)
           AND (? IS NULL OR instr('|' || ? || '|', '|' || w.key || '|') > 0)
           AND (? IS NULL OR instr('|' || ? || '|', '|' || m.key || '|') > 0)";

    // key_x / key_y は Rust 側で String として読み取るので、INTEGER 系の数値軸（#134）でも
    // 必ず TEXT になるよう SELECT で CAST する。GROUP BY は元の式（数値）のまま。
    let sql = format!(
        "SELECT
            CAST({x_expr} AS TEXT) as key_x,
            CAST({y_expr} AS TEXT) as key_y,
            {x_display} as name_x,
            {y_display} as name_y,
            COUNT(*)                                                  as total,
            SUM(CASE WHEN res.key='win'  THEN 1 ELSE 0 END)           as wins,
            SUM(CASE WHEN res.key='draw' THEN 1 ELSE 0 END)           as draws,
            AVG(CASE WHEN b.detail_fetched = 1 THEN b.kill     END)   as avg_kill,
            AVG(CASE WHEN b.detail_fetched = 1 THEN b.death    END)   as avg_death,
            AVG(CASE WHEN b.detail_fetched = 1 THEN b.assist   END)   as avg_assist,
            AVG(CASE WHEN b.detail_fetched = 1 THEN b.special  END)   as avg_special,
            AVG(CASE WHEN b.detail_fetched = 1 THEN b.inked    END)   as avg_inked,
            AVG(CASE WHEN b.detail_fetched = 1 THEN b.duration END)   as avg_duration
         FROM battle b
         JOIN lobby  l   ON l.id   = b.lobby_id
         JOIN rule   r   ON r.id   = b.rule_id
         JOIN result res ON res.id = b.result_id
         JOIN weapon w   ON w.id   = b.weapon_id
         JOIN map    m   ON m.id   = b.map_id
         WHERE {filter_where}
         GROUP BY {x_expr}, {y_expr}
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

    // 武器軸の Top N 絞り込み（バトル数の合計で上位 N の武器のみ残す）。
    let top_n_value = top_n.unwrap_or(20).max(1) as usize;
    let weapon_axis: Option<bool> =
        if      group_by_x == "weapon" { Some(true) }   // x 軸が weapon
        else if group_by_y == "weapon" { Some(false) }  // y 軸が weapon
        else                           { None };

    let kept_weapon_keys: Option<std::collections::HashSet<String>> = weapon_axis.map(|x_is_weapon| {
        let mut counts: std::collections::HashMap<String, i64> = std::collections::HashMap::new();
        for r in &rows {
            let key: String = if x_is_weapon { r.get("key_x") } else { r.get("key_y") };
            let t: i64 = r.get("total");
            *counts.entry(key).or_default() += t;
        }
        let mut pairs: Vec<(String, i64)> = counts.into_iter().collect();
        pairs.sort_by(|a, b| b.1.cmp(&a.1));
        pairs.into_iter().take(top_n_value).map(|(k, _)| k).collect()
    });

    let result: Vec<serde_json::Value> = rows.into_iter().filter_map(|r| {
        let key_x: String = r.get("key_x");
        let key_y: String = r.get("key_y");

        // Top N 絞り込み
        if let Some(ref keys) = kept_weapon_keys {
            let weapon_key = if weapon_axis == Some(true) { &key_x } else { &key_y };
            if !keys.contains(weapon_key) {
                return None;
            }
        }

        let total: i64 = r.get("total");
        let wins:  i64 = r.get("wins");
        let draws: i64 = r.get("draws");
        let decisive   = total - draws;
        let win_rate   = if decisive > 0 { wins as f64 / decisive as f64 } else { 0.0 };

        Some(serde_json::json!({
            "key_x":        key_x,
            "key_y":        key_y,
            "name_x":       r.try_get::<String, _>("name_x").unwrap_or_else(|_| key_x.clone()),
            "name_y":       r.try_get::<String, _>("name_y").unwrap_or_else(|_| key_y.clone()),
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
        }))
    }).collect();

    Ok(result)
}

/// `db_grouped_stats_2d` の ally_weapon / enemy_weapon 対応版（#118）。
///
/// X 軸 / Y 軸のどちらか or 両方が `ally_weapon` または `enemy_weapon` のとき呼ばれる。
/// `battle_player` テーブルを軸ごとに JOIN して、(味方武器, X) や (ally_weapon, enemy_weapon) の
/// クロス集計を行う。
///
/// セマンティクス：
/// - 各軸とも、同一バトル × 同一武器の重複は内側 DISTINCT サブクエリで 1 にまとめる
/// - 両軸が bp の場合は (味方武器 × 相手武器) 全ペアが寄与（ally 3 × enemy 4 = 12 ペア/バトル）
async fn db_grouped_stats_2d_with_bp(
    db: &tauri::State<'_, DbPool>,
    group_by_x: &str,
    group_by_y: &str,
    since: &Option<String>,
    until: &Option<String>,
    mode: &Option<String>,
    rule: &Option<String>,
    result_filter: &Option<String>,
    weapon: &Option<String>,
    stage: &Option<String>,
    top_n: Option<i64>,
) -> Result<Vec<serde_json::Value>, String> {
    let mode = translate_mode_filter(mode.clone());
    let rule = translate_rule_filter(rule.clone());

    let x_is_bp = matches!(group_by_x, "ally_weapon" | "enemy_weapon");
    let y_is_bp = matches!(group_by_y, "ally_weapon" | "enemy_weapon");

    fn bp_params(g: &str) -> (i64, bool) {
        if g == "ally_weapon" { (1, true) } else { (0, false) }
    }
    let (x_team, x_excl_self) = bp_params(group_by_x);
    let (y_team, y_excl_self) = bp_params(group_by_y);

    let x_bp_where: &str = if x_excl_self {
        "bp.is_our_team = ? AND bp.is_me = 0"
    } else {
        "bp.is_our_team = ?"
    };
    let y_bp_where: &str = if y_excl_self {
        "bp.is_our_team = ? AND bp.is_me = 0"
    } else {
        "bp.is_our_team = ?"
    };

    // 非 bp 軸の式（既存の axis_expr / axis_display_expr ロジックを再現）
    fn non_bp_axis_expr(axis: &str) -> Result<&'static str, String> {
        Ok(match axis {
            "weapon"          => "w.key",
            "stage"           => "m.key",
            "rule"            => RULE_KEY_AS_OLD,
            "mode"            => "CASE WHEN l.key LIKE 'bankara%' THEN 'bankara' ELSE (CASE l.key WHEN 'xmatch' THEN 'x' ELSE l.key END) END",
            "sub_weapon"      => "COALESCE(w.sub_key, '(不明)')",
            "special_weapon"  => "COALESCE(w.special_key, '(不明)')",
            "weapon_category" => "COALESCE(NULLIF(w.category_key, ''), '(未分類)')",
            "result"          => "res.key",
            _ => return Err(format!("未対応の group_by: {axis}")),
        })
    }
    fn non_bp_axis_display(axis: &str, fallback: &'static str) -> &'static str {
        match axis {
            "weapon" => "COALESCE(MAX(w.name_ja), w.key)",
            "stage"  => "COALESCE(MAX(m.name_ja), m.key)",
            _        => fallback,
        }
    }

    let (x_expr, x_display): (&str, &str) = if x_is_bp {
        // 表示名も key（スラッグ）で揃えて weaponImages にマッチさせる（#118 のフィックス方針と同じ）
        ("ax.weapon_key", "MAX(ax.weapon_key)")
    } else {
        let e = non_bp_axis_expr(group_by_x)?;
        let d = non_bp_axis_display(group_by_x, e);
        (e, d)
    };
    let (y_expr, y_display): (&str, &str) = if y_is_bp {
        ("ay.weapon_key", "MAX(ay.weapon_key)")
    } else {
        let e = non_bp_axis_expr(group_by_y)?;
        let d = non_bp_axis_display(group_by_y, e);
        (e, d)
    };

    // FROM 句を組み立て：bp 軸 → DISTINCT サブクエリ、その下に battle 本体と通常 JOIN
    let from_clause = if x_is_bp && y_is_bp {
        format!(
            "(SELECT DISTINCT bp.battle_id, w_bp.key as weapon_key
              FROM battle_player bp
              JOIN weapon w_bp ON w_bp.id = bp.weapon_id
              WHERE {x_bp_where}) ax
             JOIN (SELECT DISTINCT bp.battle_id, w_bp.key as weapon_key
                   FROM battle_player bp
                   JOIN weapon w_bp ON w_bp.id = bp.weapon_id
                   WHERE {y_bp_where}) ay ON ay.battle_id = ax.battle_id
             JOIN battle b ON b.id = ax.battle_id"
        )
    } else if x_is_bp {
        format!(
            "(SELECT DISTINCT bp.battle_id, w_bp.key as weapon_key
              FROM battle_player bp
              JOIN weapon w_bp ON w_bp.id = bp.weapon_id
              WHERE {x_bp_where}) ax
             JOIN battle b ON b.id = ax.battle_id"
        )
    } else {
        // y_is_bp のみ
        format!(
            "(SELECT DISTINCT bp.battle_id, w_bp.key as weapon_key
              FROM battle_player bp
              JOIN weapon w_bp ON w_bp.id = bp.weapon_id
              WHERE {y_bp_where}) ay
             JOIN battle b ON b.id = ay.battle_id"
        )
    };

    let filter_where =
        "(? IS NULL OR b.played_at >= ?)
           AND (? IS NULL OR b.played_at <= ?)
           AND (? IS NULL OR instr('|' || ? || '|', '|' || l.key || '|') > 0)
           AND (? IS NULL OR r.key = ?)
           AND (? IS NULL OR res.key = ?)
           AND (? IS NULL OR instr('|' || ? || '|', '|' || w.key || '|') > 0)
           AND (? IS NULL OR instr('|' || ? || '|', '|' || m.key || '|') > 0)";

    let sql = format!(
        "SELECT
            {x_expr} as key_x,
            {y_expr} as key_y,
            {x_display} as name_x,
            {y_display} as name_y,
            COUNT(*)                                                  as total,
            SUM(CASE WHEN res.key='win'  THEN 1 ELSE 0 END)           as wins,
            SUM(CASE WHEN res.key='draw' THEN 1 ELSE 0 END)           as draws,
            AVG(CASE WHEN b.detail_fetched = 1 THEN b.kill     END)   as avg_kill,
            AVG(CASE WHEN b.detail_fetched = 1 THEN b.death    END)   as avg_death,
            AVG(CASE WHEN b.detail_fetched = 1 THEN b.assist   END)   as avg_assist,
            AVG(CASE WHEN b.detail_fetched = 1 THEN b.special  END)   as avg_special,
            AVG(CASE WHEN b.detail_fetched = 1 THEN b.inked    END)   as avg_inked,
            AVG(CASE WHEN b.detail_fetched = 1 THEN b.duration END)   as avg_duration
         FROM {from_clause}
         JOIN lobby  l   ON l.id   = b.lobby_id
         JOIN rule   r   ON r.id   = b.rule_id
         JOIN result res ON res.id = b.result_id
         JOIN weapon w   ON w.id   = b.weapon_id
         JOIN map    m   ON m.id   = b.map_id
         WHERE {filter_where}
         GROUP BY {x_expr}, {y_expr}
         ORDER BY total DESC"
    );

    // バインド順：bp 軸が WHERE 句にあれば先に。次に通常フィルター。
    let mut query = sqlx::query(&sql);
    if x_is_bp { query = query.bind(x_team); }
    if y_is_bp { query = query.bind(y_team); }
    query = query
        .bind(since).bind(since)
        .bind(until).bind(until)
        .bind(&mode).bind(&mode)
        .bind(&rule).bind(&rule)
        .bind(result_filter).bind(result_filter)
        .bind(weapon).bind(weapon)
        .bind(stage).bind(stage);

    let rows = query
        .fetch_all(db.as_ref())
        .await
        .map_err(|e| e.to_string())?;

    // 武器軸（自分/味方/相手）の Top N 絞り込み。X 軸・Y 軸それぞれ独立に判定。
    // 両軸が武器系（ally × enemy など）のときも両方に Top N が効くようにする。
    let top_n_value = top_n.unwrap_or(20).max(1) as usize;
    let is_weapon_x = x_is_bp || group_by_x == "weapon";
    let is_weapon_y = y_is_bp || group_by_y == "weapon";

    // 各軸ごとに「その軸でのバトル数合計」で上位 N 件を抽出。
    fn top_n_set(rows: &[sqlx::sqlite::SqliteRow], x_axis: bool, n: usize) -> std::collections::HashSet<String> {
        let mut counts: std::collections::HashMap<String, i64> = std::collections::HashMap::new();
        for r in rows {
            let key: String = if x_axis { r.get("key_x") } else { r.get("key_y") };
            let t: i64 = r.get("total");
            *counts.entry(key).or_default() += t;
        }
        let mut pairs: Vec<(String, i64)> = counts.into_iter().collect();
        pairs.sort_by(|a, b| b.1.cmp(&a.1));
        pairs.into_iter().take(n).map(|(k, _)| k).collect()
    }
    let kept_x: Option<std::collections::HashSet<String>> =
        if is_weapon_x { Some(top_n_set(&rows, true,  top_n_value)) } else { None };
    let kept_y: Option<std::collections::HashSet<String>> =
        if is_weapon_y { Some(top_n_set(&rows, false, top_n_value)) } else { None };

    let result: Vec<serde_json::Value> = rows.into_iter().filter_map(|r| {
        let key_x: String = r.get("key_x");
        let key_y: String = r.get("key_y");

        if let Some(ref keys) = kept_x { if !keys.contains(&key_x) { return None; } }
        if let Some(ref keys) = kept_y { if !keys.contains(&key_y) { return None; } }

        let total: i64 = r.get("total");
        let wins:  i64 = r.get("wins");
        let draws: i64 = r.get("draws");
        let decisive   = total - draws;
        let win_rate   = if decisive > 0 { wins as f64 / decisive as f64 } else { 0.0 };

        Some(serde_json::json!({
            "key_x":        key_x,
            "key_y":        key_y,
            "name_x":       r.try_get::<String, _>("name_x").unwrap_or_else(|_| key_x.clone()),
            "name_y":       r.try_get::<String, _>("name_y").unwrap_or_else(|_| key_y.clone()),
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
        }))
    }).collect();

    Ok(result)
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

/// バトル詳細の my_team / other_teams JSON を全件返す（画像キャッシュ用）。新スキーマから読む。
pub async fn get_battles_team_json(pool: &DbPool) -> Result<Vec<(Option<String>, Option<String>)>, String> {
    let rows = sqlx::query(
        "SELECT my_team, other_teams FROM battle
         WHERE my_team IS NOT NULL OR other_teams IS NOT NULL",
    )
    .fetch_all(pool.as_ref())
    .await
    .map_err(|e| e.to_string())?;
    Ok(rows
        .into_iter()
        .map(|r| (r.try_get("my_team").ok().flatten(), r.try_get("other_teams").ok().flatten()))
        .collect())
}

/// 新スキーマの weapon マスター（と weapon_id を持つ battle_player）から
/// 旧 weapons テーブルに sub/special を補完する。db_list_weapons が sub/special
/// 画像 URL を保持する旧 weapons テーブルを読んでいる間に必要。
pub async fn populate_weapons_from_battles(pool: &DbPool) -> Result<usize, String> {
    // 新 weapon マスター + battle_player から、武器ごとの最新 sub/special を集約
    sqlx::query(
        "INSERT INTO weapons (name, category, sub_weapon, special_weapon)
         SELECT w.key, COALESCE(w.category_key, ''), w.sub_key, w.special_key
         FROM weapon w
         WHERE w.key != ''
         ON CONFLICT(name) DO UPDATE SET
             category       = CASE WHEN excluded.category != '' THEN excluded.category ELSE weapons.category END,
             sub_weapon     = COALESCE(excluded.sub_weapon, weapons.sub_weapon),
             special_weapon = COALESCE(excluded.special_weapon, weapons.special_weapon)",
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
/// version 8: 新 battle テーブルに parent_json 列を追加し、旧 battles から backfill
/// version 9: 新 battle テーブルに表示用カラム (knockout/sub_weapon/special_weapon/awards/my_team/other_teams) を追加し、旧 battles から backfill
/// version 10: 既存バトルの gear_configuration を my_team/other_teams JSON から backfill
/// version 11: battle.rule_id を nullable に変更し、旧 battles / battle_players テーブルを drop
pub async fn migrate_battle_ids(pool: &DbPool) -> Result<usize, String> {
    let ver_row = sqlx::query("PRAGMA user_version")
        .fetch_one(pool.as_ref())
        .await
        .map_err(|e| e.to_string())?;
    let current_version: i64 = ver_row.get(0);

    if current_version >= 11 {
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

    // version 8: 新 battle テーブルに parent_json 列を追加し、旧 battles から backfill。
    //            stat.ink アップロードのランクマッチ情報 (challenge_win/lose 等) で必要。
    //            あわせて statink_uuid も旧 → 新へ同期する（PR 90-D2b で stat.ink upload を
    //            新スキーマから読むようにするための準備）。
    if current_version < 8 {
        // ALTER TABLE は IF NOT EXISTS 非対応なので、失敗を握りつぶす（既に列があれば OK）。
        let _ = sqlx::query("ALTER TABLE battle ADD COLUMN parent_json TEXT")
            .execute(pool.as_ref())
            .await;

        let parent_filled = sqlx::query(
            "UPDATE battle
                SET parent_json = (SELECT old_b.parent_json FROM battles old_b WHERE old_b.id = battle.id)
              WHERE parent_json IS NULL",
        )
        .execute(pool.as_ref())
        .await
        .map_err(|e| format!("v8 parent_json backfill 失敗: {e}"))?
        .rows_affected();

        let uuid_synced = sqlx::query(
            "UPDATE battle
                SET statink_uuid = (SELECT old_b.statink_uuid FROM battles old_b WHERE old_b.id = battle.id)
              WHERE statink_uuid IS NULL
                AND EXISTS (SELECT 1 FROM battles old_b WHERE old_b.id = battle.id AND old_b.statink_uuid IS NOT NULL)",
        )
        .execute(pool.as_ref())
        .await
        .map_err(|e| format!("v8 statink_uuid 同期失敗: {e}"))?
        .rows_affected();

        sqlx::query("PRAGMA user_version = 8")
            .execute(pool.as_ref())
            .await
            .map_err(|e| e.to_string())?;

        log::info!(
            "migrate v8: battle に parent_json 追加 (backfill {} 件, statink_uuid 同期 {} 件)",
            parent_filled,
            uuid_synced,
        );
    }

    // version 9: 新 battle テーブルに表示用カラム (knockout / sub_weapon / special_weapon /
    //            awards / my_team / other_teams) を追加し、旧 battles から backfill。
    //            これで `db_list_battles` 等のフロント向け表示クエリも新スキーマで賄える。
    if current_version < 9 {
        for sql in [
            "ALTER TABLE battle ADD COLUMN knockout       TEXT",
            "ALTER TABLE battle ADD COLUMN sub_weapon     TEXT",
            "ALTER TABLE battle ADD COLUMN special_weapon TEXT",
            "ALTER TABLE battle ADD COLUMN awards         TEXT",
            "ALTER TABLE battle ADD COLUMN my_team        TEXT",
            "ALTER TABLE battle ADD COLUMN other_teams    TEXT",
        ] {
            // ALTER TABLE IF NOT EXISTS は非対応なので失敗を握りつぶす（列が既にあれば OK）
            let _ = sqlx::query(sql).execute(pool.as_ref()).await;
        }

        let filled = sqlx::query(
            "UPDATE battle SET
                knockout       = COALESCE(battle.knockout,       (SELECT b.knockout       FROM battles b WHERE b.id = battle.id)),
                sub_weapon     = COALESCE(battle.sub_weapon,     (SELECT b.sub_weapon     FROM battles b WHERE b.id = battle.id)),
                special_weapon = COALESCE(battle.special_weapon, (SELECT b.special_weapon FROM battles b WHERE b.id = battle.id)),
                awards         = COALESCE(battle.awards,         (SELECT b.awards         FROM battles b WHERE b.id = battle.id)),
                my_team        = COALESCE(battle.my_team,        (SELECT b.my_team        FROM battles b WHERE b.id = battle.id)),
                other_teams    = COALESCE(battle.other_teams,    (SELECT b.other_teams    FROM battles b WHERE b.id = battle.id))
              WHERE EXISTS (SELECT 1 FROM battles b WHERE b.id = battle.id)",
        )
        .execute(pool.as_ref())
        .await
        .map_err(|e| format!("v9 backfill 失敗: {e}"))?
        .rows_affected();

        sqlx::query("PRAGMA user_version = 9")
            .execute(pool.as_ref())
            .await
            .map_err(|e| e.to_string())?;

        log::info!(
            "migrate v9: battle に表示用カラム追加 (backfill {} 件)",
            filled,
        );
    }

    // version 10: 既存バトルの gear_configuration を my_team / other_teams JSON から backfill。
    //             ability マスター (v6 で seed 済み) + abilities::ABILITY_HASHES のハッシュ→キー対応で
    //             ギア画像 URL から ability ID を逆引きし、find-or-create で gear_configuration に
    //             登録、battle_player の headgear_id / clothing_id / shoes_id を埋める。
    if current_version < 10 {
        let ability_id_map = load_ability_id_map(pool).await?;
        let mut gear_cache: std::collections::HashMap<GearKey, i64> = std::collections::HashMap::new();

        let battle_ids = sqlx::query(
            "SELECT id FROM battle
             WHERE my_team IS NOT NULL OR other_teams IS NOT NULL",
        )
        .fetch_all(pool.as_ref())
        .await
        .map_err(|e| e.to_string())?;

        let mut processed = 0usize;
        let mut skipped = 0usize;
        for row in &battle_ids {
            let bid: String = row.get("id");
            match populate_gear_for_battle(pool, &bid, &ability_id_map, &mut gear_cache).await {
                Ok(_) => processed += 1,
                Err(e) => {
                    log::warn!(
                        "[v10 gear] populate 失敗 battle={}: {e}",
                        &bid[..bid.len().min(20)]
                    );
                    skipped += 1;
                }
            }
        }

        sqlx::query("PRAGMA user_version = 10")
            .execute(pool.as_ref())
            .await
            .map_err(|e| e.to_string())?;

        log::info!(
            "migrate v10: gear_configuration backfill (processed {}, skipped {}, gear_configs {})",
            processed,
            skipped,
            gear_cache.len(),
        );
    }

    // version 11: battle.rule_id を nullable に変更（list クエリ取り込み時点で
    //             rule が未確定なバトルも挿入できるようにするため）。SQLite は
    //             ALTER COLUMN がないので table recreation パターン。
    //             あわせて旧 battles / battle_players テーブルを drop し、
    //             以後は完全に新スキーマで動作する。
    //             旧 weapons は db_list_weapons が sub/special 画像を保持するため残す。
    if current_version < 11 {
        // 既存インデックス・データを保ったまま rule_id を nullable に変更
        sqlx::query("PRAGMA foreign_keys = OFF")
            .execute(pool.as_ref())
            .await
            .map_err(|e| e.to_string())?;

        let recreation_sql = "
            CREATE TABLE battle_v11 (
                id                 TEXT    PRIMARY KEY,
                uuid               TEXT,
                played_at          TEXT    NOT NULL,
                period             TEXT,
                lobby_id           INTEGER NOT NULL REFERENCES lobby(id),
                rule_id            INTEGER REFERENCES rule(id),
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
                statink_uuid       TEXT,
                parent_json        TEXT,
                knockout           TEXT,
                sub_weapon         TEXT,
                special_weapon     TEXT,
                awards             TEXT,
                my_team            TEXT,
                other_teams        TEXT
            );
            INSERT INTO battle_v11 SELECT * FROM battle;
            DROP TABLE battle;
            ALTER TABLE battle_v11 RENAME TO battle;
            CREATE INDEX battle_played_at ON battle(played_at);
            CREATE INDEX battle_lobby     ON battle(lobby_id);
            CREATE INDEX battle_rule      ON battle(rule_id);
            CREATE INDEX battle_map       ON battle(map_id);
            CREATE INDEX battle_weapon    ON battle(weapon_id);
        ";
        sqlx::query(recreation_sql)
            .execute(pool.as_ref())
            .await
            .map_err(|e| format!("v11 battle 再作成失敗: {e}"))?;

        // 旧テーブルを drop（旧 weapons は db_list_weapons でまだ使うので残す）
        sqlx::query("DROP TABLE IF EXISTS battle_players")
            .execute(pool.as_ref())
            .await
            .map_err(|e| format!("v11 battle_players drop 失敗: {e}"))?;
        sqlx::query("DROP TABLE IF EXISTS battles")
            .execute(pool.as_ref())
            .await
            .map_err(|e| format!("v11 battles drop 失敗: {e}"))?;

        sqlx::query("PRAGMA foreign_keys = ON")
            .execute(pool.as_ref())
            .await
            .map_err(|e| e.to_string())?;

        sqlx::query("PRAGMA user_version = 11")
            .execute(pool.as_ref())
            .await
            .map_err(|e| e.to_string())?;

        log::info!("migrate v11: battle.rule_id を nullable 化、旧 battles / battle_players を drop");
    }

    Ok(updated)
}

// ---------------------------------------------------------------------------
// stat.ink アップロード管理
// ---------------------------------------------------------------------------

/// stat.ink アップロード処理が必要とする最小フィールドだけを持つ軽量行。
/// 旧 `BattleRow` は表示・集計用の全カラムを保持しているが、stat.ink 側は
/// raw_json と parent_json と id だけ参照する。
#[derive(Debug, FromRow)]
pub struct StatinkBattleRow {
    pub id: String,
    pub raw_json: String,
    pub parent_json: Option<String>,
}

/// statink_uuid が未設定のバトル一覧を返す（古い順）。新スキーマから読む。
pub async fn get_battles_not_uploaded(pool: &DbPool) -> Result<Vec<StatinkBattleRow>, String> {
    let rows = sqlx::query_as::<_, StatinkBattleRow>(
        "SELECT id, raw_json, parent_json FROM battle
         WHERE statink_uuid IS NULL
           AND detail_fetched = 1
           AND raw_json IS NOT NULL
         ORDER BY played_at ASC",
    )
    .fetch_all(pool.as_ref())
    .await
    .map_err(|e| e.to_string())?;
    Ok(rows)
}

/// statink_uuid が設定済みのバトル一覧を返す（id, statink_uuid のペア）。新スキーマから読む。
pub async fn get_battles_uploaded(pool: &DbPool) -> Result<Vec<(String, String)>, String> {
    let rows = sqlx::query(
        "SELECT id, statink_uuid FROM battle WHERE statink_uuid IS NOT NULL ORDER BY played_at ASC",
    )
    .fetch_all(pool.as_ref())
    .await
    .map_err(|e| e.to_string())?;
    Ok(rows
        .into_iter()
        .map(|r| (r.get::<String, _>("id"), r.get::<String, _>("statink_uuid")))
        .collect())
}

/// バトルの statink_uuid を NULL にリセットする（削除後の再アップロード用）。
pub async fn reset_statink_uuid(pool: &DbPool, id: &str) -> Result<(), String> {
    sqlx::query("UPDATE battle SET statink_uuid = NULL WHERE id = ?")
        .bind(id)
        .execute(pool.as_ref())
        .await
        .map_err(|e| e.to_string())?;
    Ok(())
}

/// バトルを stat.ink アップロード済みとしてマークする。
pub async fn mark_statink_uploaded(pool: &DbPool, id: &str, uuid: &str) -> Result<(), String> {
    sqlx::query("UPDATE battle SET statink_uuid=? WHERE id=?")
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
