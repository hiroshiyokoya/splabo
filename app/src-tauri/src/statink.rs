//! stat.ink API v3 へのバトルデータアップロード。
//!
//! s3s (https://github.com/frozenpandaman/s3s) の prepare_battle_result / set_scoreboard を参考に、
//! vsHistoryDetail の raw_json から直接ペイロードを構築する。
//! 武器・ステージは stat.ink API への逆引きを行わず、Nintendo の base64 ID を
//! デコードした数値 ID（stat.ink のエイリアスとして受理される）をそのまま送る。

use reqwest::Client;

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
//
// SplatNet 3 の画像 URL はハッシュ化されたファイル名（`<sha256>_0.png`）になっており、
// CamelCase のアビリティ名は含まれない。s3s が持つハッシュ → stat.ink キーのテーブルを
// そのまま転載して URL 内の部分一致で逆引きする。
// 出典: https://github.com/frozenpandaman/s3s/blob/master/utils.py (translate_gear_ability)

/// (画像ファイル名ハッシュ, stat.ink アビリティキー)
/// None は空スロット（ギアパワー未付与）を表す。
const ABILITY_HASHES: &[(&str, Option<&str>)] = &[
    ("5c98cc37d2ce56291a7e430459dc9c44d53ca98b8426c5192f4a53e6dd6e4293", Some("ink_saver_main")),
    ("11293d8fe7cfb82d55629c058a447f67968fc449fd52e7dd53f7f162fa4672e3", Some("ink_saver_sub")),
    ("29b845ea895b931bfaf895e0161aeb47166cbf05f94f04601769c885d019073b", Some("ink_recovery_up")),
    ("3b6c56c57a6d8024f9c7d6e259ffa2e2be4bdf958653b834e524ffcbf1e6808e", Some("run_speed_up")),
    ("087ffffe40c28a40a39dc4a577c235f4cc375540c79dfa8ede1d8b63a063f261", Some("swim_speed_up")),
    ("e8668a2af7259be74814a9e453528a3e9773435a34177617a45bbf79ad0feb17", Some("special_charge_up")),
    ("e3154ab67494df2793b72eabf912104c21fbca71e540230597222e766756b3e4", Some("special_saver")),
    ("fba267bd56f536253a6bcce1e919d8a48c2b793c1b554ac968af8d2068b22cab", Some("special_power_up")),
    ("aaa9b7e95a61bfd869aaa9beb836c74f9b8d4e5d4186768a27d6e443c64f33ce", Some("quick_respawn")),
    ("138820ed46d68bdf2d7a21fb3f74621d8fc8c2a7cb6abe8d7c1a3d7c465108a7", Some("quick_super_jump")),
    ("9df9825e470e00727aa1009c4418cf0ace58e1e529dab9a7c1787309bb25f327", Some("sub_power_up")),
    ("db36f7e89194ed642f53465abfa449669031a66d7538135c703d3f7d41f99c0d", Some("ink_resistance_up")),
    ("664489b24e668ef1937bfc9a80a8cf9cf4927b1e16481fa48e7faee42122996d", Some("sub_resistance_up")),
    ("1a0c78a1714c5abababd7ffcba258c723fefade1f92684aa5f0ff7784cc467d0", Some("intensify_action")),
    ("85d97cd3d5890b80e020a554167e69b5acfa86e96d6e075b5776e6a8562d3d4a", Some("opening_gambit")),
    ("d514787f65831c5121f68b8d96338412a0d261e39e522638488b24895e97eb88", Some("last_ditch_effort")),
    ("aa5b599075c3c1d27eff696aeded9f1e1ddf7ae3d720268e520b260db5600d60", Some("tenacity")),
    ("748c101d23261aee8404c573a947ffc7e116a8da588c7371c40c4f2af6a05a19", Some("comeback")),
    ("2c0ef71abfb3efe0e67ab981fc9cd46efddcaf93e6e20da96980079f8509d05d", Some("ninja_squid")),
    ("de15cad48e5f23d147449c70ee4e2973118959a1a115401561e90fc65b53311b", Some("haunt")),
    ("56816a7181e663b5fedce6315eb0ad538e0aadc257b46a630fcfcc4a16155941", Some("thermal_ink")),
    ("de0d92f7dfed6c76772653d6858e7b67dd1c83be31bd2324c7939105180f5b71", Some("respawn_punisher")),
    ("0d6607b6334e1e84279e482c1b54659e31d30486ef0576156ee0974d8d569dbc", Some("ability_doubler")),
    ("f9c21eacf6dbc1d06edbe498962f8ed766ab43cb1d63806f3731bf57411ae7b6", Some("stealth_jump")),
    ("9d982dc1a7a8a427d74df0edcebcc13383c325c96e75af17b9cdb6f4e8dafb24", Some("object_shredder")),
    ("18f03a68ee64da0a2e4e40d6fc19de2e9af3569bb6762551037fd22cf07b7d2d", Some("drop_roller")),
    // 空スロット用画像（None）
    ("dc937b59892604f5a86ac96936cd7ff09e25f18ae6b758e8014a24c7fa039e91", None),
];

/// 画像 URL から stat.ink のアビリティキーを返す。
/// 空スロット画像は `Some(None)`、未知ハッシュは `None`。
fn ability_key_from_url(url: &str) -> Option<Option<&'static str>> {
    ABILITY_HASHES
        .iter()
        .find(|(hash, _)| url.contains(hash))
        .map(|(_, key)| *key)
}

/// 画像 URL を stat.ink ペイロード用 JSON 値（文字列 or null）に変換する。
/// 未知ハッシュも null として扱う（API 互換を優先）。
fn ability_value(url: &str) -> serde_json::Value {
    match ability_key_from_url(url).flatten() {
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
