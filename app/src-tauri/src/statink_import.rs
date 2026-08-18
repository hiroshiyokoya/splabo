//! stat.ink API v3 からの過去バトル履歴インポート（#174）。
//!
//! `statink.rs` の逆方向。stat.ink に保存済みの自分のバトルを一括ダウンロードし、
//! 新スキーマ (`battle` / `battle_player` / マスター) へ取り込む。
//!
//! 取得経路（調査で確定した stat.ink API v3 仕様）:
//! - 一覧 JSON: `GET https://stat.ink/@<screen_name>/spl3/index.json?page=N`
//!   - `show-v3/user-json` アクション。`ActiveDataProvider` の pageSize=100、`page` で 1 始まりページング。
//!   - `Authorization: Bearer <api_key>` を付けると `isAuthenticated=true` になり、
//!     非公開バトルも含めて返る（GetSingleBattleAction / UserAction の isAuthenticated 判定より）。
//!   - 各要素は `BattleApiFormatter::toJson` 形式（statink.rs が POST する形とほぼ対称）。
//! - screen_name は API キーから直接引けないため、既存のアップロード済みバトル 1 件から
//!   `fetch_screen_name`（`GET /api/v3/battle/<uuid>` の `user.screen_name`）で取得する。
//!
//! マスターキーのマッピング:
//! - lobby / rule / result: stat.ink の key と chartoon の seed が一致するので素通し。
//! - weapon: chartoon の weapon.key は SplatNet 表示名なので `weapon.name.ja_JP` を使う。
//! - stage:  chartoon の map.key は SplatNet 数値 ID。stat.ink には数値 ID が無いので
//!   `stage.name.ja_JP` で既存 map に名寄せし、無ければ stat.ink stage key で新規作成する。

use reqwest::Client;
use serde_json::Value;

const USER_AGENT: &str = concat!("chartoon/", env!("CARGO_PKG_VERSION"));

/// ページ間の待機（レート制限を尊重）。
const PAGE_DELAY_MS: u64 = 1500;
/// 安全のためのページ上限（100 件/page → 最大 50,000 件）。
const MAX_PAGES: u32 = 500;
/// 1 ページあたりの想定件数（pageSize=100）。これ未満なら最終ページとみなす。
const PAGE_SIZE: usize = 100;

/// インポート結果。
#[derive(Debug, serde::Serialize, Default)]
pub struct ImportResult {
    /// 新規取り込み件数。
    pub imported: usize,
    /// 既存（uuid 重複）でスキップした件数。
    pub skipped: usize,
    /// マッピング失敗等でスキップした件数。
    pub failed: usize,
    /// 取得したバトル総数。
    pub total: usize,
}

// ---------------------------------------------------------------------------
// JSON ヘルパー
// ---------------------------------------------------------------------------

/// 多言語 name オブジェクトから ja_JP を優先、無ければ en_US を取り出す。
fn name_ja(v: Option<&Value>) -> Option<String> {
    let obj = v?;
    obj.get("ja_JP")
        .or_else(|| obj.get("ja-JP"))
        .and_then(|x| x.as_str())
        .map(|s| s.to_string())
}

fn name_en(v: Option<&Value>) -> Option<String> {
    let obj = v?;
    obj.get("en_US")
        .or_else(|| obj.get("en-US"))
        .and_then(|x| x.as_str())
        .map(|s| s.to_string())
}

fn opt_i64(v: &Value, key: &str) -> Option<i64> {
    v.get(key).and_then(|x| x.as_i64())
}

fn opt_f64(v: &Value, key: &str) -> Option<f64> {
    // stat.ink の power 系は文字列 "1234.5" のことがあるため両対応。
    match v.get(key) {
        Some(Value::Number(n)) => n.as_f64(),
        Some(Value::String(s)) => s.parse::<f64>().ok(),
        _ => None,
    }
}

fn i64_or_zero(v: &Value, key: &str) -> i64 {
    opt_i64(v, key).unwrap_or(0)
}

