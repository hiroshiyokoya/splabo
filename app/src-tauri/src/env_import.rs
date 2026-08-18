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

/// per-player ブロック 1 個分の読み出し位置。kill-assist(offset1) / special(offset5) /
/// abilities(offset7) は集計に使わないので持たない。
struct SlotCols {
    weapon: usize,
    kill:   usize,
    assist: usize,
    death:  usize,
    inked:  usize,
}

const fn slot_cols(base: usize) -> SlotCols {
    SlotCols { weapon: base, kill: base + 2, assist: base + 3, death: base + 4, inked: base + 6 }
}

/// A1–A4 / B1–B4 の順。A1 が投稿者本人。
/// stat.ink CSV は 8 人全員の kill/assist/death/inked を持つので全スロットを取り込む（#501）。
const SLOTS: [SlotCols; 8] = [
    slot_cols(21), slot_cols(29), slot_cols(37), slot_cols(45),
    slot_cols(53), slot_cols(61), slot_cols(69), slot_cols(77),
];

/// `SLOTS` と同じ並びの env_battles カラム接頭辞。
const SLOT_NAMES: [&str; 8] = ["a1", "a2", "a3", "a4", "b1", "b2", "b3", "b4"];

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
    // カテゴリ / サブ / スペシャル・英語名は同梱の静的マスターから埋める（#492・#712）。
    let attrs = crate::weapon_static::lookup(statink_key);
    let name_en = crate::weapon_static::lookup_name_en(statink_key);
    sqlx::query(
        "INSERT OR IGNORE INTO weapon (key, name_ja, name_en, statink_key, category_key, sub_key, special_key)
         VALUES (?, ?, ?, ?, ?, ?, ?)",
    )
    .bind(statink_key)
    .bind(statink_key) // name_ja は後でマスター API から上書きされる
    .bind(name_en)
    .bind(statink_key)
    .bind(attrs.map(|(cat, _, _)| cat))
    .bind(attrs.map(|(_, sub, _)| sub))
    .bind(attrs.map(|(_, _, sp)| sp))
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
    let name_en = crate::stage_static::lookup_name_en(statink_key);
    sqlx::query(
        "INSERT OR IGNORE INTO map (key, name_ja, name_en, statink_key) VALUES (?, ?, ?, ?)",
    )
    .bind(statink_key)
    .bind(statink_key)
    .bind(name_en)
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
        // ブキ種 / サブ / スペシャルの日本語名（#492: 未分類をなくす）
        // カテゴリは公式準拠へ正規化（stat.ink の「リールガン」→「シューター」・#523）
        let ja = |ptr: &str| item.pointer(ptr).and_then(|v| v.as_str()).map(str::to_string);
        let category = ja("/type/name/ja_JP").map(|c| {
            crate::weapon_static::normalize_category(&c).to_string()
        });
        let sub      = ja("/sub/name/ja_JP");
        let special  = ja("/special/name/ja_JP");
        // key=statink_key に合わせて upsert: key が既にあれば statink_key を更新、なければ INSERT。
        // 属性は空欄のときだけ API 値で埋める（SplatNet 由来の既存値は温存）。
        sqlx::query(
            "INSERT INTO weapon (key, name_ja, statink_key, category_key, sub_key, special_key)
             VALUES (?, ?, ?, ?, ?, ?)
             ON CONFLICT(key) DO UPDATE SET
                 statink_key  = excluded.statink_key,
                 name_ja      = COALESCE(NULLIF(name_ja, key), excluded.name_ja),
                 category_key = COALESCE(NULLIF(category_key, ''), excluded.category_key),
                 sub_key      = COALESCE(NULLIF(sub_key, ''),      excluded.sub_key),
                 special_key  = COALESCE(NULLIF(special_key, ''),  excluded.special_key)",
        )
        .bind(name_ja)  // chartoon は name_ja をプライマリキーとして使う場合があるため name_ja 優先
        .bind(name_ja)
        .bind(key)
        .bind(&category)
        .bind(&sub)
        .bind(&special)
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

        // 属性が空欄のままの既存行（statink_key で照合）を API 値で埋める（#492）。
        sqlx::query(
            "UPDATE weapon
                SET category_key = COALESCE(NULLIF(category_key, ''), ?),
                    sub_key      = COALESCE(NULLIF(sub_key, ''),      ?),
                    special_key  = COALESCE(NULLIF(special_key, ''),  ?)
              WHERE statink_key = ?
                AND (category_key IS NULL OR category_key = ''
                     OR sub_key     IS NULL OR sub_key     = ''
                     OR special_key IS NULL OR special_key = '')",
        )
        .bind(&category)
        .bind(&sub)
        .bind(&special)
        .bind(key)
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
    ];
    let mut expect: Vec<(usize, String)> =
        EXPECT.iter().map(|&(i, n)| (i, n.to_string())).collect();
    // 8 スロット分の weapon/kill/assist/death/inked をすべて突き合わせる（#501 で全員分を読むため）。
    for (cols, name) in SLOTS.iter().zip(SLOT_NAMES) {
        let up = name.to_uppercase();
        expect.push((cols.weapon, format!("{up}-weapon")));
        expect.push((cols.kill,   format!("{up}-kill")));
        expect.push((cols.assist, format!("{up}-assist")));
        expect.push((cols.death,  format!("{up}-death")));
        expect.push((cols.inked,  format!("{up}-inked")));
    }
    for (idx, name) in expect {
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
    // ロビー・ルール・ステージ・ブキの id キャッシュ（呼び出し元で使い回す）
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

        // ブキスラッグ → weapon_id（キャッシュ付き）
        // キャッシュにないスラッグを先に非同期解決してからキャッシュを参照する。
        for cols in &SLOTS {
            let slug = fields.get(cols.weapon).copied().unwrap_or("").trim();
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
            slots: std::array::from_fn(|i| {
                let cols = &SLOTS[i];
                SlotStats {
                    weapon_id: wid(cols.weapon),
                    kill:      opt_i64(&fields, cols.kill),
                    death:     opt_i64(&fields, cols.death),
                    assist:    opt_i64(&fields, cols.assist),
                    inked:     opt_i64(&fields, cols.inked),
                }
            }),
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

/// env_battles の INSERT 文。列の並びは `flush_batch` のバインド順と一致させること。
fn env_insert_sql() -> String {
    let mut cols: Vec<String> = [
        "source_date", "lobby_id", "rule_id", "map_id", "period", "season", "game_ver",
        "win_team", "knockout",
        "alpha_inked", "alpha_ink_percent", "alpha_count",
        "bravo_inked", "bravo_ink_percent", "bravo_count",
        "poster_rank", "poster_power",
    ]
    .iter()
    .map(|s| s.to_string())
    .collect();
    for name in SLOT_NAMES {
        cols.push(format!("{name}_weapon_id"));
    }
    for name in SLOT_NAMES {
        for metric in ["kill", "death", "assist", "inked"] {
            cols.push(format!("{name}_{metric}"));
        }
    }
    let ph = vec!["?"; cols.len()].join(",");
    format!("INSERT INTO env_battles ({}) VALUES ({ph})", cols.join(", "))
}

/// バッチを env_battles に INSERT する。
async fn flush_batch(conn: &mut SqliteConnection, batch: &mut Vec<EnvBattleRow>) -> Result<usize, String> {
    let n = batch.len();
    if n == 0 {
        return Ok(0);
    }
    let sql = env_insert_sql();
    // トランザクション制御は呼び出し元（import_csv_bytes が 1 日 = 1 トランザクション）が持つ。
    // ここでは渡されたトランザクション上にバッチをまとめて INSERT するだけ。
    for row in batch.drain(..) {
        let mut q = sqlx::query(&sql)
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
            .bind(row.poster_power);
        for s in &row.slots {
            q = q.bind(s.weapon_id);
        }
        for s in &row.slots {
            q = q.bind(s.kill).bind(s.death).bind(s.assist).bind(s.inked);
        }
        q.execute(&mut *conn).await.map_err(|e| e.to_string())?;
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
    /// `SLOT_NAMES` と同じ並び（A1–A4 / B1–B4）。
    slots: [SlotStats; 8],
}

/// プレイヤー 1 人分の取り込み値。
struct SlotStats {
    weapon_id: Option<i64>,
    kill:      Option<i64>,
    death:     Option<i64>,
    assist:    Option<i64>,
    inked:     Option<i64>,
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

/// 環境データを入れ直す。`since` が無いときは全期間 ZIP、あるときはその日から昨日までの日次 CSV。
///
/// 進捗は "env_import_progress" emit で通知する。
#[tauri::command]
pub async fn import_env_full(
    app: AppHandle,
    db:  tauri::State<'_, DbPool>,
    since: Option<String>,
) -> Result<usize, String> {
    let since = since.filter(|s| !s.is_empty());
    match since {
        None => import_env_zip(app, db).await,
        Some(s) => import_env_from_date(app, db, s).await,
    }
}

/// 全期間 ZIP をダウンロードして env_battles に取り込む。
async fn import_env_zip(
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
    begin_env_replace(&mut *conn).await?;

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

    finish_env_replace(&app, &mut *conn, total_days).await?;
    drop(conn);

    emit_progress(&app, total_days, total_days, "import");
    log::info!("[env_import] 完了: 合計 {total_inserted} 行挿入");
    Ok(total_inserted)
}

/// 指定日から昨日までを日次 CSV で取り込む。既存の env_battles は消す。
async fn import_env_from_date(
    app: AppHandle,
    db:  tauri::State<'_, DbPool>,
    since: String,
) -> Result<usize, String> {
    let dates = dates_from_since(&since)?;
    if dates.is_empty() {
        return Err("取得する日がありません".into());
    }
    log::info!("[env_import] 日次 CSV {} 日分 ({} 〜 {})", dates.len(), dates.first().unwrap(), dates.last().unwrap());

    let client = crate::http::build_client()?;
    sync_statink_masters(&db, &client).await?;

    let mut conn = db.acquire().await.map_err(|e| format!("DB コネクション取得失敗: {e}"))?;
    begin_env_replace(&mut *conn).await?;

    let mut lobby_cache:  std::collections::HashMap<String, Option<i64>> = Default::default();
    let mut rule_cache:   std::collections::HashMap<String, Option<i64>> = Default::default();
    let mut map_cache:    std::collections::HashMap<String, Option<i64>> = Default::default();
    let mut weapon_cache: std::collections::HashMap<String, Option<i64>> = Default::default();
    let total_inserted = import_daily_csvs(
        &app, &client, &mut *conn, &dates,
        &mut lobby_cache, &mut rule_cache, &mut map_cache, &mut weapon_cache,
    ).await?;

    finish_env_replace(&app, &mut *conn, dates.len()).await?;
    drop(conn);
    emit_progress(&app, dates.len(), dates.len(), "import");
    log::info!("[env_import] 完了: 合計 {total_inserted} 行挿入 (since={since})");
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

    let mut lobby_cache:  std::collections::HashMap<String, Option<i64>> = Default::default();
    let mut rule_cache:   std::collections::HashMap<String, Option<i64>> = Default::default();
    let mut map_cache:    std::collections::HashMap<String, Option<i64>> = Default::default();
    let mut weapon_cache: std::collections::HashMap<String, Option<i64>> = Default::default();

    // 差分取り込みも専用コネクション 1 本に固定し、書き込みを散らさない。
    let mut conn = db.acquire().await.map_err(|e| format!("DB コネクション取得失敗: {e}"))?;
    let total_inserted = import_daily_csvs(
        &app, &client, &mut *conn, &dates,
        &mut lobby_cache, &mut rule_cache, &mut map_cache, &mut weapon_cache,
    ).await?;

    emit_progress(&app, dates.len(), dates.len(), "import");
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

const ENV_INDEX_NAMES: &[&str] = &[
    "idx_env_date_rule", "idx_env_date_map", "idx_env_date_lobby",
    "idx_env_a1_weapon", "idx_env_b1_weapon",
    "idx_env_a2_weapon", "idx_env_a3_weapon", "idx_env_a4_weapon",
    "idx_env_b2_weapon", "idx_env_b3_weapon", "idx_env_b4_weapon",
];

/// 入れ直し用: 索引を外し、既存行を消す。専用コネクション 1 本にだけ PRAGMA を当てる。
///
/// journal_mode は WAL のまま（MEMORY にすると他コネクションと混在してロックし、
/// 中断時に DB 破損リスクがある）。FK は参照先 id が解決済み or NULL なので一時オフ可。
/// 索引名を足し忘れると再取得のたびに消えて、ブキ選択肢が 50 秒に戻る（#602）。
async fn begin_env_replace(conn: &mut SqliteConnection) -> Result<(), String> {
    for pragma in [
        "PRAGMA busy_timeout = 30000",
        "PRAGMA foreign_keys = OFF",
        "PRAGMA synchronous = OFF",
        "PRAGMA temp_store = MEMORY",
    ] {
        let _ = sqlx::query(pragma).execute(&mut *conn).await;
    }
    for idx in ENV_INDEX_NAMES {
        let _ = sqlx::query(&format!("DROP INDEX IF EXISTS {idx}"))
            .execute(&mut *conn).await;
    }
    sqlx::query("DELETE FROM env_battles")
        .execute(&mut *conn)
        .await
        .map_err(|e| format!("env_battles クリア失敗: {e}"))?;
    Ok(())
}

async fn finish_env_replace(
    app: &AppHandle,
    conn: &mut SqliteConnection,
    total_days: usize,
) -> Result<(), String> {
    emit_progress(app, total_days, total_days, "index");
    log::info!("[env_import] インデックス再構築中...");
    for sql in [
        "CREATE INDEX IF NOT EXISTS idx_env_date_rule  ON env_battles(source_date, rule_id)",
        "CREATE INDEX IF NOT EXISTS idx_env_date_map   ON env_battles(source_date, map_id)",
        "CREATE INDEX IF NOT EXISTS idx_env_date_lobby ON env_battles(source_date, lobby_id)",
        "CREATE INDEX IF NOT EXISTS idx_env_a1_weapon  ON env_battles(a1_weapon_id)",
        "CREATE INDEX IF NOT EXISTS idx_env_b1_weapon  ON env_battles(b1_weapon_id)",
        "CREATE INDEX IF NOT EXISTS idx_env_a2_weapon  ON env_battles(a2_weapon_id)",
        "CREATE INDEX IF NOT EXISTS idx_env_a3_weapon  ON env_battles(a3_weapon_id)",
        "CREATE INDEX IF NOT EXISTS idx_env_a4_weapon  ON env_battles(a4_weapon_id)",
        "CREATE INDEX IF NOT EXISTS idx_env_b2_weapon  ON env_battles(b2_weapon_id)",
        "CREATE INDEX IF NOT EXISTS idx_env_b3_weapon  ON env_battles(b3_weapon_id)",
        "CREATE INDEX IF NOT EXISTS idx_env_b4_weapon  ON env_battles(b4_weapon_id)",
    ] {
        sqlx::query(sql).execute(&mut *conn).await
            .map_err(|e| format!("インデックス再作成失敗: {e}"))?;
    }
    for pragma in [
        "PRAGMA foreign_keys = ON",
        "PRAGMA synchronous = NORMAL",
    ] {
        let _ = sqlx::query(pragma).execute(&mut *conn).await;
    }
    Ok(())
}

type IdCache = std::collections::HashMap<String, Option<i64>>;

async fn import_daily_csvs(
    app: &AppHandle,
    client: &Client,
    conn: &mut SqliteConnection,
    dates: &[String],
    lobby_cache: &mut IdCache,
    rule_cache: &mut IdCache,
    map_cache: &mut IdCache,
    weapon_cache: &mut IdCache,
) -> Result<usize, String> {
    let total = dates.len();
    let mut total_inserted = 0usize;
    for (idx, date) in dates.iter().enumerate() {
        emit_progress(app, idx, total, "download");
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
            conn, &csv_bytes, date,
            lobby_cache, rule_cache, map_cache, weapon_cache,
        ).await?;
        total_inserted += inserted;
        log::info!("[env_import] {} → {} 行挿入", date, inserted);
    }
    Ok(total_inserted)
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

fn dates_inclusive(start: chrono::NaiveDate, end: chrono::NaiveDate) -> Vec<String> {
    let mut dates = Vec::new();
    let mut cur = start;
    while cur <= end {
        dates.push(cur.format("%Y-%m-%d").to_string());
        cur += chrono::Duration::days(1);
    }
    dates
}

fn yesterday_utc() -> chrono::NaiveDate {
    (chrono::Utc::now() - chrono::Duration::days(1)).date_naive()
}

/// `since`（含む）から昨日までの日付一覧。
fn dates_from_since(since: &str) -> Result<Vec<String>, String> {
    let start = chrono::NaiveDate::parse_from_str(since, "%Y-%m-%d")
        .map_err(|_| format!("開始日が読めません: {since}"))?;
    let end = yesterday_utc();
    if start > end {
        return Err(format!("開始日 {since} が昨日より後です"));
    }
    Ok(dates_inclusive(start, end))
}

/// max_date の翌日から昨日までの "YYYY-MM-DD" 一覧を返す。
fn build_date_range(max_date: Option<&str>) -> Vec<String> {
    let yesterday = yesterday_utc();
    let start = if let Some(d) = max_date {
        match chrono::NaiveDate::parse_from_str(d, "%Y-%m-%d") {
            Ok(dt) => dt + chrono::Duration::days(1),
            Err(_) => return Vec::new(),
        }
    } else {
        yesterday
    };
    dates_inclusive(start, yesterday)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// stat.ink CSV のヘッダ（2026-07 時点の 91 カラム）。
    const HEADER: &str = "season,period,game-ver,lobby,mode,stage,time,win,knockout,rank,power,\
alpha-inked,alpha-ink-percent,alpha-count,alpha-color,alpha-theme,\
bravo-inked,bravo-ink-percent,bravo-count,bravo-color,bravo-theme,\
A1-weapon,A1-kill-assist,A1-kill,A1-assist,A1-death,A1-special,A1-inked,A1-abilities,\
A2-weapon,A2-kill-assist,A2-kill,A2-assist,A2-death,A2-special,A2-inked,A2-abilities,\
A3-weapon,A3-kill-assist,A3-kill,A3-assist,A3-death,A3-special,A3-inked,A3-abilities,\
A4-weapon,A4-kill-assist,A4-kill,A4-assist,A4-death,A4-special,A4-inked,A4-abilities,\
B1-weapon,B1-kill-assist,B1-kill,B1-assist,B1-death,B1-special,B1-inked,B1-abilities,\
B2-weapon,B2-kill-assist,B2-kill,B2-assist,B2-death,B2-special,B2-inked,B2-abilities,\
B3-weapon,B3-kill-assist,B3-kill,B3-assist,B3-death,B3-special,B3-inked,B3-abilities,\
B4-weapon,B4-kill-assist,B4-kill,B4-assist,B4-death,B4-special,B4-inked,B4-abilities,\
medal1-grade,medal1-name,medal2-grade,medal2-name,medal3-grade,medal3-name,event";

    fn header_record(s: &str) -> csv::StringRecord {
        csv::StringRecord::from(s.split(',').collect::<Vec<_>>())
    }

    /// 8 スロット全員の weapon/kill/assist/death/inked 位置が実ヘッダと一致する（#336 / #501）。
    #[test]
    fn slot_columns_match_statink_header() {
        assert!(validate_env_csv_header(&header_record(HEADER)).is_ok());
    }

    /// 列が 1 つでもズレたら取り込みを止める（静かに壊れたデータを入れない）。
    #[test]
    fn shifted_header_is_rejected() {
        let shifted = format!("extra,{HEADER}");
        assert!(validate_env_csv_header(&header_record(&shifted)).is_err());
    }

    /// INSERT 文のプレースホルダ数が、バインドする値の数（固定 17 + ブキ 8 + KDA 32）と一致する。
    #[test]
    fn insert_placeholder_count_matches_binds() {
        let sql = env_insert_sql();
        assert_eq!(sql.matches('?').count(), 17 + 8 + 8 * 4);
    }

    #[test]
    fn dates_inclusive_includes_both_ends() {
        let start = chrono::NaiveDate::from_ymd_opt(2026, 8, 10).unwrap();
        let end = chrono::NaiveDate::from_ymd_opt(2026, 8, 12).unwrap();
        assert_eq!(
            dates_inclusive(start, end),
            vec!["2026-08-10", "2026-08-11", "2026-08-12"]
        );
    }

    #[test]
    fn dates_from_since_rejects_bad_date() {
        assert!(dates_from_since("2026/08/01").is_err());
    }
}
