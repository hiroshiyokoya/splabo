//! パネルの PNG / HTML 保存（#500 / #505）。
//!
//! FE が作ったバイト列を base64 で受け取り、「名前を付けて保存」ダイアログで書き出す。
//! 合成・HTML 生成は FE 側の責務で、ここはダイアログとファイル書き込みだけを持つ。

use base64::Engine;
use tauri::AppHandle;
use tauri_plugin_dialog::DialogExt;

/// パネル書き出し形式。未指定・未知値は PNG 扱い（既存呼び出し互換）。
fn normalize_format(format: Option<&str>) -> &'static str {
    match format.map(|s| s.trim().to_ascii_lowercase()).as_deref() {
        Some("html") => "html",
        _ => "png",
    }
}

/// PNG / HTML バイト列を保存ダイアログ経由で書き出す。
///
/// 戻り値は保存先パス。ユーザーがキャンセルしたら `None`（FE はエラー表示しない）。
#[tauri::command]
pub async fn save_panel_image(
    app:         AppHandle,
    filename:    String,
    data_base64: String,
    format:      Option<String>,
) -> Result<Option<String>, String> {
    let fmt = normalize_format(format.as_deref());
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(data_base64.as_bytes())
        .map_err(|e| format!("保存データを読み取れませんでした: {e}"))?;

    // ダイアログはコールバック式なので、選択結果を oneshot で待つ。
    // blocking_save_file は async ランタイムのスレッドを塞ぐため使わない。
    let (tx, rx) = tokio::sync::oneshot::channel();
    let mut dialog = app.dialog().file().set_file_name(&filename);
    dialog = match fmt {
        "html" => dialog.add_filter("HTML", &["html", "htm"]),
        _ => dialog.add_filter("PNG 画像", &["png"]),
    };
    dialog.save_file(move |path| {
        let _ = tx.send(path);
    });

    let Some(path) = rx.await.map_err(|e| e.to_string())? else {
        return Ok(None);
    };
    let path = path
        .into_path()
        .map_err(|e| format!("保存先を解決できませんでした: {e}"))?;
    std::fs::write(&path, &bytes).map_err(|e| format!("保存に失敗しました: {e}"))?;
    log::info!("[image_export] パネルを保存 ({fmt}): {}", path.display());
    Ok(Some(path.to_string_lossy().to_string()))
}
