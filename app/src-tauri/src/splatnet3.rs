//! SplatNet3 GraphQL API からバトル履歴を取得し、DB に保存するモジュール。

use crate::db::{BattleRow, DbPool};

const GRAPHQL_URL: &str = "https://api.lp1.av5ja.srv.nintendo.net/api/graphql";

// SplatNet3 WebView バージョン（auth.rs の SPLATNET3_WEB_VIEW_VER と同値を維持すること）
const WEB_VIEW_VER: &str = "10.0.0-dfefd0af";

// ハッシュは s3s (https://github.com/frozenpandaman/s3s) の utils.py を参照して更新すること。
const HASH_REGULAR: &str = "2fe6ea7a2de1d6a888b7bd3dbeb6acc8e3246f055ca39b80c4531bbcd0727bba";
const HASH_BANKARA: &str = "9863ea4744730743268e2940396e21b891104ed40e2286789f05100b45a0b0fd";
const HASH_XMATCH: &str = "eb5996a12705c2e94813a62e05c0dc419aad2811b8d49d53e5732290105559cb";
// イベントマッチ（EventBattleHistoriesQuery）。値は splatnet3-types v4.0.0 同梱のハッシュ。
// ⚠ 注意: このハッシュは Nintendo 側で廃止されている可能性がある（#162 で WeaponRecordQuery の
// v4 ハッシュが廃止と判明した前例あり）。実機で叩いて `persisted query does not exist` が出たら、
// splatoon3.ink 等で有効な最新 EventBattleHistoriesQuery ハッシュに差し替えること。
const HASH_EVENT: &str = "e47f9aac5599f75c842335ef0ab8f4c640e8bf2afe588a3b1d4b480ee79198ac";
const HASH_DETAIL:   &str = "94faa2ff992222d11ced55e0f349920a82ac50f414ae33c83d1d1c9d8161c5dd";
// WeaponRecordQuery は v10 で廃止。HistoryRecordQuery の weaponHistory にブキ+カテゴリが含まれる。
const HASH_WEAPONS:  &str = "a654ecc80161a7ca5c38761c1d9e502d405eae764e2d343618b9c74b1dc0a80f";
// MyOutfitCommonDataEquipmentsQuery（所持ギア一覧）。splabo v0.8 ギア取得 Rust 化（Phase A2）。
// s3s utils.py の translate_rid より。Phase 0 スパイクで実機取得を実証済みの canonical hash。
const HASH_GEAR: &str = "45a4c343d973864f7bb9e9efac404182be1d48cf2181619505e9b7cd3b56a6e8";

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
// ギア取得（MyOutfitCommonDataEquipmentsQuery）— splabo v0.8 Phase A2
//
// chartoon の GraphQL 経路（graphql_request）で所持ギア（頭/服/靴）を取得する。
// Phase 0 スパイクで実機取得を実証済み。geartoon サイドカーの fetch_gear を置換する。
// レスポンスは geartoon wrapper.js の `splatnet.getEquipment()` と同一構造:
//   { "data": { "headGears": { "nodes": [...] },
//               "clothingGears": { "nodes": [...] },
//               "shoesGears": { "nodes": [...] } } }
// 実際の gear_db.bin / .gti 生成（フォーマット互換）は gear.rs 側が担う。
// ---------------------------------------------------------------------------

