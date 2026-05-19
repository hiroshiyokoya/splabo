use tauri::{
    AppHandle, Emitter, Manager, State,
    menu::{Menu, MenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
};

pub mod auth;
pub mod crypto;
pub mod db;
pub mod images;
pub mod nxapi;
pub mod splatnet3;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
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
        .manage(auth::AuthState::default())
        .invoke_handler(tauri::generate_handler![
            auth::start_login,
            auth::handle_auth_redirect,
            auth::check_auth_status,
            auth::logout,
            db::db_battle_stats,
            db::db_battle_count,
            db::db_list_battles,
            db::db_weapons_used,
            db::db_summary,
            db::db_list_weapons,
            db::backfill_battle_players,
            images::read_image,
            fetch_battles,
            fetch_battle_details,
            fetch_weapons,
        ])
        .setup(|app| {
            if cfg!(debug_assertions) {
                app.handle().plugin(
                    tauri_plugin_log::Builder::default()
                        .level(log::LevelFilter::Info)
                        .build(),
                )?;
            }

            // deep-link
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

            // DB初期化
            let handle = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                match db::init_db(&handle).await {
                    Ok(pool) => { handle.manage(pool); }
                    Err(e) => log::error!("DB初期化失敗: {e}"),
                }
            });

            // システムトレイ
            setup_tray(app.handle())?;

            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

/// SplatNet3 からバトル履歴を取得して DB に保存する。新規保存件数を返す。
#[tauri::command]
async fn fetch_battles(app: AppHandle, db: State<'_, db::DbPool>) -> Result<usize, String> {
    let result = nxapi::nxapi_get_bullet_token(&app).await?;
    let client = reqwest::Client::builder()
        .build()
        .map_err(|e| format!("HTTP クライアント構築失敗: {e}"))?;
    splatnet3::fetch_and_store_battles(
        &db,
        &result.bullet_token,
        &result.country,
        &result.language,
        &client,
        &app,
    )
    .await
}

/// HistoryRecordQuery で武器マスター（名前・カテゴリ・画像）を取得して DB に保存し、
/// さらに battles テーブルから sub/special を補完する。合計保存件数を返す。
#[tauri::command]
async fn fetch_weapons(app: AppHandle, db: State<'_, db::DbPool>) -> Result<usize, String> {
    let result = nxapi::nxapi_get_bullet_token(&app).await?;
    let client = reqwest::Client::builder()
        .build()
        .map_err(|e| format!("HTTP クライアント構築失敗: {e}"))?;
    let count = splatnet3::fetch_and_store_weapons(
        &db,
        &result.bullet_token,
        &result.country,
        &result.language,
        &client,
        &app,
    )
    .await?;
    // battle_players から sub/special を補完（category は上書きしない）
    db::populate_weapons_from_battles(&db).await?;
    // バトルデータからサブ・スペシャル画像をキャッシュ
    splatnet3::cache_sub_special_images(&db, &app, &client).await?;
    Ok(count)
}

/// 詳細未取得バトルに VsHistoryDetailQuery を発行して K/D/A を更新する。更新件数を返す。
#[tauri::command]
async fn fetch_battle_details(app: AppHandle, db: State<'_, db::DbPool>) -> Result<usize, String> {
    let result = nxapi::nxapi_get_bullet_token(&app).await?;
    let client = reqwest::Client::builder()
        .build()
        .map_err(|e| format!("HTTP クライアント構築失敗: {e}"))?;
    splatnet3::fetch_and_update_details(
        &db,
        &result.bullet_token,
        &result.country,
        &result.language,
        &client,
    )
    .await
}

fn setup_tray(app: &AppHandle) -> tauri::Result<()> {
    let open = MenuItem::with_id(app, "open", "開く", true, None::<&str>)?;
    let quit = MenuItem::with_id(app, "quit", "終了", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&open, &quit])?;

    TrayIconBuilder::with_id("main")
        .icon(app.default_window_icon().unwrap().clone())
        .menu(&menu)
        .on_menu_event(|app, event| match event.id.as_ref() {
            "open" => show_window(app),
            "quit" => app.exit(0),
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } = event
            {
                show_window(tray.app_handle());
            }
        })
        .build(app)?;

    Ok(())
}

fn show_window(app: &AppHandle) {
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.show();
        let _ = w.unminimize();
        let _ = w.set_focus();
    }
}
