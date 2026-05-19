use serde::Deserialize;
use tauri::{AppHandle, Manager};
use tauri_plugin_shell::ShellExt;

#[derive(Deserialize)]
pub struct BulletTokenResult {
    pub bullet_token: String,
    pub country: String,
    pub language: String,
}

/// session_token を nxapi ストレージに保存する。
/// handle_auth_redirect 後に呼び出す。
pub async fn nxapi_setup(app: &AppHandle, session_token: &str) -> Result<(), String> {
    let data_dir = nxapi_data_dir(app)?;

    let output = app
        .shell()
        .sidecar("nxapi-sidecar")
        .map_err(|e| format!("サイドカー起動失敗: {e}"))?
        .args(["setup", session_token, &data_dir])
        .output()
        .await
        .map_err(|e| format!("サイドカー実行失敗: {e}"))?;

    parse_ok_response(&output.stdout, "nxapi setup")
}

/// nxapi ストレージから bullet token を取得する。
pub async fn nxapi_get_bullet_token(app: &AppHandle) -> Result<BulletTokenResult, String> {
    let data_dir = nxapi_data_dir(app)?;

    let output = app
        .shell()
        .sidecar("nxapi-sidecar")
        .map_err(|e| format!("サイドカー起動失敗: {e}"))?
        .args(["get_bullet_token", &data_dir])
        .output()
        .await
        .map_err(|e| format!("サイドカー実行失敗: {e}"))?;

    let stdout = String::from_utf8_lossy(&output.stdout);
    let result: serde_json::Value = serde_json::from_str(stdout.trim())
        .map_err(|e| format!("サイドカー出力解析失敗: {e}\nstdout: {stdout}"))?;

    if result["ok"].as_bool() != Some(true) {
        let err = result["error"].as_str().unwrap_or("不明なエラー");
        return Err(format!("bullet token 取得失敗: {err}"));
    }

    Ok(BulletTokenResult {
        bullet_token: result["bullet_token"]
            .as_str()
            .ok_or_else(|| "bullet_token フィールドが見つかりません".to_string())?
            .to_string(),
        country: result["country"]
            .as_str()
            .ok_or_else(|| "country フィールドが見つかりません".to_string())?
            .to_string(),
        language: result["language"]
            .as_str()
            .ok_or_else(|| "language フィールドが見つかりません".to_string())?
            .to_string(),
    })
}

fn nxapi_data_dir(app: &AppHandle) -> Result<String, String> {
    app.path()
        .app_data_dir()
        .map(|p| p.join("nxapi-data").to_string_lossy().to_string())
        .map_err(|e| format!("データディレクトリ取得失敗: {e}"))
}

fn parse_ok_response(stdout: &[u8], cmd: &str) -> Result<(), String> {
    let text = String::from_utf8_lossy(stdout);
    let result: serde_json::Value = serde_json::from_str(text.trim())
        .map_err(|e| format!("{cmd} 出力解析失敗: {e}\nstdout: {text}"))?;

    if result["ok"].as_bool() != Some(true) {
        let err = result["error"].as_str().unwrap_or("不明なエラー");
        return Err(format!("{cmd} 失敗: {err}"));
    }
    Ok(())
}