/// 所持ギア（MyOutfitCommonDataEquipmentsQuery）の生レスポンス JSON を取得して返す。
/// 戻り値は `{ "data": { "headGears": ..., "clothingGears": ..., "shoesGears": ... } }`。
pub async fn fetch_gear_equipment(
    client: &reqwest::Client,
    bullet_token: &str,
    country: &str,
    language: &str,
) -> Result<serde_json::Value, String> {
    graphql_request(client, bullet_token, country, language, HASH_GEAR, None).await
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
/// 未知の値はそのまま返す（不明なルールを一律 "turf_war" にしないこと。
/// migrate v2 の挙動と一致）。
fn rule_to_slug(rule_raw: &str) -> String {
    match rule_raw {
        "TURF_WAR" => "turf_war".to_string(),
        "AREA"     => "area".to_string(),
        "LOFT"     => "yagura".to_string(),
        "GOAL"     => "hoko".to_string(),
        "CLAM"     => "asari".to_string(),
        ""         => String::new(),
        other      => {
            log::warn!("未知のルール値: {}（そのまま保存）", other);
            other.to_string()
        }
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
/// `parent` は historyGroup の親（レギュラーには無いので常に None）。
fn parse_regular_node(node: &serde_json::Value, fetched_at: &str, parent: Option<&serde_json::Value>) -> BattleRow {
    let id = str_val(node, "id");
    let played_at = get_played_at(node);
    let rule_raw = node.pointer("/vsRule/rule").and_then(|x| x.as_str()).unwrap_or("");
    let rule = rule_to_slug(rule_raw);
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
        parent_json: parent.map(|p| p.to_string()),
    }
}

/// バンカラバトル1件のレスポンスノードから BattleRow を生成する。
/// `parent` はバンカラチャレンジ時のみ bankaraMatchChallenge オブジェクト。
fn parse_bankara_node(node: &serde_json::Value, fetched_at: &str, parent: Option<&serde_json::Value>) -> BattleRow {
    let id = str_val(node, "id");
    let played_at = get_played_at(node);
    let rule_raw = node.pointer("/vsRule/rule").and_then(|x| x.as_str()).unwrap_or("");
    let rule = rule_to_slug(rule_raw);
    let (stage, stage_name) = parse_stage(node);
    let (weapon, kill, death, assist, special, inked) = parse_my_result(node);
    let result = parse_judgement(node);
    let duration = i64_val(node, "duration");

    // SplatNet3 GraphQL の正しいフィールド名は bankaraMatch.mode
    // （以前は bankaraMatch.bankaraMode と参照していて常に空文字 → 全部 open に倒れていた）
    let bankara_mode = node
        .pointer("/bankaraMatch/mode")
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
        parent_json: parent.map(|p| p.to_string()),
    }
}

/// Xマッチ1件のレスポンスノードから BattleRow を生成する。
/// `parent` は評価戦時のみ xMatchMeasurement オブジェクト。
fn parse_xmatch_node(node: &serde_json::Value, fetched_at: &str, parent: Option<&serde_json::Value>) -> BattleRow {
    let id = str_val(node, "id");
    let played_at = get_played_at(node);
    let rule_raw = node.pointer("/vsRule/rule").and_then(|x| x.as_str()).unwrap_or("");
    let rule = rule_to_slug(rule_raw);
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
        parent_json: parent.map(|p| p.to_string()),
    }
}

/// イベントマッチ1件のレスポンスノードから BattleRow を生成する。
/// `parent` はイベントの historyGroup 親（leagueMatchHistoryGroup）。
/// mode は常に "event"（lobby=event(5) に対応）。rule はバトルごとに vsRule から決める。
fn parse_event_node(node: &serde_json::Value, fetched_at: &str, parent: Option<&serde_json::Value>) -> BattleRow {
    let id = str_val(node, "id");
    let played_at = get_played_at(node);
    let rule_raw = node.pointer("/vsRule/rule").and_then(|x| x.as_str()).unwrap_or("");
    let rule = rule_to_slug(rule_raw);
    let (stage, stage_name) = parse_stage(node);
    let (weapon, kill, death, assist, special, inked) = parse_my_result(node);
    let result = parse_judgement(node);
    let duration = i64_val(node, "duration");

    BattleRow {
        id,
        played_at,
        mode: "event".to_string(),
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
        parent_json: parent.map(|p| p.to_string()),
    }
}

/// VsHistoryListQuery のノードからブキ名・inked を抽出する。
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

