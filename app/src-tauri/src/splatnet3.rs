//! SplatNet3 GraphQL API からバトル履歴を取得し、DB に保存するモジュール。

use crate::db::{BattleRow, DbPool};

const GRAPHQL_URL: &str = "https://api.lp1.av5ja.srv.nintendo.net/api/graphql";

// SplatNet3 WebView バージョン（auth.rs の SPLATNET3_WEB_VIEW_VER と同値を維持すること）
const WEB_VIEW_VER: &str = "10.0.0-dfefd0af";

// ハッシュは s3s (https://github.com/frozenpandaman/s3s) の utils.py を参照して更新すること。
const HASH_REGULAR: &str = "2fe6ea7a2de1d6a888b7bd3dbeb6acc8e3246f055ca39b80c4531bbcd0727bba";
const HASH_BANKARA: &str = "9863ea4744730743268e2940396e21b891104ed40e2286789f05100b45a0b0fd";
const HASH_XMATCH: &str = "eb5996a12705c2e94813a62e05c0dc419aad2811b8d49d53e5732290105559cb";
const HASH_DETAIL:   &str = "94faa2ff992222d11ced55e0f349920a82ac50f414ae33c83d1d1c9d8161c5dd";
// WeaponRecordQuery は v10 で廃止。HistoryRecordQuery の weaponHistory に武器+カテゴリが含まれる。
const HASH_WEAPONS:  &str = "a654ecc80161a7ca5c38761c1d9e502d405eae764e2d343618b9c74b1dc0a80f";

// ---------------------------------------------------------------------------
// HTTP ヘルパー
// ---------------------------------------------------------------------------

async fn graphql_request(
    client: &reqwest::Client,
    bullet_token: &str,
    country: &str,
    language: &str,
    hash: &str,
    cursor: Option<&str>,
) -> Result<serde_json::Value, String> {
    let variables = match cursor {
        Some(c) => serde_json::json!({ "after": c }),
        None    => serde_json::json!({}),
    };
    let body = serde_json::json!({
        "variables": variables,
        "extensions": {
            "persistedQuery": {
                "version": 1,
                "sha256Hash": hash
            }
        }
    });

    let resp = client
        .post(GRAPHQL_URL)
        .header("Authorization", format!("Bearer {bullet_token}"))
        .header("X-Web-View-Ver", WEB_VIEW_VER)
        .header("Content-Type", "application/json")
        .header("Accept", "*/*")
        .header("Accept-Language", language)
        .header("X-NACOUNTRY", country)
        .header(
            "User-Agent",
            "Mozilla/5.0 (Linux; Android 8.0.0) AppleWebKit/537.36 \
             (KHTML, like Gecko) Chrome/94.0.4606.61 Mobile Safari/537.36",
        )
        .header("Referer", "https://api.lp1.av5ja.srv.nintendo.net/")
        .json(&body)
        .send()
        .await
        .map_err(|e| format!("SplatNet3 GraphQL リクエスト失敗: {e}"))?;

    if !resp.status().is_success() {
        let status = resp.status();
        let text = resp.text().await.unwrap_or_default();
        return Err(format!("SplatNet3 GraphQL エラー ({status}): {text}"));
    }

    resp.json::<serde_json::Value>()
        .await
        .map_err(|e| format!("SplatNet3 GraphQL レスポンス解析失敗: {e}"))
}

// ---------------------------------------------------------------------------
// バトルリスト → BattleRow 変換
// ---------------------------------------------------------------------------

fn str_val(v: &serde_json::Value, key: &str) -> String {
    v.get(key)
        .and_then(|x| x.as_str())
        .unwrap_or("")
        .to_string()
}

fn i64_val(v: &serde_json::Value, key: &str) -> i64 {
    v.get(key)
        .and_then(|x| x.as_i64())
        .unwrap_or(0)
}

/// vsRule/rule フィールドから stat.ink スラグに変換する。
fn rule_to_slug(rule_raw: &str) -> &'static str {
    match rule_raw {
        "TURF_WAR" => "turf_war",
        "AREA"     => "area",
        "LOFT"     => "yagura",
        "GOAL"     => "hoko",
        "CLAM"     => "asari",
        _          => "turf_war",
    }
}

