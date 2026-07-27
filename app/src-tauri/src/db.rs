//! SQLite によるバトルデータの永続化。
//!
//! テーブル設計方針:
//! - 主要フィールドはクエリ・集計用に個別カラムで保持
//! - 全生データは raw_json に格納し、将来の分析に備える

use serde::{Deserialize, Serialize};
use sqlx::{Pool, Sqlite, SqlitePool, Row, FromRow};
use sqlx::sqlite::{SqliteConnectOptions, SqliteJournalMode, SqliteSynchronous};
use std::sync::Arc;
use std::time::Duration;
use tauri::{AppHandle, Manager};

pub type DbPool = Arc<Pool<Sqlite>>;

// ---------------------------------------------------------------------------
// 初期化
// ---------------------------------------------------------------------------

pub async fn init_db(app: &AppHandle) -> Result<DbPool, String> {
    let data_dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    std::fs::create_dir_all(&data_dir).map_err(|e| e.to_string())?;
    let db_path = data_dir.join("chartoon.db");

    // プールの全コネクションに共通設定を適用する。
    // - busy_timeout: SQLite は単一ライターのため、起動直後の他処理（バトル取得・
    //   マイグレーション・シャドウライト）と環境データ一括取り込みが衝突しうる。
    //   未設定だと衝突時に即 SQLITE_BUSY（"database is locked"）で落ちるので、
    //   一定時間ロック解放を待つようにする。
    // - journal_mode=WAL / synchronous=NORMAL: 通常運用の標準設定を明示。
    //   connect_with でテンプレートとして渡すことで、後からプール内の一部
    //   コネクションにだけ PRAGMA を打つ（＝効かない・混在する）事故を防ぐ。
    let opts = SqliteConnectOptions::new()
        .filename(&db_path)
        .create_if_missing(true)
        .journal_mode(SqliteJournalMode::Wal)
        .synchronous(SqliteSynchronous::Normal)
        .busy_timeout(Duration::from_secs(30))
        .foreign_keys(true);

    let pool = SqlitePool::connect_with(opts).await.map_err(|e| e.to_string())?;
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

/// SplatNet3 の `knockout` フィールドを `battle.is_knockout` の三値に変換する（#315）。
///
/// `knockout` は **"WIN" / "LOSE" / "NEITHER"** の 3 値（ナワバリ等では null）。
///   - `"WIN"`  → `Some(1)` : KO 勝ち
///   - `"LOSE"` → `Some(0)` : KO 負け
///   - `"NEITHER"` / 未知 / null → `None` : ノックアウト無し（時間切れ決着）
///
/// ⚠ 以前は `if k == "WIN" { 1 } else { 0 }` という 2 値変換で、**"NEITHER" まで 0 に潰していた**。
///    集計側（`SUM(is_knockout = 0) as knockout_lose`）は三値前提なので、
///    KO 負けに時間切れバトルが全部混ざって約 3.5 倍に膨らんでいた。
fn knockout_flag(knockout: Option<&str>) -> Option<i64> {
    match knockout {
        Some("WIN")  => Some(1),
        Some("LOSE") => Some(0),
        _            => None,
    }
}

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
    // weapon_records からの LEFT JOIN 列 (#49)。未取得武器は NULL。
    pub weapon_level: Option<i64>,
    pub win_count_total: Option<i64>,
    pub paint_point_total: Option<i64>,
    pub weapon_power: Option<f64>,
    pub weapon_power_max: Option<f64>,
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

/// 新スキーマの `battle` テーブルに `INSERT OR IGNORE` する。
/// rule が空 (list クエリ取り込み直後) なら rule_id = NULL で挿入し、後段の
/// `shadow_update_battle_detail` (詳細取得後) で正しい rule_id に更新される。
/// rule 以外の必須 FK (lobby / result / weapon / map) が解決できない場合は warn + スキップ。
///
/// **既存行はスキップする (#141)**：list クエリは詳細クエリより情報が少ない
/// （rule_id / raw_json / my_team / other_teams 等が無い）。`INSERT OR REPLACE` で
/// 既存行を上書きしてしまうと `detail_fetched` も DEFAULT 0 に戻り、すべての
/// 詳細情報が消えて再フェッチが走るループになる。既存行はそのまま温存する。
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
    let is_knockout: Option<i64> = knockout_flag(row.knockout.as_deref());

    sqlx::query(
        "INSERT OR IGNORE INTO battle
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

/// 新スキーマの `battle_player` テーブルに `INSERT OR IGNORE` する（シャドウライト）。
/// 親 `battle` が新スキーマに居ない場合（FK 違反）はスキップ。
/// 同一バトル × 同一スロットのレコードは内容変化しないため、既存行はスキップで OK (#141)。
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
        "INSERT OR IGNORE INTO battle_player
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
    let is_knockout: Option<i64> = knockout_flag(knockout);
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
        "bankara"   => "bankara_challenge|bankara_open".to_string(),
        "splatfest" => "splatfest_open|splatfest_challenge".to_string(),
        "x"         => "xmatch".to_string(),
        _           => m,
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
            AVG(CASE WHEN b.detail_fetched = 1 THEN b.kill   END) as avg_kill,
            AVG(CASE WHEN b.detail_fetched = 1 THEN b.death  END) as avg_death,
            AVG(CASE WHEN b.detail_fetched = 1 THEN b.assist END) as avg_assist
         FROM battle b
         JOIN lobby  l   ON l.id   = b.lobby_id
         JOIN rule   r   ON r.id   = b.rule_id
         JOIN result res ON res.id = b.result_id
         JOIN weapon w   ON w.id   = b.weapon_id
         JOIN map    m   ON m.id   = b.map_id
         WHERE (? IS NULL OR b.played_at >= ?)
           AND (? IS NULL OR b.played_at <= ?)
           AND (? IS NULL OR instr('|' || ? || '|', '|' || l.key || '|') > 0)
           AND (? IS NULL OR instr('|' || ? || '|', '|' || r.key || '|') > 0)
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
    let avg_kill:   Option<f64>    = row.try_get("avg_kill").ok();
    let avg_death:  Option<f64>    = row.try_get("avg_death").ok();
    let avg_assist: Option<f64>    = row.try_get("avg_assist").ok();
    let decisive                   = total - draws;
    Ok(serde_json::json!({
        "total": total,
        "wins": wins,
        "draws": draws,
        "win_rate": if decisive > 0 { wins as f64 / decisive as f64 } else { 0.0 },
        "weapon_count": weapon_count,
        "avg_kill":   avg_kill,
        "avg_death":  avg_death,
        "avg_assist": avg_assist,
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
           AND (? IS NULL OR instr('|' || ? || '|', '|' || r.key || '|') > 0)
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
           AND (? IS NULL OR instr('|' || ? || '|', '|' || r.key || '|') > 0)
           AND (? IS NULL OR res.key = ?)
           AND (? IS NULL OR instr('|' || ? || '|', '|' || w.key || '|') > 0)
           AND (? IS NULL OR instr('|' || ? || '|', '|' || m.key || '|') > 0)
           -- トリカラマッチはバトルリストに載せない（#293）。ルールが他と大きく異なるため。
           AND (json_extract(b.raw_json, '$.vsRule.rule') IS NULL
                OR json_extract(b.raw_json, '$.vsRule.rule') <> 'TRI_COLOR')
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
           AND (? IS NULL OR instr('|' || ? || '|', '|' || r.key || '|') > 0)
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

    // バンカラ(open/challenge) は 'bankara'、フェス(open/challenge) は 'splatfest' に束ねる。
    // トリカラ(splatfest_tricolor) は LOBBY_SEED 未対応で集計に乗らないため、ここでは考慮不要。
    let by_mode = bind_filters!(sqlx::query(&format!(
        "SELECT
                CASE WHEN l.key LIKE 'bankara%' THEN 'bankara'
                     WHEN l.key LIKE 'splatfest%' THEN 'splatfest'
                     ELSE {LOBBY_KEY_AS_OLD} END as name,
                COUNT(*) as total,
                SUM(CASE WHEN res.key='win'  THEN 1 ELSE 0 END) as wins,
                SUM(CASE WHEN res.key='draw' THEN 1 ELSE 0 END) as draws
         {common_joins} WHERE {filter_where}
         GROUP BY CASE WHEN l.key LIKE 'bankara%' THEN 'bankara'
                       WHEN l.key LIKE 'splatfest%' THEN 'splatfest'
                       ELSE l.key END
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
           AND (? IS NULL OR instr('|' || ? || '|', '|' || r.key || '|') > 0)
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
            -- 自チーム KO 勝ち / 相手 KO による負け数。
            -- is_knockout は 1 (自分側 WIN を KO で取った) / 0 (KO で負けた) / NULL (時間切れ) の三値。
            SUM(CASE WHEN b.is_knockout = 1 THEN 1 ELSE 0 END)        as knockout_win,
            SUM(CASE WHEN b.is_knockout = 0 THEN 1 ELSE 0 END)        as knockout_lose,
            AVG(CASE WHEN b.detail_fetched = 1 THEN b.kill     END)   as avg_kill,
            AVG(CASE WHEN b.detail_fetched = 1 THEN b.death    END)   as avg_death,
            AVG(CASE WHEN b.detail_fetched = 1 THEN b.assist   END)   as avg_assist,
            AVG(CASE WHEN b.detail_fetched = 1 THEN b.special  END)   as avg_special,
            AVG(CASE WHEN b.detail_fetched = 1 THEN b.inked    END)   as avg_inked,
            AVG(CASE WHEN b.detail_fetched = 1 THEN b.duration END)   as avg_duration,
            -- 合計系（#175）。detail_fetched=1 のバトルのみ K/D/A/塗りが入る。
            -- 該当バトルが 1 件もない場合 SUM は NULL（FE で null フォールバック）。
            SUM(CASE WHEN b.detail_fetched = 1 THEN b.kill   END)     as sum_kill,
            SUM(CASE WHEN b.detail_fetched = 1 THEN b.death  END)     as sum_death,
            SUM(CASE WHEN b.detail_fetched = 1 THEN b.assist END)     as sum_assist,
            SUM(CASE WHEN b.detail_fetched = 1 THEN b.inked  END)     as sum_inked
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
        let knockout_win:  i64 = r.try_get("knockout_win").unwrap_or(0);
        let knockout_lose: i64 = r.try_get("knockout_lose").unwrap_or(0);
        serde_json::json!({
            "key":           r.get::<String, _>("key"),
            "name":          name,
            "total":         total,
            "wins":          wins,
            "draws":         draws,
            "win_rate":      win_rate,
            "knockout_win":  knockout_win,
            "knockout_lose": knockout_lose,
            "avg_kill":      r.try_get::<f64, _>("avg_kill").ok(),
            "avg_death":     r.try_get::<f64, _>("avg_death").ok(),
            "avg_assist":    r.try_get::<f64, _>("avg_assist").ok(),
            "avg_special":   r.try_get::<f64, _>("avg_special").ok(),
            "avg_inked":     r.try_get::<f64, _>("avg_inked").ok(),
            "avg_duration":  r.try_get::<f64, _>("avg_duration").ok(),
            "sum_kill":      r.try_get::<i64, _>("sum_kill").ok(),
            "sum_death":     r.try_get::<i64, _>("sum_death").ok(),
            "sum_assist":    r.try_get::<i64, _>("sum_assist").ok(),
            "sum_inked":     r.try_get::<i64, _>("sum_inked").ok(),
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
           AND (? IS NULL OR instr('|' || ? || '|', '|' || r.key || '|') > 0)
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
            SUM(CASE WHEN b.is_knockout = 1 THEN 1 ELSE 0 END)        as knockout_win,
            SUM(CASE WHEN b.is_knockout = 0 THEN 1 ELSE 0 END)        as knockout_lose,
            AVG(CASE WHEN b.detail_fetched = 1 THEN b.kill     END)   as avg_kill,
            AVG(CASE WHEN b.detail_fetched = 1 THEN b.death    END)   as avg_death,
            AVG(CASE WHEN b.detail_fetched = 1 THEN b.assist   END)   as avg_assist,
            AVG(CASE WHEN b.detail_fetched = 1 THEN b.special  END)   as avg_special,
            AVG(CASE WHEN b.detail_fetched = 1 THEN b.inked    END)   as avg_inked,
            AVG(CASE WHEN b.detail_fetched = 1 THEN b.duration END)   as avg_duration,
            -- 合計系（#175）。detail_fetched=1 のバトルのみ K/D/A/塗りが入る。
            SUM(CASE WHEN b.detail_fetched = 1 THEN b.kill   END)     as sum_kill,
            SUM(CASE WHEN b.detail_fetched = 1 THEN b.death  END)     as sum_death,
            SUM(CASE WHEN b.detail_fetched = 1 THEN b.assist END)     as sum_assist,
            SUM(CASE WHEN b.detail_fetched = 1 THEN b.inked  END)     as sum_inked
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
        let knockout_win:  i64 = r.try_get("knockout_win").unwrap_or(0);
        let knockout_lose: i64 = r.try_get("knockout_lose").unwrap_or(0);
        serde_json::json!({
            "key":           r.get::<String, _>("key"),
            "name":          name,
            "total":         total,
            "wins":          wins,
            "draws":         draws,
            "win_rate":      win_rate,
            "knockout_win":  knockout_win,
            "knockout_lose": knockout_lose,
            "avg_kill":      r.try_get::<f64, _>("avg_kill").ok(),
            "avg_death":     r.try_get::<f64, _>("avg_death").ok(),
            "avg_assist":    r.try_get::<f64, _>("avg_assist").ok(),
            "avg_special":   r.try_get::<f64, _>("avg_special").ok(),
            "avg_inked":     r.try_get::<f64, _>("avg_inked").ok(),
            "avg_duration":  r.try_get::<f64, _>("avg_duration").ok(),
            "sum_kill":      r.try_get::<i64, _>("sum_kill").ok(),
            "sum_death":     r.try_get::<i64, _>("sum_death").ok(),
            "sum_assist":    r.try_get::<i64, _>("sum_assist").ok(),
            "sum_inked":     r.try_get::<i64, _>("sum_inked").ok(),
        })
    }).collect())
}

/// 2 軸でクロス集計する。ヒートマップ用。
///
/// 返す JSON 形式: `[{ key_x, key_y, name_x, name_y, total, wins, draws, win_rate,
/// avg_kill, avg_death, avg_assist, avg_special, avg_inked, avg_duration }, ...]`
///
/// `avg_duration` は集計結果に含めるが、フロントのメトリクス選択肢（MetricKey）からは
/// #436 で削除済み。UI は表示しない（保存済みグラフは読み込み時に勝率へ退避）。
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
           AND (? IS NULL OR instr('|' || ? || '|', '|' || r.key || '|') > 0)
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
           AND (? IS NULL OR instr('|' || ? || '|', '|' || r.key || '|') > 0)
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

/// WeaponRecordQuery で取得したユーザー固有の武器統計を upsert する (#49)。
/// weapon_id は weapons.name と一致するキー（武器の日本語名）。
pub async fn upsert_weapon_record(
    pool: &DbPool,
    weapon_id: &str,
    weapon_level: i64,
    win_count_total: i64,
    paint_point_total: i64,
    // 以下は WeaponRecordQuery には含まれないが、将来の別クエリで埋められる想定でカラムだけ用意。
    big_run_level: Option<i64>,
    weapon_power: Option<f64>,
    weapon_power_max: Option<f64>,
) -> Result<(), String> {
    let now_ts = chrono::Utc::now().timestamp();
    sqlx::query(
        "INSERT INTO weapon_records (
            weapon_id, weapon_level, big_run_level,
            win_count_total, paint_point_total,
            weapon_power, weapon_power_max, last_fetched_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(weapon_id) DO UPDATE SET
            weapon_level      = excluded.weapon_level,
            big_run_level     = COALESCE(excluded.big_run_level, weapon_records.big_run_level),
            win_count_total   = excluded.win_count_total,
            paint_point_total = excluded.paint_point_total,
            weapon_power      = COALESCE(excluded.weapon_power, weapon_records.weapon_power),
            weapon_power_max  = COALESCE(excluded.weapon_power_max, weapon_records.weapon_power_max),
            last_fetched_at   = excluded.last_fetched_at",
    )
    .bind(weapon_id)
    .bind(weapon_level)
    .bind(big_run_level)
    .bind(win_count_total)
    .bind(paint_point_total)
    .bind(weapon_power)
    .bind(weapon_power_max)
    .bind(now_ts)
    .execute(pool.as_ref())
    .await
    .map_err(|e| format!("weapon_records upsert 失敗 ({weapon_id}): {e}"))?;
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
/// 適用済みマイグレーションの最新版。**新しい `if current_version < N` ブロックを足したら
/// 必ずここを N に更新する。** 更新を忘れると `migrate_battle_ids` 冒頭の早期 return に
/// 阻まれ、追加したマイグレーションが一度も実行されない（#206・#306 の再発防止）。
const LATEST_MIGRATION_VERSION: i64 = 21;

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
/// version 12: WeaponRecordQuery 用 weapon_records テーブル追加 (#49) — 武器熟練度・勝利数・塗りポイント
/// version 13: stat.ink import (#174) の重複排除用に battle.uuid を backfill
/// version 14: フェスマッチ(ナワバリ)の lobby_id を raw_json から救済 (#180)
/// version 15: weapon / map に statink_key カラム追加 (#184)
/// version 16: env_battles テーブル新設（stat.ink 公開バトルデータ）(#184)
/// version 17: インポート済みバトルに statink_uuid を補填（再送防止）(#200 / #204)
/// version 18: フェス(チャレンジ)の lobby を raw_json から振り直し (#293)
/// version 19: is_knockout を三値に修復（KO負けから時間切れ決着を除外）(#315)
/// version 20: weapon の category/sub/special 空欄を同梱の静的マスターで backfill (#492)
/// version 21: env_battles に A2–A4 / B2–B4 の kill/death/assist/inked 列を追加 (#501)
///
/// ⚠ **マイグレーションを追加したら `LATEST_MIGRATION_VERSION` も必ず上げること。**
///    ここが古いままだと早期 return に阻まれて新しい版が一度も走らない（#206 / #306 で 2 度踏んだ）。
pub async fn migrate_battle_ids(pool: &DbPool) -> Result<usize, String> {
    let ver_row = sqlx::query("PRAGMA user_version")
        .fetch_one(pool.as_ref())
        .await
        .map_err(|e| e.to_string())?;
    let current_version: i64 = ver_row.get(0);

    if current_version >= LATEST_MIGRATION_VERSION {
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

    if current_version < 12 {
        // WeaponRecordQuery 用テーブル (#49)。
        // weapon_id は weapons.name と一致させる（旧 weapons の PK が name のため、
        // db_list_weapons の LEFT JOIN がそのまま使える）。
        // bigRunLevel / weaponPower / weaponPowerMax は WeaponRecordQuery 自体には含まれない
        // 想定外フィールドだが、将来の別クエリで埋める可能性に備えてカラムだけ用意しておく。
        sqlx::query(
            "CREATE TABLE IF NOT EXISTS weapon_records (
                weapon_id          TEXT    PRIMARY KEY,
                weapon_level       INTEGER NOT NULL DEFAULT 0,
                big_run_level      INTEGER,
                win_count_total    INTEGER NOT NULL DEFAULT 0,
                paint_point_total  INTEGER NOT NULL DEFAULT 0,
                weapon_power       REAL,
                weapon_power_max   REAL,
                last_fetched_at    INTEGER
            )",
        )
        .execute(pool.as_ref())
        .await
        .map_err(|e| format!("v12 weapon_records 作成失敗: {e}"))?;

        sqlx::query("PRAGMA user_version = 12")
            .execute(pool.as_ref())
            .await
            .map_err(|e| e.to_string())?;

        log::info!("migrate v12: weapon_records テーブルを追加");
    }

    // version 13: stat.ink からのインポート (#174) の重複排除に使うため、
    //             既存バトル全件の battle.uuid を SplatNet の id から再計算して backfill する。
    //             chartoon / s3s と同じ UUID v5 名前空間で計算するので、stat.ink 側の
    //             uuid (= client_uuid) と一致し、SplatNet 直取得済みのバトルを
    //             stat.ink import 時に重複として検出・スキップできる。
    if current_version < 13 {
        let rows = sqlx::query("SELECT id FROM battle WHERE uuid IS NULL")
            .fetch_all(pool.as_ref())
            .await
            .map_err(|e| e.to_string())?;
        let mut filled = 0usize;
        for row in &rows {
            let id: String = row.get("id");
            // インポート由来のバトル (id がそのまま UUID) は対象外。SplatNet base64 id のみ計算。
            let uuid = crate::statink::battle_uuid(&id);
            // battle_uuid は base64 デコードできない id をそのまま返すので、変化が無ければスキップ。
            if uuid == id {
                continue;
            }
            sqlx::query("UPDATE battle SET uuid = ? WHERE id = ? AND uuid IS NULL")
                .bind(&uuid)
                .bind(&id)
                .execute(pool.as_ref())
                .await
                .map_err(|e| e.to_string())?;
            filled += 1;
        }

        sqlx::query("PRAGMA user_version = 13")
            .execute(pool.as_ref())
            .await
            .map_err(|e| e.to_string())?;

        log::info!("migrate v13: battle.uuid を backfill ({} 件)", filled);
    }

    // version 14: フェスマッチ(ナワバリ)の救済 (#180)。
    //             vsMode=FEST の FEST 分岐が無かったため mode='fest' で保存され
    //             lobby_id が割り当てられず（あるいは誤った値で）集計から外れていた。
    //             旧 `battles` 由来の救済（v5 系）とは別に、新スキーマ `battle` 側の
    //             lobby_id を raw_json の festMatch.mode から正しい lobby に振り直す。
    //               festMatch.mode: CHALLENGE -> splatfest_challenge(7)
    //                               REGULAR/空/未知 -> splatfest_open(6)
    //               TRI_COLOR は LOBBY_SEED 未対応のため対象外（集計外のまま）。
    if current_version < 14 {
        // 対象: vsMode=FEST だが lobby が splatfest 系でないバトル。
        // raw_json から vsMode/mode を見て FEST のものだけ拾う（誤判定済みのもの）。
        let rows = sqlx::query(
            "SELECT b.id, b.raw_json
             FROM battle b
             JOIN lobby l ON l.id = b.lobby_id
             WHERE b.raw_json IS NOT NULL
               AND l.key NOT LIKE 'splatfest%'"
        )
        .fetch_all(pool.as_ref())
        .await
        .map_err(|e| e.to_string())?;

        let mut fixed = 0usize;
        for row in &rows {
            let id: String = row.get("id");
            let raw_json: String = row.get("raw_json");

            let Ok(json) = serde_json::from_str::<serde_json::Value>(&raw_json) else { continue };

            // 詳細クエリの vsMode/mode が FEST のものだけが対象
            let vsmode = json.pointer("/vsMode/mode").and_then(|v| v.as_str()).unwrap_or("");
            if vsmode != "FEST" {
                continue;
            }

            let fm = json.pointer("/festMatch/mode").and_then(|v| v.as_str()).unwrap_or("");
            let new_key = match fm {
                "CHALLENGE" => "splatfest_challenge",
                // TRI_COLOR は LOBBY_SEED 未対応。集計外のままにするため救済しない。
                "TRI_COLOR" => continue,
                _ => "splatfest_open", // REGULAR / 空 / 未知は open にフォールバック
            };
            let Some(lobby_id) = old_mode_to_lobby_id(new_key) else { continue };

            sqlx::query("UPDATE battle SET lobby_id = ? WHERE id = ?")
                .bind(lobby_id)
                .bind(&id)
                .execute(pool.as_ref())
                .await
                .map_err(|e| e.to_string())?;
            fixed += 1;
        }

        sqlx::query("PRAGMA user_version = 14")
            .execute(pool.as_ref())
            .await
            .map_err(|e| e.to_string())?;

        log::info!("migrate v14: フェスマッチの lobby_id を救済 ({} 件)", fixed);
    }

    // version 15: weapon / map に statink_key カラムを追加し、
    //             インポート時に stat.ink スラッグ → weapon.id / map.id 解決を可能にする。
    if current_version < 15 {
        for sql in [
            "ALTER TABLE weapon ADD COLUMN statink_key TEXT",
            "ALTER TABLE map    ADD COLUMN statink_key TEXT",
            "CREATE UNIQUE INDEX IF NOT EXISTS weapon_statink_key ON weapon(statink_key) WHERE statink_key IS NOT NULL",
            "CREATE UNIQUE INDEX IF NOT EXISTS map_statink_key    ON map(statink_key)    WHERE statink_key IS NOT NULL",
        ] {
            // ALTER TABLE が既に適用済みなら失敗を無視する（冪等性）。
            let _ = sqlx::query(sql).execute(pool.as_ref()).await;
        }
        sqlx::query("PRAGMA user_version = 15")
            .execute(pool.as_ref())
            .await
            .map_err(|e| e.to_string())?;
        log::info!("migrate v15: weapon/map に statink_key 追加");
    }

    // version 16: env_battles テーブル新設（stat.ink 公開バトルデータ集計用）。
    if current_version < 16 {
        let env_ddl = r#"
            CREATE TABLE IF NOT EXISTS env_battles (
                id            INTEGER PRIMARY KEY AUTOINCREMENT,
                source_date   TEXT    NOT NULL,
                lobby_id      INTEGER REFERENCES lobby(id),
                rule_id       INTEGER REFERENCES rule(id),
                map_id        INTEGER REFERENCES map(id),
                period        TEXT    NOT NULL,
                season        TEXT,
                game_ver      TEXT,
                win_team      TEXT    NOT NULL,
                knockout      INTEGER,
                alpha_inked       INTEGER,
                alpha_ink_percent REAL,
                alpha_count       INTEGER,
                bravo_inked       INTEGER,
                bravo_ink_percent REAL,
                bravo_count       INTEGER,
                poster_rank   TEXT,
                poster_power  REAL,
                a1_weapon_id INTEGER REFERENCES weapon(id),
                a2_weapon_id INTEGER REFERENCES weapon(id),
                a3_weapon_id INTEGER REFERENCES weapon(id),
                a4_weapon_id INTEGER REFERENCES weapon(id),
                b1_weapon_id INTEGER REFERENCES weapon(id),
                b2_weapon_id INTEGER REFERENCES weapon(id),
                b3_weapon_id INTEGER REFERENCES weapon(id),
                b4_weapon_id INTEGER REFERENCES weapon(id),
                a1_kill INTEGER, a1_death INTEGER, a1_assist INTEGER, a1_inked INTEGER,
                b1_kill INTEGER, b1_death INTEGER, b1_assist INTEGER, b1_inked INTEGER
            );
            CREATE INDEX IF NOT EXISTS idx_env_date_rule  ON env_battles(source_date, rule_id);
            CREATE INDEX IF NOT EXISTS idx_env_date_map   ON env_battles(source_date, map_id);
            CREATE INDEX IF NOT EXISTS idx_env_date_lobby ON env_battles(source_date, lobby_id);
            CREATE INDEX IF NOT EXISTS idx_env_a1_weapon  ON env_battles(a1_weapon_id);
            CREATE INDEX IF NOT EXISTS idx_env_b1_weapon  ON env_battles(b1_weapon_id);
        "#;
        sqlx::query(env_ddl)
            .execute(pool.as_ref())
            .await
            .map_err(|e| e.to_string())?;
        sqlx::query("PRAGMA user_version = 16")
            .execute(pool.as_ref())
            .await
            .map_err(|e| e.to_string())?;
        log::info!("migrate v16: env_battles テーブル新設");
    }

    // version 17: インポート済みバトル（uuid に stat.ink の UUID を持つ）に statink_uuid を補填し、
    // 「アップロード済み」扱いにして自動アップロードでの再送・重複を防ぐ（#200 / #204 の遡及修正）。
    // 正規の SplatNet 由来バトルは uuid が NULL（shadow_write_battle は uuid を入れない）ため影響しない。
    if current_version < 17 {
        let res = sqlx::query(
            "UPDATE battle SET statink_uuid = uuid
             WHERE statink_uuid IS NULL AND uuid IS NOT NULL AND uuid <> ''",
        )
        .execute(pool.as_ref())
        .await
        .map_err(|e| e.to_string())?;
        sqlx::query("PRAGMA user_version = 17")
            .execute(pool.as_ref())
            .await
            .map_err(|e| e.to_string())?;
        log::info!(
            "migrate v17: インポート済みバトル {} 件に statink_uuid を補填（再送防止）",
            res.rows_affected()
        );
    }

    // version 18: フェス(チャレンジ)の誤分類を修正 (#293 / #306)。
    //             v14 は存在しない festMatch.mode を見ていたため、フェス(チャレンジ)を
    //             含む全フェス戦が splatfest_open に倒れていた。raw_json から振り直す。
    //
    //             判定は splatnet3.rs の FEST 分岐と同一:
    //               festMatch.myFestPower が非 null（フェスパワーはチャレンジにしか付かない）
    //               または vsMode.id == VsMode-7 → splatfest_challenge(7)
    //               それ以外（VsMode-6=オープン / VsMode-8=トリカラ）→ splatfest_open(6)
    //             トリカラはオープン扱いのまま（バトルリストは vsRule=TRI_COLOR で除外）。
    if current_version < 18 {
        let rows = sqlx::query(
            "SELECT b.id, b.raw_json
             FROM battle b
             JOIN lobby l ON l.id = b.lobby_id
             WHERE b.raw_json IS NOT NULL
               AND l.key LIKE 'splatfest%'"
        )
        .fetch_all(pool.as_ref())
        .await
        .map_err(|e| e.to_string())?;

        let mut fixed = 0usize;
        for row in &rows {
            let id: String = row.get("id");
            let raw_json: String = row.get("raw_json");
            let Ok(json) = serde_json::from_str::<serde_json::Value>(&raw_json) else { continue };

            let vsmode_id = json.pointer("/vsMode/id").and_then(|v| v.as_str()).unwrap_or("");
            let has_fest_power = json
                .pointer("/festMatch/myFestPower")
                .map(|v| !v.is_null())
                .unwrap_or(false);
            let new_key = if vsmode_id == "VnNNb2RlLTc=" || has_fest_power {
                "splatfest_challenge"
            } else {
                "splatfest_open"
            };
            let Some(lobby_id) = old_mode_to_lobby_id(new_key) else { continue };

            let res = sqlx::query("UPDATE battle SET lobby_id = ? WHERE id = ? AND lobby_id <> ?")
                .bind(lobby_id)
                .bind(&id)
                .bind(lobby_id)
                .execute(pool.as_ref())
                .await
                .map_err(|e| e.to_string())?;
            fixed += res.rows_affected() as usize;
        }

        sqlx::query("PRAGMA user_version = 18")
            .execute(pool.as_ref())
            .await
            .map_err(|e| e.to_string())?;
        log::info!("migrate v18: フェス(チャレンジ)の lobby を vsMode.id で振り直し ({} 件補正)", fixed);
    }

    // version 19: is_knockout の三値を修復 (#315)。
    //             以前の変換 `if k == "WIN" { 1 } else { 0 }` は "NEITHER"（ノックアウト無し）
    //             まで 0 に潰していたため、`SUM(is_knockout = 0) as knockout_lose` に
    //             時間切れ決着のバトルが全部混ざり、KO 負けが約 3.5 倍に膨らんでいた。
    //             生値は battle.knockout に残っているので SQL だけで振り直せる。
    if current_version < 19 {
        let res = sqlx::query(
            "UPDATE battle
                SET is_knockout = CASE knockout
                                    WHEN 'WIN'  THEN 1
                                    WHEN 'LOSE' THEN 0
                                    ELSE NULL
                                  END
              WHERE is_knockout IS NOT (CASE knockout
                                          WHEN 'WIN'  THEN 1
                                          WHEN 'LOSE' THEN 0
                                          ELSE NULL
                                        END)",
        )
        .execute(pool.as_ref())
        .await
        .map_err(|e| e.to_string())?;

        sqlx::query("PRAGMA user_version = 19")
            .execute(pool.as_ref())
            .await
            .map_err(|e| e.to_string())?;
        log::info!(
            "migrate v19: is_knockout を三値に修復（KO負けから時間切れを除外・{} 件補正）",
            res.rows_affected()
        );
    }

    if current_version < 20 {
        // 武器のカテゴリ / サブ / スペシャルが空欄の行を、同梱の静的マスターで埋める（#492）。
        // stat.ink 由来（環境分析 CSV）でしか登場しない武器は属性が空のまま
        // 「(未分類)」「(不明)」に落ちていた。statink_key または key（slug）で照合し、
        // SplatNet 由来の既存値は温存する（空欄のみ埋める）。
        let mut filled = 0u64;
        for (slug, cat, sub, sp) in crate::weapon_static::WEAPON_STATIC_ATTRS {
            let res = sqlx::query(
                "UPDATE weapon
                    SET category_key = COALESCE(NULLIF(category_key, ''), ?),
                        sub_key      = COALESCE(NULLIF(sub_key, ''),      ?),
                        special_key  = COALESCE(NULLIF(special_key, ''),  ?)
                  WHERE (statink_key = ? OR key = ?)
                    AND (category_key IS NULL OR category_key = ''
                         OR sub_key     IS NULL OR sub_key     = ''
                         OR special_key IS NULL OR special_key = '')",
            )
            .bind(cat)
            .bind(sub)
            .bind(sp)
            .bind(slug)
            .bind(slug)
            .execute(pool.as_ref())
            .await
            .map_err(|e| e.to_string())?;
            filled += res.rows_affected();
        }

        sqlx::query("PRAGMA user_version = 20")
            .execute(pool.as_ref())
            .await
            .map_err(|e| e.to_string())?;
        log::info!("migrate v20: 武器属性の空欄を静的マスターで backfill（{filled} 件）");
    }

    // version 21: env_battles に A2–A4 / B2–B4 の kill/death/assist/inked 列を追加（#501）。
    // stat.ink CSV は元々 8 人全員の記録を持っているが、取り込みは A1/B1 だけだった。
    // 既存行は NULL のまま（集計は非 NULL 件数を母数にする）。全期間再取得で埋まる。
    if current_version < 21 {
        let existing: std::collections::HashSet<String> =
            sqlx::query("PRAGMA table_info(env_battles)")
                .fetch_all(pool.as_ref())
                .await
                .map_err(|e| e.to_string())?
                .into_iter()
                .map(|r| r.get::<String, _>("name"))
                .collect();
        for slot in ["a2", "a3", "a4", "b2", "b3", "b4"] {
            for metric in ["kill", "death", "assist", "inked"] {
                let col = format!("{slot}_{metric}");
                if existing.contains(&col) {
                    continue;
                }
                sqlx::query(&format!("ALTER TABLE env_battles ADD COLUMN {col} INTEGER"))
                    .execute(pool.as_ref())
                    .await
                    .map_err(|e| e.to_string())?;
            }
        }

        sqlx::query("PRAGMA user_version = 21")
            .execute(pool.as_ref())
            .await
            .map_err(|e| e.to_string())?;
        log::info!("migrate v21: env_battles に A2–A4 / B2–B4 の KDA 列を追加");
    }

    Ok(updated)
}

// ---------------------------------------------------------------------------
// 環境分析（#184）
// ---------------------------------------------------------------------------

/// env_battles テーブルの取得状況サマリ。
#[derive(Debug, Serialize)]
pub struct EnvStatus {
    pub min_date:   Option<String>,
    pub max_date:   Option<String>,
    pub total_rows: i64,
    /// 取り込み済みデータが 7 人分の KDA を持っているか（#501）。
    /// v0.9.7 より前に取り込んだ行は A1/B1 の KDA しか持たない。
    pub full_kda:   bool,
}

/// env_battles の min/max 日付と総行数を返す。
#[tauri::command]
pub async fn env_status(db: tauri::State<'_, DbPool>) -> Result<EnvStatus, String> {
    let row = sqlx::query(
        "SELECT MIN(source_date) AS min_d, MAX(source_date) AS max_d, COUNT(*) AS cnt FROM env_battles",
    )
    .fetch_one(db.as_ref())
    .await
    .map_err(|e| e.to_string())?;

    // 7 人分の KDA が揃っているかは「最初に入った行」で判定する（#501）。
    // 取り込みは追記なので、最古の行が A2 の KDA を持っていれば全期間が新形式。
    // 全行を数えると数千万行のフルスキャンになるため、rowid 先頭 1 行だけを見る。
    let full_kda = sqlx::query("SELECT a2_kill IS NOT NULL AS ok FROM env_battles ORDER BY id LIMIT 1")
        .fetch_optional(db.as_ref())
        .await
        .map_err(|e| e.to_string())?
        .map(|r| r.get::<i64, _>("ok") != 0)
        .unwrap_or(true); // 未取得なら「これから入るデータは新形式」なので案内しない

    Ok(EnvStatus {
        min_date:   row.try_get::<Option<String>, _>("min_d").ok().flatten(),
        max_date:   row.try_get::<Option<String>, _>("max_d").ok().flatten(),
        total_rows: row.get::<i64, _>("cnt"),
        full_kda,
    })
}

// ---------------------------------------------------------------------------
// 環境分析 拡張（#187）: 散布図 / ヒートマップ
// ---------------------------------------------------------------------------

/// env_battles の共通フィルタ条件をひとまとめにした構造体（#189 で拡張・#477 で武器/ステージ複数）。
///
/// 期間・ロビー・ルール・ステージ・武器に加え、ゲームバージョン（複数）・
/// ウデマエ帯（複数）・Xパワー範囲を AND で絞り込む。
/// `game_vers` / `poster_ranks` / `weapon_keys` / `stage_keys` は空なら絞り込まない。
#[derive(Default)]
pub struct EnvFilters {
    pub lobby_keys:   Vec<String>,
    pub rule_keys:    Vec<String>,
    pub stage_keys:   Vec<String>,
    pub weapon_keys:  Vec<String>,
    pub since:        Option<String>,
    pub until:        Option<String>,
    pub game_vers:    Vec<String>,
    pub poster_ranks: Vec<String>,
    pub power_min:    Option<f64>,
    pub power_max:    Option<f64>,
}

/// env_battles の共通フィルタ句を組み立てる。
///
/// 返すのは `WHERE ...` 文字列（フィルタ無しなら空文字）。バインドは
/// `bind_env_filters` を WHERE が登場する回数だけ呼んで行う（順序を厳守）。
fn build_env_where(f: &EnvFilters) -> String {
    let mut wp: Vec<String> = Vec::new();
    if !f.lobby_keys.is_empty() {
        let ph = vec!["?"; f.lobby_keys.len()].join(",");
        wp.push(format!("EXISTS (SELECT 1 FROM lobby lk WHERE lk.id = eb.lobby_id AND lk.key IN ({ph}))"));
    }
    if !f.rule_keys.is_empty() {
        let ph = vec!["?"; f.rule_keys.len()].join(",");
        wp.push(format!("EXISTS (SELECT 1 FROM rule rk WHERE rk.id = eb.rule_id AND rk.key IN ({ph}))"));
    }
    if !f.stage_keys.is_empty() {
        let ph = vec!["?"; f.stage_keys.len()].join(",");
        wp.push(format!("EXISTS (SELECT 1 FROM map mk WHERE mk.id = eb.map_id AND mk.key IN ({ph}))"));
    }
    if !f.weapon_keys.is_empty() {
        // いずれかのスロットに選んだ武器が乗っているバトルに絞る（#477）。
        // 投稿者（a1）は集計対象外なので絞り込みからも外す。含めてしまうと
        // 「投稿者しか使っていないバトル」がバトル数には乗るのに勝率・KDA には
        // 寄与せず、母数が食い違う（#501）。
        let ph = vec!["?"; f.weapon_keys.len()].join(",");
        wp.push(format!(
            "EXISTS (\
               SELECT 1 FROM weapon wk \
               WHERE wk.key IN ({ph}) \
                 AND wk.id IN (\
                   eb.a2_weapon_id, eb.a3_weapon_id, eb.a4_weapon_id, \
                   eb.b1_weapon_id, eb.b2_weapon_id, eb.b3_weapon_id, eb.b4_weapon_id\
                 )\
             )"
        ));
    }
    if f.since.is_some()     { wp.push("eb.source_date >= ?".into()); }
    if f.until.is_some()     { wp.push("eb.source_date <= ?".into()); }
    if !f.game_vers.is_empty() {
        let ph = vec!["?"; f.game_vers.len()].join(",");
        wp.push(format!("eb.game_ver IN ({ph})"));
    }
    if !f.poster_ranks.is_empty() {
        let ph = vec!["?"; f.poster_ranks.len()].join(",");
        wp.push(format!("eb.poster_rank IN ({ph})"));
    }
    if f.power_min.is_some() { wp.push("eb.poster_power >= ?".into()); }
    if f.power_max.is_some() { wp.push("eb.poster_power <= ?".into()); }
    if wp.is_empty() { String::new() } else { format!("WHERE {}", wp.join(" AND ")) }
}

/// `build_env_where` と対になる、1 回分のフィルタ値バインド。
/// `build_env_where` がプレースホルダを並べた順序と完全に一致させること。
fn bind_env_filters<'q>(
    mut q: sqlx::query::Query<'q, Sqlite, sqlx::sqlite::SqliteArguments<'q>>,
    f: &'q EnvFilters,
) -> sqlx::query::Query<'q, Sqlite, sqlx::sqlite::SqliteArguments<'q>> {
    for v in &f.lobby_keys   { q = q.bind(v); }
    for v in &f.rule_keys    { q = q.bind(v); }
    for v in &f.stage_keys   { q = q.bind(v); }
    for v in &f.weapon_keys  { q = q.bind(v); }
    if let Some(v) = &f.since     { q = q.bind(v); }
    if let Some(v) = &f.until     { q = q.bind(v); }
    for v in &f.game_vers    { q = q.bind(v); }
    for v in &f.poster_ranks { q = q.bind(v); }
    if let Some(v) = f.power_min { q = q.bind(v); }
    if let Some(v) = f.power_max { q = q.bind(v); }
    q
}

/// 散布図 1 点分。集計単位（武器 or ステージ）ごとに各指標を一括で返す。
/// 指標は集計軸によって埋まるものが異なり、該当しないものは null。
#[derive(Debug, Serialize)]
pub struct EnvScatterStat {
    pub key:        String,      // 武器キー or ステージキー
    /// アイコン画像を引くための正式名（= ローカルマスターの `name_ja`・#412）。
    ///
    /// 画像キャッシュは SplatNet3 の**表示名**をキーにして保存されている（`images::read_image`）ため、
    /// `key`（武器は `weapon.key`・stat.ink 由来だと英字スラッグのことがある）では当たらない。
    /// env_battles は `statink_key` 経由でローカルマスター行に解決済みなので、その行の
    /// `name_ja` をそのまま返す。ローカルマスターに無い武器は `name_ja` もスラッグのままで、
    /// 画像が見つからない（FE 側でアイコンなし・名前だけにフォールバックする）。
    pub icon_name:  Option<String>,
    pub n:          i64,         // サンプルサイズ（武器=ピック数 / ステージ=バトル数）
    // 武器集計の指標
    pub pick_rate:  Option<f64>,
    pub win_rate:   Option<f64>,
    pub avg_kill:   Option<f64>, // 記録のあるスロットのみ母数
    pub avg_death:  Option<f64>,
    pub avg_assist: Option<f64>,
    pub avg_inked:  Option<f64>,
    // ステージ集計の指標
    pub ko_rate:      Option<f64>,
    pub avg_ink_self: Option<f64>,
    pub avg_ink_opp:  Option<f64>,
    pub avg_count:    Option<f64>,
    // 武器集計のみ（#480）。カテゴリ色分け用。
    pub category_key: Option<String>,
    pub sub_key:      Option<String>,
    pub special_key:  Option<String>,
}

/// 武器スロット 1 個の集計用定義。
struct ScatterSlot {
    wid:  &'static str, // weapon_id カラム
    k:    &'static str, // kill カラム or "NULL"
    d:    &'static str,
    a:    &'static str,
    ink:  &'static str,
    team: &'static str, // "alpha" | "bravo"
}

/// 投稿者（A1）を除いた投稿者チーム側の 3 スロット。
///
/// stat.ink の全体統計は投稿者を母数から外している（自分のバトルだけを上げる人が多く、
/// 投稿者の武器と勝敗に偏りが出るため）。splabo もそれに倣う（#501）。
const SELF_SLOTS: &[ScatterSlot] = &[
    ScatterSlot { wid: "a2_weapon_id", k: "a2_kill", d: "a2_death", a: "a2_assist", ink: "a2_inked", team: "alpha" },
    ScatterSlot { wid: "a3_weapon_id", k: "a3_kill", d: "a3_death", a: "a3_assist", ink: "a3_inked", team: "alpha" },
    ScatterSlot { wid: "a4_weapon_id", k: "a4_kill", d: "a4_death", a: "a4_assist", ink: "a4_inked", team: "alpha" },
];
const OPP_SLOTS: &[ScatterSlot] = &[
    ScatterSlot { wid: "b1_weapon_id", k: "b1_kill", d: "b1_death", a: "b1_assist", ink: "b1_inked", team: "bravo" },
    ScatterSlot { wid: "b2_weapon_id", k: "b2_kill", d: "b2_death", a: "b2_assist", ink: "b2_inked", team: "bravo" },
    ScatterSlot { wid: "b3_weapon_id", k: "b3_kill", d: "b3_death", a: "b3_assist", ink: "b3_inked", team: "bravo" },
    ScatterSlot { wid: "b4_weapon_id", k: "b4_kill", d: "b4_death", a: "b4_assist", ink: "b4_inked", team: "bravo" },
];
/// 環境データの散布図用集計。
///
/// - `group_by` = "weapon": 武器ごとに pick_rate / win_rate / KDA を集計
///   （投稿者を除く 7 スロットの UNION ALL）
/// - `group_by` = "stage" : ステージごとに ko_rate / 平均塗り割合 / 平均人数 を集計
/// - `side` = "all" | "self"(alpha) | "opp"(bravo) … 武器集計でのスロット選択。
///   "self" は投稿者を除いた味方 3 人。
#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn env_scatter_stats(
    db:           tauri::State<'_, DbPool>,
    group_by:     String,
    side:         Option<String>,
    lobby_keys:   Option<Vec<String>>,
    rule_keys:    Option<Vec<String>>,
    stage_keys:   Option<Vec<String>>,
    weapon_keys:  Option<Vec<String>>,
    since:        Option<String>,
    until:        Option<String>,
    game_vers:    Option<Vec<String>>,
    poster_ranks: Option<Vec<String>>,
    power_min:    Option<f64>,
    power_max:    Option<f64>,
) -> Result<Vec<EnvScatterStat>, String> {
    let f = EnvFilters {
        lobby_keys:   lobby_keys.unwrap_or_default(),
        rule_keys:    rule_keys.unwrap_or_default(),
        stage_keys:   stage_keys.unwrap_or_default(),
        weapon_keys:  weapon_keys.unwrap_or_default(),
        since, until,
        game_vers:    game_vers.unwrap_or_default(),
        poster_ranks: poster_ranks.unwrap_or_default(),
        power_min, power_max,
    };
    let where_clause = build_env_where(&f);

    if group_by == "stage" {
        // ステージ固有指標（バトル単位）。KO率は出さない（#478）。
        // 勝率・KDA は武器絞り込み時だけスロット展開で算出（未選択だと両チーム平均で約50%になり無意味）。
        let battle_sql = format!(
            r#"
            SELECT eb.map_id AS mid,
                   COALESCE(m.name_ja, m.key) AS key,
                   m.name_ja AS icon_name,
                   COUNT(*) AS n,
                   AVG(eb.alpha_ink_percent) AS avg_ink_self,
                   AVG(eb.bravo_ink_percent) AS avg_ink_opp,
                   AVG((COALESCE(eb.alpha_count,0) + COALESCE(eb.bravo_count,0)) / 2.0) AS avg_count
            FROM env_battles eb
            JOIN map m ON m.id = eb.map_id
            {where}
            GROUP BY eb.map_id
            HAVING n >= 50
            ORDER BY n DESC
            "#,
            where = where_clause,
        );
        let q = bind_env_filters(sqlx::query(&battle_sql), &f);
        let rows = q.fetch_all(db.as_ref()).await.map_err(|e| e.to_string())?;

        // map_id → 勝率/KDA（武器フィルタがあるときだけ埋める）
        let mut weapon_stats: std::collections::HashMap<i64, (Option<f64>, Option<f64>, Option<f64>, Option<f64>, Option<f64>)> =
            std::collections::HashMap::new();
        if !f.weapon_keys.is_empty() {
            // 選んだ武器が乗っているスロットだけ展開（投稿者 A1 は除外・#501）。
            let wph = vec!["?"; f.weapon_keys.len()].join(",");
            let slots: Vec<&ScatterSlot> = SELF_SLOTS.iter().chain(OPP_SLOTS.iter()).collect();
            let slot_sqls: Vec<String> = slots
                .iter()
                .map(|s| {
                    format!(
                        "SELECT eb.map_id AS mid, \
                                CASE WHEN eb.win_team = '{team}' THEN 1.0 ELSE 0.0 END AS won, \
                                {k} AS k, {d} AS d, {a} AS a, {ink} AS ink \
                         FROM env_battles eb \
                         JOIN weapon wk ON wk.id = eb.{wid} AND wk.key IN ({wph}) \
                         {where}",
                        team = s.team, k = s.k, d = s.d, a = s.a, ink = s.ink, wid = s.wid,
                        wph = wph, where = where_clause,
                    )
                })
                .collect();
            let sql = format!(
                r#"
                WITH app AS (
                    {app}
                )
                SELECT mid,
                       AVG(won) AS win_rate,
                       AVG(k)   AS avg_kill,
                       AVG(d)   AS avg_death,
                       AVG(a)   AS avg_assist,
                       AVG(ink) AS avg_inked
                FROM app
                GROUP BY mid
                "#,
                app = slot_sqls.join("\n                UNION ALL\n                "),
            );
            // 各スロット: weapon_keys バインド + EnvFilters バインド
            let mut q = sqlx::query(&sql);
            for _ in 0..slots.len() {
                for v in &f.weapon_keys { q = q.bind(v); }
                q = bind_env_filters(q, &f);
            }
            let wrows = q.fetch_all(db.as_ref()).await.map_err(|e| e.to_string())?;
            for row in wrows {
                let mid: i64 = row.get("mid");
                weapon_stats.insert(
                    mid,
                    (
                        row.try_get::<Option<f64>, _>("win_rate").unwrap_or(None),
                        row.try_get::<Option<f64>, _>("avg_kill").unwrap_or(None),
                        row.try_get::<Option<f64>, _>("avg_death").unwrap_or(None),
                        row.try_get::<Option<f64>, _>("avg_assist").unwrap_or(None),
                        row.try_get::<Option<f64>, _>("avg_inked").unwrap_or(None),
                    ),
                );
            }
        }

        let mut result = Vec::new();
        for row in rows {
            let mid: i64 = row.get("mid");
            let (win_rate, avg_kill, avg_death, avg_assist, avg_inked) =
                weapon_stats.get(&mid).copied().unwrap_or((None, None, None, None, None));
            result.push(EnvScatterStat {
                key:          row.get("key"),
                icon_name:    row.try_get::<Option<String>, _>("icon_name").unwrap_or(None),
                n:            row.get("n"),
                pick_rate:    None,
                win_rate,
                avg_kill,
                avg_death,
                avg_assist,
                avg_inked,
                ko_rate:      None,
                avg_ink_self: row.try_get::<Option<f64>, _>("avg_ink_self").unwrap_or(None),
                avg_ink_opp:  row.try_get::<Option<f64>, _>("avg_ink_opp").unwrap_or(None),
                avg_count:    row.try_get::<Option<f64>, _>("avg_count").unwrap_or(None),
                category_key: None,
                sub_key:      None,
                special_key:  None,
            });
        }
        return Ok(result);
    }

    // group_by == "weapon"（デフォルト）
    let slots: Vec<&ScatterSlot> = match side.as_deref() {
        Some("self") => SELF_SLOTS.iter().collect(),
        Some("opp")  => OPP_SLOTS.iter().collect(),
        _            => SELF_SLOTS.iter().chain(OPP_SLOTS.iter()).collect(),
    };
    let slots_len = slots.len() as f64;

    let selects: Vec<String> = slots.iter().map(|s| format!(
        "SELECT {wid} AS wid, CASE WHEN win_team = '{team}' THEN 1 ELSE 0 END AS won, \
         {k} AS k, {d} AS d, {a} AS a, {ink} AS ink FROM env_battles eb {where}",
        wid = s.wid, team = s.team, k = s.k, d = s.d, a = s.a, ink = s.ink, where = where_clause,
    )).collect();
    let app = selects.join("\n            UNION ALL ");

    let sql = format!(
        r#"
        WITH app AS (
            {app}
        ),
        tb AS (SELECT COUNT(*) AS c FROM env_battles eb {where})
        SELECT w.key      AS key,
               w.name_ja  AS icon_name,
               w.category_key AS category_key,
               w.sub_key      AS sub_key,
               w.special_key  AS special_key,
               COUNT(*)   AS n,
               tb.c       AS total_battles,
               AVG(app.won) AS win_rate,
               AVG(app.k)   AS avg_kill,
               AVG(app.d)   AS avg_death,
               AVG(app.a)   AS avg_assist,
               AVG(app.ink) AS avg_inked
        FROM app
        JOIN weapon w ON w.id = app.wid
        CROSS JOIN tb
        WHERE app.wid IS NOT NULL
        GROUP BY app.wid
        HAVING n >= 50
        ORDER BY n DESC
        "#,
        app = app, where = where_clause,
    );

    // バインド: UNION ALL の各 SELECT（slots.len() 回）+ tb（1 回）。
    let mut q = sqlx::query(&sql);
    for _ in 0..(slots.len() + 1) {
        q = bind_env_filters(q, &f);
    }
    let rows = q.fetch_all(db.as_ref()).await.map_err(|e| e.to_string())?;

    let mut result = Vec::new();
    for row in rows {
        let n: i64 = row.get("n");
        let total_battles: i64 = row.get("total_battles");
        let pick_rate = if total_battles > 0 {
            Some(n as f64 / (total_battles as f64 * slots_len))
        } else {
            Some(0.0)
        };
        result.push(EnvScatterStat {
            key:          row.get("key"),
            icon_name:    row.try_get::<Option<String>, _>("icon_name").unwrap_or(None),
            n,
            pick_rate,
            win_rate:     row.try_get::<Option<f64>, _>("win_rate").unwrap_or(None),
            avg_kill:     row.try_get::<Option<f64>, _>("avg_kill").unwrap_or(None),
            avg_death:    row.try_get::<Option<f64>, _>("avg_death").unwrap_or(None),
            avg_assist:   row.try_get::<Option<f64>, _>("avg_assist").unwrap_or(None),
            avg_inked:    row.try_get::<Option<f64>, _>("avg_inked").unwrap_or(None),
            ko_rate:      None,
            avg_ink_self: None,
            avg_ink_opp:  None,
            avg_count:    None,
            category_key: row.try_get::<Option<String>, _>("category_key").unwrap_or(None),
            sub_key:      row.try_get::<Option<String>, _>("sub_key").unwrap_or(None),
            special_key:  row.try_get::<Option<String>, _>("special_key").unwrap_or(None),
        });
    }
    Ok(result)
}

/// 環境ヒートマップの 1 セル。
#[derive(Debug, Serialize)]
pub struct EnvMatrixCell {
    pub row_key: String,
    pub col_key: String,
    pub value:   Option<f64>,
    pub n:       i64,
}

/// 行・列の周辺集計（marginals）の 1 キー分（#411）。
///
/// **セルの足切り（サンプル不足のセルを返さない）とは無関係に、全バトルから算出する。**
/// 軸ラベルの色付けはこの値を使う。セルを落としてから束ねると、交差する軸によって
/// 残るセルが変わり「武器×ルールとステージ×ルールで同じルールの値が違う」ことになる。
///
/// - `value` … そのキーの集計値（率・平均は全バトルからの比、バトル数は合計）。算出不能は None。
/// - `n`     … そのキーの合計サンプル数。FE が「標本が少なすぎる軸には色を付けない」判定に使う。
#[derive(Debug, Serialize)]
pub struct EnvMatrixMarginal {
    pub key:   String,
    pub value: Option<f64>,
    pub n:     i64,
}

/// `env_matrix_stats` の返却（#411 で marginals を追加）。
#[derive(Debug, Serialize)]
pub struct EnvMatrixStats {
    /// 表示するセル（従来どおりサンプル不足のセルは含まない）。
    pub cells:         Vec<EnvMatrixCell>,
    pub row_marginals: Vec<EnvMatrixMarginal>,
    pub col_marginals: Vec<EnvMatrixMarginal>,
}

/// セル足切り前の 1 グループ（SQL の GROUP BY 1 行）の生集計（#411）。
/// セル値も周辺集計も、すべてここから同じ式で導く。
#[derive(Debug, Clone, Default, PartialEq)]
struct MatrixRaw {
    /// 投稿者を除く 7 スロット合算の件数（バトルレベル集計では COUNT(*)）。
    n:        i64,
    /// KDA の記録があるスロットの件数（キル系メトリクスの母数）。
    n_kda:    i64,
    sum_won:  f64,
    sum_ko:   f64,
    sum_k:    f64,
    sum_d:    f64,
    sum_a:    f64,
    sum_ink:  f64,
    /// ピック率の分母（そのカテゴリの全バトル数 × 投稿者を除く 7 スロット）。
    pick_den: f64,
}

/// メトリクスの集計形（#411）。
///
/// - `Ratio` … 値 = num/den。周辺集計はキーごとに num・den を足してから割る。
///   これは「セル値をサンプル数で加重平均した値」と同値で、
///   Σ(値ᵢ×nᵢ)/Σnᵢ = Σ(生の分子)/Σ(生の分母) となり **交差する軸に依存しない**。
/// - `Sum`   … 値そのものが件数（バトル数）。加重平均は size-biased で意味を成さないので合計。
#[derive(Debug, Clone, Copy, PartialEq)]
enum Agg {
    Ratio { num: f64, den: f64 },
    Sum(f64),
}

impl Agg {
    /// 表示値。分母が 0（＝母数なし）は算出不能。
    fn value(self) -> Option<f64> {
        match self {
            Agg::Ratio { num, den } => {
                if den > 0.0 { Some(num / den) } else { None }
            }
            Agg::Sum(v) => Some(v),
        }
    }
}

/// メトリクス名 → そのグループの集計（分子・分母）。未知のメトリクスは None。
fn cell_agg(cell_metric: &str, r: &MatrixRaw) -> Option<Agg> {
    let n = r.n as f64;
    // キル系（キル/デス/アシスト/塗り）は記録の無いスロットがある（再取得前のデータは B1 のみ）。
    // 母数はスロット合算ではなく非 NULL 件数（n_kda）。セル側の HAVING と揃える。
    let kda = r.n_kda as f64;
    Some(match cell_metric {
        "win_rate"      => Agg::Ratio { num: r.sum_won, den: n },
        "ko_rate"       => Agg::Ratio { num: r.sum_ko,  den: n },
        // ピック率 = そのカテゴリでの延べ出現数 / そのカテゴリの全スロット数。
        "pick_rate"     => Agg::Ratio { num: n,         den: r.pick_den },
        "avg_kill"      => Agg::Ratio { num: r.sum_k,   den: kda },
        "avg_death"     => Agg::Ratio { num: r.sum_d,   den: kda },
        "avg_assist"    => Agg::Ratio { num: r.sum_a,   den: kda },
        "avg_inked"     => Agg::Ratio { num: r.sum_ink, den: kda },
        // 比の指標は「平均の比」＝「合計の比」（母数 n_kda が約分される）。
        // 合計で持てば周辺集計も同じ式で正しく畳める。
        "kill_ratio"    => Agg::Ratio { num: r.sum_k,             den: r.sum_d },
        "contrib_kill"  => Agg::Ratio { num: r.sum_k + r.sum_a,   den: kda },
        "contrib_ratio" => Agg::Ratio { num: r.sum_k + r.sum_a,   den: r.sum_d },
        "battles"       => Agg::Sum(n),
        _ => return None,
    })
}

/// 周辺集計の入力（セル 1 つ分の寄与）。**足切り前の全グループ**を渡すこと（#411）。
#[derive(Debug, Clone, PartialEq)]
struct MarginalInput {
    row_key: String,
    col_key: String,
    agg:     Option<Agg>,
    /// そのセルのサンプル数（キル系は n_kda）。軸の合計標本数になる。
    n:       i64,
}

#[derive(Debug, Clone, Copy, PartialEq)]
enum Axis { Row, Col }

/// 入力を軸方向へ畳んで周辺集計を作る（#411）。
///
/// キーの出現順を保つ（FE は Map 参照なので順序に依存しないが、テストと差分の読みやすさのため）。
fn fold_marginals(inputs: &[MarginalInput], axis: Axis) -> Vec<EnvMatrixMarginal> {
    use std::collections::HashMap;
    /// (Σnum, Σden, Σsum, Σn, 合計系か)
    struct Acc { num: f64, den: f64, sum: f64, n: i64, is_sum: bool }
    let mut order: Vec<String> = Vec::new();
    let mut idx:   HashMap<String, usize> = HashMap::new();
    let mut acc:   Vec<Acc> = Vec::new();

    for input in inputs {
        let key = match axis { Axis::Row => &input.row_key, Axis::Col => &input.col_key };
        let i = *idx.entry(key.clone()).or_insert_with(|| {
            order.push(key.clone());
            acc.push(Acc { num: 0.0, den: 0.0, sum: 0.0, n: 0, is_sum: false });
            acc.len() - 1
        });
        acc[i].n += input.n;
        match input.agg {
            Some(Agg::Ratio { num, den }) => { acc[i].num += num; acc[i].den += den; }
            Some(Agg::Sum(v))             => { acc[i].sum += v; acc[i].is_sum = true; }
            None                          => {}
        }
    }

    order.into_iter().zip(acc).map(|(key, a)| EnvMatrixMarginal {
        key,
        value: if a.is_sum {
            Some(a.sum)
        } else if a.den > 0.0 {
            Some(a.num / a.den)
        } else {
            None
        },
        n: a.n,
    }).collect()
}

/// スロット単位の集計が必要な次元（weapon およびその属性軸）。
fn is_weapon_slot_dim(dim: &str) -> bool {
    matches!(dim, "weapon" | "weapon_category" | "sub_weapon" | "special_weapon")
}

/// weapon テーブル上の GROUP BY / SELECT 用キー式（#481）。
/// マスターに和名列が無い属性は key をそのまま返す（FE の GROUP_BY_LABELS と整合）。
fn weapon_slot_key_expr(dim: &str) -> Option<&'static str> {
    match dim {
        "weapon"          => Some("w.key"),
        "weapon_category" => Some("COALESCE(NULLIF(w.category_key, ''), '(未分類)')"),
        "sub_weapon"      => Some("COALESCE(w.sub_key, '(不明)')"),
        "special_weapon"  => Some("COALESCE(w.special_key, '(不明)')"),
        _                 => None,
    }
}

/// 集計次元（battle レベル）→ (env_battles の id カラム, マスターテーブル名, 表示ラベル列)。
/// map は key が数値 ID / スラッグなので name_ja を表示に使う。rule / lobby は key（FE で和名化）。
/// weapon 系はスロット集計が必要なため別扱い（ここでは None）。
fn matrix_dim(dim: &str) -> Option<(&'static str, &'static str, &'static str)> {
    match dim {
        "stage" => Some(("map_id",   "map",   "name_ja")),
        "rule"  => Some(("rule_id",  "rule",  "key")),
        "lobby" => Some(("lobby_id", "lobby", "key")),
        _       => None,
    }
}

/// 武器フィルタ前提の非武器×非武器マトリクス（#520）。
///
/// ステージ×ルール等で、選んだ武器が乗っているスロット視点の勝率・KDA を出す。
/// 散布図のステージ集計（#478）と同じく、武器キーで JOIN したスロットだけを展開する。
async fn env_matrix_stats_weapon_filtered(
    db:           &Pool<Sqlite>,
    row_dim:      &str,
    col_dim:      &str,
    cell_metric:  &str,
    kda_based:    bool,
    f:            &EnvFilters,
    where_clause: &str,
) -> Result<EnvMatrixStats, String> {
    let (row_col, rmaster, rlabel) = matrix_dim(row_dim)
        .ok_or_else(|| format!("未知の集計次元: {row_dim}"))?;
    let (col_col, cmaster, clabel) = matrix_dim(col_dim)
        .ok_or_else(|| format!("未知の集計次元: {col_dim}"))?;

    let wph = vec!["?"; f.weapon_keys.len()].join(",");
    let slots: Vec<&ScatterSlot> = SELF_SLOTS.iter().chain(OPP_SLOTS.iter()).collect();
    let selects: Vec<String> = slots
        .iter()
        .map(|s| {
            format!(
                "SELECT eb.{row_col} AS rid, eb.{col_col} AS cid, \
                        CASE WHEN eb.win_team = '{team}' THEN 1 ELSE 0 END AS won, \
                        {k} AS k, {d} AS d, {a} AS a, {ink} AS ink \
                 FROM env_battles eb \
                 JOIN weapon wk ON wk.id = eb.{wid} AND wk.key IN ({wph}) \
                 {where}",
                row_col = row_col,
                col_col = col_col,
                team = s.team,
                k = s.k,
                d = s.d,
                a = s.a,
                ink = s.ink,
                wid = s.wid,
                wph = wph,
                where = where_clause,
            )
        })
        .collect();
    let app = selects.join("\n            UNION ALL ");

    let sql = format!(
        r#"
        WITH app AS (
            {app}
        )
        SELECT rm.{rlabel} AS row_key,
               cm.{clabel} AS col_key,
               COUNT(*) AS n,
               COUNT(app.k) AS n_kda,
               CAST(SUM(app.won) AS REAL) AS sum_won,
               CAST(SUM(app.k)   AS REAL) AS sum_k,
               CAST(SUM(app.d)   AS REAL) AS sum_d,
               CAST(SUM(app.a)   AS REAL) AS sum_a,
               CAST(SUM(app.ink) AS REAL) AS sum_ink
        FROM app
        JOIN {rmaster} rm ON rm.id = app.rid
        JOIN {cmaster} cm ON cm.id = app.cid
        WHERE app.rid IS NOT NULL AND app.cid IS NOT NULL
        GROUP BY app.rid, app.cid
        "#,
        app = app,
        rlabel = rlabel,
        clabel = clabel,
        rmaster = rmaster,
        cmaster = cmaster,
    );

    // 各スロット: weapon_keys バインド + EnvFilters バインド（散布図ステージ集計と同じ）
    let mut q = sqlx::query(&sql);
    for _ in 0..slots.len() {
        for v in &f.weapon_keys {
            q = q.bind(v);
        }
        q = bind_env_filters(q, f);
    }
    let rows = q.fetch_all(db).await.map_err(|e| e.to_string())?;

    let min_n = if kda_based { 20 } else { 30 };
    let mut cells = Vec::new();
    let mut inputs = Vec::new();
    for row in rows {
        let sum = |name: &str| -> f64 {
            if let Ok(v) = row.try_get::<f64, _>(name) {
                return v;
            }
            if let Ok(Some(v)) = row.try_get::<Option<f64>, _>(name) {
                return v;
            }
            if let Ok(v) = row.try_get::<i64, _>(name) {
                return v as f64;
            }
            if let Ok(Some(v)) = row.try_get::<Option<i64>, _>(name) {
                return v as f64;
            }
            0.0
        };
        let raw = MatrixRaw {
            n:        row.get("n"),
            n_kda:    row.get("n_kda"),
            sum_won:  sum("sum_won"),
            sum_ko:   0.0,
            sum_k:    sum("sum_k"),
            sum_d:    sum("sum_d"),
            sum_a:    sum("sum_a"),
            sum_ink:  sum("sum_ink"),
            pick_den: 0.0,
        };
        let n = if kda_based { raw.n_kda } else { raw.n };
        let agg = cell_agg(cell_metric, &raw);
        let row_key: String = row.get("row_key");
        let col_key: String = row.get("col_key");
        inputs.push(MarginalInput {
            row_key: row_key.clone(),
            col_key: col_key.clone(),
            agg,
            n,
        });
        if n >= min_n {
            cells.push(EnvMatrixCell {
                row_key,
                col_key,
                value: agg.and_then(Agg::value),
                n,
            });
        }
    }

    Ok(EnvMatrixStats {
        cells,
        row_marginals: fold_marginals(&inputs, Axis::Row),
        col_marginals: fold_marginals(&inputs, Axis::Col),
    })
}

/// 環境データのマトリクス（ヒートマップ）集計。
///
/// - `cell_metric` = "win_rate" | "pick_rate" | "avg_kill" | "avg_death" | "avg_assist"
///   | "avg_inked" | "kill_ratio" | "contrib_kill" | "contrib_ratio" … 行/列の **一方が
///   weapon / weapon_category / sub_weapon / special_weapon**、または **武器フィルタ指定の
///   非武器×非武器**（#520。ピック率は武器系軸必須）。いずれも投稿者を除く 7 人が母数（#501）。
/// - `cell_metric` = "ko_rate" | "battles"   … 行/列とも **weapon 系以外**（バトルレベル指標）
///
/// セルはサンプル不足を落として返すが、行・列の周辺集計（marginals）は
/// **足切り前の全グループ**から算出して一緒に返す（#411）。軸ラベルの色付けに使う。
#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn env_matrix_stats(
    db:           tauri::State<'_, DbPool>,
    row_dim:      String,
    col_dim:      String,
    cell_metric:  String,
    lobby_keys:   Option<Vec<String>>,
    rule_keys:    Option<Vec<String>>,
    stage_keys:   Option<Vec<String>>,
    weapon_keys:  Option<Vec<String>>,
    since:        Option<String>,
    until:        Option<String>,
    game_vers:    Option<Vec<String>>,
    poster_ranks: Option<Vec<String>>,
    power_min:    Option<f64>,
    power_max:    Option<f64>,
) -> Result<EnvMatrixStats, String> {
    let f = EnvFilters {
        lobby_keys:   lobby_keys.unwrap_or_default(),
        rule_keys:    rule_keys.unwrap_or_default(),
        stage_keys:   stage_keys.unwrap_or_default(),
        weapon_keys:  weapon_keys.unwrap_or_default(),
        since, until,
        game_vers:    game_vers.unwrap_or_default(),
        poster_ranks: poster_ranks.unwrap_or_default(),
        power_min, power_max,
    };
    let where_clause = build_env_where(&f);
    // KDA 系（キル/デス/アシスト/塗り＋派生比）は記録のあるスロットだけが母数になる。
    // 全期間再取得前のデータは B1 しか KDA を持たないので、勝率/ピック率（7 スロット全員）
    // とは母数が揃わない。足切りしきい値も別にする。
    let kda_based = matches!(
        cell_metric.as_str(),
        "avg_kill" | "avg_death" | "avg_assist" | "avg_inked"
            | "kill_ratio" | "contrib_kill" | "contrib_ratio"
    );
    let weapon_centric = cell_metric == "win_rate" || cell_metric == "pick_rate" || kda_based;

    if weapon_centric {
        // 行・列のうち厳密に一方が weapon 系（スロット単位集計）であること。
        // 例外: 武器フィルタありなら非武器×非武器でも、選んだ武器が乗ったスロット視点で集計できる（#520）。
        // ピック率は「軸上の武器シェア」なので武器系軸が無いと出さない。
        let slot_is_row = is_weapon_slot_dim(&row_dim);
        let slot_is_col = is_weapon_slot_dim(&col_dim);
        if slot_is_row && slot_is_col {
            return Err(
                "この指標は行・列の一方を weapon / weapon_category / sub_weapon / special_weapon にしてください"
                    .to_string(),
            );
        }
        if !slot_is_row && !slot_is_col {
            if f.weapon_keys.is_empty() {
                return Err(
                    "この指標は行・列の一方を weapon 系にするか、武器フィルタを指定してください"
                        .to_string(),
                );
            }
            if cell_metric == "pick_rate" {
                return Err(
                    "ピック率は行・列の一方を weapon / weapon_category / sub_weapon / special_weapon にしてください"
                        .to_string(),
                );
            }
            return env_matrix_stats_weapon_filtered(
                db.as_ref(),
                &row_dim,
                &col_dim,
                &cell_metric,
                kda_based,
                &f,
                &where_clause,
            )
            .await;
        }
        let slot_dim = if slot_is_row { &row_dim } else { &col_dim };
        let other_dim = if slot_is_row { &col_dim } else { &row_dim };
        let slot_key_expr = weapon_slot_key_expr(slot_dim)
            .ok_or_else(|| format!("未知の集計次元: {slot_dim}"))?;
        let (oid_col, omaster, olabel) = matrix_dim(other_dim)
            .ok_or_else(|| format!("未知の集計次元: {other_dim}"))?;

        // 投稿者を除く 7 スロット（A2–A4 alpha / B1–B4 bravo）を UNION ALL（#501）。
        // KDA 母数 = 非 NULL 件数（COUNT(app.k)）。全期間再取得前のデータは B1 しか
        // KDA を持たないため、母数は 7 に満たないことがある。
        let slots: Vec<&ScatterSlot> = SELF_SLOTS.iter().chain(OPP_SLOTS.iter()).collect();
        let selects: Vec<String> = slots.iter().map(|s| format!(
            "SELECT {wid} AS wid, CASE WHEN win_team = '{team}' THEN 1 ELSE 0 END AS won, \
             {k} AS k, {d} AS d, {a} AS a, {ink} AS ink, \
             eb.{oid} AS oid FROM env_battles eb {where}",
            wid = s.wid, team = s.team, k = s.k, d = s.d, a = s.a, ink = s.ink,
            oid = oid_col, where = where_clause,
        )).collect();
        let app = selects.join("\n            UNION ALL ");

        // 周辺集計（#411）を足切り前の全グループから作るため、SQL では絞り込まず
        // 生の合計だけを取る。セルの足切りは取得後に Rust 側で同じ条件を適用する
        // （KDA 系はキル母数 n_kda >= 20、勝率/ピック率はスロット合算 n >= 30）。
        let sql = format!(
            r#"
            WITH app AS (
                {app}
            ),
            otot AS (SELECT eb.{oid} AS oid, COUNT(*) AS c FROM env_battles eb {where} GROUP BY eb.{oid})
            SELECT {slot_key} AS slot_key,
                   om.{olabel} AS other_key,
                   COUNT(*) AS n,
                   COUNT(app.k) AS n_kda,
                   -- SUM は SQLite では integer を返すことがある。sqlx の f64 デコードと
                   -- 型が食い違うと失敗して 0 に潰れていたため、REAL にキャストする（#458）。
                   CAST(SUM(app.won) AS REAL) AS sum_won,
                   otot.c * {slot_count}.0 AS pick_den,
                   CAST(SUM(app.k)   AS REAL) AS sum_k,
                   CAST(SUM(app.d)   AS REAL) AS sum_d,
                   CAST(SUM(app.a)   AS REAL) AS sum_a,
                   CAST(SUM(app.ink) AS REAL) AS sum_ink
            FROM app
            JOIN weapon w  ON w.id  = app.wid
            JOIN {omaster} om ON om.id = app.oid
            JOIN otot ON otot.oid = app.oid
            WHERE app.wid IS NOT NULL AND app.oid IS NOT NULL
            GROUP BY {slot_key}, app.oid
            "#,
            app = app, oid = oid_col, omaster = omaster, olabel = olabel,
            slot_key = slot_key_expr, where = where_clause, slot_count = slots.len(),
        );

        // バインド: スロット数 + otot 1 回。
        let mut q = sqlx::query(&sql);
        for _ in 0..(slots.len() + 1) {
            q = bind_env_filters(q, &f);
        }
        let rows = q.fetch_all(db.as_ref()).await.map_err(|e| e.to_string())?;

        // KDA 系はキル母数（記録のあるスロットの件数）で足切り。勝率/ピック率はスロット合算。
        let min_n = if kda_based { 20 } else { 30 };

        let mut cells  = Vec::new();
        let mut inputs = Vec::new();
        for row in rows {
            let slot_key: String = row.get("slot_key");
            let other_key:  String = row.get("other_key");
            // SUM/演算列は REAL に寄せているが、万一 integer が来ても落ちないようにする（#458）。
            // 以前の `try_get::<Option<f64>>().unwrap_or(None)` は型不一致を握りつぶして 0 にしていた。
            let sum = |name: &str| -> f64 {
                if let Ok(v) = row.try_get::<f64, _>(name) { return v; }
                if let Ok(Some(v)) = row.try_get::<Option<f64>, _>(name) { return v; }
                if let Ok(v) = row.try_get::<i64, _>(name) { return v as f64; }
                if let Ok(Some(v)) = row.try_get::<Option<i64>, _>(name) { return v as f64; }
                0.0
            };
            let raw = MatrixRaw {
                n:        row.get("n"),
                n_kda:    row.get("n_kda"),
                sum_won:  sum("sum_won"),
                sum_ko:   0.0,
                sum_k:    sum("sum_k"),
                sum_d:    sum("sum_d"),
                sum_a:    sum("sum_a"),
                sum_ink:  sum("sum_ink"),
                pick_den: sum("pick_den"),
            };
            // KDA 系はキル母数、それ以外はスロット合算を件数として返す。
            let n = if kda_based { raw.n_kda } else { raw.n };
            let agg = cell_agg(&cell_metric, &raw);
            let (row_key, col_key) = if slot_is_row {
                (slot_key, other_key)
            } else {
                (other_key, slot_key)
            };
            // 周辺集計には足切り前の全グループを渡す（#411）。
            inputs.push(MarginalInput {
                row_key: row_key.clone(), col_key: col_key.clone(), agg, n,
            });
            if n >= min_n {
                cells.push(EnvMatrixCell { row_key, col_key, value: agg.and_then(Agg::value), n });
            }
        }

        let mut row_marginals = fold_marginals(&inputs, Axis::Row);
        let mut col_marginals = fold_marginals(&inputs, Axis::Col);
        // ピック率は「武器のシェア」なので、weapon 系以外の軸へ射影するとどのキーでも
        // Σシェア＝一定（スロットで割り切った合計）になり、軸間の差が出ない。
        // 情報の無い値に色を付けても誤読させるだけなので値なし（＝既定色）にする。
        if cell_metric == "pick_rate" {
            let flat = if slot_is_row { &mut col_marginals } else { &mut row_marginals };
            for m in flat.iter_mut() { m.value = None; }
        }
        return Ok(EnvMatrixStats { cells, row_marginals, col_marginals });
    }

    // バトルレベル × バトルレベル（weapon 系を含まない）。
    if is_weapon_slot_dim(&row_dim) || is_weapon_slot_dim(&col_dim) {
        return Err(
            "ko_rate/battles は weapon / weapon_category / sub_weapon / special_weapon 以外の次元同士で指定してください"
                .to_string(),
        );
    }
    let (row_col, rmaster, rlabel) = matrix_dim(&row_dim).ok_or_else(|| format!("未知の集計次元: {row_dim}"))?;
    let (col_col, cmaster, clabel) = matrix_dim(&col_dim).ok_or_else(|| format!("未知の集計次元: {col_dim}"))?;

    if !matches!(cell_metric.as_str(), "ko_rate" | "battles") {
        return Err(format!("未知の cell_metric: {cell_metric}"));
    }

    // セル値も周辺集計も生の合計から導くので、SQL では合計だけを取り、
    // 足切り（n >= 30）は取得後に Rust 側で適用する（#411）。
    let sql = format!(
        r#"
        SELECT rm.{rlabel} AS row_key,
               cm.{clabel} AS col_key,
               COUNT(*) AS n,
               SUM(CASE WHEN eb.knockout = 1 THEN 1.0 ELSE 0.0 END) AS sum_ko
        FROM env_battles eb
        JOIN {rmaster} rm ON rm.id = eb.{row_col}
        JOIN {cmaster} cm ON cm.id = eb.{col_col}
        {where}
        GROUP BY eb.{row_col}, eb.{col_col}
        "#,
        rmaster = rmaster, cmaster = cmaster, rlabel = rlabel, clabel = clabel,
        row_col = row_col, col_col = col_col, where = where_clause,
    );
    let q = bind_env_filters(sqlx::query(&sql), &f);
    let rows = q.fetch_all(db.as_ref()).await.map_err(|e| e.to_string())?;

    let mut cells  = Vec::new();
    let mut inputs = Vec::new();
    for row in rows {
        let row_key: String = row.get("row_key");
        let col_key: String = row.get("col_key");
        let raw = MatrixRaw {
            n:      row.get("n"),
            sum_ko: row.try_get::<Option<f64>, _>("sum_ko").unwrap_or(None).unwrap_or(0.0),
            ..Default::default()
        };
        let n   = raw.n;
        let agg = cell_agg(&cell_metric, &raw);
        inputs.push(MarginalInput { row_key: row_key.clone(), col_key: col_key.clone(), agg, n });
        if n >= 30 {
            cells.push(EnvMatrixCell { row_key, col_key, value: agg.and_then(Agg::value), n });
        }
    }
    Ok(EnvMatrixStats {
        row_marginals: fold_marginals(&inputs, Axis::Row),
        col_marginals: fold_marginals(&inputs, Axis::Col),
        cells,
    })
}

/// 「今シーズン」の日付レンジ。最新バトルが属するシーズンの min/max source_date。
#[derive(Debug, Serialize)]
pub struct EnvSeasonRange {
    pub season: Option<String>,
    pub since:  Option<String>,
    pub until:  Option<String>,
}

/// 最新バトルが属するシーズンと、その日付レンジ（source_date の min/max）を返す。
/// FE の「今シーズン」期間プリセットは、この since/until を散布図/ヒートマップに渡す。
#[tauri::command]
pub async fn env_season_range(db: tauri::State<'_, DbPool>) -> Result<EnvSeasonRange, String> {
    let row = sqlx::query(
        r#"
        WITH cur AS (
            SELECT season FROM env_battles
            WHERE source_date = (SELECT MAX(source_date) FROM env_battles)
            LIMIT 1
        )
        SELECT (SELECT season FROM cur) AS season,
               MIN(source_date)         AS since,
               MAX(source_date)         AS until
        FROM env_battles
        WHERE season IS (SELECT season FROM cur)
        "#,
    )
    .fetch_one(db.as_ref())
    .await
    .map_err(|e| e.to_string())?;

    Ok(EnvSeasonRange {
        season: row.try_get::<Option<String>, _>("season").unwrap_or(None),
        since:  row.try_get::<Option<String>, _>("since").unwrap_or(None),
        until:  row.try_get::<Option<String>, _>("until").unwrap_or(None),
    })
}

// ---------------------------------------------------------------------------
// 環境分析 フィルタ拡充（#189）: バージョン / ウデマエ帯の選択肢
// ---------------------------------------------------------------------------

/// 取り込み済みデータに含まれるゲームバージョン 1 件分。
#[derive(Debug, Serialize)]
pub struct EnvVersion {
    pub game_ver: String,
    pub n:        i64,
    pub min_date: Option<String>,
    pub max_date: Option<String>,
}

/// "1.2.0" / "10.0.1" 等のバージョン文字列を (major, minor, patch) の数値タプルに。
/// 文字列ソートだと "10.x" が "2.x" より前に来てしまうため、数値比較用キーを作る。
fn version_key(v: &str) -> (u32, u32, u32) {
    let mut it = v.split('.').map(|p| p.trim().parse::<u32>().unwrap_or(0));
    (it.next().unwrap_or(0), it.next().unwrap_or(0), it.next().unwrap_or(0))
}

/// env_battles に存在するゲームバージョンを、件数・日付レンジ付きで新しい順に返す。
/// セレクタの選択肢を取り込み済みデータから動的生成するために使う。
#[tauri::command]
pub async fn env_versions(db: tauri::State<'_, DbPool>) -> Result<Vec<EnvVersion>, String> {
    let rows = sqlx::query(
        r#"
        SELECT game_ver,
               COUNT(*)         AS n,
               MIN(source_date) AS min_d,
               MAX(source_date) AS max_d
        FROM env_battles
        WHERE game_ver IS NOT NULL AND game_ver <> ''
        GROUP BY game_ver
        "#,
    )
    .fetch_all(db.as_ref())
    .await
    .map_err(|e| e.to_string())?;

    let mut result: Vec<EnvVersion> = rows
        .into_iter()
        .map(|row| EnvVersion {
            game_ver: row.get("game_ver"),
            n:        row.get("n"),
            min_date: row.try_get::<Option<String>, _>("min_d").unwrap_or(None),
            max_date: row.try_get::<Option<String>, _>("max_d").unwrap_or(None),
        })
        .collect();
    // セマンティックバージョンの降順（新しい順）。
    result.sort_by(|a, b| version_key(&b.game_ver).cmp(&version_key(&a.game_ver)));
    Ok(result)
}

/// 取り込み済みデータに含まれるウデマエ帯 1 件分。
#[derive(Debug, Serialize)]
pub struct EnvRank {
    pub poster_rank: String,
    pub n:           i64,
}

/// ウデマエの並び順キー（C- が最小、X が最大）。未知の値は末尾。
/// 実データは `C-`〜`A+`,`S`,`S+ 0`〜`S+ 50`,`X` の形（`S+` はスペース＋番号付き）。
/// stat.ink の値は小文字のこともあるので大文字化して照合する。
fn rank_order(r: &str) -> i64 {
    let up = r.trim().to_uppercase();
    // "S+ 12" → S の直後に、番号順で並べる。
    if let Some(rest) = up.strip_prefix("S+") {
        let n: i64 = rest.trim().parse().unwrap_or(0);
        return 100 + n;
    }
    const ORDER: &[&str] = &["C-", "C", "C+", "B-", "B", "B+", "A-", "A", "A+", "S"];
    if let Some(p) = ORDER.iter().position(|x| *x == up) {
        return p as i64;          // 0..9
    }
    if up == "X" { return 100_000; }   // S+ 帯より上
    99_999                              // 未知 → 末尾付近
}

/// env_battles に記録された投稿者ウデマエ（poster_rank）を、ウデマエ順に整列して返す。
/// poster_rank は投稿者（A1）のみの記録である点に注意（UI に注記する）。
#[tauri::command]
pub async fn env_ranks(db: tauri::State<'_, DbPool>) -> Result<Vec<EnvRank>, String> {
    let rows = sqlx::query(
        r#"
        SELECT poster_rank, COUNT(*) AS n
        FROM env_battles
        WHERE poster_rank IS NOT NULL AND poster_rank <> ''
        GROUP BY poster_rank
        "#,
    )
    .fetch_all(db.as_ref())
    .await
    .map_err(|e| e.to_string())?;

    let mut result: Vec<EnvRank> = rows
        .into_iter()
        .map(|row| EnvRank {
            poster_rank: row.get("poster_rank"),
            n:           row.get("n"),
        })
        .collect();
    result.sort_by(|a, b| {
        rank_order(&a.poster_rank)
            .cmp(&rank_order(&b.poster_rank))
            .then_with(|| a.poster_rank.cmp(&b.poster_rank))
    });
    Ok(result)
}

/// 環境分析の武器/ステージ絞り込み用の 1 選択肢（#477）。
#[derive(Debug, Serialize)]
pub struct EnvFilterOption {
    pub key:   String,
    pub label: String,
    pub n:     i64,
}

/// env_battles に登場する武器をピック数降順で返す（絞り込み UI 用・#477）。
/// 件数は集計と同じく投稿者（a1）を除いたスロットで数える（#501）。
#[tauri::command]
pub async fn env_weapons(db: tauri::State<'_, DbPool>) -> Result<Vec<EnvFilterOption>, String> {
    let rows = sqlx::query(
        r#"
        SELECT w.key AS key,
               COALESCE(NULLIF(w.name_ja, ''), w.key) AS label,
               COUNT(*) AS n
        FROM env_battles eb
        JOIN weapon w ON w.id IN (
            eb.a2_weapon_id, eb.a3_weapon_id, eb.a4_weapon_id,
            eb.b1_weapon_id, eb.b2_weapon_id, eb.b3_weapon_id, eb.b4_weapon_id
        )
        GROUP BY w.id
        ORDER BY n DESC
        "#,
    )
    .fetch_all(db.as_ref())
    .await
    .map_err(|e| e.to_string())?;

    Ok(rows
        .into_iter()
        .map(|row| EnvFilterOption {
            key:   row.get("key"),
            label: row.get("label"),
            n:     row.get("n"),
        })
        .collect())
}

/// env_battles に登場するステージをバトル数降順で返す（絞り込み UI 用・#477）。
#[tauri::command]
pub async fn env_stages(db: tauri::State<'_, DbPool>) -> Result<Vec<EnvFilterOption>, String> {
    let rows = sqlx::query(
        r#"
        SELECT m.key AS key,
               COALESCE(NULLIF(m.name_ja, ''), m.key) AS label,
               COUNT(*) AS n
        FROM env_battles eb
        JOIN map m ON m.id = eb.map_id
        GROUP BY m.id
        ORDER BY n DESC
        "#,
    )
    .fetch_all(db.as_ref())
    .await
    .map_err(|e| e.to_string())?;

    Ok(rows
        .into_iter()
        .map(|row| EnvFilterOption {
            key:   row.get("key"),
            label: row.get("label"),
            n:     row.get("n"),
        })
        .collect())
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
    // v11 で旧 battles テーブルは drop 済み（再起動時の init schema で空のまま再作成される）。
    // 集計は新スキーマの battle / weapon / result を経由する:
    //   旧 weapons.name は populate_weapons_from_battles で新 weapon.key と一致させてあるので、
    //   weapons.name = weapon.key で JOIN し、weapon.id で battle.weapon_id とつなぐ。
    // weapon_records (#49) は LEFT JOIN で未取得武器は NULL を返す。
    let rows = sqlx::query_as::<_, WeaponRecord>(
        "SELECT w.name, w.category, w.sub_weapon, w.special_weapon,
                w.sub_weapon_image, w.special_weapon_image,
                COUNT(b.id) as total,
                COALESCE(SUM(CASE WHEN res.key='win'  THEN 1 ELSE 0 END), 0) as wins,
                COALESCE(SUM(CASE WHEN res.key='draw' THEN 1 ELSE 0 END), 0) as draws,
                wr.weapon_level      as weapon_level,
                wr.win_count_total   as win_count_total,
                wr.paint_point_total as paint_point_total,
                wr.weapon_power      as weapon_power,
                wr.weapon_power_max  as weapon_power_max
         FROM weapons w
         LEFT JOIN weapon nw ON nw.key = w.name
         LEFT JOIN battle b ON b.weapon_id = nw.id
         LEFT JOIN result res ON res.id = b.result_id
         LEFT JOIN weapon_records wr ON wr.weapon_id = w.name
         GROUP BY w.name
         ORDER BY CASE WHEN w.category = '' OR w.category IS NULL THEN 1 ELSE 0 END,
                  w.category, total DESC, w.name",
    )
    .fetch_all(db.as_ref())
    .await
    .map_err(|e| e.to_string())?;
    Ok(rows)
}

// ---------------------------------------------------------------------------
// stat.ink インポート (#174)
// ---------------------------------------------------------------------------

/// stat.ink からインポートした 1 バトル分の正規化済みデータ。
/// `statink_import.rs` が stat.ink battle JSON から組み立て、
/// `insert_imported_battle` 経由で新スキーマへ書き込む。
#[derive(Debug, Default)]
pub struct ImportedBattleRow {
    /// 新スキーマ battle.id。stat.ink には SplatNet base64 id が無いため uuid をそのまま使う。
    pub id: String,
    /// s3s / chartoon と同じ UUID v5（stat.ink 側の `uuid` フィールド = client_uuid）。
    pub uuid: String,
    pub played_at: String,
    pub lobby_key: String,
    /// rule が取れない場合は空文字。空なら rule_id = NULL で挿入する。
    pub rule_key: String,
    pub result_key: String,
    /// 武器マスター key（= 表示名）。chartoon の weapon.key は SplatNet 表示名なので
    /// stat.ink の weapon.name.ja_JP を使う。
    pub weapon_key: String,
    /// ステージ識別用の stat.ink stage key（フォールバックの map.key 用）。
    pub stage_statink_key: String,
    pub stage_name_ja: Option<String>,
    pub stage_name_en: Option<String>,
    pub is_knockout: Option<i64>,
    pub rank_in_team: Option<i64>,
    pub kill: i64,
    pub assist: i64,
    pub kill_or_assist: i64,
    pub death: i64,
    pub special: i64,
    pub inked: i64,
    pub duration: i64,
    pub our_team_inked: Option<i64>,
    pub their_team_inked: Option<i64>,
    pub our_team_percent: Option<f64>,
    pub their_team_percent: Option<f64>,
    pub our_team_count: Option<i64>,
    pub their_team_count: Option<i64>,
    pub rank_before: Option<String>,
    pub rank_after: Option<String>,
    pub rank_before_s_plus: Option<i64>,
    pub rank_after_s_plus: Option<i64>,
    pub x_power_before: Option<f64>,
    pub x_power_after: Option<f64>,
    /// stat.ink battle JSON 全体（fallback / 再パース用）。
    pub raw_json: String,
    /// my_team / other_teams を SplatNet 互換の形に組み直した JSON 文字列。
    /// バトル詳細モーダル・ギア集計が参照する。
    pub my_team: Option<String>,
    pub other_teams: Option<String>,
}

/// lobby / rule / result マスターの key → id を引く（固定 ID seed 済み）。
async fn id_by_key(pool: &DbPool, table: &str, key: &str) -> Result<Option<i64>, String> {
    if key.is_empty() {
        return Ok(None);
    }
    // table はコード内固定文字列のみ（外部入力ではない）なので format! で安全。
    let sql = format!("SELECT id FROM {table} WHERE key = ? LIMIT 1");
    let row = sqlx::query(&sql)
        .bind(key)
        .fetch_optional(pool.as_ref())
        .await
        .map_err(|e| e.to_string())?;
    Ok(row.map(|r| r.get::<i64, _>("id")))
}

/// stat.ink のステージを chartoon の map マスターに解決する。
/// まず name_ja で既存行（SplatNet 取得済みの数値 ID key を持つ map）に一致させ、
/// 無ければ stat.ink の stage key で新規作成する。id を返す。
async fn resolve_map_id_for_import(
    pool: &DbPool,
    statink_key: &str,
    name_ja: Option<&str>,
    name_en: Option<&str>,
) -> Result<Option<i64>, String> {
    // 1. 既存 map を name_ja で照合（SplatNet 直取得分とキーを共有して集計を統合）。
    if let Some(name) = name_ja {
        if !name.is_empty() {
            let row = sqlx::query("SELECT id FROM map WHERE name_ja = ? LIMIT 1")
                .bind(name)
                .fetch_optional(pool.as_ref())
                .await
                .map_err(|e| e.to_string())?;
            if let Some(r) = row {
                return Ok(Some(r.get::<i64, _>("id")));
            }
        }
    }
    // 2. フォールバック: stat.ink の stage key で新規作成 / 取得。
    if statink_key.is_empty() {
        return Ok(None);
    }
    sqlx::query("INSERT OR IGNORE INTO map (key, name_ja, name_en) VALUES (?, ?, ?)")
        .bind(statink_key)
        .bind(name_ja)
        .bind(name_en)
        .execute(pool.as_ref())
        .await
        .map_err(|e| e.to_string())?;
    let row = sqlx::query("SELECT id FROM map WHERE key = ? LIMIT 1")
        .bind(statink_key)
        .fetch_optional(pool.as_ref())
        .await
        .map_err(|e| e.to_string())?;
    Ok(row.map(|r| r.get::<i64, _>("id")))
}

/// 指定 uuid のバトルが既に存在するか。stat.ink import の重複排除に使う。
pub async fn battle_uuid_exists(pool: &DbPool, uuid: &str) -> Result<bool, String> {
    if uuid.is_empty() {
        return Ok(false);
    }
    let row = sqlx::query("SELECT 1 FROM battle WHERE uuid = ? LIMIT 1")
        .bind(uuid)
        .fetch_optional(pool.as_ref())
        .await
        .map_err(|e| e.to_string())?;
    Ok(row.is_some())
}

/// インポートした 1 バトルを新スキーマ (battle / battle_player) へ書き込む。
/// 必須 FK (lobby / result / weapon / map) が解決できない場合は warn してスキップ（false を返す）。
/// `INSERT OR IGNORE` なので uuid 重複時は呼び出し元で事前に弾く前提。挿入成功時 true。
pub async fn insert_imported_battle(pool: &DbPool, row: &ImportedBattleRow) -> Result<bool, String> {
    let lobby_id  = id_by_key(pool, "lobby", &row.lobby_key).await?;
    let rule_id   = if row.rule_key.is_empty() { None } else { id_by_key(pool, "rule", &row.rule_key).await? };
    let result_id = id_by_key(pool, "result", &row.result_key).await?;
    let weapon_id = upsert_weapon_id(pool, &row.weapon_key).await?;
    let map_id    = resolve_map_id_for_import(
        pool,
        &row.stage_statink_key,
        row.stage_name_ja.as_deref(),
        row.stage_name_en.as_deref(),
    )
    .await?;

    let (Some(lobby_id), Some(result_id), Some(weapon_id), Some(map_id)) =
        (lobby_id, result_id, weapon_id, map_id)
    else {
        log::warn!(
            "[import] battle スキップ uuid={} (lobby={} result={} weapon={} stage={})",
            &row.uuid,
            row.lobby_key,
            row.result_key,
            row.weapon_key,
            row.stage_statink_key,
        );
        return Ok(false);
    };

    let res = sqlx::query(
        "INSERT OR IGNORE INTO battle
            (id, uuid, played_at, lobby_id, rule_id, map_id, result_id, weapon_id,
             is_knockout, rank_in_team, kill, assist, kill_or_assist, death, special, inked, duration,
             our_team_inked, their_team_inked, our_team_percent, their_team_percent,
             our_team_count, their_team_count,
             rank_before, rank_after, rank_before_s_plus, rank_after_s_plus,
             x_power_before, x_power_after,
             raw_json, detail_fetched, statink_uuid, my_team, other_teams)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?)",
    )
    .bind(&row.id)
    .bind(&row.uuid)
    .bind(&row.played_at)
    .bind(lobby_id)
    .bind(rule_id)
    .bind(map_id)
    .bind(result_id)
    .bind(weapon_id)
    .bind(row.is_knockout)
    .bind(row.rank_in_team)
    .bind(row.kill)
    .bind(row.assist)
    .bind(row.kill_or_assist)
    .bind(row.death)
    .bind(row.special)
    .bind(row.inked)
    .bind(row.duration)
    .bind(row.our_team_inked)
    .bind(row.their_team_inked)
    .bind(row.our_team_percent)
    .bind(row.their_team_percent)
    .bind(row.our_team_count)
    .bind(row.their_team_count)
    .bind(&row.rank_before)
    .bind(&row.rank_after)
    .bind(row.rank_before_s_plus)
    .bind(row.rank_after_s_plus)
    .bind(row.x_power_before)
    .bind(row.x_power_after)
    .bind(&row.raw_json)
    // statink_uuid = インポート元の stat.ink uuid。これを入れることで「アップロード済み」
    // 扱いになり、auto-upload の対象（statink_uuid IS NULL）から外れて再送・重複を防ぐ。
    .bind(&row.uuid)
    .bind(&row.my_team)
    .bind(&row.other_teams)
    .execute(pool.as_ref())
    .await
    .map_err(|e| format!("import battle insert 失敗 uuid={}: {e}", row.uuid))?;

    // INSERT OR IGNORE で衝突した場合 rows_affected == 0。
    let inserted = res.rows_affected() > 0;

    // プレイヤー行（ギア込み）を既存パイプラインで書き込む。
    if inserted {
        let players = parse_players_from_json(&row.id, row.my_team.as_deref(), row.other_teams.as_deref());
        insert_battle_players(pool, &players).await?;
    }

    Ok(inserted)
}

// ---------------------------------------------------------------------------
// テスト
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    /// 周辺集計の入力を組み立てるヘルパ。
    fn input(row: &str, col: &str, metric: &str, raw: MatrixRaw, kda_based: bool) -> MarginalInput {
        let n = if kda_based { raw.n_kda } else { raw.n };
        MarginalInput {
            row_key: row.to_string(),
            col_key: col.to_string(),
            agg:     cell_agg(metric, &raw),
            n,
        }
    }

    fn value_of(ms: &[EnvMatrixMarginal], key: &str) -> Option<f64> {
        ms.iter().find(|m| m.key == key).expect("キーが無い").value
    }
    fn n_of(ms: &[EnvMatrixMarginal], key: &str) -> i64 {
        ms.iter().find(|m| m.key == key).expect("キーが無い").n
    }

    /// 勝率の周辺集計は「そのキーの全バトル」の比。1 セルが極端に小さくても除外しない。
    #[test]
    fn marginals_include_tiny_cells() {
        // ガチエリア: 大きいセル 60 勝 / 100 + 小さいセル 1 勝 / 1
        let inputs = vec![
            input("area", "w1", "win_rate", MatrixRaw { n: 100, sum_won: 60.0, ..Default::default() }, false),
            input("area", "w2", "win_rate", MatrixRaw { n: 1,   sum_won: 1.0,  ..Default::default() }, false),
        ];
        let rows = fold_marginals(&inputs, Axis::Row);
        assert_eq!(value_of(&rows, "area"), Some(61.0 / 101.0));
        assert_eq!(n_of(&rows, "area"), 101);
    }

    /// **交差する軸を変えても同じ値になる**（#411 の受け入れ条件）。
    /// 同じ 200 バトル・120 勝を、武器 2 種で割った場合とステージ 4 種で割った場合で比較する。
    #[test]
    fn marginals_are_independent_of_cross_axis() {
        let by_weapon = vec![
            input("area", "w1", "win_rate", MatrixRaw { n: 150, sum_won: 90.0, ..Default::default() }, false),
            input("area", "w2", "win_rate", MatrixRaw { n: 50,  sum_won: 30.0, ..Default::default() }, false),
        ];
        let by_stage = vec![
            input("area", "s1", "win_rate", MatrixRaw { n: 40, sum_won: 25.0, ..Default::default() }, false),
            input("area", "s2", "win_rate", MatrixRaw { n: 60, sum_won: 35.0, ..Default::default() }, false),
            input("area", "s3", "win_rate", MatrixRaw { n: 97, sum_won: 58.0, ..Default::default() }, false),
            // 足切り（30）に引っかかる小さいセル。これを落とすと値がズレる。
            input("area", "s4", "win_rate", MatrixRaw { n: 3,  sum_won: 2.0,  ..Default::default() }, false),
        ];
        let w = value_of(&fold_marginals(&by_weapon, Axis::Row), "area").unwrap();
        let s = value_of(&fold_marginals(&by_stage,  Axis::Row), "area").unwrap();
        assert!((w - 0.6).abs() < 1e-12, "{w}");
        assert!((w - s).abs() < 1e-12, "武器割り {w} とステージ割り {s} が一致しない");
    }

    /// キル系は記録のあるスロット（n_kda）が母数。スロット合算（n）で割ってはいけない。
    #[test]
    fn kda_metrics_use_n_kda_denominator() {
        let raw = MatrixRaw { n: 80, n_kda: 20, sum_k: 100.0, ..Default::default() };
        assert_eq!(cell_agg("avg_kill", &raw), Some(Agg::Ratio { num: 100.0, den: 20.0 }));
        assert_eq!(cell_agg("avg_kill", &raw).unwrap().value(), Some(5.0));
        // 勝率はスロット合算が母数。
        let raw = MatrixRaw { n: 80, n_kda: 20, sum_won: 40.0, ..Default::default() };
        assert_eq!(cell_agg("win_rate", &raw), Some(Agg::Ratio { num: 40.0, den: 80.0 }));

        // 周辺集計のサンプル数もキル母数（n_kda）で積む。
        let inputs = vec![
            input("area", "w1", "avg_kill", MatrixRaw { n: 80, n_kda: 20, sum_k: 100.0, ..Default::default() }, true),
            input("area", "w2", "avg_kill", MatrixRaw { n: 40, n_kda: 10, sum_k: 20.0,  ..Default::default() }, true),
        ];
        let rows = fold_marginals(&inputs, Axis::Row);
        assert_eq!(n_of(&rows, "area"), 30);
        assert_eq!(value_of(&rows, "area"), Some(120.0 / 30.0));
    }

    /// キルレは「平均の比」＝「合計の比」。周辺集計もキル合計 / デス合計になる。
    #[test]
    fn kill_ratio_folds_as_sum_ratio() {
        let inputs = vec![
            input("area", "w1", "kill_ratio", MatrixRaw { n_kda: 20, sum_k: 100.0, sum_d: 50.0, ..Default::default() }, true),
            input("area", "w2", "kill_ratio", MatrixRaw { n_kda: 10, sum_k: 20.0,  sum_d: 40.0, ..Default::default() }, true),
        ];
        let rows = fold_marginals(&inputs, Axis::Row);
        assert_eq!(value_of(&rows, "area"), Some(120.0 / 90.0));
    }

    /// バトル数（カウント系）は加重平均ではなく合計。
    #[test]
    fn battles_marginal_is_sum() {
        let inputs = vec![
            input("area", "s1", "battles", MatrixRaw { n: 100, ..Default::default() }, false),
            input("area", "s2", "battles", MatrixRaw { n: 5,   ..Default::default() }, false),
            input("hoko", "s1", "battles", MatrixRaw { n: 40,  ..Default::default() }, false),
        ];
        let rows = fold_marginals(&inputs, Axis::Row);
        assert_eq!(value_of(&rows, "area"), Some(105.0));
        assert_eq!(value_of(&rows, "hoko"), Some(40.0));
        // 列方向も同じ入力から畳める。
        let cols = fold_marginals(&inputs, Axis::Col);
        assert_eq!(value_of(&cols, "s1"), Some(140.0));
    }

    /// 母数が 0 のキーは値なし（0 除算にしない）。サンプル数だけは積む。
    #[test]
    fn marginal_without_denominator_is_none() {
        let inputs = vec![
            input("area", "w1", "avg_kill", MatrixRaw { n: 80, n_kda: 0, ..Default::default() }, true),
        ];
        let rows = fold_marginals(&inputs, Axis::Row);
        assert_eq!(value_of(&rows, "area"), None);
        assert_eq!(n_of(&rows, "area"), 0);
    }

    /// 未知のメトリクスは集計しない（値なし）。
    #[test]
    fn unknown_metric_has_no_agg() {
        assert_eq!(cell_agg("nope", &MatrixRaw { n: 10, ..Default::default() }), None);
    }

    /// 集計スロットは投稿者（a1）を含まない 7 人ちょうど（#501）。
    /// ここが 8 に戻るとピック率の分母と勝率の母数が投稿者込みになる。
    #[test]
    fn scatter_slots_exclude_poster() {
        let slots: Vec<&ScatterSlot> = SELF_SLOTS.iter().chain(OPP_SLOTS.iter()).collect();
        assert_eq!(slots.len(), 7);
        for s in &slots {
            assert!(!s.wid.starts_with("a1_"), "投稿者スロットが混ざっている: {}", s.wid);
            // 全スロットが実カラムの KDA を持つ（NULL 固定のスロットを残さない）。
            for col in [s.k, s.d, s.a, s.ink] {
                assert_ne!(col, "NULL", "{} の KDA が NULL 固定のまま", s.wid);
            }
        }
    }
}
