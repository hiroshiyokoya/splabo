//! stat.ink API v3 へのバトルデータアップロード。
//!
//! s3s (https://github.com/frozenpandaman/s3s) の prepare_battle_result / set_scoreboard を参考に、
//! vsHistoryDetail の raw_json から直接ペイロードを構築する。
//! 武器・ステージは stat.ink API への逆引きを行わず、Nintendo の base64 ID を
//! デコードした数値 ID（stat.ink のエイリアスとして受理される）をそのまま送る。

use reqwest::Client;
use tauri::{AppHandle, Emitter};

/// stat.ink への HTTP リクエストに付与する User-Agent。
const USER_AGENT: &str = concat!("chartoon/", env!("CARGO_PKG_VERSION"));

// s3s と同じ UUID5 名前空間。同一バトルで s3s と UUID が一致するため stat.ink 側で重複排除される。
const S3S_NAMESPACE_BYTES: [u8; 16] = [
    0xb3, 0xa2, 0xdb, 0xf5,
    0x2c, 0x09,
    0x47, 0x92,
    0xb7, 0x8c,
    0x00, 0xb5, 0x48, 0xb7, 0x0a, 0xeb,
];

// ---------------------------------------------------------------------------
// base64 ID デコード
// ---------------------------------------------------------------------------

/// Nintendo の base64 エンコード ID をデコードしてプレフィックスを除去する。
/// `VsStage-10` → `10`（数値）、`VsHistoryDetail-u-...` → そのまま文字列。
fn b64d(b64str: &str) -> String {
    use base64::Engine;
    let Ok(bytes) = base64::engine::general_purpose::STANDARD.decode(b64str) else {
        return b64str.to_string();
    };
    let Ok(s) = String::from_utf8(bytes) else {
        return b64str.to_string();
    };
    s
}

/// base64 ID をデコードして stat.ink に渡す値（数値 or 文字列）を返す。
fn decode_id(b64str: &str) -> serde_json::Value {
    let s = b64d(b64str);
    // 既知プレフィックスを除去
    for prefix in &["Weapon-", "VsStage-", "VsMode-", "VsRule-"] {
        if let Some(rest) = s.strip_prefix(prefix) {
            if let Ok(n) = rest.parse::<i64>() {
                return serde_json::json!(n);
            }
        }
    }
    // VsHistoryDetail など文字列のまま返すもの
    serde_json::json!(s)
}

// ---------------------------------------------------------------------------
// UUID 生成（s3s と同一ロジック）
// ---------------------------------------------------------------------------

/// バトル ID の base64 から UUID v5 を生成する（s3s と同一）。
fn battle_uuid(battle_id_b64: &str) -> String {
    let full_id = b64d(battle_id_b64);
    // 末尾 52 文字: "YYYYMMDDTHHMMSS_xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx"
    let suffix = if full_id.len() >= 52 {
        &full_id[full_id.len() - 52..]
    } else {
        &full_id
    };
    let namespace = uuid::Uuid::from_bytes(S3S_NAMESPACE_BYTES);
    uuid::Uuid::new_v5(&namespace, suffix.as_bytes()).to_string()
}

// ---------------------------------------------------------------------------
// RGBA → hex
// ---------------------------------------------------------------------------

fn rgba_to_hex(color: &serde_json::Value) -> Option<String> {
    let r = (color.get("r")?.as_f64()? * 255.0) as u8;
    let g = (color.get("g")?.as_f64()? * 255.0) as u8;
    let b = (color.get("b")?.as_f64()? * 255.0) as u8;
    let a = (color.get("a")?.as_f64()? * 255.0) as u8;
    Some(format!("{r:02x}{g:02x}{b:02x}{a:02x}"))
}

// ---------------------------------------------------------------------------
// ギアパワー（アビリティ）
// ---------------------------------------------------------------------------

/// 画像 URL を stat.ink ペイロード用 JSON 値（文字列 or null）に変換する。
/// 未知ハッシュも null として扱う（API 互換を優先）。
fn ability_value(url: &str) -> serde_json::Value {
    match crate::abilities::ability_key_from_url(url).flatten() {
        Some(key) => serde_json::json!(key),
        None      => serde_json::Value::Null,
    }
}