/// GraphQL レスポンスからバトルノード一覧を (detail, parent_for_idx0) のペアで抽出する。
/// SplatNet3 の historyGroups > nodes > historyDetails > nodes 構造を辿る。
///
/// `parent` は historyGroup の親ノード（bankaraMatchChallenge / xMatchMeasurement）の
/// 最小オブジェクト。stat.ink へのアップロード時に rank_before/after や challenge_win/lose、
/// x_power_after を組み立てるために使う。
///
/// s3s と同じ流儀で、**各 historyGroup の最初のバトル（idx==0、＝最新）にのみ** parent を
/// 紐付ける。それ以外のバトルは parent=None（chronological に累計値が不正になるため）。
fn extract_battle_nodes(
    resp: &serde_json::Value,
) -> Vec<(&serde_json::Value, Option<serde_json::Value>)> {
    let mut nodes: Vec<(&serde_json::Value, Option<serde_json::Value>)> = Vec::new();

    let history_keys = [
        "regularBattleHistories",
        "bankaraBattleHistories",
        "xBattleHistories",
        "eventBattleHistories",
    ];

    for key in &history_keys {
        if let Some(history) = resp.pointer(&format!("/data/{key}/historyGroups/nodes")) {
            if let Some(groups) = history.as_array() {
                for group in groups {
                    if let Some(details) =
                        group.pointer("/historyDetails/nodes").and_then(|x| x.as_array())
                    {
                        // group の親情報を一度だけ抽出
                        let parent = extract_parent_for_group(group);
                        for (idx, detail) in details.iter().enumerate() {
                            // idx==0（最新バトル）にだけ parent を紐付ける
                            let p = if idx == 0 { parent.clone() } else { None };
                            nodes.push((detail, p));
                        }
                    }
                }
            }
        }
    }

    nodes
}

