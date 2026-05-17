//! nxapi サイドカーとの通信を担当するモジュール。
//!
//! サイドカー (`nxapi-sidecar`) は `tools/nxapi-wrapper/` にある Node.js スクリプトを
//! pkg でコンパイルした単体実行ファイルで、`app/src-tauri/binaries/` に配置される。
//!
//! ## IPC プロトコル
//! サイドカーを CLI で呼び出し、stdout の 1行 JSON を読む。
//! ```
//! nxapi-sidecar setup <session_token> <data_dir>
//! → {"ok": true, "nsid": "822e566d031654b0"}
//!
//! nxapi-sidecar fetch_gear <data_dir> <out_dir>
//! → {"ok": true, "db_path": "/abs/path/to/gear_db.json"}
//!
//! nxapi-sidecar check_login <data_dir>
//! → {"ok": true, "logged_in": true, "nsid": "822e566d031654b0"}
//! ```

use serde::Deserialize;
use tauri::{AppHandle, Manager};
use tauri_plugin_shell::ShellExt;
use crate::crypto;

// ── サイドカー応答の型 ──────────────────────────────────────

#[derive(Deserialize)]
struct SidecarResponse {
    ok: bool,
    #[serde(default)]
    error: Option<String>,
    // setup
    #[serde(default)]
    nsid: Option<String>,
    // fetch_gear
    #[serde(default)]
    db_path: Option<String>,
    // check_login
    #[serde(default)]
    logged_in: Option<bool>,
}

// ── 内部ヘルパー ──────────────────────────────────────────

/// data ディレクトリのパスを文字列で返す（nxapi ストレージのルート）。
/// 本番は AppData、開発時は tools/data。
fn resolve_nxapi_data_dir(app: &AppHandle) -> Result<String, String> {
    // 本番: AppData/com.geartoon.app/
    if let Ok(data_dir) = app.path().app_data_dir() {
        let p = data_dir.join("nxapi");
        if !p.exists() {
            std::fs::create_dir_all(&p).map_err(|e| e.to_string())?;
        }
        return Ok(path_to_slash(&p));
    }
    Err("アプリデータディレクトリが解決できません".to_string())
}

/// out_dir: gear_db.json と images/ の出力先（tools/data/ 相当）。
fn resolve_gear_out_dir(app: &AppHandle) -> Result<String, String> {
    // 本番: AppData/com.geartoon.app/data/
    if let Ok(data_dir) = app.path().app_data_dir() {
        let p = data_dir.join("data");
        if !p.exists() {
            std::fs::create_dir_all(&p).map_err(|e| e.to_string())?;
        }
        return Ok(path_to_slash(&p));
    }
    Err("出力ディレクトリが解決できません".to_string())
}

