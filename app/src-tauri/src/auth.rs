//! Nintendo Switch Online (NSO) OAuth 認証フローの Rust 実装。
//!
//! フロー全体:
//! ```text
//! 1. Nintendo Account ログインURLをブラウザで開く（PKCE付き OAuth2）
//! 2. npf71b963c1b7b6d119://auth#... へリダイレクト → deep-link でキャッチ
//! 3. session_token_code → session_token（長期保存）
//! 4. session_token → id_token（15分）
//! 5. id_token → f-token（POST https://api.imink.app/f）
//! 6. id_token + f-token → gtoken（Web Service Token / 約2時間）
//! 7. gtoken → bulletToken（約2時間）
//! ```
//!
//! 認証情報の永続化:
//! - `session_token` のみ長期保存が必要（tauri-plugin-store に保存）。
//!   将来的には OS キーチェーン（tauri-plugin-keyring）への移行が望ましいが、
//!   Windows ビルドの安定性を優先して現状は store を使用。
//! - `gtoken` / `bulletToken` は短命なため毎回再取得する。

use base64::Engine;
use rand::RngCore;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::sync::Mutex;
use tauri::{AppHandle, Manager, State};
use tauri_plugin_store::StoreExt;

// ---------------------------------------------------------------------------
// 定数
// ---------------------------------------------------------------------------

/// Nintendo Switch Online アプリ (ZNCA) の client_id。
const CLIENT_ID: &str = "71b963c1b7b6d119";
/// OAuth2 リダイレクト先のカスタムスキーム URL（npf<client_id>://auth）。
const REDIRECT_URI: &str = "npf71b963c1b7b6d119://auth";
/// 認可リクエストの scope。
const SCOPE: &str = "openid user user.birthday user.screenName";

/// Nintendo Account 認可エンドポイント。
const NA_AUTHORIZE_URL: &str = "https://accounts.nintendo.com/connect/1.0.0/authorize";
/// session_token_code → session_token 交換エンドポイント。
const NA_SESSION_TOKEN_URL: &str = "https://accounts.nintendo.com/connect/1.0.0/api/session_token";
/// session_token → id_token / access_token 交換エンドポイント。
const NA_TOKEN_URL: &str = "https://accounts.nintendo.com/connect/1.0.0/api/token";
/// Nintendo Account ユーザー情報エンドポイント（birthday/country 取得用）。
const NA_USER_ME_URL: &str = "https://api.accounts.nintendo.com/2.0.0/users/me";

/// Coral (znc) API: Account/Login（gtoken 取得元の login）。
const CORAL_LOGIN_URL: &str = "https://api-lp1.znc.srv.nintendo.net/v4/Account/Login";
/// Coral (znc) API: Game/GetWebServiceToken（gtoken 取得）。
const CORAL_GET_WEB_SERVICE_TOKEN_URL: &str =
    "https://api-lp1.znc.srv.nintendo.net/v4/Game/GetWebServiceToken";

/// nxapi-znca-api f-token 生成エンドポイント。
const ZNCA_API_URL: &str = "https://nxapi-znca-api.fancy.org.uk/api/znca/f";
/// nxapi クライアント互換バージョン（nxapi の ZNCA_API_COMPATIBILITY_VERSION と同値）。
const ZNCA_API_COMPATIBILITY_VERSION: &str = "w8zSLBsxR7rVoGJA";

/// SplatNet3 bullet_token エンドポイント。
const SPLATNET3_BULLET_TOKEN_URL: &str =
    "https://api.lp1.av5ja.srv.nintendo.net/api/bullet_tokens";
/// SplatNet3 (Splatoon3) の Web Service ID。
const SPLATNET3_WEB_SERVICE_ID: u64 = 4_834_290_508_791_808;

/// Coral アプリのバージョン（remote config の `coral.znca_version` に対応）。
/// 実運用では nxapi-remote-config.json から動的に読むのが望ましい。
const ZNCA_VERSION: &str = "3.3.0";
/// SplatNet3 WebView バージョン（remote config の `coral_gws_splatnet3.app_ver`）。
const SPLATNET3_WEB_VIEW_VER: &str = "10.0.0-dfefd0af";