/// historyGroup のノードから親情報（bankaraMatchChallenge or xMatchMeasurement）を取り出す。
/// 該当する子オブジェクトが無い・null の場合は None。
fn extract_parent_for_group(group: &serde_json::Value) -> Option<serde_json::Value> {
    if let Some(p) = group.get("bankaraMatchChallenge").filter(|v| !v.is_null()) {
        return Some(p.clone());
    }
    if let Some(p) = group.get("xMatchMeasurement").filter(|v| !v.is_null()) {
        return Some(p.clone());
    }
    // イベントマッチの historyGroup 親情報（leagueMatchEvent / myLeaguePower /
    // measurementState / teamComposition 等）。EventBattleHistoriesQuery の型定義より。
    if let Some(p) = group.get("leagueMatchHistoryGroup").filter(|v| !v.is_null()) {
        return Some(p.clone());
    }
    None
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
    let regular_pairs = extract_battle_nodes(&regular_resp);
    let regular_rows: Vec<BattleRow> = regular_pairs
        .iter()
        .map(|(n, p)| parse_regular_node(n, &fetched_at, p.as_ref()))
        .collect();
    total_inserted += crate::db::insert_battles(pool, regular_rows).await?;

    // --- バンカラ ---
    let bankara_resp =
        graphql_request(client, bullet_token, country, language, HASH_BANKARA, None).await?;
    let bankara_pairs = extract_battle_nodes(&bankara_resp);
    let bankara_rows: Vec<BattleRow> = bankara_pairs
        .iter()
        .map(|(n, p)| parse_bankara_node(n, &fetched_at, p.as_ref()))
        .collect();
    total_inserted += crate::db::insert_battles(pool, bankara_rows).await?;

    // --- Xマッチ ---
    let xmatch_resp =
        graphql_request(client, bullet_token, country, language, HASH_XMATCH, None).await?;
    let xmatch_pairs = extract_battle_nodes(&xmatch_resp);
    let xmatch_rows: Vec<BattleRow> = xmatch_pairs
        .iter()
        .map(|(n, p)| parse_xmatch_node(n, &fetched_at, p.as_ref()))
        .collect();
    total_inserted += crate::db::insert_battles(pool, xmatch_rows).await?;

    // --- イベントマッチ ---
    // ⚠ HASH_EVENT が Nintendo 側で廃止されている場合、graphql_request が
    // `persisted query does not exist` 系のエラーを返す。その場合はイベント取得だけ
    // スキップして他モードの取得は継続する（warn を残し、ハッシュ差し替えを促す）。
    // event_resp はこの関数スコープで保持する（extract_battle_nodes が借用を返すため）。
    let event_resp = match graphql_request(client, bullet_token, country, language, HASH_EVENT, None).await {
        Ok(r) => Some(r),
        Err(e) => {
            log::warn!(
                "イベントマッチ取得スキップ: {e} — HASH_EVENT ({}) が廃止された可能性。\
                 splatoon3.ink 等で有効な EventBattleHistoriesQuery ハッシュに差し替えること。",
                HASH_EVENT
            );
            None
        }
    };
    let event_pairs = match &event_resp {
        Some(resp) => {
            let pairs = extract_battle_nodes(resp);
            let event_rows: Vec<BattleRow> = pairs
                .iter()
                .map(|(n, p)| parse_event_node(n, &fetched_at, p.as_ref()))
                .collect();
            total_inserted += crate::db::insert_battles(pool, event_rows).await?;
            pairs
        }
        None => Vec::new(),
    };

    // --- 画像キャッシュ ---
    let all_nodes = regular_pairs.iter().map(|(n, _)| *n)
        .chain(bankara_pairs.iter().map(|(n, _)| *n))
        .chain(xmatch_pairs.iter().map(|(n, _)| *n))
        .chain(event_pairs.iter().map(|(n, _)| *n));
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

        // 詳細クエリ由来の rule / mode で上書き（リスト取り込み時の取りこぼし救済）
        let rule_raw = detail.pointer("/vsRule/rule").and_then(|v| v.as_str()).unwrap_or("");
        let rule = rule_to_slug(rule_raw);

        let vsmode_raw = detail.pointer("/vsMode/mode").and_then(|v| v.as_str()).unwrap_or("");
        let mode: String = match vsmode_raw {
            "REGULAR" => "regular".to_string(),
            "BANKARA" => {
                let bm = detail.pointer("/bankaraMatch/mode")
                    .and_then(|v| v.as_str()).unwrap_or("");
                if bm == "CHALLENGE" { "bankara_challenge".to_string() } else { "bankara_open".to_string() }
            }
            "X_MATCH" => "x".to_string(),
            // イベントマッチは SplatNet3 内部では「リーグマッチ」扱いで vsMode.mode = "LEAGUE"。
            // VsMode.id は VsMode-51（base64: "VnNNb2RlLTUx"）。詳細クエリには leagueMatch ノードが付く。
            // EventBattleHistoriesQuery の historyGroup には leagueMatchHistoryGroup が入ることからも
            // イベント＝リーグ系であることが確認できる。lobby=event(5) に正規化する。
            "LEAGUE" => "event".to_string(),
            "FEST" => {
                // オープン/チャレンジの判定（#293 / #306）。
                //
                // festMatch.mode は VsHistoryDetail に存在しない（実 DB のフェス戦を全数調査して確認）。
                // これに依存していたため、以前は全て splatfest_open に誤分類されていた。
                //
                // 実データ（オープン 45 戦）で確認できた事実:
                //   - vsMode は全件 {"id":"VnNNb2RlLTY=","mode":"FEST"}（= VsMode-6）
                //   - festMatch のキーは conchShell / contribution / dragonMatchType / jewel / myFestPower
                //   - myFestPower は全件 null（＝オープンにはフェスパワーが無い）
                //
                // フェスパワー（myFestPower）はチャレンジにしか付かないので、これを主たる根拠にする。
                // stat.ink 送信側（statink.rs）が使う VsMode-7 判定も OR で併用しておく
                // （チャレンジ戦のサンプルが手元に無く、どちらが真の判別材料か確証が無いため）。
                // オープンはどちらの条件も満たさないので、併用しても誤判定は起きない。
                let vsmode_id = detail.pointer("/vsMode/id").and_then(|v| v.as_str()).unwrap_or("");
                let has_fest_power = detail
                    .pointer("/festMatch/myFestPower")
                    .map(|v| !v.is_null())
                    .unwrap_or(false);
                if vsmode_id == "VnNNb2RlLTc=" || has_fest_power {
                    "splatfest_challenge".to_string()
                } else {
                    // オープン（VsMode-6）とトリカラ（VsMode-8）。トリカラも lobby は open 扱いに
                    // して詳細更新のスキップ（無限リトライ）を防ぎ、バトルリスト表示側で
                    // vsRule=TRI_COLOR により別途除外する。
                    "splatfest_open".to_string()
                }
            }
            ""        => String::new(),
            other     => {
                log::warn!("未知の vsMode/mode: {} (id={})", other, id);
                other.to_lowercase()
            }
        };

        if let Err(e) = crate::db::update_battle_detail(
            pool, id, kill, death, assist, special, inked, &detail.to_string(),
            &rule,
            &mode,
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

        // 全プレイヤーのブキデータを battle_players に保存
        let players = crate::db::parse_players_from_json(id, my_team.as_deref(), other_teams.as_deref());
        if let Err(e) = crate::db::insert_battle_players(pool, &players).await {
            log::warn!("battle_players 保存失敗 ({id}): {e}");
        }

        updated += 1;
    }

    Ok(updated)
}