/// 単一ギア（headGear / clothingGear / shoesGear）を stat.ink 形式に変換する。
fn build_gear(gear: &serde_json::Value) -> serde_json::Value {
    let primary_url = gear
        .pointer("/primaryGearPower/image/url")
        .and_then(|v| v.as_str())
        .unwrap_or("");

    let secondary: Vec<serde_json::Value> = gear
        .get("additionalGearPowers")
        .and_then(|v| v.as_array())
        .map(|arr| {
            arr.iter()
                .map(|g| {
                    let url = g.pointer("/image/url").and_then(|v| v.as_str()).unwrap_or("");
                    ability_value(url)
                })
                .collect()
        })
        .unwrap_or_default();

    serde_json::json!({
        "primary_ability":     ability_value(primary_url),
        "secondary_abilities": secondary,
    })
}

// ---------------------------------------------------------------------------
// プレイヤー構造体の構築（s3s の set_scoreboard に相当）
// ---------------------------------------------------------------------------

fn build_player(player: &serde_json::Value, rank_in_team: usize) -> serde_json::Value {
    let is_myself = player.get("isMyself").and_then(|v| v.as_bool()).unwrap_or(false);
    let weapon_b64 = player.pointer("/weapon/id").and_then(|v| v.as_str()).unwrap_or("");
    let inked = player.get("paint").and_then(|v| v.as_i64()).unwrap_or(0);

    let mut p = serde_json::json!({
        "me":           if is_myself { "yes" } else { "no" },
        "weapon":       decode_id(weapon_b64),
        "inked":        if inked > 0 { serde_json::json!(inked) } else { serde_json::Value::Null },
        "rank_in_team": rank_in_team,
    });

    if let Some(name) = player.get("name").and_then(|v| v.as_str()) {
        p["name"] = serde_json::json!(name);
    }
    if let Some(byname) = player.get("byname").and_then(|v| v.as_str()) {
        p["splashtag_title"] = serde_json::json!(byname);
    }
    if let Some(name_id) = player.get("nameId").and_then(|v| v.as_str()) {
        p["number"] = serde_json::json!(name_id);
    }
    if let Some(species) = player.get("species").and_then(|v| v.as_str()) {
        p["species"] = serde_json::json!(species.to_lowercase());
    }

    match player.get("result") {
        Some(result) if !result.is_null() => {
            // Nintendo の result["kill"] は kill+assist（kill_or_assist）
            let kill_or_assist = result.get("kill").and_then(|v| v.as_i64()).unwrap_or(0);
            let assist         = result.get("assist").and_then(|v| v.as_i64()).unwrap_or(0);
            p["kill_or_assist"] = serde_json::json!(kill_or_assist);
            p["assist"]         = serde_json::json!(assist);
            p["kill"]           = serde_json::json!(kill_or_assist - assist);
            p["death"]          = serde_json::json!(result.get("death").and_then(|v| v.as_i64()).unwrap_or(0));
            p["special"]        = serde_json::json!(result.get("special").and_then(|v| v.as_i64()).unwrap_or(0));
            p["disconnected"]   = serde_json::json!("no");

            // ギアパワー（接続継続プレイヤーのみ）
            let mut gears = serde_json::json!({});
            if let Some(g) = player.get("headGear")     { gears["headgear"] = build_gear(g); }
            if let Some(g) = player.get("clothingGear") { gears["clothing"] = build_gear(g); }
            if let Some(g) = player.get("shoesGear")    { gears["shoes"]    = build_gear(g); }
            if !gears.as_object().map(|o| o.is_empty()).unwrap_or(true) {
                p["gears"] = gears;
            }
        }
        _ => {
            p["disconnected"] = serde_json::json!("yes");
        }
    }

    p
}

fn build_team_players(players_val: Option<&serde_json::Value>) -> Vec<serde_json::Value> {
    players_val
        .and_then(|v| v.as_array())
        .map(|arr| {
            arr.iter()
                .enumerate()
                .map(|(i, p)| build_player(p, i + 1))
                .collect()
        })
        .unwrap_or_default()
}