/// znca-api hash_method: Coral の Account/Login 用。
const HASH_METHOD_CORAL: u8 = 1;
/// znca-api hash_method: Web Service Token 用。
const HASH_METHOD_WEB_SERVICE: u8 = 2;

// ---------------------------------------------------------------------------
// 認証トークン保存：chartoon と geartoon で共有するためのファイルベース実装。
// パス：<config_dir>/splatoon-gear/auth.json
//   - Windows: %APPDATA%\splatoon-gear\auth.json
//   - macOS:   ~/Library/Application Support/splatoon-gear/auth.json
//   - Linux:   ~/.config/splatoon-gear/auth.json
//
// 既存ユーザーの session_token は tauri_plugin_store(`auth.json` in app_data_dir)
// に保存されているため、起動時に共有ファイルが無く store にある場合は移行する。
// ---------------------------------------------------------------------------

const SHARED_DIR_NAME:    &str = "splatoon-gear";
const SHARED_FILE_NAME:   &str = "auth.json";
const PENDING_FILE_NAME:  &str = "login_pending.json";
/// 認証 pending ファイルの有効期限（10 分）。これより古いと使わず削除。
const PENDING_TTL_SECS:   i64  = 600;

fn shared_dir(app: &AppHandle) -> Result<std::path::PathBuf, String> {
    let base = app.path().config_dir().map_err(|e| format!("config_dir 取得失敗: {e}"))?;
    Ok(base.join(SHARED_DIR_NAME))
}

fn shared_auth_path(app: &AppHandle) -> Result<std::path::PathBuf, String> {
    Ok(shared_dir(app)?.join(SHARED_FILE_NAME))
}

fn shared_pending_path(app: &AppHandle) -> Result<std::path::PathBuf, String> {
    Ok(shared_dir(app)?.join(PENDING_FILE_NAME))
}

/// 共有ファイル → 旧 store の順に探す。後者から取得した場合は共有ファイルにも書き戻す。
fn load_session_token(app: &AppHandle) -> Option<String> {
    // 1) 共有ファイル
    if let Ok(path) = shared_auth_path(app) {
        if let Ok(content) = std::fs::read_to_string(&path) {
            if let Ok(v) = serde_json::from_str::<serde_json::Value>(&content) {
                if let Some(t) = v.get("session_token").and_then(|s| s.as_str()).filter(|s| !s.is_empty()) {
                    return Some(t.to_string());
                }
            }
        }
    }
    // 2) 旧 store からの後方互換読み込み → 共有ファイルへ移行
    let store = app.store(STORE_FILE).ok()?;
    let token = store.get(STORE_KEY_SESSION_TOKEN)
        .and_then(|v| v.as_str().map(|s| s.to_string()))
        .filter(|s| !s.is_empty())?;
    let _ = save_session_token(app, &token);  // 共有ファイルへ移行（失敗してもメモリ上の token は返す）
    Some(token)
}

fn save_session_token(app: &AppHandle, token: &str) -> Result<(), String> {
    let path = shared_auth_path(app)?;
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| format!("共有ディレクトリ作成失敗: {e}"))?;
    }
    let payload = serde_json::json!({
        "session_token": token,
        "updated_at":    chrono::Utc::now().to_rfc3339(),
        "source_app":    "chartoon",
    });
    std::fs::write(&path, serde_json::to_string_pretty(&payload).unwrap_or_default())
        .map_err(|e| format!("共有 auth.json 書き込み失敗: {e}"))
}