/// vsStage/id (base64) と vsStage/name を抽出する。
fn parse_stage(node: &serde_json::Value) -> (String, Option<String>) {
    let stage_b64 = node.pointer("/vsStage/id").and_then(|x| x.as_str()).unwrap_or("");
    let stage_id = crate::db::extract_stage_numeric_id(stage_b64);
    let stage_name = node.pointer("/vsStage/name").and_then(|x| x.as_str()).map(|s| s.to_string());
    (stage_id, stage_name)
}

/// レギュラーバトル1件のレスポンスノードから BattleRow を生成する。
fn parse_regular_node(node: &serde_json::Value, fetched_at: &str) -> BattleRow {
    let id = str_val(node, "id");
    let played_at = get_played_at(node);
    let rule_raw = node.pointer("/vsRule/rule").and_then(|x| x.as_str()).unwrap_or("");
    let rule = rule_to_slug(rule_raw).to_string();
    let (stage, stage_name) = parse_stage(node);
    let (weapon, kill, death, assist, special, inked) = parse_my_result(node);
    let result = parse_judgement(node);
    let duration = i64_val(node, "duration");

    BattleRow {
        id,
        played_at,
        mode: "regular".to_string(),
        rule,
        stage,
        stage_name,
        weapon,
        result,
        kill,
        death,
        assist,
        special,
        inked,
        duration,
        rank_before: None,
        rank_after: None,
        x_power: None,
        raw_json: node.to_string(),
        fetched_at: fetched_at.to_string(),
        knockout: None,
        sub_weapon: None,
        special_weapon: None,
        awards: None,
        my_team: None,
        other_teams: None,
        statink_uuid: None,
    }
}

/// バンカラバトル1件のレスポンスノードから BattleRow を生成する。
fn parse_bankara_node(node: &serde_json::Value, fetched_at: &str) -> BattleRow {
    let id = str_val(node, "id");
    let played_at = get_played_at(node);
    let rule_raw = node.pointer("/vsRule/rule").and_then(|x| x.as_str()).unwrap_or("");
    let rule = rule_to_slug(rule_raw).to_string();
    let (stage, stage_name) = parse_stage(node);
    let (weapon, kill, death, assist, special, inked) = parse_my_result(node);
    let result = parse_judgement(node);
    let duration = i64_val(node, "duration");

    let bankara_mode = node
        .pointer("/bankaraMatch/bankaraMode")
        .and_then(|x| x.as_str())
        .unwrap_or("");
    let mode = if bankara_mode == "CHALLENGE" { "bankara_challenge" } else { "bankara_open" };

    let rank_before = node
        .pointer("/bankaraMatch/earnedUdemaePoint")
        .and_then(|x| x.as_i64())
        .map(|p| p.to_string());

    BattleRow {
        id,
        played_at,
        mode: mode.to_string(),
        rule,
        stage,
        stage_name,
        weapon,
        result,
        kill,
        death,
        assist,
        special,
        inked,
        duration,
        rank_before,
        rank_after: None,
        x_power: None,
        raw_json: node.to_string(),
        fetched_at: fetched_at.to_string(),
        knockout: None,
        sub_weapon: None,
        special_weapon: None,
        awards: None,
        my_team: None,
        other_teams: None,
        statink_uuid: None,
    }
}

