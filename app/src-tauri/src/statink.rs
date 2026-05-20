//! stat.ink API v3 へのバトルデータアップロード。

use reqwest::Client;
use std::collections::HashMap;

const STATINK_API: &str = "https://stat.ink/api/v3";

// ---------------------------------------------------------------------------
// マッピング
// ---------------------------------------------------------------------------

/// ルールスラグ（chartoon）→ stat.ink ルールキー
fn map_rule(rule: &str) -> &str {
    match rule {
        "turf_war" => "nawabari",
        "area"     => "area",
        "yagura"   => "yagura",
        "hoko"     => "hoko",
        "asari"    => "asari",
        _          => rule,
    }
}

/// モード（chartoon）→ stat.ink lobby キー
fn map_mode(mode: &str) -> &str {
    match mode {
        "x"                 => "xmatch",
        "regular"           => "regular",
        "bankara_challenge" => "bankara_challenge",
        "bankara_open"      => "bankara_open",
        _                   => mode,
    }
}

// ---------------------------------------------------------------------------
// stat.ink マスターデータ取得
// ---------------------------------------------------------------------------

/// stat.ink から `ja_JP 名 → key` のマップを取得する（武器またはステージ）。
async fn fetch_name_key_map(client: &Client, endpoint: &str) -> HashMap<String, String> {
    let url = format!("{STATINK_API}/{endpoint}");
    let Ok(resp) = client
        .get(&url)
        .header("User-Agent", "chartoon/0.1")
        .send()
        .await
    else {
        return HashMap::new();
    };

    if !resp.status().is_success() {
        return HashMap::new();
    }

    let Ok(items) = resp.json::<serde_json::Value>().await else {
        return HashMap::new();
    };

    items
        .as_array()
        .map(|arr| {
            arr.iter()
                .filter_map(|item| {
                    let key  = item.get("key")?.as_str()?.to_string();
                    let name = item.pointer("/name/ja_JP")?.as_str()?.to_string();
                    Some((name, key))
                })
                .collect()
        })
        .unwrap_or_default()
}

// ---------------------------------------------------------------------------
// UUID 生成
// ---------------------------------------------------------------------------

/// バトル ID から冪等な UUID v4 形式文字列を生成する。
fn derive_uuid(battle_id: &str) -> String {
    use sha2::{Digest, Sha256};
    let mut h = Sha256::new();
    h.update(b"chartoon-statink-uuid:");
    h.update(battle_id.as_bytes());
    let d = h.finalize();
    format!(
        "{:08x}-{:04x}-4{:03x}-{:04x}-{:02x}{:02x}{:02x}{:02x}{:02x}{:02x}",
        u32::from_be_bytes([d[0], d[1], d[2], d[3]]),
        u16::from_be_bytes([d[4], d[5]]),
        u16::from_be_bytes([d[6], d[7]]) & 0x0fff,
        (u16::from_be_bytes([d[8], d[9]]) & 0x3fff) | 0x8000,
        d[10], d[11], d[12], d[13], d[14], d[15],
    )
}

// ---------------------------------------------------------------------------
// チームメンバー変換ヘルパー
// ---------------------------------------------------------------------------

/// SplatNet3 プレイヤー配列 JSON → stat.ink team_members 配列。
fn build_team_members(players_json: &str, weapon_map: &HashMap<String, String>) -> serde_json::Value {
    let Ok(players) = serde_json::from_str::<serde_json::Value>(players_json) else {
        return serde_json::json!([]);
    };
    let Some(arr) = players.as_array() else {
        return serde_json::json!([]);
    };

    let members: Vec<serde_json::Value> = arr
        .iter()
        .map(|p| {
            let is_myself = p.get("isMyself").and_then(|v| v.as_bool()).unwrap_or(false);
            let weapon_name = p.pointer("/weapon/name").and_then(|v| v.as_str()).unwrap_or("");
            let weapon_key = weapon_map
                .get(weapon_name)
                .cloned()
                .unwrap_or_else(|| weapon_name.to_string());
            let kill    = p.pointer("/result/kill")   .and_then(|v| v.as_i64()).unwrap_or(0);
            let death   = p.pointer("/result/death")  .and_then(|v| v.as_i64()).unwrap_or(0);
            let assist  = p.pointer("/result/assist") .and_then(|v| v.as_i64()).unwrap_or(0);
            let special = p.pointer("/result/special").and_then(|v| v.as_i64()).unwrap_or(0);
            let inked   = p.get("paint").and_then(|v| v.as_i64()).unwrap_or(0);

            serde_json::json!({
                "me":            is_myself,
                "weapon":        weapon_key,
                "kill":          kill,
                "assist":        assist,
                "kill_or_assist": kill + assist,
                "death":         death,
                "special":       special,
                "inked":         if inked > 0 { serde_json::json!(inked) } else { serde_json::Value::Null },
            })
        })
        .collect();

    serde_json::json!(members)
}

