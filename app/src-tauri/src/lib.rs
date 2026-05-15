use tauri::{AppHandle, Manager};

/// PathBuf を Windows の \\?\ プレフィックスなし・スラッシュ区切りの文字列に変換
fn path_to_slash(p: &std::path::Path) -> String {
  let s = p.to_string_lossy();
  // Windows extended path prefix を除去
  let s = s.strip_prefix(r"\\?\").unwrap_or(&s);
  s.replace('\\', "/")
}

/// tools/data/ ディレクトリの絶対パスを解決する。
/// 1. 本番: AppData/com.hiroshiyokoya.geartoon/data/
/// 2. 開発: CWD相対で ../../tools/data/ (src-tauri/ から実行されるため)
fn resolve_data_dir(app: &AppHandle) -> Option<std::path::PathBuf> {
  // 本番: app data dir 配下
  if let Ok(data_dir) = app.path().app_data_dir() {
    let p = data_dir.join("data");
    if p.join("gear_db.json").exists() {
      return Some(p);
    }
  }
  // 開発: CWD相対
  for rel in ["../../tools/data", "../tools/data"] {
    let p = std::path::PathBuf::from(rel);
    if p.join("gear_db.json").exists() {
      if let Ok(canonical) = p.canonicalize() {
        return Some(canonical);
      }
    }
  }
  None
}

/// gear_db.json の内容を文字列で返す
#[tauri::command]
fn read_gear_db(app: AppHandle) -> Result<String, String> {
  let dir = resolve_data_dir(&app)
    .ok_or_else(|| "ギアデータが見つかりません（tools/data/gear_db.json）".to_string())?;
  std::fs::read_to_string(dir.join("gear_db.json"))
    .map_err(|e| e.to_string())
}

/// tools/data/ の絶対パスを返す（フロントエンドが画像パスを解決するために使用）
/// パスはスラッシュ区切り・\\?\ プレフィックスなしで返す
#[tauri::command]
fn get_data_dir(app: AppHandle) -> Result<String, String> {
  resolve_data_dir(&app)
    .map(|p| path_to_slash(&p))
    .ok_or_else(|| "ギアデータディレクトリが見つかりません".to_string())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
  tauri::Builder::default()
    .invoke_handler(tauri::generate_handler![read_gear_db, get_data_dir])
    .setup(|app| {
      if cfg!(debug_assertions) {
        app.handle().plugin(
          tauri_plugin_log::Builder::default()
            .level(log::LevelFilter::Info)
            .build(),
        )?;
      }
      Ok(())
    })
    .run(tauri::generate_context!())
    .expect("error while running tauri application");
}