/// Xマッチ1件のレスポンスノードから BattleRow を生成する。
fn parse_xmatch_node(node: &serde_json::Value, fetched_at: &str) -> BattleRow {
    let id = str_val(node, "id");
    let played_at = get_played_at(node);
    let rule_raw = node.pointer("/vsRule/rule").and_then(|x| x.as_str()).unwrap_or("");
    let rule = rule_to_slug(rule_raw).to_string();
    let (stage, stage_name) = parse_stage(node);
    let (weapon, kill, death, assist, special, inked) = parse_my_result(node);
    let result = parse_judgement(node);
    let duration = i64_val(node, "duration");

    let x_power = node
        .pointer("/xMatch/lastXPower")
        .and_then(|x| x.as_f64());

    BattleRow {
        id,
        played_at,
        mode: "x".to_string(),
        rule,
        stage,
        stage_name,
        weapon,
        result,
        kill,
        death,
        assist,
        special,
        inked,
        duration,
        rank_before: None,
        rank_after: None,
        x_power,
        raw_json: node.to_string(),
        fetched_at: fetched_at.to_string(),
        knockout: None,
        sub_weapon: None,
        special_weapon: None,
        awards: None,
        my_team: None,
        other_teams: None,
        statink_uuid: None,
    }
}

/// VsHistoryListQuery のノードから武器名・inked を抽出する。
/// kill/death/assist/special はリストクエリに含まれないため 0。（#21 詳細クエリで対応予定）
fn parse_my_result(node: &serde_json::Value) -> (String, i64, i64, i64, i64, i64) {
    let weapon = node
        .pointer("/player/weapon/name")
        .and_then(|x| x.as_str())
        .unwrap_or("")
        .to_string();
    let inked = node
        .pointer("/myTeam/result/paintPoint")
        .and_then(|x| x.as_i64())
        .unwrap_or(0);
    (weapon, 0, 0, 0, 0, inked)
}

/// バトル ID の base64 から played_at（ISO 8601 UTC）を抽出する。
/// ID 形式: base64("VsHistoryDetail-...:MODE:yyyyMMddTHHmmss_uuid")
/// BANKARA / XMATCH のレスポンスには playedTime フィールドが存在しないためこちらを使う。
fn played_at_from_id(id: &str) -> String {
    use base64::Engine;
    let decoded = base64::engine::general_purpose::STANDARD
        .decode(id)
        .unwrap_or_default();
    let s = String::from_utf8_lossy(&decoded);
    // "MODE:20260518T143321_uuid" のパターンを探す
    for part in s.split(':') {
        if let Some(ts) = part.split('_').next() {
            if ts.len() == 15 && ts.as_bytes().get(8) == Some(&b'T') {
                let (date, time) = ts.split_at(8);
                let time = &time[1..]; // 'T' を除く
                let (y, md) = date.split_at(4);
                let (m, d) = md.split_at(2);
                let (hh, ms) = time.split_at(2);
                let (mm, ss) = ms.split_at(2);
                return format!("{y}-{m}-{d}T{hh}:{mm}:{ss}Z");
            }
        }
    }
    String::new()
}

/// playedTime フィールドがなければ id から抽出する。
fn get_played_at(node: &serde_json::Value) -> String {
    let v = str_val(node, "playedTime");
    if !v.is_empty() { v } else { played_at_from_id(&str_val(node, "id")) }
}

/// judgement フィールドを win / lose / draw に正規化する（stat.ink ID 形式）。
fn parse_judgement(node: &serde_json::Value) -> String {
    match node
        .get("judgement")
        .and_then(|x| x.as_str())
        .unwrap_or("")
    {
        "WIN" => "win".to_string(),
        "LOSE" | "DEEMED_LOSE" => "lose".to_string(),
        "DRAW" | "EXEMPTED_LOSE" => "draw".to_string(),
        _ => "lose".to_string(),
    }
}

/// GraphQL レスポンスからバトルノード一覧を抽出する。
/// SplatNet3 の historyGroups > nodes > historyDetails > nodes 構造を辿る。
fn extract_battle_nodes(resp: &serde_json::Value) -> Vec<&serde_json::Value> {
    let mut nodes = Vec::new();

    // data.regularBattleHistories.historyGroups.nodes[]
    //   .historyDetails.nodes[]
    // または data.bankaraBattleHistories / xBattleHistories と同じ構造
    let history_keys = [
        "regularBattleHistories",
        "bankaraBattleHistories",
        "xBattleHistories",
    ];

    for key in &history_keys {
        if let Some(history) = resp.pointer(&format!("/data/{key}/historyGroups/nodes")) {
            if let Some(groups) = history.as_array() {
                for group in groups {
                    if let Some(details) =
                        group.pointer("/historyDetails/nodes").and_then(|x| x.as_array())
                    {
                        nodes.extend(details.iter());
                    }
                }
            }
        }
    }

    nodes
}

