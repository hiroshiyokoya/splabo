//! stat.ink 公開バトルデータの取り込み（#184）。
//!
//! フロー:
//!  1. stat.ink マスター API（/api/v3/weapon, /api/v3/stage）を叩いて
//!     weapon.statink_key / map.statink_key を更新する。
//!  2. 全期間 ZIP（battle-results-csv.zip） または日次 CSV を DL・解凍・パースして
//!     env_battles に INSERT する。
//!  3. 進捗は Tauri emit "env_import_progress" で FE へ通知する。

use reqwest::Client;
use serde::Serialize;
use sqlx::{Connection, Row, SqliteConnection};
use std::io::{Cursor, Read};
use tauri::{AppHandle, Emitter};
use zip::ZipArchive;

use crate::db::DbPool;

const USER_AGENT: &str = concat!("chartoon/", env!("CARGO_PKG_VERSION"));

/// 全期間 ZIP URL。
const ZIP_URL: &str =
    "https://dl-stats.stats.ink/splatoon-3/battle-results-csv/battle-results-csv.zip";

/// 日次 CSV の URL テンプレート。
const DAILY_BASE: &str = "https://dl-stats.stats.ink/splatoon-3/battle-results-csv";

/// 進捗 emit のペイロード。
#[derive(Debug, Serialize, Clone)]
pub struct ImportProgress {
    pub current: usize,
    pub total:   usize,
    pub phase:   String, // "download" | "extract" | "import"
}

// ---------------------------------------------------------------------------
// CSV カラム定数（stat.ink CSV 91 カラム）
// ---------------------------------------------------------------------------
const COL_SEASON:       usize = 0;
const COL_PERIOD:       usize = 1;
const COL_GAME_VER:     usize = 2;
const COL_LOBBY:        usize = 3;
const COL_MODE:         usize = 4;
const COL_STAGE:        usize = 5;
// 6: time（未使用）
const COL_WIN:          usize = 7;
const COL_KNOCKOUT:     usize = 8;
const COL_POSTER_RANK:  usize = 9;
const COL_POSTER_POWER: usize = 10;
const COL_ALPHA_INKED:       usize = 11;
const COL_ALPHA_INK_PERCENT: usize = 12;
const COL_ALPHA_COUNT:       usize = 13;
// 14-15: 未使用
const COL_BRAVO_INKED:       usize = 16;
const COL_BRAVO_INK_PERCENT: usize = 17;
const COL_BRAVO_COUNT:       usize = 18;
// 19-20: 未使用
// per-player ブロックは 8 列: weapon, kill-assist, kill, assist, death, special, inked, abilities。
// 旧コードは kill-assist(offset1) と special(offset5) の存在を見落とし、
// kill/assist/death/inked を 1 列ずつ手前に読んでいた（#336）。CSV ヘッダで確定した正値に修正。
const COL_A1_WEAPON: usize = 21;
// 22: A1-kill-assist（kill+assist 合算・未使用）
const COL_A1_KILL:   usize = 23;
const COL_A1_ASSIST: usize = 24;
const COL_A1_DEATH:  usize = 25;
// 26: A1-special（SP 発動回数・未使用）
const COL_A1_INKED: usize = 27;
// 28: A1-abilities（未使用）
const COL_A2_WEAPON: usize = 29;
const COL_A3_WEAPON: usize = 37;
const COL_A4_WEAPON: usize = 45;
const COL_B1_WEAPON: usize = 53;
// 54: B1-kill-assist（未使用）
const COL_B1_KILL:   usize = 55;
const COL_B1_ASSIST: usize = 56;
const COL_B1_DEATH:  usize = 57;
// 58: B1-special（未使用）
const COL_B1_INKED: usize = 59;
const COL_B2_WEAPON: usize = 61;
const COL_B3_WEAPON: usize = 69;
const COL_B4_WEAPON: usize = 77;

// ---------------------------------------------------------------------------
// lobby キー変換（stat.ink CSV → chartoon LOBBY_SEED キー）
// ---------------------------------------------------------------------------

fn csv_lobby_to_key(s: &str) -> Option<&'static str> {
    match s {
        "regular"            => Some("regular"),
        "bankara_open"       => Some("bankara_open"),
        "bankara_challenge"  => Some("bankara_challenge"),
        "xmatch"             => Some("xmatch"),  // DB では "xmatch" で LOBBY_SEED id=4
        "splatfest_open"     => Some("splatfest_open"),
        "splatfest_challenge" => Some("splatfest_challenge"),
        "event"              => Some("event"),
        _ => None,
    }
}

/// mode (ルール) キー変換: stat.ink CSV → chartoon rule.key。
fn csv_mode_to_rule_key(s: &str) -> Option<&'static str> {
    match s {
        "nawabari" => Some("nawabari"),
        "area"     => Some("area"),
        "yagura"   => Some("yagura"),
        "hoko"     => Some("hoko"),
        "asari"    => Some("asari"),
        _ => None,
    }
}