// ---------------------------------------------------------------------------
// メインのペイロード構築（s3s の prepare_battle_result に相当）
// ---------------------------------------------------------------------------

/// vsHistoryDetail JSON から stat.ink POST ペイロードを構築する。
fn build_payload(detail: &serde_json::Value) -> serde_json::Value {
    let mut payload = serde_json::json!({});

    // --- UUID ---
    if let Some(id_b64) = detail.get("id").and_then(|v| v.as_str()) {
        payload["uuid"] = serde_json::json!(battle_uuid(id_b64));
    }

    // --- Lobby ---
    let mode = detail.pointer("/vsMode/mode").and_then(|v| v.as_str()).unwrap_or("");
    payload["lobby"] = serde_json::json!(match mode {
        "REGULAR" => "regular",
        "BANKARA" => {
            let bm = detail.pointer("/bankaraMatch/mode").and_then(|v| v.as_str()).unwrap_or("");
            if bm == "CHALLENGE" { "bankara_challenge" } else { "bankara_open" }
        }
        "X_MATCH" => "xmatch",
        "PRIVATE" => "private",
        "FEST" => {
            // VsMode ID: 6=tricolor/open 7=pro 8=open
            let mode_id_b64 = detail.pointer("/vsMode/id").and_then(|v| v.as_str()).unwrap_or("");
            let mode_id = b64d(mode_id_b64).replace("VsMode-", "").parse::<i64>().unwrap_or(0);
            if mode_id == 7 { "splatfest_challenge" } else { "splatfest_open" }
        }
        "LEAGUE" => "event",
        other => other,
    });

    // --- Rule ---
    let rule_raw = detail.pointer("/vsRule/rule").and_then(|v| v.as_str()).unwrap_or("");
    let rule_slug = match rule_raw {
        "TURF_WAR"  => "nawabari",
        "AREA"      => "area",
        "LOFT"      => "yagura",
        "GOAL"      => "hoko",
        "CLAM"      => "asari",
        "TRI_COLOR" => "tricolor",
        other       => other,
    };
    payload["rule"] = serde_json::json!(rule_slug);

    // --- Stage ---
    let stage_b64 = detail.pointer("/vsStage/id").and_then(|v| v.as_str()).unwrap_or("");
    payload["stage"] = decode_id(stage_b64);

    // --- 自分のスタッツ ---
    if let Some(players) = detail.pointer("/myTeam/players").and_then(|v| v.as_array()) {
        for (i, player) in players.iter().enumerate() {
            if player.get("isMyself").and_then(|v| v.as_bool()).unwrap_or(false) {
                let weapon_b64 = player.pointer("/weapon/id").and_then(|v| v.as_str()).unwrap_or("");
                payload["weapon"]       = decode_id(weapon_b64);
                payload["inked"]        = serde_json::json!(player.get("paint").and_then(|v| v.as_i64()).unwrap_or(0));
                payload["rank_in_team"] = serde_json::json!(i + 1);
                if let Some(species) = player.get("species").and_then(|v| v.as_str()) {
                    payload["species"] = serde_json::json!(species.to_lowercase());
                }
                if let Some(result) = player.get("result") {
                    if !result.is_null() {
                        let koa    = result.get("kill")   .and_then(|v| v.as_i64()).unwrap_or(0);
                        let assist = result.get("assist") .and_then(|v| v.as_i64()).unwrap_or(0);
                        payload["kill_or_assist"] = serde_json::json!(koa);
                        payload["assist"]         = serde_json::json!(assist);
                        payload["kill"]           = serde_json::json!(koa - assist);
                        payload["death"]          = serde_json::json!(result.get("death")  .and_then(|v| v.as_i64()).unwrap_or(0));
                        payload["special"]        = serde_json::json!(result.get("special").and_then(|v| v.as_i64()).unwrap_or(0));
                    }
                }
                break;
            }
        }
    }

    // --- チーム合計塗りポイント ---
    let sum_paint = |path: &str| -> i64 {
        detail.pointer(path)
            .and_then(|v| v.as_array())
            .map(|arr| arr.iter().map(|p| p.get("paint").and_then(|v| v.as_i64()).unwrap_or(0)).sum())
            .unwrap_or(0)
    };
    let our_inked   = sum_paint("/myTeam/players");
    let their_inked = sum_paint("/otherTeams/0/players");
    if our_inked   > 0 { payload["our_team_inked"]   = serde_json::json!(our_inked); }
    if their_inked > 0 { payload["their_team_inked"] = serde_json::json!(their_inked); }

    // --- 勝敗 ---
    payload["result"] = serde_json::json!(match detail.get("judgement").and_then(|v| v.as_str()).unwrap_or("") {
        "WIN"                    => "win",
        "LOSE" | "DEEMED_LOSE"   => "lose",
        "EXEMPTED_LOSE"          => "exempted_lose",
        "DRAW"                   => "draw",
        _                        => "lose",
    });

    // --- ルール別スコア ---
    if rule_slug == "nawabari" || rule_slug == "tricolor" {
        // ナワバリ: 塗り占有率
        if let Some(r) = detail.pointer("/myTeam/result/paintRatio").and_then(|v| v.as_f64()) {
            payload["our_team_percent"] = serde_json::json!((r * 1000.0).round() / 10.0);
        }
        if let Some(r) = detail.pointer("/otherTeams/0/result/paintRatio").and_then(|v| v.as_f64()) {
            payload["their_team_percent"] = serde_json::json!((r * 1000.0).round() / 10.0);
        }
    } else {
        // ガチマ: KO有無・カウント
        let knockout_raw = detail.get("knockout").and_then(|v| v.as_str()).unwrap_or("NEITHER");
        payload["knockout"] = serde_json::json!(
            if knockout_raw != "NEITHER" && !knockout_raw.is_empty() { "yes" } else { "no" }
        );
        if let Some(s) = detail.pointer("/myTeam/result/score").and_then(|v| v.as_i64()) {
            payload["our_team_count"] = serde_json::json!(s);
        }
        if let Some(s) = detail.pointer("/otherTeams/0/result/score").and_then(|v| v.as_i64()) {
            payload["their_team_count"] = serde_json::json!(s);
        }
    }

    // --- 時刻 ---
    if let Some(played_time) = detail.get("playedTime").and_then(|v| v.as_str()) {
        if let Ok(dt) = chrono::DateTime::parse_from_rfc3339(played_time) {
            let start_ts = dt.timestamp();
            payload["start_at"] = serde_json::json!(start_ts);
            let duration = detail.get("duration").and_then(|v| v.as_i64()).unwrap_or(0);
            if duration > 0 {
                payload["end_at"] = serde_json::json!(start_ts + duration);
            }
        }
    }

    // --- チームカラー ---
    if let Some(color) = detail.pointer("/myTeam/color") {
        if let Some(hex) = rgba_to_hex(color) {
            payload["our_team_color"] = serde_json::json!(hex);
        }
    }
    if let Some(color) = detail.pointer("/otherTeams/0/color") {
        if let Some(hex) = rgba_to_hex(color) {
            payload["their_team_color"] = serde_json::json!(hex);
        }
    }

    // --- スコアボード ---
    let our_players   = build_team_players(detail.pointer("/myTeam/players"));
    let their_players = build_team_players(detail.pointer("/otherTeams/0/players"));
    if !our_players.is_empty()   { payload["our_team_players"]   = serde_json::json!(our_players); }
    if !their_players.is_empty() { payload["their_team_players"] = serde_json::json!(their_players); }

    // トリカラー
    if rule_slug == "tricolor" {
        if let Some(color) = detail.pointer("/otherTeams/1/color") {
            if let Some(hex) = rgba_to_hex(color) {
                payload["third_team_color"] = serde_json::json!(hex);
            }
        }
        let third_players = build_team_players(detail.pointer("/otherTeams/1/players"));
        if !third_players.is_empty() { payload["third_team_players"] = serde_json::json!(third_players); }

        if let Some(r) = detail.pointer("/otherTeams/1/result/paintRatio").and_then(|v| v.as_f64()) {
            payload["third_team_percent"] = serde_json::json!((r * 1000.0).round() / 10.0);
        }
        let third_inked: i64 = detail.pointer("/otherTeams/1/players")
            .and_then(|v| v.as_array())
            .map(|arr| arr.iter().map(|p| p.get("paint").and_then(|v| v.as_i64()).unwrap_or(0)).sum())
            .unwrap_or(0);
        if third_inked > 0 { payload["third_team_inked"] = serde_json::json!(third_inked); }
    }

    // --- バンカラ追加情報 ---
    if mode == "BANKARA" {
        if let Some(exp) = detail.pointer("/bankaraMatch/earnedUdemaePoint").and_then(|v| v.as_i64()) {
            payload["rank_exp_change"] = serde_json::json!(exp);
        }
        if let Some(power) = detail.pointer("/bankaraMatch/bankaraPower/power").and_then(|v| v.as_f64()) {
            payload["bankara_power_after"] = serde_json::json!(power);
        } else if let Some(power) = detail.pointer("/bankaraMatch/weaponPower").and_then(|v| v.as_f64()) {
            payload["series_weapon_power_after"] = serde_json::json!(power);
        }
    }

    // --- X マッチ ---
    if mode == "X_MATCH" {
        if let Some(power) = detail.pointer("/xMatch/lastXPower").and_then(|v| v.as_f64()) {
            payload["x_power_after"] = serde_json::json!(power);
        }
    }

    // --- メダル ---
    if let Some(awards) = detail.get("awards").and_then(|v| v.as_array()) {
        let medals: Vec<serde_json::Value> = awards.iter()
            .filter_map(|a| a.get("name").and_then(|v| v.as_str()).map(|s| serde_json::json!(s)))
            .collect();
        if !medals.is_empty() {
            payload["medals"] = serde_json::json!(medals);
        }
    }

    // --- エージェント情報 ---
    payload["agent"]         = serde_json::json!("chartoon");
    payload["agent_version"] = serde_json::json!(env!("CARGO_PKG_VERSION"));
    payload["automated"]     = serde_json::json!(true);

    payload
}