// ---------------------------------------------------------------------------
// 公開 API
// ---------------------------------------------------------------------------

/// レギュラー・バンカラ・Xマッチのバトル履歴を SplatNet3 から取得し DB に保存する。
/// 新規保存件数の合計を返す。
pub async fn fetch_and_store_battles(
    pool: &DbPool,
    bullet_token: &str,
    country: &str,
    language: &str,
    client: &reqwest::Client,
    app: &tauri::AppHandle,
) -> Result<usize, String> {
    let fetched_at = chrono::Utc::now().to_rfc3339();
    let mut total_inserted = 0usize;

    // --- レギュラー ---
    let regular_resp =
        graphql_request(client, bullet_token, country, language, HASH_REGULAR, None).await?;
    let regular_nodes = extract_battle_nodes(&regular_resp);
    let regular_rows: Vec<BattleRow> = regular_nodes
        .iter()
        .map(|n| parse_regular_node(n, &fetched_at))
        .collect();
    total_inserted += crate::db::insert_battles(pool, regular_rows).await?;

    // --- バンカラ ---
    let bankara_resp =
        graphql_request(client, bullet_token, country, language, HASH_BANKARA, None).await?;
    let bankara_nodes = extract_battle_nodes(&bankara_resp);
    let bankara_rows: Vec<BattleRow> = bankara_nodes
        .iter()
        .map(|n| parse_bankara_node(n, &fetched_at))
        .collect();
    total_inserted += crate::db::insert_battles(pool, bankara_rows).await?;

    // --- Xマッチ ---
    let xmatch_resp =
        graphql_request(client, bullet_token, country, language, HASH_XMATCH, None).await?;
    let xmatch_nodes = extract_battle_nodes(&xmatch_resp);
    let xmatch_rows: Vec<BattleRow> = xmatch_nodes
        .iter()
        .map(|n| parse_xmatch_node(n, &fetched_at))
        .collect();
    total_inserted += crate::db::insert_battles(pool, xmatch_rows).await?;

    // --- 画像キャッシュ ---
    let all_nodes = regular_nodes
        .into_iter()
        .chain(bankara_nodes)
        .chain(xmatch_nodes);
    let image_targets = collect_image_targets(all_nodes);
    for (kind, name, url) in image_targets {
        if let Err(e) = crate::images::download_and_cache(app, client, &kind, &name, &url).await {
            log::warn!("画像ダウンロードスキップ: {e}");
        }
    }

    Ok(total_inserted)
}

/// 詳細クエリ（vsResultId 指定）を発行し、レスポンスを返す。
async fn graphql_detail_request(
    client: &reqwest::Client,
    bullet_token: &str,
    country: &str,
    language: &str,
    vs_result_id: &str,
) -> Result<serde_json::Value, String> {
    let body = serde_json::json!({
        "variables": { "vsResultId": vs_result_id },
        "extensions": {
            "persistedQuery": {
                "version": 1,
                "sha256Hash": HASH_DETAIL
            }
        }
    });

    let resp = client
        .post(GRAPHQL_URL)
        .header("Authorization", format!("Bearer {bullet_token}"))
        .header("X-Web-View-Ver", WEB_VIEW_VER)
        .header("Content-Type", "application/json")
        .header("Accept", "*/*")
        .header("Accept-Language", language)
        .header("X-NACOUNTRY", country)
        .header(
            "User-Agent",
            "Mozilla/5.0 (Linux; Android 8.0.0) AppleWebKit/537.36 \
             (KHTML, like Gecko) Chrome/94.0.4606.61 Mobile Safari/537.36",
        )
        .header("Referer", "https://api.lp1.av5ja.srv.nintendo.net/")
        .json(&body)
        .send()
        .await
        .map_err(|e| format!("詳細クエリ失敗: {e}"))?;

    if !resp.status().is_success() {
        let status = resp.status();
        let text = resp.text().await.unwrap_or_default();
        return Err(format!("詳細クエリエラー ({status}): {text}"));
    }

    resp.json::<serde_json::Value>()
        .await
        .map_err(|e| format!("詳細クエリレスポンス解析失敗: {e}"))
}

