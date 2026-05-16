use tauri::{AppHandle, Emitter, Manager};

pub mod auth;
pub mod nxapi;

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
    // プラグイン
    // single-instance は deep-link より先に登録する必要がある。
    // 2つ目のインスタンスが起動した時（= deep-link コールバック）、
    // 引数に deep-link URL が含まれていればフロントへ転送する。
    .plugin(tauri_plugin_single_instance::init(|app, args, _cwd| {
        for arg in &args {
            if arg.starts_with("npf71b963c1b7b6d119://") {
                let _ = app.emit("deep-link-received", arg.clone());
            }
        }
    }))
    .plugin(tauri_plugin_shell::init())
    .plugin(tauri_plugin_opener::init())
    .plugin(tauri_plugin_store::Builder::default().build())
    .plugin(tauri_plugin_deep_link::init())
    // PKCE パラメータ保持用のアプリ状態
    .manage(auth::AuthState::default())
    .invoke_handler(tauri::generate_handler![
      read_gear_db,
      get_data_dir,
      // 認証コマンド（auth.rs）
      auth::start_login,
      auth::handle_auth_redirect,
      auth::get_bullet_token,
      auth::check_auth_status,
      auth::logout,
      // nxapi サイドカーコマンド（nxapi.rs）
      nxapi::nxapi_setup,
      nxapi::nxapi_fetch_gear,
      nxapi::nxapi_check_login,
    ])
    .setup(|app| {
      if cfg!(debug_assertions) {
        app.handle().plugin(
          tauri_plugin_log::Builder::default()
            .level(log::LevelFilter::Info)
            .build(),
        )?;
      }

      // deep-link: npf71b963c1b7b6d119://auth#... を受信したら
      // フロントへ "deep-link-received" イベントを発火する。
      {
        use tauri_plugin_deep_link::DeepLinkExt;
        let handle = app.handle().clone();
        app.deep_link().on_open_url(move |event| {
          for url in event.urls() {
            let _ = handle.emit("deep-link-received", url.to_string());
          }
        });
      }

      Ok(())
    })
    .run(tauri::generate_context!())
    .expect("error while running tauri application");
}