/// SplatNet3 otherTeams JSON → stat.ink their_team_members 配列（最初のチームを使用）。
fn build_their_team_members(other_teams_json: &str, weapon_map: &HashMap<String, String>) -> serde_json::Value {
    let Ok(teams) = serde_json::from_str::<serde_json::Value>(other_teams_json) else {
        return serde_json::json!([]);
    };
    let players_json = teams
        .as_array()
        .and_then(|arr| arr.first())
        .and_then(|team| team.get("players"))
        .map(|v| v.to_string())
        .unwrap_or_default();

    if players_json.is_empty() {
        return serde_json::json!([]);
    }
    build_team_members(&players_json, weapon_map)
}

/// SplatNet3 awards JSON → stat.ink medals 配列（名前のみ）。
fn build_medals(awards_json: &str) -> serde_json::Value {
    let Ok(awards) = serde_json::from_str::<serde_json::Value>(awards_json) else {
        return serde_json::Value::Null;
    };
    let Some(arr) = awards.as_array() else {
        return serde_json::Value::Null;
    };
    let names: Vec<serde_json::Value> = arr
        .iter()
        .filter_map(|a| a.get("name").and_then(|v| v.as_str()).map(|s| serde_json::json!(s)))
        .collect();

    if names.is_empty() {
        serde_json::Value::Null
    } else {
        serde_json::json!(names)
    }
}

// ---------------------------------------------------------------------------
// アップロード
// ---------------------------------------------------------------------------

