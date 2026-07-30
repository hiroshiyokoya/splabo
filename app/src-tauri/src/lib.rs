use tauri::{
    AppHandle, Emitter, Manager, State,
    menu::{Menu, MenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
};

pub mod abilities;
pub mod ai_views;
pub mod auth;
pub mod battle_export;
pub mod companion;
pub mod crypto;
pub mod db;
pub mod env_import;
pub mod gear;
pub mod gear_crypto;
pub mod http;
pub mod icon_manifest;
pub mod image_export;
pub mod images;
pub mod migration;
pub mod nxapi;
pub mod splatnet3;
pub mod sql_functions;
pub mod statink;
pub mod statink_import;
pub mod weapon_static;

/// スケジューラー設定（フロントエンドから set_scheduler_config で更新される）
/// (enabled, interval_min) — interval_min は分単位（15, 30, 60, 120, 360, 720, 1440 等）
pub struct SchedulerConfig(pub std::sync::Mutex<(bool, u32)>);
impl Default for SchedulerConfig {
    fn default() -> Self { Self(std::sync::Mutex::new((false, 1440))) }  // デフォルト 24h
}

/// stat.ink 設定（フロントエンドから set_statink_config で更新される）
pub struct StatinkConfig(pub std::sync::Mutex<(bool, String)>);  // (auto_upload, api_key)
impl Default for StatinkConfig {
    fn default() -> Self { Self(std::sync::Mutex::new((false, String::new()))) }
}

/// fetch_complete イベントのペイロード
#[derive(serde::Serialize, Clone)]
struct FetchCompletePayload {
    battles: usize,
    details: usize,
    uploaded: usize,
}

/// バトル取得中フラグ。run_fetch_full の進行状態を表す（手動・起動時・スケジューラー共通）。
/// フロントエンドは fetch_start / fetch_finish イベント、または is_fetching コマンドで参照する。
#[derive(Default)]
pub struct FetchInProgress(pub std::sync::atomic::AtomicBool);

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
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_store::Builder::default().build())
        .plugin(tauri_plugin_deep_link::init())
        // パネル画像の保存先を選ばせるためのダイアログ（#500）。呼び出しは Rust 側だけ。
        .plugin(tauri_plugin_dialog::init())
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                let enabled = window.app_handle()
                    .try_state::<SchedulerConfig>()
                    .map(|c| c.0.lock().unwrap().0)
                    .unwrap_or(false);
                if enabled {
                    api.prevent_close();
                    let _ = window.hide();
                } else {
                    window.app_handle().exit(0);
                }
            }
        })
        .manage(auth::AuthState::default())
        .manage(SchedulerConfig::default())
        .manage(StatinkConfig::default())
        .manage(FetchInProgress::default())
        .manage(gear::GearFetchInProgress::default())
        .manage(companion::CompanionState::default())
        .manage(image_export::LastExportDir::default())
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
            db::db_grouped_stats,
            db::db_grouped_stats_2d,
            db::db_list_weapons,
            db::backfill_battle_players,
            images::read_image,
            image_export::save_panel_image,
            fetch_battles_full,
            is_fetching,
            fetch_weapons,
            set_scheduler_config,
            set_statink_config,
            upload_to_statink,
            upload_to_statink_one,
            delete_statink_all,
            detect_statink_screen_name,
            import_from_statink,
            env_import::sync_env_masters,
            env_import::import_env_full,
            env_import::import_env_delta,
            db::env_status,
            db::env_filtered_count,
            db::env_scatter_stats,
            db::env_matrix_stats,
            db::env_season_range,
            db::env_versions,
            db::env_ranks,
            db::env_weapons,
            db::env_stages,
            // ギア表示系（geartoon 由来・Phase A1 で移植・gear.rs）
            gear::read_gear_db,
            gear::get_data_dir,
            gear::read_all_gti,
            gear::delete_gear_data,
            // ギア取得系（Rust GraphQL 経路・Phase A2・gear.rs）
            gear::fetch_gear_full,
            // battle_db エクスポート（モバイルコンパニオン・#325・battle_export.rs）
            battle_export::export_battle_db,
            // コンパニオン同期サーバー（モバイルコンパニオン・#324・companion.rs）
            companion::companion_start,
            companion::companion_stop,
            companion::companion_status,
            // 接続トラブルの自己診断（Windows ファイアウォール / プロファイル案内・#363）
            companion::companion_diagnostics,
            // データ移行（Phase C・migration.rs）
            migration::get_migration_report,
        ])
        .setup(|app| {
            // データ移行（Phase C・#242）: DB 初期化より前に同期実行する。
            // 識別子据え置き（com.chartoon.app）中は移行元==移行先で no-op になる。
            // 本番 D で識別子が com.splabo.app に変わって初めて発火する。
            migration::run_startup_migration(app.handle());

            if cfg!(debug_assertions) {
                app.handle().plugin(
                    tauri_plugin_log::Builder::default()
                        .level(log::LevelFilter::Info)
                        // ログのタイムスタンプを OS のローカルタイムに（デフォルトは UTC）
                        .timezone_strategy(tauri_plugin_log::TimezoneStrategy::UseLocal)
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
                        // 既存レコードを stat.ink ID 形式に移行
                        if let Some(pool) = handle.try_state::<db::DbPool>() {
                            match db::migrate_battle_ids(&pool).await {
                                Ok(n) if n > 0 => log::info!("[移行] mode/rule/stage/result を正規化 {n}件"),
                                Ok(_) => {},
                                Err(e) => log::warn!("[移行] 失敗: {e}"),
                            }
                        }
                        // AI 用ビューを張り直す（#572）。**マイグレーションの後**であること。
                        // rule_id の nullable 化(v11)・環境の KDA 列(v21)を前提にしている。
                        // 毎起動 drop→create するので版管理は不要（コードが常に正）。
                        if let Some(pool) = handle.try_state::<db::DbPool>() {
                            if let Err(e) = ai_views::create_views(&pool).await {
                                log::warn!("[AI ビュー] {e}");
                            }
                        }
                        // DB 準備完了後に起動時フェッチ（未ログインならスキップ）
                        if let Some(pool) = handle.try_state::<db::DbPool>() {
                            if auth::is_logged_in(&handle) {
                                log::info!("[起動時取得] 開始");
                                match run_fetch_full(&handle, &pool).await {
                                    Ok((b, d, u)) => {
                                        log::info!("[起動時取得] 完了 バトル+{b}件 詳細+{d}件 stat.ink+{u}件");
                                        // サイドバー手動取得と同じく、バトル成功後にギアも best-effort（#440）。
                                        fetch_gear_best_effort(&handle, "起動時取得").await;
                                    }
                                    Err(e)        => log::error!("[起動時取得] 失敗: {e}"),
                                }
                            } else {
                                log::info!("[起動時取得] 未ログインのためスキップ");
                            }
                        }
                    }
                    Err(e) => log::error!("DB初期化失敗: {e}"),
                }
            });

            // 自動取得スケジューラー（インターバル方式・切りのいい時刻で発火）
            // 起動タイミングに依存せず「壁時計の minute_of_day % interval == 0」を満たす分に発火。
            // 例: interval=15 なら 0,15,30,45 分、interval=360 なら 0:00/6:00/12:00/18:00。
            let handle = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                let mut last_fired_at: Option<chrono::DateTime<chrono::Local>> = None;
                loop {
                    tokio::time::sleep(tokio::time::Duration::from_secs(60)).await;

                    let (enabled, interval_min) = {
                        let config = handle.state::<SchedulerConfig>();
                        let v = *config.0.lock().unwrap();
                        v
                    };

                    if !enabled || interval_min == 0 || !auth::is_logged_in(&handle) {
                        continue;
                    }

                    use chrono::Timelike;
                    let now = chrono::Local::now();
                    let minutes_today: u32 = now.hour() * 60 + now.minute();
                    let is_boundary    = minutes_today % interval_min == 0;
                    let recently_fired = last_fired_at
                        .map(|t| (now - t).num_seconds() < 90)
                        .unwrap_or(false);

                    if is_boundary && !recently_fired {
                        last_fired_at = Some(now);
                        if let Some(pool) = handle.try_state::<db::DbPool>() {
                            log::info!("[自動取得] 開始 ({:02}:{:02}, 間隔 {} 分)",
                                now.hour(), now.minute(), interval_min);
                            match run_fetch_full(&handle, &pool).await {
                                Ok((b, _, u)) => {
                                    log::info!("[自動取得] 完了 バトル+{b}件 stat.ink+{u}件");
                                    // サイドバー手動取得と同じく、バトル成功後にギアも best-effort（#440）。
                                    fetch_gear_best_effort(&handle, "自動取得").await;
                                    send_notification(&handle, b);
                                }
                                Err(e) => {
                                    log::error!("[自動取得] 失敗: {e}");
                                    send_notification_error(&handle);
                                }
                            }
                        }
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

/// バトル取得 → 詳細取得 → 武器補完 → 画像キャッシュ → battle_db エクスポート を一括実行し、
/// その**後**に stat.ink 自動アップロードを best-effort で行う。
/// 開始時に "fetch_start"、終了時に "fetch_finish" イベントを emit する（成功・失敗共通）。
/// 成功時はさらに "fetch_complete" を emit する（既存の lastFetchedAt 更新リスナー用）。
///
/// ギア取得は含めない。起動時・自動取得・サイドバーは呼び出し側で `fetch_gear_best_effort`
/// を後続実行する（#440）。コンパニオンの battle-only 経路を壊さないため本体には入れない。
///
/// # 「取得中」表示とアップロードの分離（#402）
/// stat.ink アップロードは取得そのものとは別物（すでに DB へ保存済みのバトルを送るだけ）。
/// 以前はこれを取得処理の最後のステップとして `FetchInProgress` を握ったまま同期実行して
/// いたため、stat.ink がダウンして HTTP がハングすると**バトル取得は終わっているのに
/// 「取得中」が永久化**した（#402 の主症状）。
/// そこでフラグ解放・`fetch_finish` は「取得＋エクスポート完了」時点で行い、
/// stat.ink アップロードはその後の後処理に回す。エクスポートは #367 の意図どおり
/// フラグ内に残す（コンパニオンの更新命令が中途半端な状態に割り込まないように）。
/// アップロードは battle_db の中身に影響しない（未送信でもエクスポートされる）ので、
/// フラグ外へ出しても安全。
///
/// 未ログイン時はサイドカー呼び出しの前に明示的に `NOT_LOGGED_IN:` プリフィクス付き
/// エラーを返し、フロントが「設定からログインしてください」UI を出せるようにする。
/// `companion.rs` の②更新命令（#326）からも同じ経路で呼ぶため `pub(crate)`。
pub(crate) async fn run_fetch_full(app: &AppHandle, db: &db::DbPool) -> Result<(usize, usize, usize), String> {
    use std::sync::atomic::Ordering;
    let flag = app.state::<FetchInProgress>();
    // 既に取得中なら多重起動を防ぐ
    if flag.0.swap(true, Ordering::SeqCst) {
        return Err("FETCH_IN_PROGRESS: 既にバトル取得が進行中です。".to_string());
    }
    let _ = app.emit("fetch_start", ());
    let result = run_fetch_full_inner(app, db).await;
    // 取得が成功したら battle_db.bin を再生成する（#367）。
    // ここに置くのは手動取得・起動時取得・スケジューラーの共通経路だから。
    // FetchInProgress を握ったまま実行し、「取得完了 = エクスポート済み」の状態で
    // フラグを解放する（コンパニオンの更新命令が中途半端な状態に割り込まないように）。
    if result.is_ok() {
        export_battle_db_best_effort(app).await;
    }
    // ここで「取得中」を終える。stat.ink アップロードのハング／遅延に取得完了表示を
    // 巻き込まないため、フラグ解放と fetch_finish はアップロードの**前**に出す（#402）。
    flag.0.store(false, Ordering::SeqCst);
    let _ = app.emit("fetch_finish", ());

    // stat.ink 自動アップロードは best-effort な後処理。失敗しても取得結果は成功のまま返す。
    let uploaded = if result.is_ok() {
        upload_to_statink_best_effort(app, db).await
    } else {
        0
    };

    result.map(|(battles, details, _)| (battles, details, uploaded))
}

/// stat.ink 自動アップロードを best-effort で実行する（#402）。
///
/// 取得完了（フラグ解放）後に呼ばれる後処理。設定が有効かつ API キーがあるときだけ送信する。
/// 失敗は握りつぶさず、`statink_upload_failed` イベントで**分類付きのエラー文字列**を
/// フロントへ伝える（#399 の `UPSTREAM_UNAVAILABLE` / `AUTH_EXPIRED` / `NETWORK` プリフィクス）。
/// 未送信バトルは DB に残るため、次回取得時に自動で再送される（取りこぼしは無い）。
async fn upload_to_statink_best_effort(app: &AppHandle, db: &db::DbPool) -> usize {
    let Some(sc) = app.try_state::<StatinkConfig>() else { return 0 };
    let (auto_upload, api_key) = {
        let v = sc.0.lock().unwrap();
        (v.0, v.1.clone())
    };
    if !auto_upload || api_key.is_empty() {
        return 0;
    }
    let client = match crate::http::build_client() {
        Ok(c) => c,
        Err(e) => { log::warn!("[stat.ink] クライアント構築失敗のため自動アップロードをスキップ: {e}"); return 0; }
    };
    match statink::upload_pending_battles(db, &client, &api_key, None, Some(app)).await {
        Ok(n) => n,
        Err(e) => {
            log::warn!("[stat.ink] 自動アップロード失敗: {e}");
            // 失敗を握りつぶさずフロントへ通知する（#402 必須2）。
            let _ = app.emit("statink_upload_failed", e);
            0
        }
    }
}

/// `battle_db.bin` の再生成を **best-effort** で実行する（#367）。
///
/// エクスポートはあくまで viewer 連携のための副次処理なので、失敗しても
/// 呼び出し元（バトル取得）を失敗させない。警告ログだけ出して続行する。
/// DB がまだ初期化されていない場合（コンパニオン未使用でも同様）は何もしない。
async fn export_battle_db_best_effort(app: &AppHandle) {
    let Some(pool) = app.try_state::<db::DbPool>() else {
        log::warn!("[battle_export] DB 未初期化のため battle_db.bin の再生成をスキップしました");
        return;
    };
    let started = std::time::Instant::now();
    let outcome = battle_export::export_battle_db(app.clone(), pool, None).await;
    absorb_export_error(outcome, started.elapsed());
}

/// エクスポート結果を best-effort として畳み込む。
///
/// 成否にかかわらず所要時間をログに出し、失敗は `warn` に落として `None` を返す
/// （呼び出し元へ `Err` を伝播させない）。副作用がログだけの純粋関数なので、
/// `AppHandle` 抜きで「失敗が伝播しないこと」をユニットテストできる。
fn absorb_export_error<T>(result: Result<T, String>, elapsed: std::time::Duration) -> Option<T> {
    match result {
        Ok(v) => {
            log::info!("[battle_export] battle_db.bin 再生成 完了 ({} ms)", elapsed.as_millis());
            Some(v)
        }
        Err(e) => {
            log::warn!(
                "[battle_export] battle_db.bin 再生成に失敗しました（バトル取得は成功扱いで続行）: {e} ({} ms)",
                elapsed.as_millis()
            );
            None
        }
    }
}

/// バトル取得・詳細取得・武器補完・画像キャッシュを行う（stat.ink アップロードは含まない）。
/// アップロードは `run_fetch_full` がフラグ解放後に best-effort で行う（#402）。
/// 戻り値の 3 要素目 `uploaded` はここでは常に 0（実際の件数は `run_fetch_full` が後段で埋める）。
async fn run_fetch_full_inner(app: &AppHandle, db: &db::DbPool) -> Result<(usize, usize, usize), String> {
    if !auth::is_logged_in(app) {
        return Err("NOT_LOGGED_IN: Nintendo アカウントでログインしていません。設定からログインしてください。".to_string());
    }
    let result = nxapi::nxapi_get_bullet_token(app).await?;
    let client = crate::http::build_client()?;

    let battles = splatnet3::fetch_and_store_battles(
        db, &result.bullet_token, &result.country, &result.language, &client, app,
    ).await?;

    let details = splatnet3::fetch_and_update_details(
        db, &result.bullet_token, &result.country, &result.language, &client,
    ).await?;

    db::populate_weapons_from_battles(db).await?;
    splatnet3::cache_sub_special_images(db, app, &client).await?;
    splatnet3::cache_ability_images(db, app, &client).await?;
    // 全ギアパワーを登場依存なしで先回りキャッシュ（viewer の全スキル表示のアイコン欠け対策・#360）
    splatnet3::cache_all_ability_images(app, &client).await?;
    // 全プレイヤー（味方・相手）のメイン武器画像もキャッシュ（#136）
    splatnet3::cache_all_weapon_images(db, app, &client).await?;

    // 「取得完了」はアップロードを待たずここで通知する（lastFetchedAt 更新用）。
    // uploaded は後段の best-effort アップロードで確定するため、ここでは 0 を載せる。
    let _ = app.emit("fetch_complete", FetchCompletePayload { battles, details, uploaded: 0 });
    Ok((battles, details, 0))
}

/// バトル取得・詳細取得・stat.ink アップロードを一括実行する。
#[tauri::command]
async fn fetch_battles_full(app: AppHandle, db: State<'_, db::DbPool>) -> Result<(usize, usize, usize), String> {
    run_fetch_full(&app, &db).await
}

/// 現在バトル取得処理が進行中かを返す。
/// フロントエンドが mount 時に問い合わせ、起動時取得との race を解消するために使う。
#[tauri::command]
fn is_fetching(state: State<'_, FetchInProgress>) -> bool {
    state.0.load(std::sync::atomic::Ordering::SeqCst)
}

/// stat.ink 設定を更新する。フロントエンドが設定変更時に呼び出す。
#[tauri::command]
fn set_statink_config(config: State<'_, StatinkConfig>, auto_upload: bool, api_key: String) {
    *config.0.lock().unwrap() = (auto_upload, api_key);
    log::info!("[stat.ink] 設定更新: auto_upload={auto_upload}");
}

/// stat.ink の screen_name を既存アップロード済みバトルから逆引きする。
/// アップロード履歴が無い・API エラー時は None。
/// `apiKey` を JS から直接渡すため、`Settings` 画面を開かなくても起動直後から呼べる。
#[tauri::command]
async fn detect_statink_screen_name(
    api_key: String,
    db: State<'_, db::DbPool>,
) -> Result<Option<String>, String> {
    if api_key.is_empty() {
        return Ok(None);
    }
    let client = crate::http::build_client()?;
    statink::fetch_screen_name(&db, &client, &api_key).await
}

/// stat.ink にアップロード済みのバトルを全件削除して statink_uuid をリセットする（再アップロード用）。
#[tauri::command]
async fn delete_statink_all(
    config: State<'_, StatinkConfig>,
    db: State<'_, db::DbPool>,
) -> Result<usize, String> {
    let api_key = config.0.lock().unwrap().1.clone();
    if api_key.is_empty() {
        return Err("stat.ink API キーが設定されていません".to_string());
    }
    let client = crate::http::build_client()?;
    statink::delete_all_uploaded_battles(&db, &client, &api_key).await
}

/// 未アップロードのバトルを stat.ink へアップロードする（手動・全件）。
#[tauri::command]
async fn upload_to_statink(
    app: AppHandle,
    config: State<'_, StatinkConfig>,
    db: State<'_, db::DbPool>,
) -> Result<usize, String> {
    let api_key = config.0.lock().unwrap().1.clone();
    if api_key.is_empty() {
        return Err("stat.ink API キーが設定されていません".to_string());
    }
    let client = crate::http::build_client()?;
    statink::upload_pending_battles(&db, &client, &api_key, None, Some(&app)).await
}

/// 未アップロードのバトルを stat.ink へ 1 件だけアップロードする（テスト用）。
#[tauri::command]
async fn upload_to_statink_one(
    app: AppHandle,
    config: State<'_, StatinkConfig>,
    db: State<'_, db::DbPool>,
) -> Result<usize, String> {
    let api_key = config.0.lock().unwrap().1.clone();
    if api_key.is_empty() {
        return Err("stat.ink API キーが設定されていません".to_string());
    }
    let client = crate::http::build_client()?;
    statink::upload_pending_battles(&db, &client, &api_key, Some(1), Some(&app)).await
}

/// stat.ink から自分の過去バトル履歴を一括インポートする（#174）。
/// API キーで `@<screen_name>/spl3/index.json` をページングして全件取得し、
/// uuid 重複を除いて新スキーマへ取り込む。{ imported, skipped, failed, total } を返す。
#[tauri::command]
async fn import_from_statink(
    config: State<'_, StatinkConfig>,
    db: State<'_, db::DbPool>,
) -> Result<statink_import::ImportResult, String> {
    let api_key = config.0.lock().unwrap().1.clone();
    if api_key.is_empty() {
        return Err("stat.ink API キーが設定されていません".to_string());
    }
    let client = crate::http::build_client()?;
    statink_import::import_all_battles(&db, &client, &api_key).await
}

/// HistoryRecordQuery で武器マスター（名前・カテゴリ・画像）を取得して DB に保存し、
/// さらに battles テーブルから sub/special を補完する。合計保存件数を返す。
#[tauri::command]
async fn fetch_weapons(app: AppHandle, db: State<'_, db::DbPool>) -> Result<usize, String> {
    if !auth::is_logged_in(&app) {
        return Err("NOT_LOGGED_IN: Nintendo アカウントでログインしていません。".to_string());
    }
    let result = nxapi::nxapi_get_bullet_token(&app).await?;
    let client = crate::http::build_client()?;
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
    splatnet3::cache_ability_images(&db, &app, &client).await?;
    splatnet3::cache_all_ability_images(&app, &client).await?;
    splatnet3::cache_all_weapon_images(&db, &app, &client).await?;

    // WeaponRecordQuery (#49) も同じ「武器データを更新」フローで取得する。
    // ここではユーザー固有統計（熟練度・勝利数・塗りポイント）の upsert と、
    // 全武器分の主・サブ・SP 画像キャッシュを行う（バトル未登場武器のアイコン欠け解消も兼ねる）。
    // 失敗してもメインフローは止めない（戻り値の count はそのまま）。
    if let Err(e) = splatnet3::fetch_and_store_weapon_records(&db, &client, &app).await {
        // nxapi 同梱の WeaponRecordQuery 持続クエリハッシュが Nintendo 側で廃止された場合は、
        // 外部依存待ちの既知問題なので warn ではなく info に落とす（chartoon Issue #162 で追跡）。
        if e.contains("persisted query") && e.contains("does not exist") {
            log::info!(
                "[weapon_records] スキップ: nxapi 同梱の WeaponRecordQuery 持続クエリハッシュが Nintendo 側で廃止。nxapi 更新待ち。"
            );
        } else {
            log::warn!("[weapon_records] 取得スキップ: {e}");
        }
    }

    Ok(count)
}

/// スケジューラー設定を更新する。フロントエンドが設定変更時に呼び出す。
/// `interval_min` は実行間隔（分）。`minute_of_day % interval_min == 0` を満たす分に発火する。
#[tauri::command]
fn set_scheduler_config(config: State<'_, SchedulerConfig>, enabled: bool, interval_min: u32) {
    *config.0.lock().unwrap() = (enabled, interval_min);
    log::info!("[スケジューラー] 設定更新: enabled={enabled} interval={interval_min}min");
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

/// バトル取得成功後のギア取得（#440）。失敗しても呼び出し元のバトル成功は維持する。
/// サイドバー手動取得（`App.tsx` の `handleFetchFull`）と同じ best-effort 方針。
/// 既に別経路でギア取得中ならスキップ（`GEAR_FETCH_IN_PROGRESS`）。
async fn fetch_gear_best_effort(app: &AppHandle, context: &str) {
    match gear::fetch_gear_full(app.clone()).await {
        Ok(g) => log::info!(
            "[{context}] ギア完了 頭+{} 服+{} 靴+{}",
            g.head, g.clothing, g.shoes
        ),
        Err(e) if e.starts_with("GEAR_FETCH_IN_PROGRESS:") => {
            log::info!("[{context}] ギア取得スキップ（別経路で進行中）");
        }
        Err(e) => log::warn!("[{context}] ギア失敗（バトル取得は成功のまま）: {e}"),
    }
}

fn send_notification(app: &AppHandle, battles: usize) {
    use tauri_plugin_notification::NotificationExt;
    let body = if battles > 0 {
        format!("バトル +{}件取得しました", battles)
    } else {
        "新しいバトルはありませんでした".to_string()
    };
    let _ = app.notification()
        .builder()
        .title("splabo")
        .body(&body)
        .show();
}

fn send_notification_error(app: &AppHandle) {
    use tauri_plugin_notification::NotificationExt;
    let _ = app.notification()
        .builder()
        .title("splabo")
        .body("バトルデータの取得に失敗しました")
        .show();
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Duration;

    /// エクスポート失敗が `Err` として伝播せず `None` に畳み込まれること（#367 の肝）。
    #[test]
    fn absorb_export_error_swallows_failure() {
        let r: Option<u32> = absorb_export_error(Err("書き込み失敗".to_string()), Duration::from_millis(3));
        assert!(r.is_none());
    }

    /// 成功時は値がそのまま取り出せること。
    #[test]
    fn absorb_export_error_passes_through_success() {
        let r = absorb_export_error(Ok(42u32), Duration::from_millis(1));
        assert_eq!(r, Some(42));
    }

    /// `run_fetch_full` の制御フロー（取得結果 → best-effort エクスポート → 戻り値）を模した検証。
    /// エクスポートがどう転んでも取得件数はそのまま返ること。
    #[test]
    fn fetch_result_is_unaffected_by_export_outcome() {
        fn simulate(
            fetch: Result<(usize, usize, usize), String>,
            export: Result<(), String>,
        ) -> Result<(usize, usize, usize), String> {
            if fetch.is_ok() {
                absorb_export_error(export, Duration::from_millis(0));
            }
            fetch
        }

        let ok = (7usize, 3usize, 0usize);
        assert_eq!(simulate(Ok(ok), Err("boom".into())), Ok(ok));
        assert_eq!(simulate(Ok(ok), Ok(())), Ok(ok));
        // 取得自体が失敗した場合はそのエラーがそのまま返る（エクスポートで塗り潰さない）。
        assert_eq!(
            simulate(Err("NOT_LOGGED_IN: ...".into()), Ok(())),
            Err("NOT_LOGGED_IN: ...".to_string())
        );
    }

    /// 多重起動防止フラグの挙動: 取得中フラグが立っている間は再入できず、
    /// エクスポートを内包しても解放後は再び取得できること。
    #[test]
    fn fetch_in_progress_flag_round_trip() {
        use std::sync::atomic::Ordering;
        let flag = FetchInProgress::default();
        assert!(!flag.0.swap(true, Ordering::SeqCst), "最初の取得は開始できる");
        assert!(flag.0.swap(true, Ordering::SeqCst), "取得中は再入できない");
        // エクスポートはフラグを握ったまま走り、その後に解放される
        flag.0.store(false, Ordering::SeqCst);
        assert!(!flag.0.swap(true, Ordering::SeqCst), "解放後は再び取得できる");
    }
}