fn delete_session_token(app: &AppHandle) -> Result<(), String> {
    let path = shared_auth_path(app)?;
    if path.exists() {
        std::fs::remove_file(&path).map_err(|e| format!("共有 auth.json 削除失敗: {e}"))?;
    }
    // 旧 store も削除（後方互換クリーンアップ）
    if let Ok(store) = app.store(STORE_FILE) {
        store.delete(STORE_KEY_SESSION_TOKEN);
        let _ = store.save();
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// 認証 pending（PKCE state/verifier）の共有ファイル管理。
//
// chartoon と geartoon が同じ deep link scheme を OS 登録しているため、
// 認証開始したアプリと deep link を受け取るアプリが食い違うことがある。
// そのため pending（state + verifier）も共有ファイルに置き、
// どちらが受け取っても session_token 交換が完了できるようにする。
// ---------------------------------------------------------------------------

fn save_pending_shared(app: &AppHandle, p: &PendingAuth) -> Result<(), String> {
    let path = shared_pending_path(app)?;
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| format!("共有ディレクトリ作成失敗: {e}"))?;
    }
    let payload = serde_json::json!({
        "state":          p.state,
        "verifier":       p.verifier,
        "started_at":     chrono::Utc::now().to_rfc3339(),
        "started_by_app": "chartoon",
    });
    std::fs::write(&path, serde_json::to_string_pretty(&payload).unwrap_or_default())
        .map_err(|e| format!("共有 pending 書き込み失敗: {e}"))
}

/// 共有 pending を読む。TTL 切れなら削除して None を返す。
fn load_pending_shared(app: &AppHandle) -> Option<PendingAuth> {
    let path = shared_pending_path(app).ok()?;
    let content = std::fs::read_to_string(&path).ok()?;
    let v: serde_json::Value = serde_json::from_str(&content).ok()?;

    // TTL 確認（10 分以上経ったら捨てる）
    if let Some(ts) = v.get("started_at").and_then(|s| s.as_str()) {
        if let Ok(dt) = chrono::DateTime::parse_from_rfc3339(ts) {
            let age = chrono::Utc::now().signed_duration_since(dt.with_timezone(&chrono::Utc));
            if age.num_seconds() > PENDING_TTL_SECS {
                let _ = std::fs::remove_file(&path);
                return None;
            }
        }
    }

    let state    = v.get("state").and_then(|s| s.as_str())?.to_string();
    let verifier = v.get("verifier").and_then(|s| s.as_str())?.to_string();
    Some(PendingAuth { state, verifier })
}

fn delete_pending_shared(app: &AppHandle) {
    if let Ok(path) = shared_pending_path(app) {
        let _ = std::fs::remove_file(&path);
    }
}

/// store のファイル名と session_token のキー。
const STORE_FILE: &str = "auth.json";
const STORE_KEY_SESSION_TOKEN: &str = "session_token";

// ---------------------------------------------------------------------------
// アプリ状態（PKCE の code_verifier / state を保持）
// ---------------------------------------------------------------------------

/// `start_login` が生成し `handle_auth_redirect` が消費する PKCE パラメータ。
#[derive(Default)]
pub struct AuthState {
    inner: Mutex<Option<PendingAuth>>,
}

#[derive(Clone)]
struct PendingAuth {
    /// PKCE code_verifier（session_token_code_verifier として送信）。
    verifier: String,
    /// CSRF 対策の state（リダイレクトで照合）。
    state: String,
}

// ---------------------------------------------------------------------------
// PKCE / ユーティリティ
// ---------------------------------------------------------------------------

/// URL-safe Base64（パディングなし）でエンコードする。
fn b64url(bytes: &[u8]) -> String {
    base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(bytes)
}

/// 指定バイト数のランダム値を URL-safe Base64 で返す。
fn random_b64url(len: usize) -> String {
    let mut buf = vec![0u8; len];
    rand::thread_rng().fill_bytes(&mut buf);
    b64url(&buf)
}

/// PKCE: code_verifier から S256 challenge を導出する。
pub fn code_challenge_s256(verifier: &str) -> String {
    let mut hasher = Sha256::new();
    hasher.update(verifier.as_bytes());
    b64url(&hasher.finalize())
}

/// PKCE の code_verifier / state をランダム生成する。
/// 戻り値: `(verifier, state)`。
pub fn generate_pkce() -> (String, String) {
    (random_b64url(32), random_b64url(36))
}

/// 現在の Unix 時刻（秒）。
fn now_unix() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

/// reqwest クライアントを構築する（共通設定）。
fn http_client() -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        .build()
        .map_err(|e| format!("HTTP クライアント構築失敗: {e}"))
}