/// start_at（{time, iso8601}）から chartoon の played_at（"YYYY-MM-DDTHH:MM:SSZ"）を作る。
fn played_at_from_battle(b: &Value) -> String {
    if let Some(ts) = b.pointer("/start_at/time").and_then(|v| v.as_i64()) {
        if let Some(dt) = chrono::DateTime::from_timestamp(ts, 0) {
            return dt.format("%Y-%m-%dT%H:%M:%SZ").to_string();
        }
    }
    // フォールバック: iso8601 文字列をそのまま正規化。
    if let Some(s) = b.pointer("/start_at/iso8601").and_then(|v| v.as_str()) {
        if let Ok(dt) = chrono::DateTime::parse_from_rfc3339(s) {
            return dt.with_timezone(&chrono::Utc).format("%Y-%m-%dT%H:%M:%SZ").to_string();
        }
    }
    String::new()
}

/// duration（秒）を start/end から計算。
fn duration_from_battle(b: &Value) -> i64 {
    let start = b.pointer("/start_at/time").and_then(|v| v.as_i64());
    let end = b.pointer("/end_at/time").and_then(|v| v.as_i64());
    match (start, end) {
        (Some(s), Some(e)) if e > s => e - s,
        _ => 0,
    }
}

/// stat.ink の 1 プレイヤー JSON を、chartoon の parse_players_from_json が読める
/// SplatNet 互換の最小形に変換する。
/// stat.ink: { me, weapon:{name:{ja_JP}}, kill, assist, death, special, inked, ... }
/// SplatNet 互換: { isMyself, weapon:{name}, result:{kill,assist,death,special}, paint }
fn statink_player_to_splatnet(p: &Value) -> Value {
    let weapon_name = name_ja(p.pointer("/weapon/name"))
        .or_else(|| name_en(p.pointer("/weapon/name")))
        .unwrap_or_default();
    let sub_name = name_ja(p.pointer("/weapon/sub/name"));
    let special_name = name_ja(p.pointer("/weapon/special/name"));

    // parse_players_from_json は my チームを kill_or_assist - assist で実キルにするため、
    // result.kill には kill_or_assist 相当（= stat.ink の kill_or_assist）を入れる。
    let kill_or_assist = opt_i64(p, "kill_or_assist")
        .unwrap_or_else(|| i64_or_zero(p, "kill") + i64_or_zero(p, "assist"));
    let assist = i64_or_zero(p, "assist");
    let death = i64_or_zero(p, "death");
    let special = i64_or_zero(p, "special");
    let paint = i64_or_zero(p, "inked");
    let is_myself = p.get("me").and_then(|v| v.as_bool()).unwrap_or(false);

    let mut weapon = serde_json::json!({ "name": weapon_name });
    if let Some(s) = sub_name {
        weapon["subWeapon"] = serde_json::json!({ "name": s });
    }
    if let Some(s) = special_name {
        weapon["specialWeapon"] = serde_json::json!({ "name": s });
    }

    serde_json::json!({
        "isMyself": is_myself,
        "weapon": weapon,
        "paint": paint,
        "result": {
            "kill": kill_or_assist,
            "assist": assist,
            "death": death,
            "special": special,
        }
    })
}

/// stat.ink players 配列を SplatNet 互換配列へ。
fn build_team_players(members: Option<&Value>) -> Vec<Value> {
    members
        .and_then(|v| v.as_array())
        .map(|arr| arr.iter().map(statink_player_to_splatnet).collect())
        .unwrap_or_default()
}

/// stat.ink battle JSON から自分のプレイヤーを探す。
fn find_myself<'a>(b: &'a Value) -> Option<&'a Value> {
    b.pointer("/our_team_members")
        .and_then(|v| v.as_array())
        .and_then(|arr| arr.iter().find(|p| p.get("me").and_then(|m| m.as_bool()).unwrap_or(false)))
}

/// ウデマエ文字列を (rank, s_plus) に分解（statink.rs::parse_udemae と同等の逆方向）。
/// stat.ink の rank_before / rank_after は { key: "s+", name: {...} } 形式。
fn rank_key(v: Option<&Value>) -> Option<String> {
    v?.get("key").and_then(|x| x.as_str()).map(|s| s.to_uppercase())
}

