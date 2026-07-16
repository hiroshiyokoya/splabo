//! コンパニオン同期サーバー（#324・設計書 splabo-viewer-design.md §4①・§5）。
//!
//! 同一 LAN 上のペア済みモバイルクライアント（splabo-viewer）へエクスポートファイルを
//! 配信するオプトイン式 HTTP サーバー。デフォルトは停止。設定トグルで起動する。
//!
//! この第一版が担うのは「起動 / 停止・ペアリング情報発行・ファイル配信・mDNS 広告」まで。
//! **②更新命令（任天堂から取り直せ）の受付は範囲外（#326）。**
//!
//! ## 構成
//! - HTTP サーバー: `tiny_http`（同期・軽量）を専用スレッドで駆動。tokio ランタイムと独立。
//!   - `GET /ping`         … トークン検証のみの疎通確認。
//!   - `GET /gear_db.bin`  … `app_data_dir()/data/gear_db.bin` を配信（不在は 404）。
//!   - `GET /battle_db.bin`… `app_data_dir()/data/battle_db.bin` を配信（不在は 404）。
//!   - いずれも `Authorization: Bearer <token>` 検証必須。不一致・欠落は 401。
//! - mDNS 広告: `mdns-sd` でサービス型 `_splabo._tcp.local.` を LAN に告知（viewer の NSD 発見用）。
//!   - **ベストエフォート**。失敗しても HTTP サーバーは動かし続ける（TXT にトークンは載せない）。
//!
//! ## セキュリティ
//! - トークンは起動ごとにランダム（16 バイト = 32 hex）。未ペア端末（トークン不一致）は 401。
//! - LAN 想定。バインドは `0.0.0.0:<空きポート>`（同一 LAN の viewer から到達可能にするため）。

use std::net::IpAddr;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::thread::JoinHandle;
use std::time::Duration;

use serde::Serialize;
use tauri::{AppHandle, Manager, State};

use mdns_sd::{ServiceDaemon, ServiceInfo};

const SERVICE_TYPE: &str = "_splabo._tcp.local.";
const SERVICE_INSTANCE: &str = "splabo";
const SERVICE_HOST: &str = "splabo.local.";

/// 稼働中のサーバー一式（停止時に一括で畳む）。
struct RunningServer {
    port: u16,
    token: String,
    stop: Arc<AtomicBool>,
    handle: Option<JoinHandle<()>>,
    mdns: Option<ServiceDaemon>,
}

/// コンパニオンサーバーの状態。デフォルト停止（オプトイン）。
#[derive(Default)]
pub struct CompanionState(Mutex<Option<RunningServer>>);

/// `companion_start` の戻り値（viewer のペアリング QR に載せる）。
#[derive(Debug, Serialize)]
pub struct CompanionInfo {
    /// LAN 側ホスト IP（IPv4・非ループバック）。viewer は到達可能なものを選ぶ。
    pub host_ips: Vec<String>,
    pub port: u16,
    pub token: String,
}

/// `companion_status` の戻り値。
#[derive(Debug, Serialize)]
pub struct CompanionStatus {
    pub running: bool,
    pub port: Option<u16>,
}

/// ランダムな共有トークン（16 バイト → 32 hex 文字）を生成する。
fn generate_token() -> String {
    use rand::Rng;
    let mut rng = rand::thread_rng();
    (0..32)
        .map(|_| std::char::from_digit(rng.gen_range(0..16), 16).unwrap())
        .collect()
}

/// LAN 側の IPv4・非ループバックアドレスを列挙する。
fn host_ipv4s() -> Vec<IpAddr> {
    match if_addrs::get_if_addrs() {
        Ok(ifaces) => ifaces
            .into_iter()
            .filter(|i| !i.is_loopback())
            .map(|i| i.ip())
            .filter(|ip| ip.is_ipv4())
            .collect(),
        Err(e) => {
            log::warn!("[companion] ホスト IP 列挙に失敗: {e}");
            Vec::new()
        }
    }
}

/// `Authorization: Bearer <token>` を検証する。
fn authorized(request: &tiny_http::Request, token: &str) -> bool {
    let expected = format!("Bearer {token}");
    request
        .headers()
        .iter()
        .find(|h| h.field.equiv("Authorization"))
        .map(|h| h.value.as_str() == expected)
        .unwrap_or(false)
}

/// 指定ファイルを `application/octet-stream` で配信する（不在は 404）。
fn respond_file(request: tiny_http::Request, path: &std::path::Path) {
    match std::fs::read(path) {
        Ok(bytes) => {
            let header = tiny_http::Header::from_bytes(
                &b"Content-Type"[..],
                &b"application/octet-stream"[..],
            )
            .unwrap();
            let response = tiny_http::Response::from_data(bytes).with_header(header);
            let _ = request.respond(response);
        }
        Err(_) => {
            let _ = request.respond(tiny_http::Response::from_string("not found").with_status_code(404));
        }
    }
}

/// 1 リクエストを捌く。
fn handle_request(request: tiny_http::Request, token: &str, data_dir: &std::path::Path) {
    // 疎通・認証チェック（全エンドポイント共通で Bearer 検証）。
    if !authorized(&request, token) {
        let _ = request.respond(tiny_http::Response::from_string("unauthorized").with_status_code(401));
        return;
    }

    // クエリを除いたパス部分で分岐。
    let url = request.url().to_string();
    let path = url.split('?').next().unwrap_or("");
    match path {
        "/ping" => {
            let _ = request.respond(tiny_http::Response::from_string("pong"));
        }
        "/gear_db.bin" => respond_file(request, &data_dir.join("gear_db.bin")),
        "/battle_db.bin" => respond_file(request, &data_dir.join("battle_db.bin")),
        _ => {
            let _ = request.respond(tiny_http::Response::from_string("not found").with_status_code(404));
        }
    }
}

