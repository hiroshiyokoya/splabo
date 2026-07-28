//! パネルの PNG / HTML 保存（#500 / #505）。
//!
//! FE が作ったバイト列を base64 で受け取り、「名前を付けて保存」ダイアログで書き出す。
//! 合成・HTML 生成は FE 側の責務で、ここはダイアログとファイル書き込みだけを持つ。

use base64::Engine;
use std::path::{Path, PathBuf};
use tauri::{AppHandle, Manager};
use tauri_plugin_dialog::DialogExt;

/// 直前に保存したディレクトリ（#557）。
///
/// ここを覚えておくことで、次の保存で「同名ファイルがあるか」を調べて連番の既定名を出せる。
/// **アプリ起動後 1 回目の保存では空**なので連番にならない。保存先が分からないため。
/// こちらから `set_directory()` でピクチャ等を指定すると OS ダイアログの「最後に使った
/// フォルダ」の記憶を上書きしてしまい、かえって不便になるので、1 回目は指定しない。
#[derive(Default)]
pub struct LastExportDir(pub std::sync::Mutex<Option<PathBuf>>);

/// パネル書き出し形式。未指定・未知値は PNG 扱い（既存呼び出し互換）。
fn normalize_format(format: Option<&str>) -> &'static str {
    match format.map(|s| s.trim().to_ascii_lowercase()).as_deref() {
        Some("html") => "html",
        _ => "png",
    }
}

/// 同名ファイルを避けた既定ファイル名を作る（#557）。
///
/// `foo.png` が既にあれば `foo-2.png` → `foo-3.png` … と空き番号を探す。
/// 拡張子が無い名前でも壊れないよう、最後の `.` で分割する。
/// 番号が尽きるほど溜まっている異常時は元の名前を返す（ダイアログの上書き確認に任せる）。
fn unique_file_name(dir: &Path, filename: &str) -> String {
    if !dir.join(filename).exists() {
        return filename.to_string();
    }
    let (stem, ext) = match filename.rsplit_once('.') {
        Some((s, e)) if !s.is_empty() => (s, format!(".{e}")),
        _ => (filename, String::new()),
    };
    for n in 2..=999 {
        let candidate = format!("{stem}-{n}{ext}");
        if !dir.join(&candidate).exists() {
            return candidate;
        }
    }
    filename.to_string()
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

    // 直前の保存先が分かっていれば、そこを既定にして空いている連番を提案する（#557）。
    let last_dir = app
        .state::<LastExportDir>()
        .0
        .lock()
        .ok()
        .and_then(|d| d.clone())
        .filter(|d| d.is_dir());
    let suggested = match &last_dir {
        Some(dir) => unique_file_name(dir, &filename),
        None => filename.clone(),
    };

    // ダイアログはコールバック式なので、選択結果を oneshot で待つ。
    // blocking_save_file は async ランタイムのスレッドを塞ぐため使わない。
    let (tx, rx) = tokio::sync::oneshot::channel();
    let mut dialog = app.dialog().file().set_file_name(&suggested);
    if let Some(dir) = &last_dir {
        dialog = dialog.set_directory(dir);
    }
    dialog = match fmt {
        "html" => dialog.add_filter("HTML", &["html", "htm"]),
        _ => dialog.add_filter("PNG 画像", &["png"]),
    };
    dialog.save_file(move |path| {
        let _ = tx.send(path);
    });

    // キャンセル時は覚えているディレクトリを触らない（次回もそのまま使う）。
    let Some(path) = rx.await.map_err(|e| e.to_string())? else {
        return Ok(None);
    };
    let path = path
        .into_path()
        .map_err(|e| format!("保存先を解決できませんでした: {e}"))?;
    std::fs::write(&path, &bytes).map_err(|e| format!("保存に失敗しました: {e}"))?;
    // 実際に選ばれた場所を次回の既定にする。
    if let Some(parent) = path.parent() {
        if let Ok(mut slot) = app.state::<LastExportDir>().0.lock() {
            *slot = Some(parent.to_path_buf());
        }
    }
    log::info!("[image_export] パネルを保存 ({fmt}): {}", path.display());
    Ok(Some(path.to_string_lossy().to_string()))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// テスト用の空ディレクトリ。プロセス ID とテスト名で衝突を避ける。
    fn temp_dir(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("splabo-export-{}-{name}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn touch(dir: &Path, name: &str) {
        std::fs::write(dir.join(name), b"x").unwrap();
    }

    #[test]
    fn 空きなら元の名前をそのまま使う() {
        let dir = temp_dir("free");
        assert_eq!(unique_file_name(&dir, "splabo-a-2026-07-28.png"), "splabo-a-2026-07-28.png");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn 同名があれば連番を付ける() {
        let dir = temp_dir("dup");
        touch(&dir, "panel.png");
        assert_eq!(unique_file_name(&dir, "panel.png"), "panel-2.png");
        touch(&dir, "panel-2.png");
        assert_eq!(unique_file_name(&dir, "panel.png"), "panel-3.png");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn 拡張子が無い名前でも壊れない() {
        let dir = temp_dir("noext");
        touch(&dir, "panel");
        assert_eq!(unique_file_name(&dir, "panel"), "panel-2");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn 名前が点で始まっても拡張子扱いしない() {
        let dir = temp_dir("dot");
        touch(&dir, ".hidden");
        assert_eq!(unique_file_name(&dir, ".hidden"), ".hidden-2");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn html_でも連番が付く() {
        let dir = temp_dir("html");
        touch(&dir, "panel.html");
        assert_eq!(unique_file_name(&dir, "panel.html"), "panel-2.html");
        let _ = std::fs::remove_dir_all(&dir);
    }
}
