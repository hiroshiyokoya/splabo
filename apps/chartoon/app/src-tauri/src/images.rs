use base64::Engine;
use sha2::{Digest, Sha256};
use tauri::{AppHandle, Manager};

fn image_path(app: &AppHandle, kind: &str, name: &str) -> Result<std::path::PathBuf, String> {
    let mut hasher = Sha256::new();
    hasher.update(name.as_bytes());
    let hash = format!("{:x}", hasher.finalize());
    Ok(app
        .path()
        .app_data_dir()
        .map_err(|e| e.to_string())?
        .join("images")
        .join(kind)
        .join(format!("{hash}.gti")))
}

/// 画像を gti 形式でキャッシュする。既存ファイルがあればスキップ。
pub async fn download_and_cache(
    app: &AppHandle,
    client: &reqwest::Client,
    kind: &str,
    name: &str,
    url: &str,
) -> Result<(), String> {
    let path = image_path(app, kind, name)?;
    if path.exists() {
        return Ok(());
    }
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }

    let bytes = client
        .get(url)
        .send()
        .await
        .map_err(|e| format!("画像ダウンロード失敗 ({kind}/{name}): {e}"))?
        .bytes()
        .await
        .map_err(|e| format!("画像読み取り失敗 ({kind}/{name}): {e}"))?;

    let scrambled = crate::crypto::scramble_image(&bytes);
    std::fs::write(&path, scrambled).map_err(|e| e.to_string())?;
    Ok(())
}

/// キャッシュ済み gti 画像を読み込み、base64 data URL として返す。
#[tauri::command]
pub fn read_image(app: AppHandle, kind: String, name: String) -> Option<String> {
    let path = image_path(&app, &kind, &name).ok()?;
    let scrambled = std::fs::read(&path).ok()?;
    let png = crate::crypto::scramble_image(&scrambled);
    let b64 = base64::engine::general_purpose::STANDARD.encode(&png);
    Some(format!("data:image/png;base64,{b64}"))
}