/// statink_uuid が未設定のバトルを stat.ink へアップロードする。
/// 返り値: アップロード成功件数。
pub async fn upload_pending_battles(
    pool: &crate::db::DbPool,
    client: &Client,
    api_key: &str,
) -> Result<usize, String> {
    if api_key.is_empty() {
        return Ok(0);
    }

    // マスターデータ取得（武器・ステージの ja_JP → key マップ）
    let weapon_map = fetch_name_key_map(client, "weapon").await;
    let stage_map  = fetch_name_key_map(client, "stage").await;

    if weapon_map.is_empty() {
        log::warn!("[stat.ink] 武器マスター取得失敗。武器キーにフォールバックします");
    }
    if stage_map.is_empty() {
        log::warn!("[stat.ink] ステージマスター取得失敗。ステージキーにフォールバックします");
    }

    let battles = crate::db::get_battles_not_uploaded(pool).await?;
    if battles.is_empty() {
        return Ok(0);
    }

    let mut uploaded = 0usize;

    for battle in &battles {
        let uuid = derive_uuid(&battle.id);

        // 武器キー: ja_JP 名 → stat.ink key（取得失敗時は日本語名をそのまま）
        let weapon_key = weapon_map
            .get(&battle.weapon)
            .cloned()
            .unwrap_or_else(|| battle.weapon.clone());

        // ステージキー: stage_name(ja_JP) → stat.ink key
        let stage_key = battle
            .stage_name
            .as_deref()
            .and_then(|n| stage_map.get(n))
            .cloned()
            .unwrap_or_else(|| battle.stage.clone());

        // kill/death は detail_fetched 後でないと 0 → 両方 0 なら null 扱い
        let has_detail = battle.kill > 0 || battle.death > 0;

        // played_at (ISO 8601) → Unix タイムスタンプ
        let start_ts = chrono::DateTime::parse_from_rfc3339(&battle.played_at)
            .map(|dt| dt.timestamp())
            .unwrap_or(0);
        let end_ts = if battle.duration > 0 && start_ts > 0 {
            start_ts + battle.duration as i64
        } else {
            0
        };

        // knockout: SplatNet3 "WIN"/"LOSE" → stat.ink true（KO決着）、null → false
        let knockout_val = match battle.knockout.as_deref() {
            Some("WIN") | Some("LOSE") => serde_json::json!(true),
            _ => serde_json::json!(false),
        };

        let mut payload = serde_json::json!({
            "uuid":    uuid,
            "lobby":   map_mode(&battle.mode),
            "rule":    map_rule(&battle.rule),
            "stage":   stage_key,
            "weapon":  weapon_key,
            "result":  battle.result,
            "knockout": knockout_val,
            "inked":   if battle.inked    > 0 { serde_json::json!(battle.inked)    } else { serde_json::Value::Null },
            "duration": if battle.duration > 0 { serde_json::json!(battle.duration) } else { serde_json::Value::Null },
            "start_at": if start_ts > 0 { serde_json::json!(start_ts) } else { serde_json::Value::Null },
            "end_at":   if end_ts   > 0 { serde_json::json!(end_ts)   } else { serde_json::Value::Null },
            "agent":         "chartoon",
            "agent_version": env!("CARGO_PKG_VERSION"),
            "automated":     true,
        });

        if has_detail {
            payload["kill"]          = serde_json::json!(battle.kill);
            payload["assist"]        = serde_json::json!(battle.assist);
            payload["kill_or_assist"] = serde_json::json!(battle.kill + battle.assist);
            payload["death"]         = serde_json::json!(battle.death);
            payload["special"]       = serde_json::json!(battle.special);
        }

        // X パワー
        if let Some(xp) = battle.x_power {
            payload["x_power_after"] = serde_json::json!(xp);
        }

        // メダル（アワード）
        if let Some(ref awards_json) = battle.awards {
            let medals = build_medals(awards_json);
            if !medals.is_null() {
                payload["medals"] = medals;
            }
        }

        // 味方チーム
        if let Some(ref my_team_json) = battle.my_team {
            let members = build_team_members(my_team_json, &weapon_map);
            if members.as_array().map(|a| !a.is_empty()).unwrap_or(false) {
                payload["our_team_members"] = members;
            }
        }

        // 相手チーム
        if let Some(ref other_teams_json) = battle.other_teams {
            let members = build_their_team_members(other_teams_json, &weapon_map);
            if members.as_array().map(|a| !a.is_empty()).unwrap_or(false) {
                payload["their_team_members"] = members;
            }
        }

        let resp = client
            .post(format!("{STATINK_API}/battle"))
            .header("Authorization", format!("Bearer {api_key}"))
            .header("Content-Type", "application/json")
            .header("User-Agent", "chartoon/0.1")
            .json(&payload)
            .send()
            .await;

        match resp {
            Ok(r) if r.status().is_success() => {
                // レスポンスの uuid を保存（なければ生成した uuid を使用）
                let statink_uuid = r
                    .json::<serde_json::Value>()
                    .await
                    .ok()
                    .and_then(|v| v.get("uuid").and_then(|u| u.as_str()).map(|s| s.to_string()))
                    .unwrap_or_else(|| uuid.clone());
                crate::db::mark_statink_uploaded(pool, &battle.id, &statink_uuid).await?;
                uploaded += 1;
            }
            Ok(r) if r.status().as_u16() == 422 => {
                // バリデーションエラー（重複など）→ アップロード済みとしてマーク
                log::warn!(
                    "[stat.ink] スキップ (422) id={}…",
                    &battle.id[..battle.id.len().min(20)]
                );
                crate::db::mark_statink_uploaded(pool, &battle.id, &uuid).await?;
            }
            Ok(r) => {
                let status = r.status();
                let body = r.text().await.unwrap_or_default();
                let snippet = &body[..body.len().min(500)];
                log::warn!("[stat.ink] アップロード失敗: status={status} body={snippet}");
            }
            Err(e) => {
                log::warn!("[stat.ink] 通信エラー: {e}");
                break; // 接続エラーなら以降もスキップ
            }
        }
    }

    log::info!("[stat.ink] {} 件アップロード完了 (対象 {} 件)", uploaded, battles.len());
    Ok(uploaded)
}