fn path_to_slash(p: &std::path::Path) -> String {
    let s = p.to_string_lossy();
    let s = s.strip_prefix(r"\\?\").unwrap_or(&s);
    s.replace('\\', "/")
}

/// サイドカーを引数付きで起動し、stdout の JSON をパースして返す。
async fn call_sidecar(app: &AppHandle, args: Vec<String>) -> Result<SidecarResponse, String> {
    let output = app
        .shell()
        .sidecar("nxapi-sidecar")
        .map_err(|e| format!("サイドカーの起動失敗: {e}"))?
        .args(&args)
        .output()
        .await
        .map_err(|e| format!("サイドカー実行エラー: {e}"))?;

    // stderr は進捗ログとして無視（デバッグ時は log::debug! にしてもよい）
    let stderr = String::from_utf8_lossy(&output.stderr);
    if !stderr.is_empty() {
        log::debug!("[nxapi sidecar stderr] {}", stderr.trim());
    }

    let stdout = String::from_utf8(output.stdout)
        .map_err(|_| "サイドカーの出力がUTF-8ではありません".to_string())?;

    let resp: SidecarResponse = serde_json::from_str(stdout.trim())
        .map_err(|e| format!("JSONパース失敗 ({e}): {stdout}"))?;

    if !resp.ok {
        return Err(resp
            .error
            .unwrap_or_else(|| "サイドカーが失敗しました".to_string()));
    }

    Ok(resp)
}

// ── Tauri コマンド ────────────────────────────────────────

/// Nintendo の session_token を受け取り、nxapi ストレージに保存する。
/// ログインフロー完了後にフロントエンドから呼ぶ。
#[tauri::command]
pub async fn nxapi_setup(session_token: String, app: AppHandle) -> Result<String, String> {
    let data_dir = resolve_nxapi_data_dir(&app)?;
    let resp = call_sidecar(
        &app,
        vec!["setup".to_string(), session_token, data_dir],
    )
    .await?;
    Ok(resp.nsid.unwrap_or_default())
}

/// SplatNet3 からギアデータを取得し、画像DL + gear_db.json を生成する。
/// 完了後に暗号化ポスト処理を行い、gear_db.bin のパスを返す。
#[tauri::command]
pub async fn nxapi_fetch_gear(app: AppHandle) -> Result<String, String> {
    let data_dir = resolve_nxapi_data_dir(&app)?;
    let out_dir = resolve_gear_out_dir(&app)?;
    let resp = call_sidecar(
        &app,
        vec!["fetch_gear".to_string(), data_dir, out_dir],
    )
    .await?;
    let db_path = resp.db_path.ok_or_else(|| "db_path が返されませんでした".to_string())?;

    // サイドカーが生成した gear_db.json + images/*.png を暗号化・スクランブルする
    encrypt_gear_data(&db_path)?;

    // 呼び出し元は bin のパスを受け取る（フロントは read_gear_db コマンドで読むため参考値）
    let bin_path = std::path::Path::new(&db_path)
        .with_file_name("gear_db.bin")
        .to_string_lossy()
        .to_string();
    Ok(bin_path)
}

/// gear_db.json を暗号化して gear_db.bin へ変換し、
/// images/*.png を XOR スクランブルして .gti にリネームする。
fn encrypt_gear_data(db_json_path: &str) -> Result<(), String> {
    let db_path = std::path::Path::new(db_json_path);
    let out_dir = db_path.parent().ok_or("db_path の親ディレクトリが不明")?;

    // gear_db.json を読み、画像パスを .gti に書き換えてから暗号化
    let json_str = std::fs::read_to_string(db_path).map_err(|e| e.to_string())?;
    let patched = json_str.replace(".png\"", ".gti\"");
    let encrypted = crypto::encrypt_db(patched.as_bytes())?;
    let bin_path = out_dir.join("gear_db.bin");
    std::fs::write(&bin_path, encrypted).map_err(|e| e.to_string())?;
    std::fs::remove_file(db_path).map_err(|e| e.to_string())?;

    // images/ 配下の .png を再帰的に .gti へスクランブル変換
    let images_dir = out_dir.join("images");
    if images_dir.is_dir() {
        scramble_images_recursive(&images_dir)?;
    }

    Ok(())
}

/// ディレクトリを再帰的に走査し、すべての .png を XOR スクランブルして .gti に変換する。
fn scramble_images_recursive(dir: &std::path::Path) -> Result<(), String> {
    for entry in std::fs::read_dir(dir).map_err(|e| e.to_string())? {
        let entry = entry.map_err(|e| e.to_string())?;
        let path = entry.path();
        if path.is_dir() {
            scramble_images_recursive(&path)?;
        } else if path.extension().and_then(|s| s.to_str()) == Some("png") {
            let data = std::fs::read(&path).map_err(|e| e.to_string())?;
            let scrambled = crypto::scramble_image(&data);
            let gti_path = path.with_extension("gti");
            std::fs::write(&gti_path, scrambled).map_err(|e| e.to_string())?;
            std::fs::remove_file(&path).map_err(|e| e.to_string())?;
        }
    }
    Ok(())
}

/// nxapi ストレージにログイン情報があるか確認する。
#[tauri::command]
pub async fn nxapi_check_login(app: AppHandle) -> Result<bool, String> {
    let data_dir = resolve_nxapi_data_dir(&app)?;
    let resp = call_sidecar(&app, vec!["check_login".to_string(), data_dir]).await?;
    Ok(resp.logged_in.unwrap_or(false))
}
