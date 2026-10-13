//! スマホ Web 版の API（#786・設計 #784 §3〜§5）。
//!
//! コンパニオンサーバー（`companion.rs`）の `POST /api/cmd/<名前>` が、許可リストに載せた
//! Tauri コマンドだけをここで中継する。ロジックは持たず、既存のコマンド関数をそのまま呼ぶ。
//!
//! - 引数はフロントの `invoke` と同じ **camelCase の JSON**（Tauri の既定の変換に合わせる）
//! - 非同期のコマンドは HTTP のスレッドから `tauri::async_runtime::block_on` で待つ
//! - 戻り値は JSON にして返す。エラーは invoke と同じく文字列（HTTP 500 の本文）
//!
//! 認証は Cookie（`POST /api/session` でトークンと交換する）。判定は [`session_matches`]。

use serde::de::DeserializeOwned;
use serde::Deserialize;
use serde_json::Value;
use tauri::{AppHandle, Manager};

use crate::db::DbPool;

/// セッション Cookie の名前。値はコンパニオンのトークンそのもの（トークンが変われば無効になる）。
pub const SESSION_COOKIE: &str = "splabo_session";

/// 中継してよいコマンド（設計 #784 §4）。これ以外は 404。
///
/// 載せないもの: ログイン・認証、取得系（`fetch_*`。取り直しは `/update`）、設定の書き込み、
/// AI 分析（API キーを扱う）、stat.ink、データ削除、コンパニオンの操作、ファイル保存、環境データの取り込み。
pub const ALLOWED_COMMANDS: &[&str] = &[
    // 読み取り
    "read_gear_db",
    "read_image",
    "db_list_battles",
    "db_battle_stats",
    "db_summary",
    "db_battle_count",
    "db_grouped_stats",
    "list_seasons",
    "db_list_weapons",
    "db_weapons_used",
    "db_stages_used",
    "list_saved_coordinates",
    // スマホ用: PC の表示設定（スタック型の順など）
    "get_shared_settings",
    // 書き込み（データの正本が PC の 1 つだけなので、スマホから編集しても競合しない）
    "save_coordinate",
    "delete_saved_coordinate",
];

/// スマホにも渡す PC の表示設定（`settings.json` のキー・#789）。
///
/// デスクトップはこれらを WebView の localStorage に持ち、`settings.json`（tauri-plugin-store）へ
/// ミラーしている（`settingsStore.ts`）。スマホのブラウザからは PC の localStorage が見えないので、
/// ミラーの方を読んで渡す。表示言語・カードの大きさは端末ごとに違ってよいので渡さない。
pub const SHARED_SETTING_KEYS: &[&str] = &[
    "splabo:stackableSkillOrder",
    "splabo:comboLimit",
    "splabo:nearLimit",
];

/// `settings.json` の中身から、スマホに渡すキーだけを取り出す（値は文字列のまま）。
pub fn pick_shared_settings(store: &Value) -> serde_json::Map<String, Value> {
    SHARED_SETTING_KEYS
        .iter()
        .filter_map(|k| store.get(*k).filter(|v| v.is_string()).map(|v| (k.to_string(), v.clone())))
        .collect()
}

fn get_shared_settings(app: &AppHandle) -> Result<Value, ApiError> {
    let path = app
        .path()
        .app_data_dir()
        .map_err(|e| ApiError::Failed(e.to_string()))?
        .join("settings.json");
    // 無い・壊れているときは空（スマホは既定の表示になるだけ）
    let store: Value = std::fs::read(&path)
        .ok()
        .and_then(|b| serde_json::from_slice(&b).ok())
        .unwrap_or(Value::Null);
    Ok(Value::Object(pick_shared_settings(&store)))
}

pub fn is_allowed(cmd: &str) -> bool {
    ALLOWED_COMMANDS.contains(&cmd)
}