// ---------------------------------------------------------------------------
// マスター解決ヘルパー
// ---------------------------------------------------------------------------

/// statink_key で weapon.id を引く。無ければ INSERT して id を返す。
pub async fn resolve_weapon_id(conn: &mut SqliteConnection, statink_key: &str) -> Result<Option<i64>, String> {
    if statink_key.is_empty() {
        return Ok(None);
    }
    // まず statink_key で探す。
    let row = sqlx::query("SELECT id FROM weapon WHERE statink_key = ? LIMIT 1")
        .bind(statink_key)
        .fetch_optional(&mut *conn)
        .await
        .map_err(|e| e.to_string())?;
    if let Some(r) = row {
        return Ok(Some(r.get("id")));
    }
    // 無ければ key=statink_key で新規作成し statink_key を付ける。
    sqlx::query(
        "INSERT OR IGNORE INTO weapon (key, name_ja, statink_key) VALUES (?, ?, ?)",
    )
    .bind(statink_key)
    .bind(statink_key) // name_ja は後でマスター API から上書きされる
    .bind(statink_key)
    .execute(&mut *conn)
    .await
    .map_err(|e| e.to_string())?;
    let row2 = sqlx::query("SELECT id FROM weapon WHERE statink_key = ? LIMIT 1")
        .bind(statink_key)
        .fetch_optional(&mut *conn)
        .await
        .map_err(|e| e.to_string())?;
    Ok(row2.map(|r| r.get("id")))
}

/// statink_key で map.id を引く。無ければ INSERT して id を返す。
async fn resolve_map_id(conn: &mut SqliteConnection, statink_key: &str) -> Result<Option<i64>, String> {
    if statink_key.is_empty() {
        return Ok(None);
    }
    let row = sqlx::query("SELECT id FROM map WHERE statink_key = ? LIMIT 1")
        .bind(statink_key)
        .fetch_optional(&mut *conn)
        .await
        .map_err(|e| e.to_string())?;
    if let Some(r) = row {
        return Ok(Some(r.get("id")));
    }
    sqlx::query(
        "INSERT OR IGNORE INTO map (key, name_ja, statink_key) VALUES (?, ?, ?)",
    )
    .bind(statink_key)
    .bind(statink_key)
    .bind(statink_key)
    .execute(&mut *conn)
    .await
    .map_err(|e| e.to_string())?;
    let row2 = sqlx::query("SELECT id FROM map WHERE statink_key = ? LIMIT 1")
        .bind(statink_key)
        .fetch_optional(&mut *conn)
        .await
        .map_err(|e| e.to_string())?;
    Ok(row2.map(|r| r.get("id")))
}

/// lobby.id を key で引く。
async fn resolve_lobby_id(conn: &mut SqliteConnection, key: &str) -> Result<Option<i64>, String> {
    let row = sqlx::query("SELECT id FROM lobby WHERE key = ? LIMIT 1")
        .bind(key)
        .fetch_optional(&mut *conn)
        .await
        .map_err(|e| e.to_string())?;
    Ok(row.map(|r| r.get("id")))
}

/// rule.id を key で引く。
async fn resolve_rule_id(conn: &mut SqliteConnection, key: &str) -> Result<Option<i64>, String> {
    let row = sqlx::query("SELECT id FROM rule WHERE key = ? LIMIT 1")
        .bind(key)
        .fetch_optional(&mut *conn)
        .await
        .map_err(|e| e.to_string())?;
    Ok(row.map(|r| r.get("id")))
}

// ---------------------------------------------------------------------------
// stat.ink マスター API 取得
// ---------------------------------------------------------------------------

/// stat.ink マスター API から weapon / stage スラッグを取得し、
/// weapon.statink_key / map.statink_key を UPDATE（または INSERT）する。
pub async fn sync_statink_masters(pool: &DbPool, client: &Client) -> Result<(usize, usize), String> {
    let weapon_count = sync_weapon_masters(pool, client).await?;
    let stage_count  = sync_stage_masters(pool, client).await?;
    Ok((weapon_count, stage_count))
}