/// HistoryRecordQuery から全ブキマスター（名前・カテゴリ・画像）を取得し DB に保存する。
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
                        log::warn!("ブキ画像キャッシュ失敗 ({name}): {e}");
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
                        log::warn!("ブキ画像URL更新失敗 ({name}): {e}");
                    }
                }
                count += 1;
            }
        }
    }

    Ok(count)
}

/// WeaponRecordQuery (#49) を nxapi-sidecar 経由で実行し、weapon_records テーブルに upsert する。
/// 同時に全ブキの主・サブ・SP 画像をキャッシュする（バトルに登場しないブキのアイコン欠け対策）。
///
/// レスポンス構造 (data.weaponRecords.nodes[]):
///   name, image2d.url, weaponId, stats.{level, paint, win, vibes, ...},
///   subWeapon.{name, image.url}, specialWeapon.{name, image.url}, weaponCategory.{...}
///
/// 戻り値は upsert 件数。
pub async fn fetch_and_store_weapon_records(
    pool: &crate::db::DbPool,
    client: &reqwest::Client,
    app: &tauri::AppHandle,
) -> Result<usize, String> {
    // nxapi-sidecar に WeaponRecordQuery を実行させ、最新の query hash を利用する。
    let data = crate::nxapi::nxapi_fetch_weapon_records(app).await?;

    let nodes = data
        .pointer("/weaponRecords/nodes")
        .and_then(|v| v.as_array())
        .ok_or_else(|| {
            let head = data.to_string();
            format!(
                "WeaponRecordQuery レスポンスに weaponRecords.nodes が無い。先頭: {}",
                &head[..head.len().min(300)]
            )
        })?;

    let mut count = 0usize;

    for node in nodes {
        let name = node.get("name").and_then(|v| v.as_str()).unwrap_or("");
        if name.is_empty() {
            continue;
        }

        // ユーザー固有統計
        let level   = node.pointer("/stats/level").and_then(|v| v.as_i64()).unwrap_or(0);
        let win     = node.pointer("/stats/win").and_then(|v| v.as_i64()).unwrap_or(0);
        let paint   = node.pointer("/stats/paint").and_then(|v| v.as_i64()).unwrap_or(0);

        // WeaponRecordQuery には big_run_level / weapon_power / weapon_power_max が無い。
        // 将来別クエリ（HistoryRecordQuery 等）が見つかったらここで埋める。今は None。
        let big_run_level: Option<i64> = None;
        let weapon_power: Option<f64>  = None;
        let weapon_power_max: Option<f64> = None;

        if let Err(e) = crate::db::upsert_weapon_record(
            pool, name, level, win, paint, big_run_level, weapon_power, weapon_power_max,
        ).await {
            log::warn!("weapon_records upsert スキップ ({name}): {e}");
            continue;
        }
        count += 1;

        // 主ブキ画像（image2d を優先、なければ image / image3d でフォールバック）。
        let weapon_url = node
            .pointer("/image2d/url")
            .and_then(|v| v.as_str())
            .or_else(|| node.pointer("/image/url").and_then(|v| v.as_str()))
            .or_else(|| node.pointer("/image2dThumbnail/url").and_then(|v| v.as_str()))
            .or_else(|| node.pointer("/image3d/url").and_then(|v| v.as_str()));
        if let Some(url) = weapon_url {
            if let Err(e) = crate::images::download_and_cache(app, client, "weapon", name, url).await {
                log::warn!("主ブキ画像キャッシュ失敗 ({name}): {e}");
            }
        }

        // サブ
        let sub_name = node.pointer("/subWeapon/name").and_then(|v| v.as_str());
        let sub_url  = node.pointer("/subWeapon/image/url").and_then(|v| v.as_str());
        if let (Some(sname), Some(surl)) = (sub_name, sub_url) {
            if let Err(e) = crate::images::download_and_cache(app, client, "sub_weapon", sname, surl).await {
                log::warn!("サブウェポン画像キャッシュ失敗 ({sname}): {e}");
            }
        }

        // SP
        let sp_name = node.pointer("/specialWeapon/name").and_then(|v| v.as_str());
        let sp_url  = node.pointer("/specialWeapon/image/url").and_then(|v| v.as_str());
        if let (Some(sname), Some(surl)) = (sp_name, sp_url) {
            if let Err(e) = crate::images::download_and_cache(app, client, "special_weapon", sname, surl).await {
                log::warn!("スペシャルウェポン画像キャッシュ失敗 ({sname}): {e}");
            }
        }

        // 旧 weapons テーブルにも sub / sp 名と画像を補完しておく（db_list_weapons 用）。
        // ここで上書きしないように COALESCE。
        if sub_name.is_some() || sp_name.is_some() {
            if let Err(e) = crate::db::update_weapon_sub_special_images(
                pool, name, sub_url, sp_url,
            ).await {
                log::warn!("ブキ画像URL更新失敗 ({name}): {e}");
            }
        }
    }

    log::info!("[weapon_records] WeaponRecordQuery 取得 {} 件", count);
    Ok(count)
}