/// 中継の失敗。HTTP ステータスに対応させる。
#[derive(Debug, PartialEq)]
pub enum ApiError {
    /// 許可リストに無い（404）
    NotFound,
    /// 引数が読めない（400）
    BadRequest(String),
    /// DB の準備がまだ（起動直後・503）
    NotReady,
    /// コマンド自体のエラー（500。本文は invoke と同じ文字列）
    Failed(String),
}

impl ApiError {
    pub fn status(&self) -> u16 {
        match self {
            ApiError::NotFound => 404,
            ApiError::BadRequest(_) => 400,
            ApiError::NotReady => 503,
            ApiError::Failed(_) => 500,
        }
    }

    pub fn body(&self) -> String {
        match self {
            ApiError::NotFound => "not found".to_string(),
            ApiError::BadRequest(m) | ApiError::Failed(m) => m.clone(),
            ApiError::NotReady => "not ready".to_string(),
        }
    }
}

// ---------------------------------------------------------------------------
// 引数（invoke と同じ camelCase）
// ---------------------------------------------------------------------------

/// バトルの絞り込み（`db_battle_stats` / `db_summary` / `db_battle_count` / `db_grouped_stats` 共通）。
#[derive(Debug, Default, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct FilterArgs {
    pub since: Option<String>,
    pub until: Option<String>,
    pub mode: Option<String>,
    pub rule: Option<String>,
    pub result_filter: Option<String>,
    pub weapon: Option<String>,
    pub stage: Option<String>,
}

#[derive(Debug, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ListBattlesArgs {
    pub limit: i64,
    pub offset: i64,
    #[serde(flatten)]
    pub filter: FilterArgs,
    #[serde(default)]
    pub order_by: Option<String>,
    #[serde(default)]
    pub order_asc: Option<bool>,
}

#[derive(Debug, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct GroupedStatsArgs {
    pub group_by: String,
    #[serde(flatten)]
    pub filter: FilterArgs,
}

#[derive(Debug, Deserialize)]
struct SourceArgs {
    source: String,
}

#[derive(Debug, Deserialize)]
struct ReadImageArgs {
    kind: String,
    name: String,
}

#[derive(Debug, Deserialize)]
struct SaveCoordinateArgs {
    input: crate::saved_coordinates::SaveCoordinateInput,
}

#[derive(Debug, Deserialize)]
struct IdArgs {
    id: String,
}

/// 引数 JSON を読む。本文が空・`null` のときは `{}` とみなす（引数の無いコマンド用）。
pub fn parse_args<T: DeserializeOwned>(args: Value) -> Result<T, ApiError> {
    let args = if args.is_null() { Value::Object(Default::default()) } else { args };
    serde_json::from_value(args).map_err(|e| ApiError::BadRequest(format!("引数が不正です: {e}")))
}

fn to_json<T: serde::Serialize>(r: Result<T, String>) -> Result<Value, ApiError> {
    let v = r.map_err(ApiError::Failed)?;
    serde_json::to_value(v).map_err(|e| ApiError::Failed(e.to_string()))
}

// ---------------------------------------------------------------------------
// 中継
// ---------------------------------------------------------------------------