/// detail_fetched=0 のバトルに VsHistoryDetailQuery を発行して K/D/A を更新する。
/// 更新件数を返す。
pub async fn fetch_and_update_details(
    pool: &DbPool,
    bullet_token: &str,
    country: &str,
    language: &str,
    client: &reqwest::Client,
) -> Result<usize, String> {
    let ids = crate::db::get_battles_without_detail(pool).await?;
    let mut updated = 0usize;

    for id in &ids {
        let resp = match graphql_detail_request(client, bullet_token, country, language, id).await {
            Ok(r) => r,
            Err(e) => {
                log::warn!("詳細取得スキップ ({id}): {e}");
                continue;
            }
        };

        let detail = match resp.pointer("/data/vsHistoryDetail") {
            Some(d) => d,
            None => {
                log::warn!("vsHistoryDetail が見つからない: {id}");
                continue;
            }
        };

        // myTeam.players の isMyself=true なプレイヤーからスタッツを取得する。
        // top-level の player.result は存在しないケースがあるため使わない。
        let myself = detail
            .pointer("/myTeam/players")
            .and_then(|v| v.as_array())
            .and_then(|players| {
                players.iter().find(|p| {
                    p.get("isMyself").and_then(|v| v.as_bool()).unwrap_or(false)
                })
            });
        let myself_result = myself.and_then(|p| p.get("result"));
        // Nintendo の result["kill"] は kill+assist（kill_or_assist）なので実キルに変換する
        let kill_or_assist = myself_result.and_then(|r| r.get("kill")).and_then(|v| v.as_i64()).unwrap_or(0);
        let assist  = myself_result.and_then(|r| r.get("assist")).and_then(|v| v.as_i64()).unwrap_or(0);
        let kill    = kill_or_assist - assist;
        let death   = myself_result.and_then(|r| r.get("death")).and_then(|v| v.as_i64()).unwrap_or(0);
        let special = myself_result.and_then(|r| r.get("special")).and_then(|v| v.as_i64()).unwrap_or(0);
        let inked   = myself.and_then(|p| p.get("paint")).and_then(|v| v.as_i64()).unwrap_or(0);

        let knockout = detail.get("knockout").and_then(|v| v.as_str()).map(|s| s.to_string());
        let sub_weapon = detail.pointer("/player/weapon/subWeapon/name")
            .and_then(|v| v.as_str()).map(|s| s.to_string());
        let special_weapon = detail.pointer("/player/weapon/specialWeapon/name")
            .and_then(|v| v.as_str()).map(|s| s.to_string());
        let awards = detail.get("awards").map(|v| v.to_string());
        let my_team = detail.pointer("/myTeam/players").map(|v| v.to_string());
        let other_teams = detail.get("otherTeams").map(|v| v.to_string());

        if let Err(e) = crate::db::update_battle_detail(
            pool, id, kill, death, assist, special, inked, &detail.to_string(),
            knockout.as_deref(),
            sub_weapon.as_deref(),
            special_weapon.as_deref(),
            awards.as_deref(),
            my_team.as_deref(),
            other_teams.as_deref(),
        )
        .await
        {
            log::warn!("詳細DB更新失敗 ({id}): {e}");
            continue;
        }

        // 全プレイヤーの武器データを battle_players に保存
        let players = crate::db::parse_players_from_json(id, my_team.as_deref(), other_teams.as_deref());
        if let Err(e) = crate::db::insert_battle_players(pool, &players).await {
            log::warn!("battle_players 保存失敗 ({id}): {e}");
        }

        updated += 1;
    }

    Ok(updated)
}

