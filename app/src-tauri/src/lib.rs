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

/// スケジューラー設定（フロントエンドから set_scheduler_config で更新される）
pub struct SchedulerConfig(pub std::sync::Mutex<(bool, u8)>);
impl Default for SchedulerConfig {
    fn default() -> Self { Self(std::sync::Mutex::new((false, 4))) }
}

/// fetch_complete イベントのペイロード
#[derive(serde::Serialize, Clone)]
struct FetchCompletePayload {
    battles: usize,
    details: usize,
}

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
        .manage(SchedulerConfig::default())
        .invoke_handler(tauri::generate_handler![
            auth::start_login,
            auth::handle_auth_redirect,
            auth::check_auth_status,
            auth::logout,
            db::db_battle_stats,
            db::db_battle_count,
            db::db_list_battles,
            db::db_weapons_used,
            db::db_stages_used,
            db::db_summary,
            db::db_list_weapons,
            db::backfill_battle_players,
            images::read_image,
            fetch_battles_full,
            fetch_weapons,
            set_scheduler_config,
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

            // DB初期化 → 完了後に起動時フェッチを1回実行
            let handle = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                match db::init_db(&handle).await {
                    Ok(pool) => {
                        handle.manage(pool);
                        // DB 準備完了後に起動時フェッチ（未ログインなら無視）
                        if let Some(pool) = handle.try_state::<db::DbPool>() {
                            log::info!("[起動時取得] 開始");
                            match run_fetch_full(&handle, &pool).await {
                                Ok((b, d)) => log::info!("[起動時取得] 完了 バトル+{b}件 詳細+{d}件"),
                                Err(e)     => log::info!("[起動時取得] スキップ: {e}"),
                            }
                        }
                    }
                    Err(e) => log::error!("DB初期化失敗: {e}"),
                }
            });

            // 自動取得スケジューラー
            let handle = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                let mut last_run_hour: Option<u32> = None;
                loop {
                    tokio::time::sleep(tokio::time::Duration::from_secs(60)).await;

                    let (enabled, target_hour) = {
                        let config = handle.state::<SchedulerConfig>();
                        let v = *config.0.lock().unwrap();
                        v
                    };

                    if !enabled {
                        last_run_hour = None;
                        continue;
                    }

                    use chrono::Timelike;
                    let current_hour = chrono::Local::now().hour();

                    if current_hour == target_hour as u32 && last_run_hour != Some(current_hour) {
                        last_run_hour = Some(current_hour);
                        if let Some(pool) = handle.try_state::<db::DbPool>() {
                            log::info!("[自動取得] 開始 ({}時)", target_hour);
                            match run_fetch_full(&handle, &pool).await {
                                Ok((b, d)) => log::info!("[自動取得] 完了 バトル+{b}件 詳細+{d}件"),
                                Err(e)     => log::error!("[自動取得] 失敗: {e}"),
                            }
                        }
                    } else if current_hour != target_hour as u32 {
                        last_run_hour = None;
                    }
                }
            });

            // システムトレイ
            setup_tray(app.handle())?;

            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

/// バトル取得 → 詳細取得 → 武器補完 → 画像キャッシュ を一括実行。
/// 完了後に "fetch_complete" イベントを emit する。
async fn run_fetch_full(app: &AppHandle, db: &db::DbPool) -> Result<(usize, usize), String> {
    let result = nxapi::nxapi_get_bullet_token(app).await?;
    let client = reqwest::Client::builder()
        .build()
        .map_err(|e| format!("HTTP クライアント構築失敗: {e}"))?;

    let battles = splatnet3::fetch_and_store_battles(
        db, &result.bullet_token, &result.country, &result.language, &client, app,
    ).await?;

    let details = splatnet3::fetch_and_update_details(
        db, &result.bullet_token, &result.country, &result.language, &client,
    ).await?;

    db::populate_weapons_from_battles(db).await?;
    splatnet3::cache_sub_special_images(db, app, &client).await?;

    let _ = app.emit("fetch_complete", FetchCompletePayload { battles, details });
    Ok((battles, details))
}

/// バトル取得・詳細取得を一括実行する。新規バトル数と更新詳細数のタプルを返す。
#[tauri::command]
async fn fetch_battles_full(app: AppHandle, db: State<'_, db::DbPool>) -> Result<(usize, usize), String> {
    run_fetch_full(&app, &db).await
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
    db::backfill_battle_players_inner(&db).await?;
    db::populate_weapons_from_battles(&db).await?;
    splatnet3::cache_sub_special_images(&db, &app, &client).await?;
    Ok(count)
}

/// スケジューラー設定を更新する。フロントエンドが設定変更時に呼び出す。
#[tauri::command]
fn set_scheduler_config(config: State<'_, SchedulerConfig>, enabled: bool, hour: u8) {
    *config.0.lock().unwrap() = (enabled, hour);
    log::info!("[スケジューラー] 設定更新: enabled={enabled} hour={hour}");
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