/// 許可リストのコマンドを呼んで、戻り値を JSON で返す。
pub fn dispatch(app: &AppHandle, cmd: &str, args: Value) -> Result<Value, ApiError> {
    if !is_allowed(cmd) {
        return Err(ApiError::NotFound);
    }
    // DB は起動後の setup で非同期に用意される。まだなら 503。
    let db = || app.try_state::<DbPool>().ok_or(ApiError::NotReady);

    match cmd {
        "read_gear_db" => to_json(crate::gear::read_gear_db(app.clone())),
        "read_image" => {
            let a: ReadImageArgs = parse_args(args)?;
            to_json(Ok::<_, String>(crate::images::read_image(app.clone(), a.kind, a.name)))
        }
        "db_list_battles" => {
            let a: ListBattlesArgs = parse_args(args)?;
            let f = a.filter;
            to_json(tauri::async_runtime::block_on(crate::db::db_list_battles(
                db()?, a.limit, a.offset, f.since, f.until, f.mode, f.rule, f.result_filter, f.weapon,
                f.stage, a.order_by, a.order_asc,
            )))
        }
        "db_battle_stats" => {
            let f: FilterArgs = parse_args(args)?;
            to_json(tauri::async_runtime::block_on(crate::db::db_battle_stats(
                db()?, f.since, f.until, f.mode, f.rule, f.result_filter, f.weapon, f.stage,
            )))
        }
        "db_summary" => {
            let f: FilterArgs = parse_args(args)?;
            to_json(tauri::async_runtime::block_on(crate::db::db_summary(
                db()?, f.since, f.until, f.mode, f.rule, f.result_filter, f.weapon, f.stage,
            )))
        }
        "db_battle_count" => {
            let f: FilterArgs = parse_args(args)?;
            to_json(tauri::async_runtime::block_on(crate::db::db_battle_count(
                db()?, f.since, f.until, f.mode, f.rule, f.result_filter, f.weapon, f.stage,
            )))
        }
        "db_grouped_stats" => {
            let a: GroupedStatsArgs = parse_args(args)?;
            let f = a.filter;
            to_json(tauri::async_runtime::block_on(crate::db::db_grouped_stats(
                db()?, a.group_by, f.since, f.until, f.mode, f.rule, f.result_filter, f.weapon, f.stage,
            )))
        }
        "list_seasons" => {
            let a: SourceArgs = parse_args(args)?;
            to_json(tauri::async_runtime::block_on(crate::season::list_seasons(db()?, a.source)))
        }
        "db_list_weapons" => to_json(tauri::async_runtime::block_on(crate::db::db_list_weapons(db()?))),
        "db_weapons_used" => to_json(tauri::async_runtime::block_on(crate::db::db_weapons_used(db()?))),
        "db_stages_used" => to_json(tauri::async_runtime::block_on(crate::db::db_stages_used(db()?))),
        "list_saved_coordinates" => to_json(crate::saved_coordinates::list_saved_coordinates(app.clone())),
        "get_shared_settings" => get_shared_settings(app),
        "save_coordinate" => {
            let a: SaveCoordinateArgs = parse_args(args)?;
            to_json(crate::saved_coordinates::save_coordinate(app.clone(), a.input))
        }
        "delete_saved_coordinate" => {
            let a: IdArgs = parse_args(args)?;
            to_json(crate::saved_coordinates::delete_saved_coordinate(app.clone(), a.id))
        }
        // is_allowed を通ったのにここに来るのは、許可リストと分岐の書き漏れ。
        _ => Err(ApiError::NotFound),
    }
}

// ---------------------------------------------------------------------------
// Cookie
// ---------------------------------------------------------------------------

/// `Cookie` ヘッダから名前の値を取り出す。
pub fn cookie_value<'a>(header: &'a str, name: &str) -> Option<&'a str> {
    header.split(';').find_map(|pair| {
        let (k, v) = pair.trim().split_once('=')?;
        (k == name).then_some(v)
    })
}

/// セッション Cookie がトークンと一致するか。
pub fn session_matches(cookie_header: Option<&str>, token: &str) -> bool {
    !token.is_empty()
        && cookie_header.and_then(|h| cookie_value(h, SESSION_COOKIE)) == Some(token)
}

/// `POST /api/session` で返す `Set-Cookie` の値。LAN の http なので `Secure` は付けない。
pub fn session_set_cookie(token: &str) -> String {
    format!("{SESSION_COOKIE}={token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=31536000")
}

/// `POST /api/session` の本文。
#[derive(Debug, Deserialize)]
pub struct SessionRequest {
    pub token: String,
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn allows_only_listed_commands() {
        assert!(is_allowed("db_list_battles"));
        assert!(is_allowed("save_coordinate"));
        for cmd in ["start_login", "fetch_gear_full", "delete_gear_data", "ai_run_sql", "companion_start", "logout"] {
            assert!(!is_allowed(cmd), "{cmd} must not be relayed");
        }
    }