// ---------------------------------------------------------------------------
// レスポンス型
// ---------------------------------------------------------------------------

#[derive(Deserialize)]
struct SessionTokenResponse {
    session_token: String,
}

#[derive(Deserialize)]
struct NaTokenResponse {
    id_token: String,
    access_token: String,
}

#[derive(Deserialize)]
struct NaUserMe {
    id: String,
    birthday: String,
    country: String,
    language: String,
}

#[derive(Deserialize)]
struct ZncaFResponse {
    f: String,
    request_id: String,
    timestamp: serde_json::Value,
}

/// Coral Account/Login のレスポンス（必要部分のみ）。
#[derive(Deserialize)]
struct CoralLoginResponse {
    result: Option<CoralLoginResult>,
}

#[derive(Deserialize)]
struct CoralLoginResult {
    #[serde(rename = "webApiServerCredential")]
    web_api_server_credential: CoralCredential,
    user: CoralUser,
}

#[derive(Deserialize)]
struct CoralCredential {
    #[serde(rename = "accessToken")]
    access_token: String,
}

#[derive(Deserialize)]
struct CoralUser {
    id: u64,
}

/// Coral GetWebServiceToken のレスポンス（必要部分のみ）。
#[derive(Deserialize)]
struct WebServiceTokenResponse {
    result: Option<WebServiceTokenResult>,
}

#[derive(Deserialize)]
struct WebServiceTokenResult {
    #[serde(rename = "accessToken")]
    access_token: String,
}

#[derive(Deserialize)]
struct BulletTokenResponse {
    #[serde(rename = "bulletToken")]
    bullet_token: String,
}

/// `get_bullet_token` がフロントに返す結果。
#[derive(Serialize)]
pub struct BulletTokenResult {
    pub bullet_token: String,
    pub gtoken: String,
    pub country: String,
    pub language: String,
}

// ---------------------------------------------------------------------------
// 純粋ロジック（Tauri 非依存。テスト・CLI から呼べる）
// ---------------------------------------------------------------------------

/// PKCE の `verifier` と CSRF `state` から Nintendo ログイン URL を構築する。
pub fn build_login_url(verifier: &str, state: &str) -> String {
    let challenge = code_challenge_s256(verifier);
    format!(
        "{base}?state={state}&redirect_uri={redirect}&client_id={client}\
         &scope={scope}&response_type=session_token_code\
         &session_token_code_challenge={challenge}\
         &session_token_code_challenge_method=S256&theme=login_form",
        base = NA_AUTHORIZE_URL,
        state = urlencode(state),
        redirect = urlencode(REDIRECT_URI),
        client = CLIENT_ID,
        scope = urlencode(SCOPE),
        challenge = challenge,
    )
}

/// リダイレクト URL のフラグメントから `session_token_code` と `state` を抽出する。
/// 戻り値: `(code, state)`。`state` は URL に含まれなければ `None`。
pub fn parse_auth_fragment(url: &str) -> Result<(String, Option<String>), String> {
    let fragment = url
        .split_once('#')
        .map(|(_, f)| f.to_string())
        .ok_or_else(|| "リダイレクト URL にフラグメントがありません".to_string())?;

    let mut session_token_code: Option<String> = None;
    let mut returned_state: Option<String> = None;
    for pair in fragment.split('&') {
        if let Some((k, v)) = pair.split_once('=') {
            match k {
                "session_token_code" => session_token_code = Some(v.to_string()),
                "state" => returned_state = Some(v.to_string()),
                _ => {}
            }
        }
    }

    let code = session_token_code
        .ok_or_else(|| "session_token_code が見つかりません".to_string())?;
    Ok((code, returned_state))
}

