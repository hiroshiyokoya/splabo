//! geartoon 由来のギア表示系コマンドモジュール。
//!
//! splabo v2.0 統合（Phase A1）で geartoon の `lib.rs` からギア表示系 4 コマンドを
//! chartoon crate へ移植したもの。暗号化・復号は `crate::gear_crypto` に委譲する。
//!
//! 移植したコマンド:
//! - `read_gear_db`     : gear_db.bin を復号（無ければ gear_db.json）して JSON 文字列で返す
//! - `get_data_dir`     : data ディレクトリの絶対パス（スラッシュ区切り）を返す
//! - `read_all_gti`     : images/ 配下の全 .gti を XOR 解除して base64 data URL 化して返す
//! - `delete_gear_data` : app_data/data/ を丸ごと削除する
//!
//! スコープ外（Phase A2 以降）: 取得系（fetch_gear 等）・auth・nxapi・サイドカーは移植しない。

use tauri::{AppHandle, Manager};

use crate::gear_crypto;

/// PathBuf を Windows の \\?\ プレフィックスなし・スラッシュ区切りの文字列に変換
fn path_to_slash(p: &std::path::Path) -> String {
    let s = p.to_string_lossy();
    // Windows extended path prefix を除去
    let s = s.strip_prefix(r"\\?\").unwrap_or(&s);
    s.replace('\\', "/")
}

/// データディレクトリのパスを解決する。
/// gear_db.bin（暗号化済み）または gear_db.json（開発用平文）が存在するディレクトリを返す。
fn resolve_data_dir(app: &AppHandle) -> Option<std::path::PathBuf> {
    if let Ok(data_dir) = app.path().app_data_dir() {
        let p = data_dir.join("data");
        if p.join("gear_db.bin").exists() || p.join("gear_db.json").exists() {
            return Some(p);
        }
    }
    for rel in ["../../tools/data", "../tools/data"] {
        let p = std::path::PathBuf::from(rel);
        if p.join("gear_db.bin").exists() || p.join("gear_db.json").exists() {
            if let Ok(canonical) = p.canonicalize() {
                return Some(canonical);
            }
        }
    }
    None
}

/// gear_db を読み込んで JSON 文字列で返す。
/// gear_db.bin（暗号化済み）があれば復号し、なければ gear_db.json をそのまま返す（開発用）。
#[tauri::command]
pub fn read_gear_db(app: AppHandle) -> Result<String, String> {
    let dir = resolve_data_dir(&app)
        .ok_or_else(|| "ギアデータが見つかりません".to_string())?;

    let bin_path = dir.join("gear_db.bin");
    if bin_path.exists() {
        let encrypted = std::fs::read(&bin_path).map_err(|e| e.to_string())?;
        let plain = gear_crypto::decrypt_db(&encrypted)?;
        String::from_utf8(plain).map_err(|e| e.to_string())
    } else {
        std::fs::read_to_string(dir.join("gear_db.json")).map_err(|e| e.to_string())
    }
}

/// data/ の絶対パスを返す（フロントエンドが画像パスを解決するために使用）
/// パスはスラッシュ区切り・\\?\ プレフィックスなしで返す
#[tauri::command]
pub fn get_data_dir(app: AppHandle) -> Result<String, String> {
    resolve_data_dir(&app)
        .map(|p| path_to_slash(&p))
        .ok_or_else(|| "ギアデータディレクトリが見つかりません".to_string())
}

/// data ディレクトリ配下の images/ を再帰スキャンして全 .gti ファイルを収集する。
fn collect_gti_paths(dir: &std::path::Path, out: &mut Vec<String>) {
    let Ok(entries) = std::fs::read_dir(dir) else { return };
    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_dir() {
            collect_gti_paths(&path, out);
        } else if path.extension().and_then(|s| s.to_str()) == Some("gti") {
            out.push(path_to_slash(&path));
        }
    }
}

/// data/images/ 配下の全 .gti ファイルを一括スキャンして読み込み、
/// XOR 解除した PNG を base64 data URL に変換して返す。
/// DB に含まれない画像（アキ枠など）も含めて全ファイルをカバーする。
/// 戻値: { "絶対パス（スラッシュ区切り）" → "data:image/png;base64,..." }
#[tauri::command]
pub fn read_all_gti(app: AppHandle) -> Result<std::collections::HashMap<String, String>, String> {
    use base64::{Engine, engine::general_purpose::STANDARD};

    let data_dir = resolve_data_dir(&app)
        .ok_or_else(|| "データディレクトリが見つかりません".to_string())?;
    let images_dir = data_dir.join("images");

    let mut paths = Vec::new();
    if images_dir.is_dir() {
        collect_gti_paths(&images_dir, &mut paths);
    }

    let mut map = std::collections::HashMap::new();
    for path in paths {
        match std::fs::read(&path) {
            Ok(scrambled) => {
                let png = gear_crypto::scramble_image(&scrambled);
                map.insert(path, format!("data:image/png;base64,{}", STANDARD.encode(&png)));
            }
            Err(e) => log::warn!("read_all_gti: {} をスキップ: {}", path, e),
        }
    }
    Ok(map)
}

/// AppData/data/ 以下（gear_db.bin・images/）を削除する。
/// 削除後はアプリ再起動またはリロードが必要。
#[tauri::command]
pub fn delete_gear_data(app: AppHandle) -> Result<(), String> {
    if let Ok(data_dir) = app.path().app_data_dir() {
        let p = data_dir.join("data");
        if p.exists() {
            std::fs::remove_dir_all(&p).map_err(|e| e.to_string())?;
        }
    }
    Ok(())
}