async fn sync_weapon_masters(pool: &DbPool, client: &Client) -> Result<usize, String> {
    let resp = client
        .get("https://stat.ink/api/v3/weapon")
        .header("User-Agent", USER_AGENT)
        .send()
        .await
        .map_err(|e| format!("stat.ink weapon API エラー: {e}"))?;
    if !resp.status().is_success() {
        return Err(format!("stat.ink weapon API 失敗: {}", resp.status()));
    }
    let items: Vec<serde_json::Value> = resp.json().await.map_err(|e| e.to_string())?;
    let mut count = 0usize;
    for item in &items {
        let Some(key) = item.get("key").and_then(|v| v.as_str()) else { continue };
        let name_ja = item
            .pointer("/name/ja_JP")
            .or_else(|| item.pointer("/name/ja-JP"))
            .and_then(|v| v.as_str())
            .unwrap_or(key);
        // key=statink_key に合わせて upsert: key が既にあれば statink_key を更新、なければ INSERT。
        sqlx::query(
            "INSERT INTO weapon (key, name_ja, statink_key)
             VALUES (?, ?, ?)
             ON CONFLICT(key) DO UPDATE SET statink_key = excluded.statink_key,
                                             name_ja    = COALESCE(NULLIF(name_ja, key), excluded.name_ja)",
        )
        .bind(name_ja)  // chartoon は name_ja をプライマリキーとして使う場合があるため name_ja 優先
        .bind(name_ja)
        .bind(key)
        .execute(pool.as_ref())
        .await
        .map_err(|e| e.to_string())?;

        // statink_key が設定されていない既存行（name_ja で照合）も更新。
        sqlx::query(
            "UPDATE weapon SET statink_key = ? WHERE name_ja = ? AND (statink_key IS NULL OR statink_key = '')",
        )
        .bind(key)
        .bind(name_ja)
        .execute(pool.as_ref())
        .await
        .map_err(|e| e.to_string())?;
        count += 1;
    }
    log::info!("[env_import] weapon マスター同期 {} 件", count);
    Ok(count)
}

async fn sync_stage_masters(pool: &DbPool, client: &Client) -> Result<usize, String> {
    let resp = client
        .get("https://stat.ink/api/v3/stage")
        .header("User-Agent", USER_AGENT)
        .send()
        .await
        .map_err(|e| format!("stat.ink stage API エラー: {e}"))?;
    if !resp.status().is_success() {
        return Err(format!("stat.ink stage API 失敗: {}", resp.status()));
    }
    let items: Vec<serde_json::Value> = resp.json().await.map_err(|e| e.to_string())?;
    let mut count = 0usize;
    for item in &items {
        let Some(key) = item.get("key").and_then(|v| v.as_str()) else { continue };
        let name_ja = item
            .pointer("/name/ja_JP")
            .or_else(|| item.pointer("/name/ja-JP"))
            .and_then(|v| v.as_str())
            .unwrap_or(key);
        // 既存マップは name_ja または splatnet3_id で管理されているため、
        // statink_key が未設定のものを name_ja で照合して更新する。
        sqlx::query(
            "UPDATE map SET statink_key = ? WHERE name_ja = ? AND (statink_key IS NULL OR statink_key = '')",
        )
        .bind(key)
        .bind(name_ja)
        .execute(pool.as_ref())
        .await
        .map_err(|e| e.to_string())?;
        // statink_key 新規行（chartoon 未登場ステージ）は key=statink_key で INSERT。
        sqlx::query(
            "INSERT OR IGNORE INTO map (key, name_ja, statink_key) VALUES (?, ?, ?)",
        )
        .bind(key)
        .bind(name_ja)
        .bind(key)
        .execute(pool.as_ref())
        .await
        .map_err(|e| e.to_string())?;
        count += 1;
    }
    log::info!("[env_import] stage マスター同期 {} 件", count);
    Ok(count)
}

// ---------------------------------------------------------------------------
// CSV 1 行パース
// ---------------------------------------------------------------------------

/// stat.ink CSV のカラム位置が想定とズレていないかをヘッダ名で検証する（#336 再発防止）。
/// 位置がズレたまま取り込むと kill / death / inked などが静かに壊れるため、
/// 主要カラムの名前が一致しなければ Err を返す（呼び出し元はその CSV をスキップする）。
fn validate_env_csv_header(headers: &csv::StringRecord) -> Result<(), String> {
    const EXPECT: &[(usize, &str)] = &[
        (COL_MODE,        "mode"),
        (COL_STAGE,       "stage"),
        (COL_WIN,         "win"),
        (COL_ALPHA_INKED, "alpha-inked"),
        (COL_A1_WEAPON,   "A1-weapon"),
        (COL_A1_KILL,     "A1-kill"),
        (COL_A1_ASSIST,   "A1-assist"),
        (COL_A1_DEATH,    "A1-death"),
        (COL_A1_INKED,    "A1-inked"),
        (COL_B1_KILL,     "B1-kill"),
        (COL_B1_INKED,    "B1-inked"),
    ];
    for &(idx, name) in EXPECT {
        let got = headers.get(idx).unwrap_or("");
        if got != name {
            return Err(format!(
                "カラム構成が想定と異なります（列 {idx} は \"{name}\" のはずが \"{got}\"）。アプリの更新が必要な可能性があります"
            ));
        }
    }
    Ok(())
}