/// `session_token_code` を `session_token` に交換する（PKCE 検証付き）。
pub async fn exchange_session_token_code(
    code: &str,
    verifier: &str,
    client: &reqwest::Client,
) -> Result<String, String> {
    let params = [
        ("client_id", CLIENT_ID),
        ("session_token_code", code),
        ("session_token_code_verifier", verifier),
    ];
    let resp = client
        .post(NA_SESSION_TOKEN_URL)
        .header("User-Agent", "NASDKAPI; Android")
        .header("Accept", "application/json")
        .form(&params)
        .send()
        .await
        .map_err(|e| format!("session_token リクエスト失敗: {e}"))?;

    if !resp.status().is_success() {
        let s = resp.status();
        let body = resp.text().await.unwrap_or_default();
        return Err(format!("session_token 取得失敗 ({s}): {body}"));
    }

    let parsed: SessionTokenResponse = resp
        .json()
        .await
        .map_err(|e| format!("session_token レスポンス解析失敗: {e}"))?;
    Ok(parsed.session_token)
}

/// `session_token` から id_token → f-token → Coral login → WebServiceToken
/// → bulletToken を順に取得する。
pub async fn fetch_bullet_token(
    session_token: &str,
    client: &reqwest::Client,
) -> Result<BulletTokenResult, String> {
    // --- ステップ 4: session_token → id_token / access_token ---
    let token_body = serde_json::json!({
        "client_id": CLIENT_ID,
        "session_token": session_token,
        "grant_type": "urn:ietf:params:oauth:grant-type:jwt-bearer-session-token",
    });
    let na_token: NaTokenResponse = client
        .post(NA_TOKEN_URL)
        .header("User-Agent", "Dalvik/2.1.0 (Linux; U; Android 8.0.0)")
        .header("Accept", "application/json")
        .json(&token_body)
        .send()
        .await
        .map_err(|e| format!("id_token リクエスト失敗: {e}"))?
        .json()
        .await
        .map_err(|e| format!("id_token レスポンス解析失敗: {e}"))?;

    // Nintendo Account ユーザー情報（birthday/country/language が Coral login で必要）。
    let user: NaUserMe = client
        .get(NA_USER_ME_URL)
        .header("User-Agent", "NASDKAPI; Android")
        .header("Accept", "application/json")
        .header("Authorization", format!("Bearer {}", na_token.access_token))
        .send()
        .await
        .map_err(|e| format!("users/me リクエスト失敗: {e}"))?
        .json()
        .await
        .map_err(|e| format!("users/me レスポンス解析失敗: {e}"))?;

    // --- ステップ 5: id_token → f-token (Coral login 用, hash_method=1) ---
    let f_coral = request_f(
        client,
        &na_token.id_token,
        HASH_METHOD_CORAL,
        Some(&user.id),
        None,
    )
    .await?;

    // --- ステップ 6a: Coral Account/Login（gtoken 取得の前段） ---
    let login_body = serde_json::json!({
        "parameter": {
            "naIdToken": na_token.id_token,
            "naBirthday": user.birthday,
            "naCountry": user.country,
            "language": user.language,
            "timestamp": f_coral.timestamp,
            "requestId": f_coral.request_id,
            "f": f_coral.f,
        }
    });
    let login: CoralLoginResponse = client
        .post(CORAL_LOGIN_URL)
        .header("X-Platform", "Android")
        .header("X-ProductVersion", ZNCA_VERSION)
        .header(
            "User-Agent",
            format!("com.nintendo.znca/{ZNCA_VERSION}(Android/12)"),
        )
        .header("Content-Type", "application/json; charset=utf-8")
        .header("Accept", "application/json")
        .json(&login_body)
        .send()
        .await
        .map_err(|e| format!("Coral login リクエスト失敗: {e}"))?
        .json()
        .await
        .map_err(|e| format!("Coral login レスポンス解析失敗: {e}"))?;

    let login_result = login
        .result
        .ok_or_else(|| "Coral login レスポンスに result がありません".to_string())?;
    let coral_access_token = login_result.web_api_server_credential.access_token;
    let coral_user_id = login_result.user.id;

    // --- ステップ 6b: id_token → f-token (WebServiceToken 用, hash_method=2) ---
    let f_web = request_f(
        client,
        &coral_access_token,
        HASH_METHOD_WEB_SERVICE,
        Some(&user.id),
        Some(coral_user_id),
    )
    .await?;

    // --- ステップ 6c: GetWebServiceToken → gtoken ---
    let gws_body = serde_json::json!({
        "parameter": {
            "id": SPLATNET3_WEB_SERVICE_ID,
            "registrationToken": coral_access_token,
            "f": f_web.f,
            "requestId": f_web.request_id,
            "timestamp": f_web.timestamp,
        }
    });
    let gws: WebServiceTokenResponse = client
        .post(CORAL_GET_WEB_SERVICE_TOKEN_URL)
        .header("X-Platform", "Android")
        .header("X-ProductVersion", ZNCA_VERSION)
        .header(
            "User-Agent",
            format!("com.nintendo.znca/{ZNCA_VERSION}(Android/12)"),
        )
        .header("Content-Type", "application/json; charset=utf-8")
        .header("Accept", "application/json")
        .header("Authorization", format!("Bearer {coral_access_token}"))
        .json(&gws_body)
        .send()
        .await
        .map_err(|e| format!("GetWebServiceToken リクエスト失敗: {e}"))?
        .json()
        .await
        .map_err(|e| format!("GetWebServiceToken レスポンス解析失敗: {e}"))?;

    let gtoken = gws
        .result
        .ok_or_else(|| "GetWebServiceToken に result がありません".to_string())?
        .access_token;

    // --- ステップ 7: gtoken → bulletToken ---
    let bullet: BulletTokenResponse = client
        .post(SPLATNET3_BULLET_TOKEN_URL)
        .header("Content-Type", "application/json")
        .header("Accept", "*/*")
        .header("X-Requested-With", "XMLHttpRequest")
        .header("X-Web-View-Ver", SPLATNET3_WEB_VIEW_VER)
        .header("X-NACOUNTRY", &user.country)
        .header("Accept-Language", &user.language)
        .header("X-GameWebToken", &gtoken)
        .header(
            "User-Agent",
            "Mozilla/5.0 (Linux; Android 8.0.0) AppleWebKit/537.36 \
             (KHTML, like Gecko) Chrome/94.0.4606.61 Mobile Safari/537.36",
        )
        .header("Referer", "https://api.lp1.av5ja.srv.nintendo.net/")
        .body("")
        .send()
        .await
        .map_err(|e| format!("bullet_token リクエスト失敗: {e}"))?
        .json()
        .await
        .map_err(|e| format!("bullet_token レスポンス解析失敗: {e}"))?;

    Ok(BulletTokenResult {
        bullet_token: bullet.bullet_token,
        gtoken,
        country: user.country,
        language: user.language,
    })
}

