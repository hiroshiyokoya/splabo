use tauri::{AppHandle, Emitter, Manager};

pub mod auth;
pub mod crypto;
pub mod nxapi;

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
fn read_gear_db(app: AppHandle) -> Result<String, String> {
  let dir = resolve_data_dir(&app)
    .ok_or_else(|| "ギアデータが見つかりません".to_string())?;

  let bin_path = dir.join("gear_db.bin");
  if bin_path.exists() {
    let encrypted = std::fs::read(&bin_path).map_err(|e| e.to_string())?;
    let plain = crypto::decrypt_db(&encrypted)?;
    String::from_utf8(plain).map_err(|e| e.to_string())
  } else {
    std::fs::read_to_string(dir.join("gear_db.json")).map_err(|e| e.to_string())
  }
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
    // gpng:// カスタムプロトコル: .gpng ファイルを XOR 復元して image/png として配信する。
    // URL 形式: gpng://localhost/<URL エンコードされた絶対パス>
    .register_uri_scheme_protocol("gpng", |_app, request| {
      let uri = request.uri().to_string();
      // "gpng://localhost/" を除いた部分がファイルパス（URL エンコード済み）
      let encoded = uri
        .strip_prefix("gpng://localhost/")
        .unwrap_or("")
        .trim_start_matches('/');
      let path = urlencoding::decode(encoded)
        .unwrap_or_else(|_| encoded.into());

      match std::fs::read(path.as_ref()) {
        Ok(scrambled) => {
          let png = crypto::scramble_image(&scrambled);
          tauri::http::Response::builder()
            .header("Content-Type", "image/png")
            .header("Access-Control-Allow-Origin", "*")
            .body(png)
            .unwrap()
        }
        Err(e) => tauri::http::Response::builder()
          .status(404)
          .body(format!("not found: {e}").into_bytes())
          .unwrap(),
      }
    })
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
        if let Some(w) = app.get_webview_window("main") {
            let _ = w.unminimize();
            let _ = w.set_focus();
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
          if let Some(w) = handle.get_webview_window("main") {
            let _ = w.unminimize();
            let _ = w.set_focus();
          }
        });
      }

      Ok(())
    })
    .run(tauri::generate_context!())
    .expect("error while running tauri application");
}