// ---------------------------------------------------------------------------
// ヘルパー
// ---------------------------------------------------------------------------

/// POST レスポンスから stat.ink 内部 UUID を取得する。
/// X-Battle-ID ヘッダーが最優先。なければ fallback（client_uuid）を返す。
fn extract_internal_uuid(resp: &reqwest::Response, fallback: &str) -> String {
    resp.headers()
        .get("x-battle-id")
        .and_then(|v| v.to_str().ok())
        .map(|s| s.to_string())
        .unwrap_or_else(|| fallback.to_string())
}

/// POST レスポンスの Location ヘッダから screen_name を抽出する。
/// `https://stat.ink/@<screen_name>/spl3/<uuid>` 形式を想定。
fn extract_screen_name(resp: &reqwest::Response) -> Option<String> {
    let location = resp.headers().get("location")?.to_str().ok()?;
    // `@` 以降 `/` までを screen_name とする
    let start = location.find("/@")? + 2;
    let rest  = &location[start..];
    let end   = rest.find('/')?;
    Some(rest[..end].to_string())
}

// ---------------------------------------------------------------------------
// アップロード
// ---------------------------------------------------------------------------

/// statink_uuid が未設定のバトル（detail_fetched=1 のみ）を stat.ink へアップロードする。
/// `limit`: Some(n) のとき最大 n 件だけ処理する（テスト用）。
/// 返り値: アップロード成功件数。
pub async fn upload_pending_battles(
    pool: &crate::db::DbPool,
    client: &Client,
    api_key: &str,
    limit: Option<usize>,
    app: Option<&AppHandle>,
) -> Result<usize, String> {
    if api_key.is_empty() {
        return Ok(0);
    }

    let mut battles = crate::db::get_battles_not_uploaded(pool).await?;
    if let Some(n) = limit {
        battles.truncate(n);
    }
    if battles.is_empty() {
        return Ok(0);
    }

    let mut uploaded = 0usize;
    let mut screen_name_emitted = false;

    for battle in &battles {
        // raw_json は detail_fetched 後は vsHistoryDetail の内容
        let detail: serde_json::Value = match serde_json::from_str(&battle.raw_json) {
            Ok(v) => v,
            Err(e) => {
                log::warn!("[stat.ink] raw_json パース失敗 id={}: {e}", &battle.id[..battle.id.len().min(20)]);
                continue;
            }
        };

        let payload = build_payload(&detail);

        let uuid = payload["uuid"].as_str().unwrap_or("").to_string();
        if uuid.is_empty() {
            log::warn!("[stat.ink] UUID 生成失敗、スキップ: id={}", &battle.id[..battle.id.len().min(20)]);
            continue;
        }

        let resp = client
            .post("https://stat.ink/api/v3/battle")
            .header("Authorization", format!("Bearer {api_key}"))
            .header("Content-Type", "application/json")
            .header("User-Agent", USER_AGENT)
            .json(&payload)
            .send()
            .await;

        match resp {
            Ok(r) if r.status().as_u16() == 201 => {
                // 新規・重複どちらも 201。X-Battle-ID ヘッダーに内部 UUID が入っている。
                let internal_uuid = extract_internal_uuid(&r, &uuid);
                let found = r.headers().get("x-found")
                    .and_then(|v| v.to_str().ok())
                    .map(|s| s == "?1")  // ?1 = already existed
                    .unwrap_or(false);
                if found {
                    log::info!(
                        "[stat.ink] スキップ (重複) id={}…",
                        &battle.id[..battle.id.len().min(20)]
                    );
                }

                // Location ヘッダから screen_name を抽出し、本セッション中で 1 度だけ通知する。
                if !screen_name_emitted {
                    if let (Some(app), Some(name)) = (app, extract_screen_name(&r)) {
                        let _ = app.emit("statink_screen_name_detected", &name);
                        log::info!("[stat.ink] screen_name 取得: {name}");
                        screen_name_emitted = true;
                    }
                }

                crate::db::mark_statink_uploaded(pool, &battle.id, &internal_uuid).await?;
                uploaded += 1;
            }
            Ok(r) => {
                let status = r.status();
                let body = r.text().await.unwrap_or_default();
                let snippet = &body[..body.len().min(500)];
                log::warn!("[stat.ink] アップロード失敗: status={status} body={snippet}");
            }
            Err(e) => {
                log::warn!("[stat.ink] 通信エラー: {e}");
                break;
            }
        }
    }

    log::info!("[stat.ink] {} 件アップロード完了 (対象 {} 件)", uploaded, battles.len());
    Ok(uploaded)
}