/// 保存済みバトルの my_team / other_teams JSON から **全プレイヤーのメインブキ画像** をキャッシュする (#136)。
///
/// `fetch_and_store_weapons`（HistoryRecordQuery）は自分が使ったことのあるブキしか返さない。
/// それだけだと味方ブキ / 相手ブキを集計軸に取った時に「自分が使ったことのないブキ」が
/// アイコン無しになり、テキストフォールバックが混ざる（#118 で発覚）。
///
/// このため、全バトル詳細の my_team + other_teams の `weapon.{name, image.url}` を走査して
/// download_and_cache する。既にキャッシュ済みのファイルがあれば短絡されるので何度呼んでも安い。
pub async fn cache_all_weapon_images(
    pool: &crate::db::DbPool,
    app: &tauri::AppHandle,
    client: &reqwest::Client,
) -> Result<(), String> {
    let team_data = crate::db::get_battles_team_json(pool).await?;

    // 同じブキ（name）はバトル間で重複するので HashMap で 1 URL に集約する。
    let mut seen: std::collections::HashMap<String, String> = std::collections::HashMap::new();

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
            let Some(name) = p.pointer("/weapon/name").and_then(|v| v.as_str()) else { continue };
            let Some(url)  = p.pointer("/weapon/image/url").and_then(|v| v.as_str()) else { continue };
            if name.is_empty() || url.is_empty() { continue; }
            seen.entry(name.to_string()).or_insert_with(|| url.to_string());
        }
    }

    log::info!("[weapon-image] all-team キャッシュ対象 {} 種", seen.len());
    let mut downloaded = 0usize;
    for (name, url) in &seen {
        match crate::images::download_and_cache(app, client, "weapon", name, url).await {
            Ok(()) => downloaded += 1,
            Err(e) => log::warn!("ブキ画像キャッシュ失敗 ({name}): {e}"),
        }
    }
    log::info!("[weapon-image] all-team キャッシュ完了 {}/{}", downloaded, seen.len());

    Ok(())
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
            log::warn!("ブキ画像URL更新失敗 ({weapon_name}): {e}");
        }
    }

    Ok(())
}