// ---------------------------------------------------------------------------
// マッピング: stat.ink battle JSON → ImportedBattleRow
// ---------------------------------------------------------------------------

fn map_battle(b: &Value) -> Option<crate::db::ImportedBattleRow> {
    let uuid = b.get("uuid").and_then(|v| v.as_str())?.to_string();
    if uuid.is_empty() {
        return None;
    }

    let lobby_key = b.pointer("/lobby/key").and_then(|v| v.as_str()).unwrap_or("").to_string();
    let rule_key = b.pointer("/rule/key").and_then(|v| v.as_str()).unwrap_or("").to_string();
    let result_key = b.get("result").and_then(|v| v.as_str()).unwrap_or("").to_string();

    let weapon_key = name_ja(b.pointer("/weapon/name"))
        .or_else(|| name_en(b.pointer("/weapon/name")))
        .unwrap_or_default();

    let stage_statink_key = b.pointer("/stage/key").and_then(|v| v.as_str()).unwrap_or("").to_string();
    let stage_name_ja = name_ja(b.pointer("/stage/name"));
    let stage_name_en = name_en(b.pointer("/stage/name"));

    let is_knockout = match b.get("knockout") {
        Some(Value::Bool(true)) => Some(1),
        Some(Value::Bool(false)) => Some(0),
        _ => None,
    };

    // 自分のスタッツ。トップレベルにあるが、念のため our_team_members の me からも補完。
    let myself = find_myself(b);
    let kill_or_assist = opt_i64(b, "kill_or_assist")
        .or_else(|| myself.and_then(|m| opt_i64(m, "kill_or_assist")))
        .unwrap_or(0);
    let assist = opt_i64(b, "assist").or_else(|| myself.and_then(|m| opt_i64(m, "assist"))).unwrap_or(0);
    let kill = opt_i64(b, "kill").or_else(|| myself.and_then(|m| opt_i64(m, "kill"))).unwrap_or(kill_or_assist - assist);
    let death = opt_i64(b, "death").or_else(|| myself.and_then(|m| opt_i64(m, "death"))).unwrap_or(0);
    let special = opt_i64(b, "special").or_else(|| myself.and_then(|m| opt_i64(m, "special"))).unwrap_or(0);
    let inked = opt_i64(b, "inked").or_else(|| myself.and_then(|m| opt_i64(m, "inked"))).unwrap_or(0);

    // my_team / other_teams を SplatNet 互換形に組み直す（プレイヤー行・ギア集計用）。
    let my_players = build_team_players(b.get("our_team_members"));
    let their_players = build_team_players(b.get("their_team_members"));
    let third_players = build_team_players(b.get("third_team_members"));

    let my_team = if my_players.is_empty() {
        None
    } else {
        Some(Value::Array(my_players).to_string())
    };
    let mut other_teams_arr: Vec<Value> = Vec::new();
    if !their_players.is_empty() {
        other_teams_arr.push(serde_json::json!({ "players": their_players }));
    }
    if !third_players.is_empty() {
        other_teams_arr.push(serde_json::json!({ "players": third_players }));
    }
    let other_teams = if other_teams_arr.is_empty() {
        None
    } else {
        Some(Value::Array(other_teams_arr).to_string())
    };

    Some(crate::db::ImportedBattleRow {
        id: uuid.clone(),
        uuid,
        played_at: played_at_from_battle(b),
        lobby_key,
        rule_key,
        result_key,
        weapon_key,
        stage_statink_key,
        stage_name_ja,
        stage_name_en,
        is_knockout,
        rank_in_team: opt_i64(b, "rank_in_team"),
        kill,
        assist,
        kill_or_assist,
        death,
        special,
        inked,
        duration: duration_from_battle(b),
        our_team_inked: opt_i64(b, "our_team_inked"),
        their_team_inked: opt_i64(b, "their_team_inked"),
        our_team_percent: opt_f64(b, "our_team_percent"),
        their_team_percent: opt_f64(b, "their_team_percent"),
        our_team_count: opt_i64(b, "our_team_count"),
        their_team_count: opt_i64(b, "their_team_count"),
        rank_before: rank_key(b.get("rank_before")),
        rank_after: rank_key(b.get("rank_after")),
        rank_before_s_plus: opt_i64(b, "rank_before_s_plus"),
        rank_after_s_plus: opt_i64(b, "rank_after_s_plus"),
        x_power_before: opt_f64(b, "x_power_before"),
        x_power_after: opt_f64(b, "x_power_after"),
        raw_json: b.to_string(),
        my_team,
        other_teams,
    })
}