    #[test]
    fn list_battles_args_are_camel_case_like_invoke() {
        let a: ListBattlesArgs = parse_args(json!({
            "limit": 20, "offset": 40, "mode": "bankara", "resultFilter": "win",
            "orderBy": "played_at", "orderAsc": false
        }))
        .unwrap();
        assert_eq!(a.limit, 20);
        assert_eq!(a.offset, 40);
        assert_eq!(a.filter.mode.as_deref(), Some("bankara"));
        assert_eq!(a.filter.result_filter.as_deref(), Some("win"));
        assert_eq!(a.filter.since, None);
        assert_eq!(a.order_by.as_deref(), Some("played_at"));
        assert_eq!(a.order_asc, Some(false));
    }

    #[test]
    fn grouped_stats_reads_group_by_and_filter() {
        let a: GroupedStatsArgs =
            parse_args(json!({ "groupBy": "weapon", "since": "2026-10-01", "weapon": null })).unwrap();
        assert_eq!(a.group_by, "weapon");
        assert_eq!(a.filter.since.as_deref(), Some("2026-10-01"));
        assert_eq!(a.filter.weapon, None);
    }

    #[test]
    fn missing_or_null_args_mean_no_filter() {
        assert_eq!(parse_args::<FilterArgs>(Value::Null).unwrap(), FilterArgs::default());
        assert_eq!(parse_args::<FilterArgs>(json!({})).unwrap(), FilterArgs::default());
    }

    #[test]
    fn missing_required_arg_is_bad_request() {
        let e = parse_args::<ListBattlesArgs>(json!({ "limit": 10 })).unwrap_err();
        assert!(matches!(e, ApiError::BadRequest(_)));
        assert_eq!(e.status(), 400);
    }

    #[test]
    fn save_coordinate_args_wrap_input() {
        let a: SaveCoordinateArgs = parse_args(json!({ "input": {
            "title": "コーデ1", "memo": "",
            "gears": {
                "head": { "id": 1, "name": "a", "main": 4, "subs": [0, -1, 4] },
                "clothing": { "id": 2, "name": "b", "main": 0, "subs": [] },
                "shoes": { "id": 3, "name": "c", "main": 1, "subs": [1] }
            }
        }}))
        .unwrap();
        assert_eq!(a.input.title, "コーデ1");
        assert_eq!(a.input.id, None);
    }

    #[test]
    fn picks_only_shared_settings() {
        let store = json!({
            "splabo:stackableSkillOrder": "[4,8,9]",
            "splabo:comboLimit": "50",
            "splabo:localePref": "en",
            "splabo:densityId": "spacious",
            "splabo:nearLimit": 10,
            "_mirroredAt": 1
        });
        let picked = pick_shared_settings(&store);
        assert_eq!(picked.get("splabo:stackableSkillOrder"), Some(&json!("[4,8,9]")));
        assert_eq!(picked.get("splabo:comboLimit"), Some(&json!("50")));
        // 端末ごとの設定・文字列でない値は渡さない
        assert!(!picked.contains_key("splabo:localePref"));
        assert!(!picked.contains_key("splabo:densityId"));
        assert!(!picked.contains_key("splabo:nearLimit"));
        assert!(pick_shared_settings(&Value::Null).is_empty());
    }

    #[test]
    fn reads_session_cookie() {
        assert_eq!(cookie_value("a=1; splabo_session=tok; b=2", SESSION_COOKIE), Some("tok"));
        assert!(session_matches(Some("x=y; splabo_session=tok"), "tok"));
        assert!(!session_matches(Some("splabo_session=other"), "tok"));
        assert!(!session_matches(Some("splabo_session_x=tok"), "tok"));
        assert!(!session_matches(None, "tok"));
        // トークンが空のときは何とも一致させない。
        assert!(!session_matches(Some("splabo_session="), ""));
    }

    #[test]
    fn set_cookie_is_http_only_and_strict() {
        let c = session_set_cookie("tok");
        assert!(c.starts_with("splabo_session=tok;"));
        assert!(c.contains("HttpOnly"));
        assert!(c.contains("SameSite=Strict"));
        assert!(c.contains("Path=/"));
    }
}