/// 保存済みバトルの my_team / other_teams JSON からギアパワー（アビリティ）画像をキャッシュする。
/// 画像名は stat.ink のアビリティキー（`ink_saver_main` など）、空スロットは `empty`。
pub async fn cache_ability_images(
    pool: &crate::db::DbPool,
    app: &tauri::AppHandle,
    client: &reqwest::Client,
) -> Result<(), String> {
    let team_data = crate::db::get_battles_team_json(pool).await?;

    // ability_key -> url （重複排除）
    let mut seen: std::collections::HashMap<&'static str, String> = std::collections::HashMap::new();

    let mut collect_from_player = |p: &serde_json::Value| {
        for gear_field in ["headGear", "clothingGear", "shoesGear"] {
            let Some(gear) = p.get(gear_field) else { continue };

            // primary
            if let Some(url) = gear.pointer("/primaryGearPower/image/url").and_then(|v| v.as_str()) {
                if let Some(key) = crate::abilities::cache_key_from_url(url) {
                    seen.entry(key).or_insert_with(|| url.to_string());
                }
            }

            // additionals
            if let Some(arr) = gear.get("additionalGearPowers").and_then(|v| v.as_array()) {
                for sub in arr {
                    if let Some(url) = sub.pointer("/image/url").and_then(|v| v.as_str()) {
                        if let Some(key) = crate::abilities::cache_key_from_url(url) {
                            seen.entry(key).or_insert_with(|| url.to_string());
                        }
                    }
                }
            }
        }
    };

    for (my_team_json, other_teams_json) in &team_data {
        if let Some(json) = my_team_json {
            if let Ok(arr) = serde_json::from_str::<serde_json::Value>(json) {
                if let Some(list) = arr.as_array() {
                    for p in list { collect_from_player(p); }
                }
            }
        }
        if let Some(json) = other_teams_json {
            if let Ok(arr) = serde_json::from_str::<serde_json::Value>(json) {
                if let Some(teams) = arr.as_array() {
                    for team in teams {
                        if let Some(list) = team.pointer("/players").and_then(|v| v.as_array()) {
                            for p in list { collect_from_player(p); }
                        }
                    }
                }
            }
        }
    }

    for (key, url) in &seen {
        if let Err(e) = crate::images::download_and_cache(app, client, "ability", key, url).await {
            log::warn!("アビリティ画像キャッシュ失敗 ({key}): {e}");
        }
    }

    Ok(())
}

/// ギアパワー画像ハッシュから SplatNet3 のスキル画像 URL を組み立てる（#360）。
///
/// 観測された実データの URL は `.../resources/prod/v3/skill_img/<hash>_0.png`
/// （`icon_manifest.rs` 冒頭の調査結果）。`/image/url` 経由で得られる URL は
/// CloudFront の署名付きだが、`resources/prod` 配下は署名なしで配信される想定でこの形を使う。
fn ability_image_url(hash: &str) -> String {
    format!("https://api.lp1.av5ja.srv.nintendo.net/resources/prod/v3/skill_img/{hash}_0.png")
}