/// 最小限の URL エンコード（クエリ値用）。
fn urlencode(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for b in s.bytes() {
        match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                out.push(b as char)
            }
            _ => out.push_str(&format!("%{:02X}", b)),
        }
    }
    out
}

// ---------------------------------------------------------------------------
// Tauri コマンド（薄いラッパー）
// ---------------------------------------------------------------------------

/// ステップ 1: PKCE パラメータを生成し、Nintendo ログイン URL を構築して
/// ブラウザで開く。`code_verifier` / `state` はアプリ状態に保存する。
#[tauri::command]
pub fn start_login(app: AppHandle, state: State<'_, AuthState>) -> Result<String, String> {
    let (verifier, csrf_state) = generate_pkce();
    let url = build_login_url(&verifier, &csrf_state);

    // 後続の handle_auth_redirect で照合・消費するため保存。
    // chartoon・geartoon 両方が同じ deep link scheme を OS 登録しているため、
    // メモリ内 (AuthState) に加えて共有 pending ファイルにも書き、もう片方が
    // deep link を受け取った場合でも交換できるようにする。
    let pending = PendingAuth { verifier, state: csrf_state };
    {
        let mut guard = state.inner.lock().map_err(|e| e.to_string())?;
        *guard = Some(pending.clone());
    }
    if let Err(e) = save_pending_shared(&app, &pending) {
        log::warn!("共有 pending 保存に失敗（メモリのみで継続）: {e}");
    }

    // Chromium 系ブラウザを直接起動する（カスタムスキームのリダイレクトを確実に処理するため）。
    // Brave など一部ブラウザはカスタムスキームをブロックするため、
    // Chrome → Edge の順で探し、どちらもなければ tauri-plugin-opener にフォールバック。
    let chromium_paths: &[&str] = &[
        r"C:\Program Files\Google\Chrome\Application\chrome.exe",
        r"C:\Program Files (x86)\Google\Chrome\Application\chrome.exe",
        r"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe",
        r"C:\Program Files\Microsoft\Edge\Application\msedge.exe",
    ];
    if let Some(browser) = chromium_paths.iter().find(|p| std::path::Path::new(p).exists()) {
        std::process::Command::new(browser)
            .arg(&url)
            .spawn()
            .map_err(|e| format!("ブラウザ起動失敗: {e}"))?;
    } else {
        use tauri_plugin_opener::OpenerExt;
        app.opener()
            .open_url(&url, None::<&str>)
            .map_err(|e| format!("ブラウザ起動失敗: {e}"))?;
    }

    Ok(url)
}