fn opt_str<'a>(fields: &'a [&'a str], idx: usize) -> Option<&'a str> {
    let s = fields.get(idx).copied().unwrap_or("").trim();
    if s.is_empty() { None } else { Some(s) }
}

fn opt_i64(fields: &[&str], idx: usize) -> Option<i64> {
    opt_str(fields, idx).and_then(|s| s.parse().ok())
}

fn opt_f64(fields: &[&str], idx: usize) -> Option<f64> {
    opt_str(fields, idx).and_then(|s| s.parse().ok())
}

// ---------------------------------------------------------------------------
// インポート本体
// ---------------------------------------------------------------------------

const BATCH_SIZE: usize = 1000;

/// 1 CSV のバイト列を解析して env_battles に INSERT し、挿入件数を返す。
///
/// `source_date` は "YYYY-MM-DD" 文字列（CSV ファイル名由来）。
async fn import_csv_bytes(
    conn: &mut SqliteConnection,
    bytes: &[u8],
    source_date: &str,
    // ロビー・ルール・ステージ・武器の id キャッシュ（呼び出し元で使い回す）
    lobby_cache:  &mut std::collections::HashMap<String, Option<i64>>,
    rule_cache:   &mut std::collections::HashMap<String, Option<i64>>,
    map_cache:    &mut std::collections::HashMap<String, Option<i64>>,
    weapon_cache: &mut std::collections::HashMap<String, Option<i64>>,
) -> Result<usize, String> {
    let mut rdr = csv::ReaderBuilder::new()
        .flexible(true)
        .from_reader(Cursor::new(bytes));

    // カラム位置がズレていないかヘッダ名で検証する（#336 再発防止）。
    // ズレていれば「静かに壊れたデータを入れる」より、その CSV を丸ごとスキップする方が安全。
    if let Ok(headers) = rdr.headers() {
        if let Err(msg) = validate_env_csv_header(headers) {
            log::warn!("[env_import] {source_date} スキップ: {msg}");
            return Ok(0);
        }
    }

    let mut batch: Vec<EnvBattleRow> = Vec::with_capacity(BATCH_SIZE);
    let mut inserted = 0usize;

    // 1 日 (1 CSV) を 1 トランザクションで囲む。途中でエラーになれば commit されず
    // 全ロールバックされるため、「部分的にしか入っていない日」が残らない。これにより
    // 差分取得 (MAX(source_date)+1 起点) が中断後も正しく欠損日を埋められる。
    let mut tx = conn.begin().await.map_err(|e| e.to_string())?;

    for result in rdr.records() {
        let record = match result {
            Ok(r) => r,
            Err(_) => continue,
        };
        let fields: Vec<&str> = record.iter().collect();
        if fields.len() < 60 {
            continue;
        }

        // win_team
        let win = opt_str(&fields, COL_WIN).unwrap_or("alpha");
        let win_team = match win {
            "alpha" => "alpha",
            "bravo" => "bravo",
            _ => continue, // 不正値はスキップ
        };

        // lobby_id
        let lobby_key = opt_str(&fields, COL_LOBBY).unwrap_or("");
        let lobby_id = if let Some(id) = lobby_cache.get(lobby_key) {
            *id
        } else {
            let mapped = csv_lobby_to_key(lobby_key);
            let id = if let Some(k) = mapped {
                resolve_lobby_id(&mut *tx, k).await?
            } else {
                None
            };
            lobby_cache.insert(lobby_key.to_string(), id);
            id
        };

        // rule_id
        let mode_key = opt_str(&fields, COL_MODE).unwrap_or("");
        let rule_id = if let Some(id) = rule_cache.get(mode_key) {
            *id
        } else {
            let mapped = csv_mode_to_rule_key(mode_key);
            let id = if let Some(k) = mapped {
                resolve_rule_id(&mut *tx, k).await?
            } else {
                None
            };
            rule_cache.insert(mode_key.to_string(), id);
            id
        };

        // map_id
        let stage_key = opt_str(&fields, COL_STAGE).unwrap_or("");
        let map_id = if let Some(id) = map_cache.get(stage_key) {
            *id
        } else {
            let id = if stage_key.is_empty() {
                None
            } else {
                resolve_map_id(&mut *tx, stage_key).await?
            };
            map_cache.insert(stage_key.to_string(), id);
            id
        };

        // 武器スラッグ → weapon_id（キャッシュ付き）
        // キャッシュにないスラッグを先に非同期解決してからキャッシュを参照する。
        let weapon_cols = [
            COL_A1_WEAPON, COL_A2_WEAPON, COL_A3_WEAPON, COL_A4_WEAPON,
            COL_B1_WEAPON, COL_B2_WEAPON, COL_B3_WEAPON, COL_B4_WEAPON,
        ];
        for &col in &weapon_cols {
            let slug = fields.get(col).copied().unwrap_or("").trim();
            if !slug.is_empty() && !weapon_cache.contains_key(slug) {
                let id = resolve_weapon_id(&mut *tx, slug).await?;
                weapon_cache.insert(slug.to_string(), id);
            }
        }

        // キャッシュ参照クロージャ（この時点では weapon_cache は既に更新済み）。
        let wid = |idx: usize| -> Option<i64> {
            weapon_cache.get(fields.get(idx).copied().unwrap_or("")).copied().flatten()
        };

        let period = opt_str(&fields, COL_PERIOD).unwrap_or("").to_string();

        let row = EnvBattleRow {
            source_date: source_date.to_string(),
            lobby_id,
            rule_id,
            map_id,
            period,
            season:   opt_str(&fields, COL_SEASON).map(|s| s.to_string()),
            game_ver: opt_str(&fields, COL_GAME_VER).map(|s| s.to_string()),
            win_team: win_team.to_string(),
            knockout: opt_str(&fields, COL_KNOCKOUT).map(|s| if s == "1" { 1i64 } else { 0 }),
            alpha_inked:       opt_i64(&fields, COL_ALPHA_INKED),
            alpha_ink_percent: opt_f64(&fields, COL_ALPHA_INK_PERCENT),
            alpha_count:       opt_i64(&fields, COL_ALPHA_COUNT),
            bravo_inked:       opt_i64(&fields, COL_BRAVO_INKED),
            bravo_ink_percent: opt_f64(&fields, COL_BRAVO_INK_PERCENT),
            bravo_count:       opt_i64(&fields, COL_BRAVO_COUNT),
            poster_rank:  opt_str(&fields, COL_POSTER_RANK).map(|s| s.to_string()),
            poster_power: opt_f64(&fields, COL_POSTER_POWER),
            a1_weapon_id: wid(COL_A1_WEAPON),
            a2_weapon_id: wid(COL_A2_WEAPON),
            a3_weapon_id: wid(COL_A3_WEAPON),
            a4_weapon_id: wid(COL_A4_WEAPON),
            b1_weapon_id: wid(COL_B1_WEAPON),
            b2_weapon_id: wid(COL_B2_WEAPON),
            b3_weapon_id: wid(COL_B3_WEAPON),
            b4_weapon_id: wid(COL_B4_WEAPON),
            a1_kill:   opt_i64(&fields, COL_A1_KILL),
            a1_death:  opt_i64(&fields, COL_A1_DEATH),
            a1_assist: opt_i64(&fields, COL_A1_ASSIST),
            a1_inked:  opt_i64(&fields, COL_A1_INKED),
            b1_kill:   opt_i64(&fields, COL_B1_KILL),
            b1_death:  opt_i64(&fields, COL_B1_DEATH),
            b1_assist: opt_i64(&fields, COL_B1_ASSIST),
            b1_inked:  opt_i64(&fields, COL_B1_INKED),
        };

        batch.push(row);
        if batch.len() >= BATCH_SIZE {
            inserted += flush_batch(&mut *tx, &mut batch).await?;
        }
    }
    if !batch.is_empty() {
        inserted += flush_batch(&mut *tx, &mut batch).await?;
    }
    tx.commit().await.map_err(|e| e.to_string())?;
    Ok(inserted)
}

/// バッチを env_battles に INSERT する。
async fn flush_batch(conn: &mut SqliteConnection, batch: &mut Vec<EnvBattleRow>) -> Result<usize, String> {
    let n = batch.len();
    if n == 0 {
        return Ok(0);
    }
    // トランザクション制御は呼び出し元（import_csv_bytes が 1 日 = 1 トランザクション）が持つ。
    // ここでは渡されたトランザクション上にバッチをまとめて INSERT するだけ。
    for row in batch.drain(..) {
        sqlx::query(
            "INSERT INTO env_battles
             (source_date, lobby_id, rule_id, map_id, period, season, game_ver,
              win_team, knockout,
              alpha_inked, alpha_ink_percent, alpha_count,
              bravo_inked, bravo_ink_percent, bravo_count,
              poster_rank, poster_power,
              a1_weapon_id, a2_weapon_id, a3_weapon_id, a4_weapon_id,
              b1_weapon_id, b2_weapon_id, b3_weapon_id, b4_weapon_id,
              a1_kill, a1_death, a1_assist, a1_inked,
              b1_kill, b1_death, b1_assist, b1_inked)
             VALUES
             (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
        )
        .bind(&row.source_date)
        .bind(row.lobby_id)
        .bind(row.rule_id)
        .bind(row.map_id)
        .bind(&row.period)
        .bind(&row.season)
        .bind(&row.game_ver)
        .bind(&row.win_team)
        .bind(row.knockout)
        .bind(row.alpha_inked)
        .bind(row.alpha_ink_percent)
        .bind(row.alpha_count)
        .bind(row.bravo_inked)
        .bind(row.bravo_ink_percent)
        .bind(row.bravo_count)
        .bind(&row.poster_rank)
        .bind(row.poster_power)
        .bind(row.a1_weapon_id)
        .bind(row.a2_weapon_id)
        .bind(row.a3_weapon_id)
        .bind(row.a4_weapon_id)
        .bind(row.b1_weapon_id)
        .bind(row.b2_weapon_id)
        .bind(row.b3_weapon_id)
        .bind(row.b4_weapon_id)
        .bind(row.a1_kill)
        .bind(row.a1_death)
        .bind(row.a1_assist)
        .bind(row.a1_inked)
        .bind(row.b1_kill)
        .bind(row.b1_death)
        .bind(row.b1_assist)
        .bind(row.b1_inked)
        .execute(&mut *conn)
        .await
        .map_err(|e| e.to_string())?;
    }
    Ok(n)
}

/// 1 行分の env_battles INSERT データ。
struct EnvBattleRow {
    source_date: String,
    lobby_id:    Option<i64>,
    rule_id:     Option<i64>,
    map_id:      Option<i64>,
    period:      String,
    season:      Option<String>,
    game_ver:    Option<String>,
    win_team:    String,
    knockout:    Option<i64>,
    alpha_inked:       Option<i64>,
    alpha_ink_percent: Option<f64>,
    alpha_count:       Option<i64>,
    bravo_inked:       Option<i64>,
    bravo_ink_percent: Option<f64>,
    bravo_count:       Option<i64>,
    poster_rank:       Option<String>,
    poster_power:      Option<f64>,
    a1_weapon_id: Option<i64>,
    a2_weapon_id: Option<i64>,
    a3_weapon_id: Option<i64>,
    a4_weapon_id: Option<i64>,
    b1_weapon_id: Option<i64>,
    b2_weapon_id: Option<i64>,
    b3_weapon_id: Option<i64>,
    b4_weapon_id: Option<i64>,
    a1_kill:   Option<i64>,
    a1_death:  Option<i64>,
    a1_assist: Option<i64>,
    a1_inked:  Option<i64>,
    b1_kill:   Option<i64>,
    b1_death:  Option<i64>,
    b1_assist: Option<i64>,
    b1_inked:  Option<i64>,
}

// ---------------------------------------------------------------------------
// Tauri コマンド
// ---------------------------------------------------------------------------

/// stat.ink マスター API を叩いて weapon / map の statink_key を更新する。
#[tauri::command]
pub async fn sync_env_masters(
    db: tauri::State<'_, DbPool>,
) -> Result<(usize, usize), String> {
    let client = crate::http::build_client()?;
    sync_statink_masters(&db, &client).await
}

/// 全期間 ZIP をダウンロードして env_battles に取り込む。
///
/// 進捗は "env_import_progress" emit で通知する。
#[tauri::command]
pub async fn import_env_full(
    app: AppHandle,
    db:  tauri::State<'_, DbPool>,
) -> Result<usize, String> {
    let client = crate::http::build_client()?;

    // まずマスターを同期する。
    sync_statink_masters(&db, &client).await?;

    // ZIP ダウンロード
    emit_progress(&app, 0, 1, "download");
    log::info!("[env_import] ZIP ダウンロード開始: {ZIP_URL}");
    let resp = client
        .get(ZIP_URL)
        .header("User-Agent", USER_AGENT)
        .send()
        .await
        .map_err(|e| format!("ZIP DL エラー: {e}"))?;
    if !resp.status().is_success() {
        return Err(format!("ZIP DL 失敗: {}", resp.status()));
    }
    let bytes = resp.bytes().await.map_err(|e| e.to_string())?;
    emit_progress(&app, 1, 1, "download");
    log::info!("[env_import] ZIP DL 完了 ({} MiB)", bytes.len() / 1024 / 1024);

    // ── インポート専用コネクションを 1 本確保する ──
    // 以降の PRAGMA・DELETE・全 INSERT・インデックス再作成をすべてこの 1 本で実行する。
    // プール（最大 10 コネクション）に対して PRAGMA を打つと借りた 1 本にしか効かず、
    // しかも実行後プールへ返却されてしまうため、書き込みごとに別コネクションへ散って
    // journal_mode が混在し "database is locked" を誘発していた。専用コネクション固定で解消する。
    let mut conn = db.acquire().await.map_err(|e| format!("DB コネクション取得失敗: {e}"))?;

    // ── バルクインポート高速化のセットアップ（この 1 本のコネクションにのみ適用）──
    // synchronous=OFF + temp_store=MEMORY で fsync を減らす。
    // journal_mode は WAL のまま維持する（MEMORY にすると他コネクションと混在して
    // ロック競合し、かつ中断時に DB 破損リスクがある）。
    // FK 検証はインポート中のみオフ（参照先 id は解決済み or NULL なので整合は保てる）。
    for pragma in [
        "PRAGMA busy_timeout = 30000",
        "PRAGMA foreign_keys = OFF",
        "PRAGMA synchronous = OFF",
        "PRAGMA temp_store = MEMORY",
    ] {
        let _ = sqlx::query(pragma).execute(&mut *conn).await;
    }
    // env_battles のインデックスを DROP（インポート中の逐次更新を避け、全行挿入後に一括 CREATE）。
    for idx in [
        "idx_env_date_rule", "idx_env_date_map", "idx_env_date_lobby",
        "idx_env_a1_weapon", "idx_env_b1_weapon",
    ] {
        let _ = sqlx::query(&format!("DROP INDEX IF EXISTS {idx}"))
            .execute(&mut *conn).await;
    }

    // 全期間取り込みなので既存の env_battles を一旦クリア（中断後の再実行で重複を防ぐ）。
    sqlx::query("DELETE FROM env_battles")
        .execute(&mut *conn)
        .await
        .map_err(|e| format!("env_battles クリア失敗: {e}"))?;

    // ZIP 解凍 + CSV インポート
    let mut archive = ZipArchive::new(Cursor::new(bytes.as_ref()))
        .map_err(|e| format!("ZIP オープン失敗: {e}"))?;
    let total_entries = archive.len();
    log::info!("[env_import] ZIP エントリ数: {total_entries}");

    let mut lobby_cache:  std::collections::HashMap<String, Option<i64>> = Default::default();
    let mut rule_cache:   std::collections::HashMap<String, Option<i64>> = Default::default();
    let mut map_cache:    std::collections::HashMap<String, Option<i64>> = Default::default();
    let mut weapon_cache: std::collections::HashMap<String, Option<i64>> = Default::default();
    let mut total_inserted = 0usize;

    // エントリを日付昇順で処理する。ZIP の格納順は日付順とは限らず、順不同のまま
    // 途中で止まると MAX(source_date) より前の未処理日が差分取得でスキップされてしまう。
    // 先に (日付, index) を集めてソートし、必ず古い日から順に取り込む。
    let mut entries: Vec<(String, usize)> = Vec::with_capacity(total_entries);
    for i in 0..total_entries {
        // ファイル名から日付を抽出: YYYY/MM/YYYY-MM-DD.csv
        let name = archive
            .by_index(i)
            .map_err(|e| format!("ZIP エントリ {i} 読み込み失敗: {e}"))?
            .name()
            .to_string();
        let date = extract_date_from_path(&name);
        if !date.is_empty() {
            entries.push((date, i));
        }
    }
    entries.sort();
    let total_days = entries.len();
    log::info!("[env_import] 取り込み対象 {total_days} 日分");

    for (processed, (source_date, idx)) in entries.iter().enumerate() {
        emit_progress(&app, processed, total_days, "extract");
        let csv_bytes = {
            let mut entry = archive.by_index(*idx)
                .map_err(|e| format!("ZIP エントリ {idx} 読み込み失敗: {e}"))?;
            let mut buf = Vec::new();
            entry.read_to_end(&mut buf).map_err(|e| e.to_string())?;
            buf
        };

        let inserted = import_csv_bytes(
            &mut *conn, &csv_bytes, source_date,
            &mut lobby_cache, &mut rule_cache, &mut map_cache, &mut weapon_cache,
        ).await?;
        total_inserted += inserted;

        if processed % 50 == 0 {
            log::info!("[env_import] {} / {} 日処理済み (累計 {} 行)", processed + 1, total_days, total_inserted);
        }
    }

    // ── 全行挿入後にインデックスをまとめて再作成 ──
    emit_progress(&app, total_days, total_days, "index");
    log::info!("[env_import] インデックス再構築中...");
    for sql in [
        "CREATE INDEX IF NOT EXISTS idx_env_date_rule  ON env_battles(source_date, rule_id)",
        "CREATE INDEX IF NOT EXISTS idx_env_date_map   ON env_battles(source_date, map_id)",
        "CREATE INDEX IF NOT EXISTS idx_env_date_lobby ON env_battles(source_date, lobby_id)",
        "CREATE INDEX IF NOT EXISTS idx_env_a1_weapon  ON env_battles(a1_weapon_id)",
        "CREATE INDEX IF NOT EXISTS idx_env_b1_weapon  ON env_battles(b1_weapon_id)",
    ] {
        sqlx::query(sql).execute(&mut *conn).await
            .map_err(|e| format!("インデックス再作成失敗: {e}"))?;
    }

    // PRAGMA を通常運用の安全側に戻してからコネクションをプールへ返却する
    // （journal_mode は WAL のまま変更していない）。
    for pragma in [
        "PRAGMA foreign_keys = ON",
        "PRAGMA synchronous = NORMAL",
    ] {
        let _ = sqlx::query(pragma).execute(&mut *conn).await;
    }
    drop(conn);

    emit_progress(&app, total_days, total_days, "import");
    log::info!("[env_import] 完了: 合計 {total_inserted} 行挿入");
    Ok(total_inserted)
}

/// 差分（最終取得日の翌日〜前日）を日次 CSV で取り込む。
#[tauri::command]
pub async fn import_env_delta(
    app: AppHandle,
    db:  tauri::State<'_, DbPool>,
) -> Result<usize, String> {
    let client = crate::http::build_client()?;

    // マスター同期
    sync_statink_masters(&db, &client).await?;

    // 最終取得日を調べる。
    let row = sqlx::query("SELECT MAX(source_date) AS max_d FROM env_battles")
        .fetch_one(db.as_ref())
        .await
        .map_err(|e| e.to_string())?;
    let max_date: Option<String> = row.try_get("max_d").ok().flatten();

    // 取得対象日の一覧: max_date + 1 day 〜 昨日。
    let dates = build_date_range(max_date.as_deref());
    if dates.is_empty() {
        log::info!("[env_import] 差分なし（最新は {:?}）", max_date);
        return Ok(0);
    }

    let total = dates.len();
    let mut lobby_cache:  std::collections::HashMap<String, Option<i64>> = Default::default();
    let mut rule_cache:   std::collections::HashMap<String, Option<i64>> = Default::default();
    let mut map_cache:    std::collections::HashMap<String, Option<i64>> = Default::default();
    let mut weapon_cache: std::collections::HashMap<String, Option<i64>> = Default::default();
    let mut total_inserted = 0usize;

    // 差分取り込みも専用コネクション 1 本に固定し、書き込みを散らさない。
    let mut conn = db.acquire().await.map_err(|e| format!("DB コネクション取得失敗: {e}"))?;

    for (idx, date) in dates.iter().enumerate() {
        emit_progress(&app, idx, total, "download");
        let (year, month) = (&date[..4], &date[5..7]);
        let url = format!("{DAILY_BASE}/{year}/{month}/{date}.csv");
        let resp = match client
            .get(&url)
            .header("User-Agent", USER_AGENT)
            .send()
            .await
        {
            Ok(r) if r.status() == 404 => {
                log::info!("[env_import] {} 404 スキップ", date);
                continue;
            }
            Ok(r) if !r.status().is_success() => {
                log::warn!("[env_import] {} 取得失敗 {}", date, r.status());
                continue;
            }
            Ok(r) => r,
            Err(e) => {
                log::warn!("[env_import] {} 通信エラー: {e}", date);
                continue;
            }
        };
        let csv_bytes = resp.bytes().await.map_err(|e| e.to_string())?;
        let inserted = import_csv_bytes(
            &mut *conn, &csv_bytes, date,
            &mut lobby_cache, &mut rule_cache, &mut map_cache, &mut weapon_cache,
        ).await?;
        total_inserted += inserted;
        log::info!("[env_import] {} → {} 行挿入", date, inserted);
    }

    emit_progress(&app, total, total, "import");
    log::info!("[env_import] 差分インポート完了: {total_inserted} 行");
    Ok(total_inserted)
}

// ---------------------------------------------------------------------------
// ユーティリティ
// ---------------------------------------------------------------------------

fn emit_progress(app: &AppHandle, current: usize, total: usize, phase: &str) {
    let _ = app.emit("env_import_progress", ImportProgress {
        current,
        total,
        phase: phase.to_string(),
    });
}

/// "YYYY/MM/YYYY-MM-DD.csv" 形式のパスから "YYYY-MM-DD" を抽出する。
fn extract_date_from_path(path: &str) -> String {
    // 末尾のファイル名部分を取る。
    let fname = path.rsplit('/').next().unwrap_or(path);
    if fname.len() >= 10 && fname[..10].chars().all(|c| c.is_ascii_digit() || c == '-') {
        fname[..10].to_string()
    } else {
        String::new()
    }
}

/// max_date の翌日から昨日までの "YYYY-MM-DD" 一覧を返す。
fn build_date_range(max_date: Option<&str>) -> Vec<String> {
    use chrono::{Duration, NaiveDate, Utc};

    let yesterday = (Utc::now() - Duration::days(1)).date_naive();
    let start = if let Some(d) = max_date {
        // parse 失敗時は空リスト返す（安全側）。
        match NaiveDate::parse_from_str(d, "%Y-%m-%d") {
            Ok(dt) => dt + Duration::days(1),
            Err(_) => return Vec::new(),
        }
    } else {
        // 全期間取得前の差分実行は想定外だが、安全に昨日だけ返す。
        yesterday
    };

    let mut dates = Vec::new();
    let mut cur = start;
    while cur <= yesterday {
        dates.push(cur.format("%Y-%m-%d").to_string());
        cur += Duration::days(1);
    }
    dates
}