/// HistoryRecordQuery から全武器マスター（名前・カテゴリ・画像）を取得し DB に保存する。
/// レスポンス構造: data.playHistory.weaponHistories[] (シーズンごと配列)
///   各要素: weaponCategories[].{ weaponCategory.name, weapons[].weapon.{ name, image.url } }
pub async fn fetch_and_store_weapons(
    pool: &crate::db::DbPool,
    bullet_token: &str,
    country: &str,
    language: &str,
    client: &reqwest::Client,
    app: &tauri::AppHandle,
) -> Result<usize, String> {
    let resp = graphql_request(client, bullet_token, country, language, HASH_WEAPONS, None).await?;

    // weaponHistories は edges/node カーソルページネーション形式。全シーズンをフラットに処理する。
    let edges = resp
        .pointer("/data/playHistory/weaponHistories/edges")
        .and_then(|v| v.as_array())
        .ok_or_else(|| {
            let wh_val = resp.pointer("/data/playHistory/weaponHistories")
                .map(|v| { let s = v.to_string(); s[..s.len().min(200)].to_string() })
                .unwrap_or_else(|| "weaponHistories なし".to_string());
            format!("playHistory.weaponHistories.edges が見つかりません。weaponHistories: {wh_val}")
        })?;

    let mut seen = std::collections::HashSet::new();
    let mut count = 0usize;

    for edge in edges {
        let seasonal = match edge.pointer("/node") {
            Some(n) => n,
            None => continue,
        };
        let categories = match seasonal.pointer("/weaponCategories").and_then(|v| v.as_array()) {
            Some(c) => c,
            None => continue,
        };
        for cat_node in categories {
            let category = cat_node
                .pointer("/weaponCategory/name")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string();

            let weapons = match cat_node.pointer("/weapons").and_then(|v| v.as_array()) {
                Some(w) => w,
                None => continue,
            };
            for w_node in weapons {
                let name = w_node
                    .pointer("/weapon/name")
                    .and_then(|v| v.as_str())
                    .unwrap_or("");
                if name.is_empty() || !seen.insert(name.to_string()) {
                    continue;
                }

                if let Some(url) = w_node.pointer("/weapon/image/url").and_then(|v| v.as_str()) {
                    if let Err(e) = crate::images::download_and_cache(app, client, "weapon", name, url).await {
                        log::warn!("武器画像キャッシュ失敗 ({name}): {e}");
                    }
                }

                let sub_name = w_node.pointer("/weapon/subWeapon/name").and_then(|v| v.as_str());
                let sub_url  = w_node.pointer("/weapon/subWeapon/image/url").and_then(|v| v.as_str());
                if let (Some(sname), Some(surl)) = (sub_name, sub_url) {
                    if let Err(e) = crate::images::download_and_cache(app, client, "sub_weapon", sname, surl).await {
                        log::warn!("サブウェポン画像キャッシュ失敗 ({sname}): {e}");
                    }
                }

                let sp_name = w_node.pointer("/weapon/specialWeapon/name").and_then(|v| v.as_str());
                let sp_url  = w_node.pointer("/weapon/specialWeapon/image/url").and_then(|v| v.as_str());
                if let (Some(sname), Some(surl)) = (sp_name, sp_url) {
                    if let Err(e) = crate::images::download_and_cache(app, client, "special_weapon", sname, surl).await {
                        log::warn!("スペシャルウェポン画像キャッシュ失敗 ({sname}): {e}");
                    }
                }

                crate::db::upsert_weapon(pool, name, &category, sub_name, sp_name).await?;
                if sub_name.is_some() || sp_name.is_some() {
                    if let Err(e) = crate::db::update_weapon_sub_special_images(pool, name, sub_name, sp_name).await {
                        log::warn!("武器画像URL更新失敗 ({name}): {e}");
                    }
                }
                count += 1;
            }
        }
    }

    Ok(count)
}