/// ステップ 2-3: deep link URL から `session_token_code` を抽出し、
/// Nintendo API で `session_token` を取得して store に保存する。
/// 取得した `session_token` を返す（フロントエンドが nxapi_setup に渡すために使用）。
#[tauri::command]
pub async fn handle_auth_redirect(
    app: AppHandle,
    state: State<'_, AuthState>,
    url: String,
) -> Result<String, String> {
    let (code, returned_state) = parse_auth_fragment(&url)?;

    // PKCE パラメータを取り出す。
    // 1) このアプリで start_login が呼ばれていればメモリ内に pending がある
    // 2) もう片方のアプリで start_login → こちらが deep link を受け取ったケース
    //    では共有 pending ファイルから読み込む（chartoon と geartoon が同じ scheme を
    //    OS 登録しているため、deep link の受け先がズレることがある）
    let pending = {
        let mut guard = state.inner.lock().map_err(|e| e.to_string())?;
        guard.take()
    }
    .or_else(|| load_pending_shared(&app))
    .ok_or_else(|| {
        "進行中のログインがありません（start_login を先に呼んでください）".to_string()
    })?;

    if let Some(rs) = returned_state {
        if rs != pending.state {
            return Err("state が一致しません（CSRF の可能性）".to_string());
        }
    }

    let client = http_client()?;
    let session_token =
        exchange_session_token_code(&code, &pending.verifier, &client).await?;

    // 交換成功したので共有 pending を削除（成否どちらでもこの後の試行は不可なので消す）
    delete_pending_shared(&app);

    // session_token を共有ファイルに保存（chartoon と geartoon で共有）。
    save_session_token(&app, &session_token)?;

    // nxapi ストレージにも保存（bullet token 取得でサイドカーが使用）。
    crate::nxapi::nxapi_setup(&app, &session_token).await?;

    Ok(session_token)
}

/// ステップ 4-7: 保存済み `session_token` から
/// id_token → f-token → Coral login (gtoken 元) → WebServiceToken (gtoken)
/// → bulletToken を順に取得して返す。
#[tauri::command]
pub async fn get_bullet_token(app: AppHandle) -> Result<BulletTokenResult, String> {
    // 保存済み session_token を読む（共有ファイル経由）。
    let session_token = load_session_token(&app)
        .ok_or_else(|| "未ログインです（session_token がありません）".to_string())?;

    let client = http_client()?;
    fetch_bullet_token(&session_token, &client).await
}