/// `abilities::ABILITY_HASHES` の全 26 種 + 空スロットを **登場に依存せず先回りキャッシュ**する（#360）。
///
/// `cache_ability_images` は「保存済みバトルに登場したギアパワー」しかキャッシュしないため、
/// viewer #24 の目標スキル選択チップ（所持に関係なく全スキルを出す）や #35 のアイコン表示で
/// アイコン欠け（テキストフォールバック混在）が起きる。これを埋めるため全種を取得する。
/// `download_and_cache` は既存ファイルを短絡するので、登場済みのものは再取得されない。
///
/// ⚠️ **未署名 URL（`ability_image_url`）で 200 が返るかは実機未検証**。開発環境からは
/// 任天堂ホストへ到達できないため確認できていない（`icon_manifest.rs` 冒頭の調査結果参照）。
/// 万一 `resources/prod` が署名必須だと全 27 件が失敗するので、**最初の実リクエストが失敗したら
/// 以降を試さず 1 警告で打ち切る**（毎回の取得フローで 27 連続失敗が出るのを避ける）。
/// 失敗してもメインの取得フローは止めない（呼び出し側で `?` を使わず握りつぶす前提の `Ok` を返す）。
pub async fn cache_all_ability_images(
    app: &tauri::AppHandle,
    client: &reqwest::Client,
) -> Result<(), String> {
    let mut cached = 0usize;
    let mut attempted = 0usize;
    for (hash, key_opt) in crate::abilities::ABILITY_HASHES {
        let key = key_opt.unwrap_or(crate::abilities::EMPTY_SLOT_KEY);
        let url = ability_image_url(hash);
        attempted += 1;
        match crate::images::download_and_cache(app, client, "ability", key, &url).await {
            Ok(()) => cached += 1,
            Err(e) => {
                log::warn!(
                    "[ability-image] 先回りキャッシュ失敗 ({key}): {e}。\
                     未署名配信に非対応の可能性があるため以降の先回り取得をスキップします。"
                );
                break;
            }
        }
    }
    log::info!(
        "[ability-image] 先回りキャッシュ {}/{} 件（全 {} 種対象）",
        cached,
        attempted,
        crate::abilities::ABILITY_HASHES.len()
    );
    Ok(())
}

/// バトルノード一覧からブキ・ステージの画像 URL を収集する（重複なし）。
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

#[cfg(test)]
mod ability_image_tests {
    use super::*;

    #[test]
    fn builds_v3_skill_img_url_from_hash() {
        let hash = "5c98cc37d2ce56291a7e430459dc9c44d53ca98b8426c5192f4a53e6dd6e4293";
        let url = ability_image_url(hash);
        assert_eq!(
            url,
            "https://api.lp1.av5ja.srv.nintendo.net/resources/prod/v3/skill_img/\
             5c98cc37d2ce56291a7e430459dc9c44d53ca98b8426c5192f4a53e6dd6e4293_0.png"
        );
    }

    #[test]
    fn every_ability_hash_yields_a_url_and_cache_key() {
        // 先回りキャッシュ（#360）が全 26 種 + 空スロットを漏れなく対象にすることを固定する。
        // URL は必ずそのハッシュを含み、キャッシュキー（画像名）は
        // Some(key) はそのキー、None（空スロット）は EMPTY_SLOT_KEY に正規化される。
        assert_eq!(crate::abilities::ABILITY_HASHES.len(), 27);
        for (hash, key_opt) in crate::abilities::ABILITY_HASHES {
            let url = ability_image_url(hash);
            assert!(url.contains(hash), "URL に {hash} が含まれること");
            assert!(url.ends_with("_0.png"));

            let key = key_opt.unwrap_or(crate::abilities::EMPTY_SLOT_KEY);
            // 逆引き（cache_key_from_url）と往復で一致すること＝キャッシュ名が契約どおり。
            assert_eq!(crate::abilities::cache_key_from_url(&url), Some(key));
        }
    }

    #[test]
    fn empty_slot_maps_to_empty_key() {
        let (empty_hash, key_opt) = crate::abilities::ABILITY_HASHES
            .iter()
            .find(|(_, k)| k.is_none())
            .expect("空スロットのエントリが存在すること");
        assert!(key_opt.is_none());
        let key = key_opt.unwrap_or(crate::abilities::EMPTY_SLOT_KEY);
        assert_eq!(key, crate::abilities::EMPTY_SLOT_KEY);
        assert_eq!(
            crate::abilities::cache_key_from_url(&ability_image_url(empty_hash)),
            Some(crate::abilities::EMPTY_SLOT_KEY)
        );
    }
}