/// 保存済みバトルの my_team / other_teams JSON からサブ・スペシャルウェポンの画像をキャッシュし、
/// weapons テーブルに image URL を記録する。
pub async fn cache_sub_special_images(
    pool: &crate::db::DbPool,
    app: &tauri::AppHandle,
    client: &reqwest::Client,
) -> Result<(), String> {
    let team_data = crate::db::get_battles_team_json(pool).await?;

    // weapon_name -> (sub_name, sub_url, special_name, special_url)
    let mut seen: std::collections::HashMap<String, (Option<String>, Option<String>, Option<String>, Option<String>)> =
        std::collections::HashMap::new();

    for (my_team_json, other_teams_json) in &team_data {
        let mut players: Vec<serde_json::Value> = Vec::new();

        if let Some(json) = my_team_json {
            if let Ok(arr) = serde_json::from_str::<serde_json::Value>(json) {
                if let Some(list) = arr.as_array() {
                    players.extend(list.iter().cloned());
                }
            }
        }
        if let Some(json) = other_teams_json {
            if let Ok(arr) = serde_json::from_str::<serde_json::Value>(json) {
                if let Some(teams) = arr.as_array() {
                    for team in teams {
                        if let Some(list) = team.pointer("/players").and_then(|v| v.as_array()) {
                            players.extend(list.iter().cloned());
                        }
                    }
                }
            }
        }

        for p in &players {
            let Some(weapon_name) = p.pointer("/weapon/name").and_then(|v| v.as_str()) else { continue };
            if seen.contains_key(weapon_name) { continue; }
            let sub_name = p.pointer("/weapon/subWeapon/name").and_then(|v| v.as_str()).map(|s| s.to_string());
            let sub_url  = p.pointer("/weapon/subWeapon/image/url").and_then(|v| v.as_str()).map(|s| s.to_string());
            let sp_name  = p.pointer("/weapon/specialWeapon/name").and_then(|v| v.as_str()).map(|s| s.to_string());
            let sp_url   = p.pointer("/weapon/specialWeapon/image/url").and_then(|v| v.as_str()).map(|s| s.to_string());
            seen.insert(weapon_name.to_string(), (sub_name, sub_url, sp_name, sp_url));
        }
    }

    for (weapon_name, (sub_name, sub_url, sp_name, sp_url)) in &seen {
        if let (Some(name), Some(url)) = (sub_name, sub_url) {
            if let Err(e) = crate::images::download_and_cache(app, client, "sub_weapon", name, url).await {
                log::warn!("サブウェポン画像キャッシュ失敗 ({name}): {e}");
            }
        }
        if let (Some(name), Some(url)) = (sp_name, sp_url) {
            if let Err(e) = crate::images::download_and_cache(app, client, "special_weapon", name, url).await {
                log::warn!("スペシャルウェポン画像キャッシュ失敗 ({name}): {e}");
            }
        }
        if let Err(e) = crate::db::update_weapon_sub_special_images(
            pool,
            weapon_name,
            sub_name.as_deref(),
            sp_name.as_deref(),
        )
        .await
        {
            log::warn!("武器画像URL更新失敗 ({weapon_name}): {e}");
        }
    }

    Ok(())
}

/// バトルノード一覧から武器・ステージの画像 URL を収集する（重複なし）。
fn collect_image_targets<'a>(
    nodes: impl Iterator<Item = &'a serde_json::Value>,
) -> Vec<(String, String, String)> {
    let mut seen = std::collections::HashSet::new();
    let mut targets = Vec::new();
    for node in nodes {
        for (kind, name_ptr, url_ptr) in [
            ("weapon",          "/player/weapon/name",                    "/player/weapon/image/url"),
            ("sub_weapon",      "/player/weapon/subWeapon/name",          "/player/weapon/subWeapon/image/url"),
            ("special_weapon",  "/player/weapon/specialWeapon/name",      "/player/weapon/specialWeapon/image/url"),
            ("stage",           "/vsStage/name",                          "/vsStage/image/url"),
        ] {
            if let (Some(name), Some(url)) = (
                node.pointer(name_ptr).and_then(|v| v.as_str()),
                node.pointer(url_ptr).and_then(|v| v.as_str()),
            ) {
                if !name.is_empty() && !url.is_empty() && seen.insert((kind, name.to_string())) {
                    targets.push((kind.to_string(), name.to_string(), url.to_string()));
                }
            }
        }
    }
    targets
}