// ---------------------------------------------------------------------------
// 削除
// ---------------------------------------------------------------------------

/// stat.ink にアップロード済みのバトルを全件削除し、DB の statink_uuid をリセットする。
/// 返り値: 削除成功件数。
pub async fn delete_all_uploaded_battles(
    pool: &crate::db::DbPool,
    client: &Client,
    api_key: &str,
) -> Result<usize, String> {
    if api_key.is_empty() {
        return Err("stat.ink API キーが設定されていません".to_string());
    }

    let battles = crate::db::get_battles_uploaded(pool).await?;
    if battles.is_empty() {
        return Ok(0);
    }

    let mut deleted = 0usize;

    for (battle_id, statink_uuid) in &battles {
        let url = format!("https://stat.ink/api/v3/battle/{statink_uuid}");
        let resp = client
            .delete(&url)
            .header("Authorization", format!("Bearer {api_key}"))
            .header("User-Agent", USER_AGENT)
            .send()
            .await;

        match resp {
            Ok(r) if r.status().as_u16() == 204 => {
                crate::db::reset_statink_uuid(pool, battle_id).await?;
                deleted += 1;
            }
            Ok(r) if r.status().as_u16() == 404 => {
                // stat.ink 上にない（手動で削除済みなど）→ DB のみリセット
                crate::db::reset_statink_uuid(pool, battle_id).await?;
                deleted += 1;
            }
            Ok(r) => {
                let status = r.status();
                let body = r.text().await.unwrap_or_default();
                log::warn!("[stat.ink] 削除失敗: uuid={statink_uuid} status={status} body={}", &body[..body.len().min(200)]);
            }
            Err(e) => {
                log::warn!("[stat.ink] 削除通信エラー: {e}");
                break;
            }
        }
    }

    log::info!("[stat.ink] {} 件削除完了 (対象 {} 件)", deleted, battles.len());
    Ok(deleted)
}