/// nxapi-znca-api の f-token エンドポイントを呼び出す。
/// - `token`: hash_method=1 では NA の id_token、=2 では Coral の accessToken。
/// - `na_id`: Nintendo Account ID。
/// - `coral_user_id`: hash_method=2 のときに付与する Coral ユーザー ID。
async fn request_f(
    client: &reqwest::Client,
    token: &str,
    hash_method: u8,
    na_id: Option<&str>,
    coral_user_id: Option<u64>,
) -> Result<ZncaFResponse, String> {
    // hash_method は文字列として送る（nxapi-znca-api の仕様）
    let mut body = serde_json::json!({
        "token": token,
        "hash_method": hash_method.to_string(),
    });
    if let Some(id) = na_id {
        body["na_id"] = serde_json::Value::String(id.to_string());
    }
    if let Some(cid) = coral_user_id {
        body["coral_user_id"] = serde_json::Value::String(cid.to_string());
    }

    let resp = client
        .post(ZNCA_API_URL)
        .header("Content-Type", "application/json")
        .header("Accept", "application/json")
        .header("User-Agent", "chartoon/0.1.0")
        .header("X-znca-Client-Version", ZNCA_API_COMPATIBILITY_VERSION)
        .json(&body)
        .send()
        .await
        .map_err(|e| format!("znca-api f リクエスト失敗: {e}"))?;

    if !resp.status().is_success() {
        let s = resp.status();
        let b = resp.text().await.unwrap_or_default();
        return Err(format!("znca-api f 失敗 ({s}): {b}"));
    }

    resp.json::<ZncaFResponse>()
        .await
        .map_err(|e| format!("znca-api f レスポンス解析失敗: {e}"))
}

/// session_token が保存済みか（= ログイン済みか）を返す。内部呼び出し用。
pub fn is_logged_in(app: &AppHandle) -> bool {
    load_session_token(app).is_some()
}

/// session_token が保存済みか（= ログイン済みか）を返す。
#[tauri::command]
pub fn check_auth_status(app: AppHandle) -> Result<bool, String> {
    Ok(load_session_token(&app).is_some())
}

/// 保存済みトークンを削除してログアウトする。
#[tauri::command]
pub fn logout(app: AppHandle) -> Result<(), String> {
    delete_session_token(&app)
}

/// `now_unix` は将来のトークン有効期限管理用。現状は未使用警告抑制のため公開。
#[allow(dead_code)]
pub fn _touch_unused() -> u64 {
    now_unix()
}

// ---------------------------------------------------------------------------
// ユニットテスト
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    /// 簡易クエリパーサ: `?` 以降を `key -> value` のリストにする。
    fn query_pairs(url: &str) -> Vec<(String, String)> {
        let q = url.split_once('?').map(|(_, q)| q).unwrap_or("");
        q.split('&')
            .filter_map(|p| p.split_once('=').map(|(k, v)| (k.to_string(), v.to_string())))
            .collect()
    }

    fn query_get<'a>(pairs: &'a [(String, String)], key: &str) -> Option<&'a str> {
        pairs
            .iter()
            .find(|(k, _)| k == key)
            .map(|(_, v)| v.as_str())
    }

    #[test]
    fn build_login_url_contains_required_params() {
        let url = build_login_url("test-verifier", "test-state");
        let pairs = query_pairs(&url);

        assert_eq!(query_get(&pairs, "state"), Some("test-state"));
        // redirect_uri / scope は urlencode されているのでデコード前提で存在のみ確認。
        assert!(query_get(&pairs, "redirect_uri").is_some(), "redirect_uri 欠落");
        assert_eq!(query_get(&pairs, "client_id"), Some(CLIENT_ID));
        assert!(query_get(&pairs, "scope").is_some(), "scope 欠落");
        assert_eq!(
            query_get(&pairs, "session_token_code_challenge"),
            Some(code_challenge_s256("test-verifier").as_str())
        );
        assert_eq!(
            query_get(&pairs, "session_token_code_challenge_method"),
            Some("S256")
        );
    }

    #[test]
    fn parse_auth_fragment_extracts_code_and_state() {
        let url = "npf71b963c1b7b6d119://auth#session_token_code=ABC123&state=XYZ789&session_state=foo";
        let (code, state) = parse_auth_fragment(url).expect("パース成功すべき");
        assert_eq!(code, "ABC123");
        assert_eq!(state.as_deref(), Some("XYZ789"));
    }

    #[test]
    fn parse_auth_fragment_errors_without_fragment() {
        let url = "npf71b963c1b7b6d119://auth?session_token_code=ABC123";
        assert!(parse_auth_fragment(url).is_err());
    }

    #[test]
    fn code_challenge_s256_matches_rfc7636_vector() {
        // RFC 7636 Appendix B の既知テストベクタ。
        let verifier = "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk";
        let expected = "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM";
        assert_eq!(code_challenge_s256(verifier), expected);
    }
}