/// mDNS 広告を開始する（ベストエフォート）。失敗しても None を返してサーバーは継続。
fn start_mdns(port: u16, ips: &[IpAddr]) -> Option<ServiceDaemon> {
    let daemon = match ServiceDaemon::new() {
        Ok(d) => d,
        Err(e) => {
            log::warn!("[companion] mDNS デーモン起動失敗（広告なしで継続）: {e}");
            return None;
        }
    };
    // TXT レコードはブロードキャストされるためトークンは載せない（バージョンのみ）。
    let props: [(&str, &str); 1] = [("v", "1")];
    let service = match ServiceInfo::new(
        SERVICE_TYPE,
        SERVICE_INSTANCE,
        SERVICE_HOST,
        ips,
        port,
        &props[..],
    ) {
        Ok(s) => s,
        Err(e) => {
            log::warn!("[companion] mDNS ServiceInfo 構築失敗（広告なしで継続）: {e}");
            return None;
        }
    };
    match daemon.register(service) {
        Ok(_) => {
            log::info!("[companion] mDNS 広告開始 {SERVICE_TYPE} port={port}");
            Some(daemon)
        }
        Err(e) => {
            log::warn!("[companion] mDNS 登録失敗（広告なしで継続）: {e}");
            None
        }
    }
}

/// `app_data_dir()/data` を解決する（存在しなければ作成）。
fn resolve_data_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("アプリデータディレクトリ解決失敗: {e}"))?
        .join("data");
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir)
}

/// コンパニオンサーバーを起動する。
///
/// ランダムトークン発行 → 空きポートで HTTP サーバー起動 → mDNS 広告 →
/// `{host_ips, port, token}` を返す（ペアリング QR 用）。
/// 既に稼働中なら現行の情報をそのまま返す（多重起動しない）。
#[tauri::command]
pub fn companion_start(
    app: AppHandle,
    state: State<'_, CompanionState>,
) -> Result<CompanionInfo, String> {
    let mut guard = state.0.lock().map_err(|e| e.to_string())?;

    // 既に稼働中: 現行情報を返す。
    if let Some(running) = guard.as_ref() {
        return Ok(CompanionInfo {
            host_ips: host_ipv4s().iter().map(|ip| ip.to_string()).collect(),
            port: running.port,
            token: running.token.clone(),
        });
    }

    let data_dir = resolve_data_dir(&app)?;

    // 空きポートで全インターフェースにバインド（LAN の viewer から到達可能に）。
    let server = tiny_http::Server::http("0.0.0.0:0")
        .map_err(|e| format!("HTTP サーバー起動失敗: {e}"))?;
    let port = server
        .server_addr()
        .to_ip()
        .map(|a| a.port())
        .ok_or_else(|| "バインドポートの解決に失敗".to_string())?;

    let token = generate_token();
    let stop = Arc::new(AtomicBool::new(false));

    // 配信スレッド: recv_timeout でポーリングし、stop フラグで抜ける。
    let server = Arc::new(server);
    let handle = {
        let server = Arc::clone(&server);
        let stop = Arc::clone(&stop);
        let token = token.clone();
        let data_dir = data_dir.clone();
        std::thread::spawn(move || {
            log::info!("[companion] HTTP サーバー稼働 0.0.0.0:{port}");
            while !stop.load(Ordering::SeqCst) {
                match server.recv_timeout(Duration::from_millis(500)) {
                    Ok(Some(request)) => handle_request(request, &token, &data_dir),
                    Ok(None) => {} // タイムアウト: stop フラグを再チェック
                    Err(e) => {
                        log::warn!("[companion] リクエスト受信エラー: {e}");
                        break;
                    }
                }
            }
            log::info!("[companion] HTTP サーバー停止");
        })
    };

    let ips = host_ipv4s();
    let mdns = start_mdns(port, &ips);

    *guard = Some(RunningServer {
        port,
        token: token.clone(),
        stop,
        handle: Some(handle),
        mdns,
    });

    Ok(CompanionInfo {
        host_ips: ips.iter().map(|ip| ip.to_string()).collect(),
        port,
        token,
    })
}

/// コンパニオンサーバーを停止する（HTTP スレッド join + mDNS 広告停止）。
#[tauri::command]
pub fn companion_stop(state: State<'_, CompanionState>) -> Result<(), String> {
    let mut guard = state.0.lock().map_err(|e| e.to_string())?;
    if let Some(mut running) = guard.take() {
        running.stop.store(true, Ordering::SeqCst);
        if let Some(daemon) = running.mdns.take() {
            let _ = daemon.shutdown();
        }
        if let Some(handle) = running.handle.take() {
            let _ = handle.join();
        }
        log::info!("[companion] 停止完了");
    }
    Ok(())
}

/// 稼働状態を返す。
#[tauri::command]
pub fn companion_status(state: State<'_, CompanionState>) -> Result<CompanionStatus, String> {
    let guard = state.0.lock().map_err(|e| e.to_string())?;
    Ok(match guard.as_ref() {
        Some(running) => CompanionStatus {
            running: true,
            port: Some(running.port),
        },
        None => CompanionStatus {
            running: false,
            port: None,
        },
    })
}