// ---------------------------------------------------------------------------
// 取得本体
// ---------------------------------------------------------------------------

/// stat.ink から自分の全バトルをインポートする。
///
/// 1. screen_name を取得（アップロード済みバトルから逆引き）。
/// 2. `@<screen_name>/spl3/index.json?page=N` を Bearer 認証で順次取得。
/// 3. 各バトルを uuid で重複チェックし、新規のみ新スキーマへ取り込む。
pub async fn import_all_battles(
    pool: &crate::db::DbPool,
    client: &Client,
    api_key: &str,
) -> Result<ImportResult, String> {
    if api_key.is_empty() {
        return Err("STATINK_NO_API_KEY: stat.ink API キーが設定されていません".to_string());
    }

    // screen_name 取得（アップロード済みバトルが 1 件以上必要）。
    let screen_name = crate::statink::fetch_screen_name(pool, client, api_key)
        .await?
        .ok_or_else(|| {
            "stat.ink の screen_name を特定できませんでした。先に 1 件以上アップロードするか、\
             stat.ink にバトルが存在することを確認してください。"
                .to_string()
        })?;

    let mut result = ImportResult::default();

    for page in 1..=MAX_PAGES {
        let url = format!("https://stat.ink/@{screen_name}/spl3/index.json?page={page}");
        let resp = client
            .get(&url)
            .header("Authorization", format!("Bearer {api_key}"))
            .header("User-Agent", USER_AGENT)
            .send()
            .await
            .map_err(|e| format!("stat.ink 通信エラー (page {page}): {e}"))?;

        let status = resp.status();
        if status.as_u16() == 429 {
            return Err(format!(
                "stat.ink のレート制限に達しました (page {page})。{} 件取り込み済み。しばらく待って再実行してください。",
                result.imported
            ));
        }
        if !status.is_success() {
            let body = resp.text().await.unwrap_or_default();
            return Err(format!(
                "stat.ink 取得失敗 (page {page}): status={status} body={}",
                &body[..body.len().min(300)]
            ));
        }

        let body: Value = resp
            .json()
            .await
            .map_err(|e| format!("stat.ink JSON パース失敗 (page {page}): {e}"))?;

        let battles = match body.as_array() {
            Some(arr) => arr,
            None => {
                log::warn!("[import] page {page} が配列ではありません。終了します。");
                break;
            }
        };

        if battles.is_empty() {
            break;
        }

        let count = battles.len();
        result.total += count;

        for b in battles {
            let Some(row) = map_battle(b) else {
                result.failed += 1;
                continue;
            };

            match crate::db::battle_uuid_exists(pool, &row.uuid).await {
                Ok(true) => {
                    result.skipped += 1;
                    continue;
                }
                Ok(false) => {}
                Err(e) => {
                    log::warn!("[import] uuid 重複チェック失敗 uuid={}: {e}", row.uuid);
                    result.failed += 1;
                    continue;
                }
            }

            match crate::db::insert_imported_battle(pool, &row).await {
                Ok(true) => result.imported += 1,
                Ok(false) => result.skipped += 1, // FK 解決失敗 or 競合
                Err(e) => {
                    log::warn!("[import] 挿入失敗 uuid={}: {e}", row.uuid);
                    result.failed += 1;
                }
            }
        }

        log::info!(
            "[import] page {page}: {} 件取得 (新規 {} / スキップ {} / 失敗 {})",
            count,
            result.imported,
            result.skipped,
            result.failed,
        );

        // 最終ページ判定（pageSize 未満なら終わり）。
        if count < PAGE_SIZE {
            break;
        }

        // レート制限を尊重して待機。
        tokio::time::sleep(std::time::Duration::from_millis(PAGE_DELAY_MS)).await;
    }

    log::info!(
        "[import] 完了: 新規 {} / スキップ {} / 失敗 {} (総取得 {})",
        result.imported,
        result.skipped,
        result.failed,
        result.total,
    );
    Ok(result)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample_battle() -> Value {
        serde_json::json!({
            "uuid": "11111111-2222-3333-4444-555555555555",
            "lobby": { "key": "bankara_challenge" },
            "rule": { "key": "area" },
            "result": "win",
            "knockout": true,
            "weapon": { "key": "wakaba", "name": { "ja_JP": "わかばシューター", "en_US": "Splattershot Jr." } },
            "stage": { "key": "yunohana", "name": { "ja_JP": "ユノハナ大渓谷", "en_US": "Scorch Gorge" } },
            "kill": 8, "assist": 2, "kill_or_assist": 10, "death": 4, "special": 3, "inked": 1200,
            "rank_in_team": 1,
            "our_team_count": 5, "their_team_count": 3,
            "rank_before": { "key": "s+" }, "rank_after": { "key": "s+" },
            "rank_before_s_plus": 0, "rank_after_s_plus": 1,
            "start_at": { "time": 1716042801, "iso8601": "2024-05-18T14:33:21+00:00" },
            "end_at": { "time": 1716043001 },
            "our_team_members": [
                { "me": true, "weapon": { "name": { "ja_JP": "わかばシューター" } },
                  "kill_or_assist": 10, "assist": 2, "death": 4, "special": 3, "inked": 1200 }
            ],
            "their_team_members": [
                { "me": false, "weapon": { "name": { "ja_JP": "スプラローラー" } },
                  "kill_or_assist": 5, "assist": 1, "death": 6, "special": 2, "inked": 900 }
            ]
        })
    }

    #[test]
    fn maps_core_fields() {
        let row = map_battle(&sample_battle()).expect("should map");
        assert_eq!(row.uuid, "11111111-2222-3333-4444-555555555555");
        assert_eq!(row.id, row.uuid);
        assert_eq!(row.lobby_key, "bankara_challenge");
        assert_eq!(row.rule_key, "area");
        assert_eq!(row.result_key, "win");
        assert_eq!(row.weapon_key, "わかばシューター");
        assert_eq!(row.stage_statink_key, "yunohana");
        assert_eq!(row.stage_name_ja.as_deref(), Some("ユノハナ大渓谷"));
        assert_eq!(row.is_knockout, Some(1));
        assert_eq!(row.kill, 8);
        assert_eq!(row.assist, 2);
        assert_eq!(row.kill_or_assist, 10);
        assert_eq!(row.death, 4);
        assert_eq!(row.rank_in_team, Some(1));
        assert_eq!(row.rank_after_s_plus, Some(1));
        assert_eq!(row.played_at, "2024-05-18T14:33:21Z");
        assert_eq!(row.duration, 200);
    }

    #[test]
    fn builds_player_json_compatible_with_parser() {
        let row = map_battle(&sample_battle()).expect("should map");
        let players = crate::db::parse_players_from_json(
            &row.id,
            row.my_team.as_deref(),
            row.other_teams.as_deref(),
        );
        // 自分（my）+ 相手 1 名
        assert_eq!(players.len(), 2);
        let me = players.iter().find(|p| p.is_myself).expect("me row");
        assert_eq!(me.weapon, "わかばシューター");
        // my チームは kill_or_assist(10) - assist(2) = 実キル 8
        assert_eq!(me.kill, 8);
        assert_eq!(me.assist, 2);
        assert_eq!(me.death, 4);
    }

    #[test]
    fn missing_uuid_returns_none() {
        let b = serde_json::json!({ "lobby": { "key": "regular" } });
        assert!(map_battle(&b).is_none());
    }
}
