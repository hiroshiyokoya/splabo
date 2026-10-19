//! スマホ Web 版のサーバー（「スマホで見る」・#786〜#788・設計 #784）。
//!
//! 同じ LAN のスマホのブラウザに、PC の SpLabo の画面とデータを配るオプトイン式 HTTP サーバー。
//! 既定は停止。設定の「スマホで見る」で起動する（オンのままならアプリ起動時に自動で立ち上がる）。
//!
//! ## 構成
//! - HTTP サーバー: `tiny_http`（同期・軽量）を専用スレッドで駆動。tokio ランタイムと独立。
//! - スマホ画面の静的ファイル（認証なし。中身はアプリに同梱のフロントだけ）:
//!   - `GET /m/` … `mobile.html`。`/assets/...`・マニフェスト・アイコン・ロゴも返す
//! - Cookie（`splabo_session`）で認証する経路:
//!   - `POST /api/session` … 本文 `{"token":"..."}` が合えば `Set-Cookie`（`splabo_session`）。
//!   - `POST /api/cmd/<名前>` … 許可リストの Tauri コマンドを中継（`web_api.rs`）。
//!   - `GET  /img/<相対パス>` … 画像（.gti）を PNG に戻して返す。
//!   - `POST /update` … 更新命令（任天堂から取り直せ）の受付。**受付のみで即応答**（202）し、
//!     実処理は裏で走る。ボディ `{"target":"battle"|"gear"|"both"}`（省略時 both）。
//!   - `GET /update_status` … 更新命令の進捗・完了・失敗を問い合わせる（ポーリング用）。
//!
//! ## 更新命令
//! - 「重い・数十秒」処理なので HTTP を掴んだまま待たせない。`POST /update` は受付可否だけを
//!   即返し、スマホは `GET /update_status` をポーリングして完了を待つ。
//! - **認証済みトークン前提**。未ログインなら任天堂 API を一切叩かず `NOT_LOGGED_IN` を返す。
//! - **多重起動しない**。実行中の更新ジョブ、およびデスクトップ側のバトル取得
//!   （`FetchInProgress`・手動/起動時/スケジューラー共通）と重なる場合は新規に走らせず、
//!   進行中である旨を返す。
//! - スマホは任天堂 API に触れない。再フェッチはこのデスクトップ側だけで完結する。
//!
//! ## セキュリティ
//! - トークンは `companion.json` に固定で保存する（「再発行」で作り直す）。スマホは QR の URL の
//!   `#t=` で受け取り、`/api/session` で Cookie に交換する。不一致・欠落は 401。
//! - LAN 想定。バインドは `0.0.0.0:<固定ポート>`（同一 LAN のスマホから到達可能にするため）。

use std::net::{IpAddr, Ipv4Addr};
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::thread::JoinHandle;
use std::time::Duration;

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use tauri::{AppHandle, Manager, State};

/// 稼働中のサーバー一式（停止時に一括で畳む）。
struct RunningServer {
    port: u16,
    token: String,
    stop: Arc<AtomicBool>,
    handle: Option<JoinHandle<()>>,
}

/// リクエスト処理に必要な一式（HTTP スレッドが保持する）。
struct ServerCtx {
    token: String,
    /// ギア画像（`gear.rs` が書く）の置き場の親（`app_data_dir()/data`）。
    data_dir: PathBuf,
    /// バトルアイコン（`images.rs` が書く）のキャッシュルート（`app_data_dir()/images`）。
    /// `data_dir` とは別系統。`/img/images/...` の kind で振り分ける（`resolve_image_path`）。
    images_root: PathBuf,
    app: AppHandle,
    /// 更新命令のジョブ状態（サーバー稼働中のみ保持。停止で捨てる）。
    job: Arc<Mutex<UpdateStatus>>,
}

/// バトルアイコンの kind（`images.rs` の kind と一致させる）。`app_data_dir()/images/<kind>/` に置かれる。
/// ギア系（gear / brand / skill）は `app_data_dir()/data/images/` 側で、名前が重ならない。
const BATTLE_ICON_KINDS: [&str; 5] = ["weapon", "sub_weapon", "special_weapon", "stage", "ability"];

/// バイト列の sha256 hex（画像の ETag）。
fn hash_bytes(bytes: &[u8]) -> String {
    let mut hasher = Sha256::new();
    hasher.update(bytes);
    format!("{:x}", hasher.finalize())
}

/// `If-None-Match` ヘッダ値と ETag の一致判定（純粋関数・テスト対象）。
///
/// tiny_http は生ヘッダを渡すため、クォート有無の両方を許容する（`"abc"` / `abc`）。
/// `*` は「何かあれば 304」の意味なので一致扱い。複数値（カンマ区切り）にも対応する。
fn etag_matches(if_none_match: Option<&str>, etag: &str) -> bool {
    let Some(header) = if_none_match else {
        return false;
    };
    header.split(',').any(|candidate| {
        let c = candidate.trim();
        let c = c.strip_prefix("W/").unwrap_or(c);
        let c = c.trim_matches('"');
        c == "*" || c == etag
    })
}

/// コンパニオンサーバーの状態。デフォルト停止（オプトイン）。
#[derive(Default)]
pub struct CompanionState(Mutex<Option<RunningServer>>);

/// `companion_start` の戻り値（設定画面の QR・URL に使う）。
#[derive(Debug, Serialize)]
pub struct CompanionInfo {
    /// LAN 側ホスト IP（IPv4・非ループバック）。先頭を QR に、残りを「ほかの URL」に出す。
    pub host_ips: Vec<String>,
    pub port: u16,
    pub token: String,
}

/// `companion_status` の戻り値。
#[derive(Debug, Serialize)]
pub struct CompanionStatus {
    pub running: bool,
    pub port: Option<u16>,
    /// 保存済みのポート（止まっているときも設定画面に出す・#787）。
    pub configured_port: u16,
}

// ---------------------------------------------------------------------------
// 更新命令（スマホの更新ボタン・`mobile/pcUpdate.ts`）
// ---------------------------------------------------------------------------

/// 更新ジョブの状態。スマホは `state` で分岐する。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum UpdateState {
    /// 一度も命令を受けていない（サーバー起動直後）。
    Idle,
    /// 実行中（`step` に現在フェーズ）。
    Running,
    /// 正常終了（`result` に件数）。
    Done,
    /// 失敗（`error_code` / `error_message`）。
    Failed,
}

/// 更新ジョブのフェーズ（進捗表示用）。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum UpdateStep {
    /// SplatNet3 からバトル再フェッチ中。
    Battles,
    /// SplatNet3 からギア再フェッチ中（gear_db.bin / .gti 再生成を含む）。
    Gear,
}

/// 更新ジョブの対象（#395）。`POST /update` のボディ `{"target": ...}` で指定する。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum UpdateTarget {
    /// バトルのみ。
    Battle,
    /// ギアのみ（gear_db.bin / .gti 再生成）。
    Gear,
    /// 両方。**省略時・不正値のフォールバック**。スマホの更新ボタンはこれを送る。
    Both,
}

impl UpdateTarget {
    fn includes_battle(self) -> bool {
        matches!(self, Self::Battle | Self::Both)
    }

    fn includes_gear(self) -> bool {
        matches!(self, Self::Gear | Self::Both)
    }

    /// ログ用の短い表記。
    fn label(self) -> &'static str {
        match self {
            Self::Battle => "battle",
            Self::Gear => "gear",
            Self::Both => "both",
        }
    }
}

/// 更新ジョブの結果件数。
///
/// **各件数は `Option`**（#395）。対象から外れて実行しなかったフェーズは `None`（JSON では null）に
/// なる。`0` で埋めると「取りに行ったが 0 件だった」と区別できないため、実行しなかったことを型で表す。
#[derive(Debug, Clone, Copy, Default, Serialize)]
pub struct UpdateResult {
    /// 新規に取り込んだバトル数。
    pub battles: Option<usize>,
    /// 詳細を補完したバトル数。
    pub details: Option<usize>,
    /// gear_db.bin に載ったギア数（頭 + 服 + 靴）。
    pub gear: Option<usize>,
}

/// `POST /update` / `GET /update_status` が返す状態。
#[derive(Debug, Clone, Serialize)]
pub struct UpdateStatus {
    pub state: UpdateState,
    /// `state == running` のときの現在フェーズ。それ以外は null。
    pub step: Option<UpdateStep>,
    /// 受付時刻（UNIX 秒）。
    pub started_at: Option<i64>,
    /// 完了・失敗時刻（UNIX 秒）。
    pub finished_at: Option<i64>,
    /// `state == failed` のときのみ。
    pub error_code: Option<&'static str>,
    /// 人間可読の失敗理由（そのまま表示せずログ向け）。
    pub error_message: Option<String>,
    /// `state == done` のときのみ。
    pub result: Option<UpdateResult>,
}

impl Default for UpdateStatus {
    fn default() -> Self {
        Self {
            state: UpdateState::Idle,
            step: None,
            started_at: None,
            finished_at: None,
            error_code: None,
            error_message: None,
            result: None,
        }
    }
}

impl UpdateStatus {
    fn running(started_at: i64, target: UpdateTarget) -> Self {
        Self {
            state: UpdateState::Running,
            // 最初のフェーズは対象で決まる。ギア単独のときに `battles` を出すと、
            // 「取りに行かないバトル」を待っているように見えてしまう（#395）。
            step: Some(if target.includes_battle() {
                UpdateStep::Battles
            } else {
                UpdateStep::Gear
            }),
            started_at: Some(started_at),
            ..Self::default()
        }
    }

    fn failed(code: &'static str, message: impl Into<String>, started_at: Option<i64>) -> Self {
        Self {
            state: UpdateState::Failed,
            step: None,
            started_at,
            finished_at: Some(now_unix()),
            error_code: Some(code),
            error_message: Some(message.into()),
            result: None,
        }
    }
}

fn now_unix() -> i64 {
    chrono::Utc::now().timestamp()
}

/// エラーメッセージを error_code に写像する（ログと、スマホが失敗の種類を見分けるため）。
///
/// 既存コードのエラーは `NOT_LOGGED_IN:` / `FETCH_IN_PROGRESS:` プリフィクス方針
/// （lib.rs `run_fetch_full` / gear.rs `fetch_gear_full`）に従うため、それを尊重する。
/// サイドカー由来の失敗は `nxapi::FailureKind` が付ける `UPSTREAM_UNAVAILABLE:` /
/// `AUTH_EXPIRED:` / `NETWORK:` プリフィクスを見る（#399）。
///
/// **「bullet token が取れなかった」という事実だけで TOKEN_EXPIRED にしない。**
/// znca-api が 500 を返しただけでも再ログインを促してしまい、ユーザーは直らない操作を
/// 繰り返すことになる（#399 の症状）。理由が分からないものは `FETCH_FAILED` に倒す。
///
/// 対応する error_code:
/// - `UPSTREAM_UNAVAILABLE` … 外部サービスの一時障害。
/// - `AUTH_EXPIRED` → `TOKEN_EXPIRED`。
/// - `NETWORK` → `FETCH_FAILED`（「デスクトップが取得に失敗した・再試行して」で扱いは同じ）。
/// - `CORAL_UPGRADE` … 任天堂が NSO の版を上げ、認証側がまだ追いついていない（#765）。
///   再ログインも再試行も直らない。
fn classify_error(message: &str) -> &'static str {
    if message.starts_with("NOT_LOGGED_IN") {
        "NOT_LOGGED_IN"
    } else if message.starts_with("FETCH_IN_PROGRESS") {
        "FETCH_IN_PROGRESS"
    } else if message.starts_with("UPSTREAM_UNAVAILABLE") {
        "UPSTREAM_UNAVAILABLE"
    } else if message.starts_with("AUTH_EXPIRED") {
        "TOKEN_EXPIRED"
    } else if message.starts_with("CORAL_UPGRADE") {
        "CORAL_UPGRADE"
    } else if message.starts_with("NETWORK") {
        "FETCH_FAILED"
    } else if message.contains("invalid_grant") {
        // プリフィクスの付かない経路（Rust 側の認証コード等）から来た失効。
        "TOKEN_EXPIRED"
    } else {
        "FETCH_FAILED"
    }
}

/// デスクトップ側のバトル取得（手動 / 起動時 / スケジューラー）が進行中か。
///
/// 既存の `FetchInProgress` をそのまま参照する（新しい並走フラグを作らない）。
fn desktop_fetch_in_progress(app: &AppHandle) -> bool {
    app.try_state::<crate::FetchInProgress>()
        .map(|f| f.0.load(Ordering::SeqCst))
        .unwrap_or(false)
}

/// 現在の状態から新規ジョブを開始してよいかを判定し、可なら `running` に遷移させる。
///
/// 実行中（`Running`）なら遷移せず false。`Idle` / `Done` / `Failed` からは再実行できる。
/// HTTP/Tauri に依存しない純粋関数として切り出し、多重起動防止をユニットテストする。
///
/// **対象が違っても実行中なら弾く**（#395）。バトルとギアで並走させると任天堂 API を同時に叩き、
/// `FetchInProgress` とも噛み合わなくなる。粒度を分ける狙いは「要らない側を取りに行かせない」ことで
/// あって「同時に走らせる」ことではない。
fn try_begin(status: &mut UpdateStatus, started_at: i64, target: UpdateTarget) -> bool {
    if status.state == UpdateState::Running {
        return false;
    }
    *status = UpdateStatus::running(started_at, target);
    true
}

/// `POST /update` のリクエストボディ（#395）。未知フィールドは無視する。
#[derive(Debug, Deserialize)]
struct UpdateCommandBody {
    #[serde(default)]
    target: Option<String>,
}

/// リクエストボディから更新対象を読み取る（#395）。
///
/// **ボディが空・JSON でない・`target` が無い・知らない値、いずれも `Both` に倒す。**
/// 400 を返さないのは、「遅いが正しい」両方取得に落ちるほうが安全だから（#395）。
fn parse_update_target(body: &str) -> UpdateTarget {
    let target = serde_json::from_str::<UpdateCommandBody>(body)
        .ok()
        .and_then(|b| b.target);
    match target.as_deref() {
        Some("battle") => UpdateTarget::Battle,
        Some("gear") => UpdateTarget::Gear,
        Some("both") | None => UpdateTarget::Both,
        Some(other) => {
            log::warn!("[companion] 未知の更新対象 \"{other}\" → both として扱う");
            UpdateTarget::Both
        }
    }
}

/// 更新ジョブ本体: SplatNet3 からバトル・ギアを取り直す。
///
/// スマホからは触れないデスクトップ側の既存経路をそのまま呼ぶ:
/// - バトル: `crate::run_fetch_full`（`FetchInProgress` による多重起動防止つき）
/// - ギア  : `crate::gear::fetch_gear_full`（gear_db.bin / .gti を再生成）
///
/// `target` で対象を絞る（#395）。
async fn run_update_job(
    app: &AppHandle,
    job: &Arc<Mutex<UpdateStatus>>,
    target: UpdateTarget,
) -> Result<UpdateResult, String> {
    let set_step = |step: UpdateStep| {
        if let Ok(mut s) = job.lock() {
            s.step = Some(step);
        }
    };

    // 実行しなかったフェーズは None のまま残す（Default = 全 None）。
    let mut result = UpdateResult::default();

    if target.includes_battle() {
        // --- バトル再フェッチ ---
        set_step(UpdateStep::Battles);
        let (battles, details, _uploaded) = {
            let pool = app.try_state::<crate::db::DbPool>().ok_or_else(|| {
                "DB がまだ初期化されていません。少し待って再試行してください。".to_string()
            })?;
            crate::run_fetch_full(app, &pool).await?
        };
        result.battles = Some(battles);
        result.details = Some(details);
    }

    if target.includes_gear() {
        // --- ギア再フェッチ（gear_db.bin / .gti 再生成まで含む） ---
        set_step(UpdateStep::Gear);
        let gear = crate::gear::fetch_gear_full(app.clone()).await?;
        result.gear = Some(gear.head + gear.clothing + gear.shoes);
    }

    Ok(result)
}

/// ログ表示用に件数を整形する。実行しなかったフェーズ（`None`）は `-`。
fn fmt_count(count: Option<usize>) -> String {
    count.map_or_else(|| "-".to_string(), |n| n.to_string())
}

/// `POST /update` を捌く。受付判定のみ同期で行い、実処理は裏で走らせて即応答する。
///
/// - 202: 受付（`state = running`）
/// - 409: 実行中 / 未ログイン / デスクトップ側取得と衝突（本文の `error_code` で分岐）
///
/// ボディで対象を指定できる（#395）。`{"target":"battle"|"gear"|"both"}`・省略時は `both`。
fn handle_update_command(mut request: tiny_http::Request, ctx: &ServerCtx) {
    // ボディは受付判定より先に読み切る（読まずに respond すると次のリクエストとずれる）。
    // 読めなかった場合もエラーにせず both に倒す（`parse_update_target` の方針と揃える）。
    let mut body = String::new();
    if let Err(e) = request.as_reader().read_to_string(&mut body) {
        log::warn!("[companion] 更新命令のボディ読み取り失敗（both として扱う）: {e}");
        body.clear();
    }
    let target = parse_update_target(&body);

    // 未ログインなら任天堂 API を一切叩かずに返す（スマホは「PC でログインして」を出す）。
    if !crate::auth::is_logged_in(&ctx.app) {
        let loc = crate::locale::app_locale(&ctx.app);
        let status = UpdateStatus::failed(
            "NOT_LOGGED_IN",
            loc.companion_not_logged_in(),
            None,
        );
        if let Ok(mut s) = ctx.job.lock() {
            *s = status.clone();
        }
        respond_json(request, 409, &status);
        return;
    }

    // デスクトップ側で取得が走っているなら並走させない（既存 FetchInProgress を尊重）。
    if desktop_fetch_in_progress(&ctx.app) {
        let loc = crate::locale::app_locale(&ctx.app);
        let status = UpdateStatus::failed(
            "FETCH_IN_PROGRESS",
            loc.companion_fetch_in_progress(),
            None,
        );
        respond_json(request, 409, &status);
        return;
    }

    let started_at = now_unix();
    let accepted = {
        let mut guard = match ctx.job.lock() {
            Ok(g) => g,
            Err(e) => {
                let status = UpdateStatus::failed("FETCH_FAILED", format!("状態ロック失敗: {e}"), None);
                respond_json(request, 500, &status);
                return;
            }
        };
        let ok = try_begin(&mut guard, started_at, target);
        let snapshot = guard.clone();
        (ok, snapshot)
    };

    match accepted {
        (false, snapshot) => {
            // 既に更新ジョブ実行中: 新たに走らせず「進行中」を返す。
            respond_json(request, 409, &snapshot);
        }
        (true, snapshot) => {
            respond_json(request, 202, &snapshot);
            log::info!("[companion] 更新命令を受付。再フェッチ開始 target={}", target.label());
            let app = ctx.app.clone();
            let job = Arc::clone(&ctx.job);
            tauri::async_runtime::spawn(async move {
                let outcome = run_update_job(&app, &job, target).await;
                if let Ok(mut s) = job.lock() {
                    match outcome {
                        Ok(result) => {
                            log::info!(
                                "[companion] 更新命令 完了 target={} バトル+{} 詳細+{} ギア{}",
                                target.label(),
                                fmt_count(result.battles),
                                fmt_count(result.details),
                                fmt_count(result.gear)
                            );
                            s.state = UpdateState::Done;
                            s.step = None;
                            s.finished_at = Some(now_unix());
                            s.result = Some(result);
                        }
                        Err(e) => {
                            let code = classify_error(&e);
                            log::error!(
                                "[companion] 更新命令 失敗 target={} [{code}]: {e}",
                                target.label()
                            );
                            let started_at = s.started_at;
                            *s = UpdateStatus::failed(code, e, started_at);
                        }
                    }
                }
            });
        }
    }
}

/// ランダムな共有トークン（16 バイト → 32 hex 文字）を生成する。
fn generate_token() -> String {
    use rand::Rng;
    let mut rng = rand::thread_rng();
    (0..32)
        .map(|_| std::char::from_digit(rng.gen_range(0..16), 16).unwrap())
        .collect()
}

/// 仮想 NIC（WSL / Hyper-V / Docker / VirtualBox / VMware 等）らしいインターフェース名か。
///
/// **除外の判定には使わない。並べ替え（優先度を下げる）だけに使う。**
/// 名前は OS 依存で当てにならない（ユーザーがアダプタ名を変更できる／ローカライズされる）ため、
/// これで弾くと本命を消してしまう恐れがある。誤検出しても「順番が後ろになるだけ」で済む用途に限る。
fn looks_virtual_iface(name: &str) -> bool {
    let n = name.to_ascii_lowercase();
    [
        "vethernet", // Windows: vEthernet (WSL (Hyper-V firewall)) / vEthernet (Default Switch)
        "wsl",
        "hyper-v",
        "docker",
        "virtualbox",
        "vmware",
        "vmnet",
        "vboxnet",
        "tailscale",
        "zerotier",
        "utun",
        "tun",
        "tap",
    ]
    .iter()
    .any(|kw| n.contains(kw))
}

/// 設定画面の QR・URL に載せる IPv4 候補を絞り込み・並べ替える純ロジック（#369）。
///
/// 入力は `(インターフェース名, IPv4)` の列（`if_addrs` が返した順）。
///
/// ## 除外するもの（APIPA のみ）
/// - **リンクローカル 169.254.0.0/16（APIPA）**。DHCP に失敗した／未接続のアダプタが付ける
///   アドレスで、原理的に LAN の別端末からは到達できない。載せる意味が無い。
///
/// **除外はこれだけ**。「仮想 NIC らしい」「レンジが怪しい」は一切除外しない。誤除外は
/// 「繋がらない」に直結するのに対し、余分な候補は「ほかの URL」として並ぶだけだからである。
///
/// ## 並べ替え（安定ソート・同点は `if_addrs` の順を保つ）
/// 0. 家庭用 LAN で最も一般的な 192.168.0.0/16 / 10.0.0.0/8 で、仮想 NIC 名でないもの
/// 1. 上記以外（グローバル IP 等）で仮想 NIC 名でないもの
/// 2. 172.16.0.0/12 で仮想 NIC 名でないもの
/// 3. 仮想 NIC らしい名前のインターフェース（レンジを問わず最後）
///
/// ### 172.16.0.0/12 を「除外」しない理由
/// WSL / Hyper-V の仮想スイッチはこのレンジを使うが、**172.16-31.x.x は正当なプライベート
/// アドレスでもあり、実際にこのレンジを使う LAN が存在する**。レンジだけで弾くとその環境では
/// 本命が消えて一切ペアリングできなくなる。よってここでは**順位を下げるだけ**にとどめ、
/// 候補としては必ず残す。仮想スイッチであれば実際にはインターフェース名でも後ろへ回るため、
/// 名前判定が効く環境では二重に沈む。
pub(crate) fn filter_host_ipv4s(candidates: Vec<(String, Ipv4Addr)>) -> Vec<IpAddr> {
    let mut kept: Vec<(u8, Ipv4Addr)> = candidates
        .into_iter()
        // 除外は APIPA だけ。
        .filter(|(_, ip)| !ip.is_link_local())
        .map(|(name, ip)| {
            let rank = if looks_virtual_iface(&name) {
                3
            } else if is_common_lan(&ip) {
                0
            } else if is_shared_private_172(&ip) {
                2
            } else {
                1
            };
            (rank, ip)
        })
        .collect();
    // sort_by_key は安定ソートなので、同ランク内の並びは if_addrs の列挙順のまま。
    kept.sort_by_key(|(rank, _)| *rank);
    kept.into_iter().map(|(_, ip)| IpAddr::V4(ip)).collect()
}

/// 家庭用 LAN で最も一般的なレンジ（192.168.0.0/16 / 10.0.0.0/8）か。
fn is_common_lan(ip: &Ipv4Addr) -> bool {
    let o = ip.octets();
    (o[0] == 192 && o[1] == 168) || o[0] == 10
}

/// 172.16.0.0/12（正当なプライベートでもあり、仮想スイッチも好んで使うレンジ）か。
fn is_shared_private_172(ip: &Ipv4Addr) -> bool {
    let o = ip.octets();
    o[0] == 172 && (16..=31).contains(&o[1])
}

/// LAN 側の IPv4・非ループバックアドレスを列挙する（APIPA 除外・到達しやすい順／#369）。
fn host_ipv4s() -> Vec<IpAddr> {
    match if_addrs::get_if_addrs() {
        Ok(ifaces) => {
            let candidates = ifaces
                .into_iter()
                .filter(|i| !i.is_loopback())
                .filter_map(|i| match i.ip() {
                    IpAddr::V4(v4) => Some((i.name, v4)),
                    IpAddr::V6(_) => None,
                })
                .collect();
            filter_host_ipv4s(candidates)
        }
        Err(e) => {
            log::warn!("[companion] ホスト IP 列挙に失敗: {e}");
            Vec::new()
        }
    }
}

/// 接続トラブルの自己診断（#363）。「スマホで見る」がオンなのにスマホから到達できない
/// 典型要因を、フロントが具体的に案内するための材料を返す。**判定のみ**で、ファイアウォール
/// 規則の変更は一切しない（管理者権限が要る／ユーザーのセキュリティ設定を勝手に変えない）。
#[derive(Debug, Serialize)]
pub struct CompanionDiagnostics {
    /// 実行 OS（`std::env::consts::OS`）。`network_category` を判定できるのは "windows" のときだけ。
    pub os: String,
    /// ネットワークプロファイル種別（Windows のみ判定）:
    /// "public"（受信ブロックの主因）/ "private" / "domain" / "unknown"、非 Windows は "unsupported"。
    pub network_category: String,
    /// LAN 側 IPv4 が 1 つでも見えているか（false なら Wi-Fi 未接続などで到達以前の問題）。
    pub has_lan_ip: bool,
    /// 今のネットワークのプロファイル（`network_category`）で、Windows ファイアウォールが
    /// splabo への受信を許可しているか（#370）。判定できないとき（Windows 以外・プロファイル不明・
    /// COM の失敗）は `None` で、断定しない。
    pub inbound_allowed: Option<bool>,
}

/// 現在のネットワークプロファイル種別を返す（#363）。
///
/// Windows は Network List Manager（COM・`INetworkListManager`）で接続中ネットワークの
/// カテゴリを問い合わせる。Public が 1 つでもあれば受信ブロックの主因なので "public" を優先で返す。
/// PowerShell 等の外部プロセスは起動しない。Windows 以外は判定手段が無いため "unsupported"。
///
/// 返す値: "public" / "private" / "domain" / "unknown" / "unsupported"。
#[cfg(target_os = "windows")]
fn detect_network_category() -> String {
    use windows::Win32::Networking::NetworkListManager::{
        INetwork, INetworkListManager, NetworkListManager, NLM_ENUM_NETWORK_CONNECTED,
        NLM_NETWORK_CATEGORY_DOMAIN_AUTHENTICATED, NLM_NETWORK_CATEGORY_PRIVATE,
        NLM_NETWORK_CATEGORY_PUBLIC,
    };
    use windows::Win32::System::Com::{
        CoCreateInstance, CoInitializeEx, CLSCTX_ALL, COINIT_APARTMENTTHREADED,
    };

    unsafe {
        // 既に別モードで初期化済みでも致命ではない（RPC_E_CHANGED_MODE 等は無視）。
        let _ = CoInitializeEx(None, COINIT_APARTMENTTHREADED);

        let manager: INetworkListManager =
            match CoCreateInstance(&NetworkListManager, None, CLSCTX_ALL) {
                Ok(m) => m,
                Err(e) => {
                    log::warn!("[companion] NetworkListManager 生成失敗: {e}");
                    return "unknown".to_string();
                }
            };

        let networks = match manager.GetNetworks(NLM_ENUM_NETWORK_CONNECTED) {
            Ok(n) => n,
            Err(e) => {
                log::warn!("[companion] 接続中ネットワークの列挙失敗: {e}");
                return "unknown".to_string();
            }
        };

        // Public を最優先で返す（到達不能の主因）。Private / Domain は fallback。
        let mut fallback: Option<&str> = None;
        loop {
            let mut item: [Option<INetwork>; 1] = [None];
            let mut fetched = 0u32;
            if networks.Next(&mut item, Some(&mut fetched)).is_err() || fetched == 0 {
                break;
            }
            let Some(network) = item[0].take() else { break };
            let cat = match network.GetCategory() {
                Ok(c) => c,
                Err(_) => continue,
            };
            if cat == NLM_NETWORK_CATEGORY_PUBLIC {
                return "public".to_string();
            } else if cat == NLM_NETWORK_CATEGORY_PRIVATE {
                fallback = Some("private");
            } else if cat == NLM_NETWORK_CATEGORY_DOMAIN_AUTHENTICATED {
                fallback = fallback.or(Some("domain"));
            }
        }
        fallback.unwrap_or("unknown").to_string()
    }
}

#[cfg(not(target_os = "windows"))]
fn detect_network_category() -> String {
    "unsupported".to_string()
}

/// 今のネットワークのプロファイルで、Windows ファイアウォールが splabo への受信を許可しているか（#370）。
///
/// 以前パブリックの状態で許可ダイアログに答えると、パブリック用の許可規則だけができる。
/// そのあとプライベートに変えると、プライベート用の規則が無いので受信は止まったままになる。
/// `network_category` は "private" なので、パブリックの警告も出ない。これを見つけるために、
/// ファイアウォールの規則（`INetFwPolicy2`・読むだけなら管理者権限は要らない）を読む。
///
/// - 対象のプロファイルは `network_category`（NLM）から決める。ファイアウォールの
///   `CurrentProfileTypes` は WSL・Hyper-V の仮想アダプタでパブリックも立つので使わない
/// - 規則は実行ファイルのパスで探す（許可ダイアログはそのとき動いている exe に規則を作る）
/// - 規則の追加・変更はしない（検出と案内だけ・#363 の方針）
#[cfg(target_os = "windows")]
fn detect_inbound_allowed(category: &str) -> Option<bool> {
    let exe = std::env::current_exe().ok()?.to_string_lossy().to_string();
    inbound_allowed_for_exe(category, &exe)
}

/// `detect_inbound_allowed` の本体。`exe` に対する規則を見る。
#[cfg(target_os = "windows")]
fn inbound_allowed_for_exe(category: &str, exe: &str) -> Option<bool> {
    use windows::core::Interface;
    use windows::Win32::NetworkManagement::WindowsFirewall::{
        INetFwPolicy2, INetFwRule, NetFwPolicy2, NET_FW_ACTION_ALLOW, NET_FW_PROFILE_TYPE2,
        NET_FW_RULE_DIR_IN,
    };
    use windows::Win32::System::Com::{
        CoCreateInstance, CoInitializeEx, CLSCTX_ALL, COINIT_APARTMENTTHREADED,
    };
    use windows::Win32::System::Ole::IEnumVARIANT;
    use windows::Win32::System::Variant::{VariantClear, VARIANT, VT_DISPATCH};

    let bit = profile_bit(category)?;

    unsafe {
        // 既に別モードで初期化済みでも致命ではない（detect_network_category と同じ）。
        let _ = CoInitializeEx(None, COINIT_APARTMENTTHREADED);

        let policy: INetFwPolicy2 = match CoCreateInstance(&NetFwPolicy2, None, CLSCTX_ALL) {
            Ok(p) => p,
            Err(e) => {
                log::warn!("[companion] NetFwPolicy2 生成失敗: {e}");
                return None;
            }
        };
        // このプロファイルでファイアウォールが切れていれば、規則が無くても通る
        if !bool::from(policy.get_FirewallEnabled(NET_FW_PROFILE_TYPE2(bit)).ok()?) {
            return Some(true);
        }

        let rules: IEnumVARIANT = match policy.Rules().and_then(|r| r._NewEnum()).and_then(|u| u.cast()) {
            Ok(e) => e,
            Err(e) => {
                log::warn!("[companion] ファイアウォール規則の列挙失敗: {e}");
                return None;
            }
        };
        let mut mine = Vec::new();
        loop {
            let mut item = [VARIANT::default()];
            let mut fetched = 0u32;
            if rules.Next(&mut item, &mut fetched).is_err() || fetched == 0 {
                break;
            }
            let inner = &item[0].Anonymous.Anonymous;
            let rule = if inner.vt == VT_DISPATCH {
                inner.Anonymous.pdispVal.as_ref().and_then(|d| d.cast::<INetFwRule>().ok())
            } else {
                None
            };
            let _ = VariantClear(&mut item[0]);
            let Some(rule) = rule else { continue };

            // 規則は数百あるので、先に exe で絞ってから残りを読む
            let app = rule.ApplicationName().map(|s| s.to_string()).unwrap_or_default();
            if !same_exe(&app, exe) {
                continue;
            }
            mine.push(FwRule {
                inbound: rule.Direction().is_ok_and(|d| d == NET_FW_RULE_DIR_IN),
                enabled: rule.Enabled().is_ok_and(bool::from),
                allow: rule.Action().is_ok_and(|a| a == NET_FW_ACTION_ALLOW),
                profiles: rule.Profiles().unwrap_or(0),
            });
        }
        Some(inbound_allowed(&mine, bit))
    }
}

#[cfg(not(target_os = "windows"))]
fn detect_inbound_allowed(_category: &str) -> Option<bool> {
    None
}

/// splabo の実行ファイルに対するファイアウォール規則のうち、判定に使う項目。
#[cfg(any(target_os = "windows", test))]
struct FwRule {
    inbound: bool,
    enabled: bool,
    allow: bool,
    /// 効くプロファイルのビット（ドメイン 1・プライベート 2・パブリック 4・すべて 0x7FFFFFFF）
    profiles: i32,
}

/// `network_category` をファイアウォールのプロファイルのビットにする。分からなければ `None`。
#[cfg(any(target_os = "windows", test))]
fn profile_bit(category: &str) -> Option<i32> {
    match category {
        "domain" => Some(1),
        "private" => Some(2),
        "public" => Some(4),
        _ => None,
    }
}

/// 規則のプログラムのパスが、この exe を指しているか。大文字小文字は区別しない。
/// 規則のパスに環境変数（`%ProgramFiles%` など）が入っていれば展開してから比べる。
#[cfg(any(target_os = "windows", test))]
fn same_exe(rule_app: &str, exe: &str) -> bool {
    let normalize = |s: &str| expand_env_vars(s.trim_start_matches(r"\\?\")).to_lowercase();
    !rule_app.is_empty() && normalize(rule_app) == normalize(exe)
}

/// `%NAME%` を環境変数の値に置き換える。値が無ければそのまま残す。
#[cfg(any(target_os = "windows", test))]
fn expand_env_vars(s: &str) -> String {
    let mut out = String::new();
    let mut rest = s;
    while let Some(start) = rest.find('%') {
        let Some(len) = rest[start + 1..].find('%') else { break };
        let name = &rest[start + 1..start + 1 + len];
        out.push_str(&rest[..start]);
        match std::env::var(name) {
            Ok(v) if !name.is_empty() => out.push_str(&v),
            _ => out.push_str(&rest[start..start + len + 2]),
        }
        rest = &rest[start + len + 2..];
    }
    out.push_str(rest);
    out
}

/// splabo の規則（exe で絞り込み済み）から、プロファイル `bit` で受信が通るかを決める。
/// 有効な受信のブロック規則が 1 つでもあれば通らない（Windows ではブロックが許可より強い）。
#[cfg(any(target_os = "windows", test))]
fn inbound_allowed(rules: &[FwRule], bit: i32) -> bool {
    let applicable = || rules.iter().filter(|r| r.inbound && r.enabled && r.profiles & bit != 0);
    !applicable().any(|r| !r.allow) && applicable().any(|r| r.allow)
}

/// JSON を指定ステータスコードで返す。
fn respond_json<T: Serialize>(request: tiny_http::Request, status: u16, body: &T) {
    let json = serde_json::to_string(body).unwrap_or_else(|e| {
        format!(r#"{{"state":"failed","error_code":"FETCH_FAILED","error_message":"JSON 生成失敗: {e}"}}"#)
    });
    let header = tiny_http::Header::from_bytes(&b"Content-Type"[..], &b"application/json"[..]).unwrap();
    let response = tiny_http::Response::from_string(json)
        .with_header(header)
        .with_status_code(status);
    let _ = request.respond(response);
}

// ---------------------------------------------------------------------------
// スマホ Web 版（#786・設計 #784 §3〜§5・§7）
// ---------------------------------------------------------------------------

/// リクエスト本文の上限（保存コーデの JSON 程度しか来ない）。
const WEB_BODY_LIMIT: u64 = 1 << 20;

/// スマホ Web 版の経路か（`/api/...` と `/img/...`）。
fn is_web_path(path: &str) -> bool {
    path.starts_with("/api/") || path.starts_with("/img/")
}

/// 更新命令の経路か。これ以外で Web の経路でも静的ファイルでもないものは 404。
fn is_update_path(path: &str) -> bool {
    matches!(path, "/update" | "/update_status")
}

/// スマホ画面の静的ファイル名（#788）。対象外は None。
///
/// - `/m`・`/m/` → `mobile.html`
/// - `/assets/<ファイル名>`（Vite の出力。1 階層・英数と `._-` だけ）
/// - マニフェストとアイコン（`app/public` のもの）
fn static_asset_name(path: &str) -> Option<String> {
    match path {
        "/m" | "/m/" | "/m/index.html" => return Some("mobile.html".to_string()),
        "/mobile.webmanifest" | "/splabo-logo.png" | "/splabo-favicon.png" | "/splabo-favicon-16.png" | "/splabo-favicon-32.png" => {
            return Some(path[1..].to_string())
        }
        _ => {}
    }
    let file = path.strip_prefix("/assets/")?;
    let ok = !file.is_empty()
        && !file.starts_with('.')
        && file.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-'));
    ok.then(|| format!("assets/{file}"))
}

/// アプリに同梱のフロント（`dist/`）からファイルを返す（#788）。
///
/// リリースでは埋め込み資産、`tauri dev` では `frontendDist`（`app/dist`）を直接読む
/// （Tauri の `asset_resolver` がそうしている）。dev でスマホ画面を変えたら `npm run build -w app` が要る。
fn respond_static(request: tiny_http::Request, app: &AppHandle, name: &str) {
    let Some(asset) = app.asset_resolver().get(name.to_string()) else {
        let _ = request.respond(tiny_http::Response::from_string("not found").with_status_code(404));
        return;
    };
    let mime = if name.ends_with(".webmanifest") {
        "application/manifest+json".to_string()
    } else {
        asset.mime_type.clone()
    };
    // ファイル名にハッシュが入る assets/ は長くキャッシュしてよい。HTML などは毎回確かめる。
    let cache = if name.starts_with("assets/") { "public, max-age=31536000, immutable" } else { "no-cache" };
    let ctype = tiny_http::Header::from_bytes(&b"Content-Type"[..], mime.as_bytes()).unwrap();
    let cache = tiny_http::Header::from_bytes(&b"Cache-Control"[..], cache.as_bytes()).unwrap();
    let _ = request.respond(tiny_http::Response::from_data(asset.bytes).with_header(ctype).with_header(cache));
}

fn header_value(request: &tiny_http::Request, name: &'static str) -> Option<String> {
    request
        .headers()
        .iter()
        .find(|h| h.field.equiv(name))
        .map(|h| h.value.as_str().to_string())
}

/// スマホ Web 版の認証。Cookie（`POST /api/session` で受け取る）が合えば通す。
fn web_authorized(request: &tiny_http::Request, token: &str) -> bool {
    crate::web_api::session_matches(header_value(request, "Cookie").as_deref(), token)
}

fn read_body(request: &mut tiny_http::Request) -> Result<String, String> {
    use std::io::Read;
    let mut body = String::new();
    request
        .as_reader()
        .take(WEB_BODY_LIMIT)
        .read_to_string(&mut body)
        .map_err(|e| e.to_string())?;
    Ok(body)
}

fn respond_text(request: tiny_http::Request, status: u16, text: &str) {
    let _ = request.respond(tiny_http::Response::from_string(text).with_status_code(status));
}

/// スマホ Web 版の経路を捌く。コマンドの実行は `dispatch` に任せる（テストでは差し替える）。
///
/// - `POST /api/session`   … 本文 `{"token":"..."}` が合えば 204 と `Set-Cookie`。合わなければ 401
/// - `POST /api/cmd/<名前>` … 許可リストのコマンドを中継（本文は invoke と同じ camelCase の引数 JSON）
/// - `GET  /img/<相対パス>` … 画像を PNG に戻して返す
fn route_web(
    mut request: tiny_http::Request,
    method: &tiny_http::Method,
    path: &str,
    token: &str,
    data_dir: &std::path::Path,
    images_root: &std::path::Path,
    dispatch: &dyn Fn(&str, serde_json::Value) -> Result<serde_json::Value, crate::web_api::ApiError>,
) {
    if (method, path) == (&tiny_http::Method::Post, "/api/session") {
        let body = read_body(&mut request).unwrap_or_default();
        let ok = serde_json::from_str::<crate::web_api::SessionRequest>(&body)
            .map(|s| !token.is_empty() && s.token == token)
            .unwrap_or(false);
        if !ok {
            return respond_text(request, 401, "unauthorized");
        }
        let cookie = tiny_http::Header::from_bytes(
            &b"Set-Cookie"[..],
            crate::web_api::session_set_cookie(token).as_bytes(),
        )
        .unwrap();
        let _ = request.respond(tiny_http::Response::empty(204).with_header(cookie));
        return;
    }

    if !web_authorized(&request, token) {
        return respond_text(request, 401, "unauthorized");
    }

    match method {
        tiny_http::Method::Post if path.starts_with("/api/cmd/") => {
            let cmd = &path["/api/cmd/".len()..];
            let body = match read_body(&mut request) {
                Ok(b) => b,
                Err(e) => return respond_text(request, 400, &e),
            };
            let args = if body.trim().is_empty() {
                serde_json::Value::Null
            } else {
                match serde_json::from_str(&body) {
                    Ok(v) => v,
                    Err(e) => return respond_text(request, 400, &format!("引数が不正です: {e}")),
                }
            };
            match dispatch(cmd, args) {
                Ok(v) => respond_json(request, 200, &v),
                Err(e) => respond_text(request, e.status(), &e.body()),
            }
        }
        tiny_http::Method::Get if path.starts_with("/img/") => {
            respond_png(request, &path["/img".len()..], data_dir, images_root)
        }
        _ => respond_text(request, 404, "not found"),
    }
}

/// 画像（`.gti`）を PNG に戻して返す（#786）。`rel` は `/images/...`。
///
/// ETag は元ファイルの sha256。スマホのブラウザがキャッシュできるよう `Cache-Control` を付ける。
fn respond_png(
    request: tiny_http::Request,
    rel: &str,
    data_dir: &std::path::Path,
    images_root: &std::path::Path,
) {
    let Some(file) = resolve_image_path(rel, data_dir, images_root) else {
        return respond_text(request, 403, "forbidden");
    };
    let Ok(bytes) = std::fs::read(&file) else {
        return respond_text(request, 404, "not found");
    };
    let etag = hash_bytes(&bytes);
    if etag_matches(header_value(&request, "If-None-Match").as_deref(), &etag) {
        let _ = request.respond(tiny_http::Response::empty(304));
        return;
    }
    let png = if file.extension().and_then(|e| e.to_str()) == Some("gti") {
        crate::crypto::scramble_image(&bytes)
    } else {
        bytes
    };
    let ctype = tiny_http::Header::from_bytes(&b"Content-Type"[..], &b"image/png"[..]).unwrap();
    let cache =
        tiny_http::Header::from_bytes(&b"Cache-Control"[..], &b"private, max-age=86400"[..]).unwrap();
    let etag_header =
        tiny_http::Header::from_bytes(&b"ETag"[..], format!("\"{etag}\"").as_bytes()).unwrap();
    let _ = request.respond(
        tiny_http::Response::from_data(png)
            .with_header(ctype)
            .with_header(cache)
            .with_header(etag_header),
    );
}

/// `images/` 配下の相対パスを安全に解決する（パストラバーサル拒否）。
///
/// リクエストパス（先頭 `/` 込み）を受け取り、実ファイルパスを返す。
/// `images/` 始まりでない・`..` を含む・親を辿るものは `None`（＝配信拒否）。
///
/// 画像キャッシュは 2 系統に分かれているため、**先頭 kind セグメントで振り分ける**:
/// - バトルアイコン（`images.rs` が書く）: `images_root`（= `app_data_dir()/images`）
/// - ギア画像（`gear.rs` が書く）: `data_dir/images`（= `app_data_dir()/data/images`）
///
/// 両者はディレクトリ名が重複しない（weapon/stage… と gear/brand/skill）ので衝突しない。
fn resolve_image_path(
    req_path: &str,
    data_dir: &std::path::Path,
    images_root: &std::path::Path,
) -> Option<PathBuf> {
    let rel = req_path.trim_start_matches('/');
    // ギア・バトルの画像パスは必ず `images/` 始まり（`read_gear_db` などが返すもの）。それ以外は拒否。
    if !rel.starts_with("images/") {
        return None;
    }
    // `..` や絶対パス・ルート要素を一切許さない（通常要素のみ許可）。
    let mut safe = PathBuf::new();
    for comp in std::path::Path::new(rel).components() {
        match comp {
            std::path::Component::Normal(c) => safe.push(c),
            _ => return None,
        }
    }
    // `images/<kind>/...` の kind を見て、バトルアイコンなら images_root 側へ回す。
    let kind = safe.iter().nth(1).and_then(|c| c.to_str()).unwrap_or("");
    // #360 で `ability` が BATTLE_ICON_KINDS に入ったので、個別の特別扱いは不要になった。
    if BATTLE_ICON_KINDS.contains(&kind) {
        // images_root は既に `images` を含むので、先頭の `images` セグメントを外して join する。
        let stripped: PathBuf = safe.iter().skip(1).collect();
        return Some(images_root.join(stripped));
    }
    Some(data_dir.join(safe))
}

/// 1 リクエストを捌く。
///
/// - `/api/...`・`/img/...` は `route_web`（Cookie 認証）
/// - スマホ画面の静的ファイルは認証なしで返す
/// - 更新命令（`/update`・`/update_status`）は Cookie 認証のうえ、`ServerCtx`（`AppHandle` / ジョブ状態）で捌く
/// - それ以外は 404
fn handle_request(request: tiny_http::Request, ctx: &ServerCtx) {
    // クエリを除いたパス部分で分岐。
    let url = request.url().to_string();
    let path = url.split('?').next().unwrap_or("").to_string();
    let method = request.method().clone();

    if is_web_path(&path) {
        let app = ctx.app.clone();
        route_web(request, &method, &path, &ctx.token, &ctx.data_dir, &ctx.images_root, &|cmd, args| {
            crate::web_api::dispatch(&app, cmd, args)
        });
        return;
    }

    // スマホ画面の静的ファイル（#788）。中身はアプリに同梱のフロントだけなので認証しない
    // （認証は画面が開いたあと、QR のトークンを Cookie に交換してから）。
    if method == tiny_http::Method::Get {
        if let Some(name) = static_asset_name(&path) {
            respond_static(request, &ctx.app, &name);
            return;
        }
    }

    // 知らない経路は認証を求めず 404（unauthorized を返すと、つながっていないように見えて紛らわしい）。
    if !is_update_path(&path) {
        let _ = request.respond(tiny_http::Response::from_string("not found").with_status_code(404));
        return;
    }

    if !web_authorized(&request, &ctx.token) {
        let _ = request.respond(tiny_http::Response::from_string("unauthorized").with_status_code(401));
        return;
    }
    match (&method, path.as_str()) {
        // 更新命令の受付。受付可否を即返し、実処理は裏で走る。
        (tiny_http::Method::Post, "/update") => handle_update_command(request, ctx),
        // 更新命令の進捗・完了・失敗の問い合わせ（スマホはこれをポーリングする）。
        (tiny_http::Method::Get, "/update_status") => {
            let status = ctx
                .job
                .lock()
                .map(|s| s.clone())
                .unwrap_or_else(|e| UpdateStatus::failed("FETCH_FAILED", format!("状態ロック失敗: {e}"), None));
            respond_json(request, 200, &status);
        }
        _ => {
            let _ = request.respond(tiny_http::Response::from_string("not found").with_status_code(404));
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

// ---------------------------------------------------------------------------
// 設定（#787・設計 #784 §5・§6）
// ---------------------------------------------------------------------------

/// 既定のポート。スマホのショートカット（URL）が変わらないよう固定にする。
pub const DEFAULT_PORT: u16 = 47620;

const CONFIG_FILE: &str = "companion.json";

fn default_port() -> u16 {
    DEFAULT_PORT
}

/// `app_data_dir()/companion.json`。オン/オフ・ポート・トークンを保存する。
///
/// - トークンは起動ごとに変えず固定にする（スマホのショートカットを PC の再起動で壊さない）。
///   「再発行」で作り直すと、古いトークンも Cookie も無効になる。
/// - `enabled` が true なら、アプリ起動時にサーバーを立ち上げる（[`autostart`]）。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct CompanionConfig {
    #[serde(default)]
    pub enabled: bool,
    #[serde(default = "default_port")]
    pub port: u16,
    #[serde(default)]
    pub token: String,
}

impl Default for CompanionConfig {
    fn default() -> Self {
        Self { enabled: false, port: DEFAULT_PORT, token: String::new() }
    }
}

fn config_path(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(app
        .path()
        .app_data_dir()
        .map_err(|e| format!("アプリデータディレクトリ解決失敗: {e}"))?
        .join(CONFIG_FILE))
}

/// 設定を読む。無い・壊れているときは既定値（壊れていても起動は妨げない）。
fn load_config(path: &std::path::Path) -> CompanionConfig {
    std::fs::read(path)
        .ok()
        .and_then(|b| serde_json::from_slice(&b).ok())
        .unwrap_or_default()
}

fn save_config(path: &std::path::Path, cfg: &CompanionConfig) -> Result<(), String> {
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    }
    let json = serde_json::to_vec_pretty(cfg).map_err(|e| e.to_string())?;
    std::fs::write(path, json).map_err(|e| e.to_string())
}

/// トークンが無ければ作る。作ったら true（保存が要る）。
fn ensure_token(cfg: &mut CompanionConfig) -> bool {
    if cfg.token.is_empty() {
        cfg.token = generate_token();
        true
    } else {
        false
    }
}

/// 設定できるポートか（予約ポートは避ける）。
pub fn validate_port(port: u16) -> Result<(), String> {
    if port < 1024 {
        return Err(format!("ポートは 1024〜65535 の範囲で指定してください（{port}）"));
    }
    Ok(())
}

fn update_config(app: &AppHandle, f: impl FnOnce(&mut CompanionConfig)) -> Result<CompanionConfig, String> {
    let path = config_path(app)?;
    let mut cfg = load_config(&path);
    f(&mut cfg);
    save_config(&path, &cfg)?;
    Ok(cfg)
}

fn running_info(running: &RunningServer) -> CompanionInfo {
    CompanionInfo {
        host_ips: host_ipv4s().iter().map(|ip| ip.to_string()).collect(),
        port: running.port,
        token: running.token.clone(),
    }
}

/// サーバーを起動する（ロック取得済み）。稼働中なら現行の情報を返す。
fn start_locked(app: &AppHandle, guard: &mut Option<RunningServer>) -> Result<CompanionInfo, String> {
    if let Some(running) = guard.as_ref() {
        return Ok(running_info(running));
    }

    let path = config_path(app)?;
    let mut cfg = load_config(&path);
    if ensure_token(&mut cfg) {
        save_config(&path, &cfg)?;
    }
    let port = cfg.port;
    let token = cfg.token.clone();

    let data_dir = resolve_data_dir(app)?;
    // バトルアイコンのキャッシュルート（`app_data_dir()/images`・`images.rs` の置き場・data_dir とは別系統）。
    // 作成はしない（未キャッシュなら画像が 404 になるだけ）。
    let images_root = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("アプリデータディレクトリ解決失敗: {e}"))?
        .join("images");

    // 固定ポートで全インターフェースにバインド（LAN のスマホから到達可能に）。
    let server = tiny_http::Server::http(("0.0.0.0", port)).map_err(|e| {
        format!("ポート {port} で起動できませんでした。ほかのアプリが使っている可能性があります。設定でポートを変えてください（{e}）")
    })?;

    let stop = Arc::new(AtomicBool::new(false));

    // 配信スレッド: recv_timeout でポーリングし、stop フラグで抜ける。
    let server = Arc::new(server);
    let handle = {
        let server = Arc::clone(&server);
        let stop = Arc::clone(&stop);
        let ctx = ServerCtx {
            token: token.clone(),
            data_dir: data_dir.clone(),
            images_root: images_root.clone(),
            app: app.clone(),
            job: Arc::new(Mutex::new(UpdateStatus::default())),
        };
        std::thread::spawn(move || {
            log::info!("[companion] HTTP サーバー稼働 0.0.0.0:{port}");
            while !stop.load(Ordering::SeqCst) {
                match server.recv_timeout(Duration::from_millis(500)) {
                    Ok(Some(request)) => handle_request(request, &ctx),
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

    *guard = Some(RunningServer {
        port,
        token: token.clone(),
        stop,
        handle: Some(handle),
    });

    Ok(CompanionInfo {
        host_ips: ips.iter().map(|ip| ip.to_string()).collect(),
        port,
        token,
    })
}

/// サーバーを止める（ロック取得済み・HTTP スレッド join）。
fn stop_locked(guard: &mut Option<RunningServer>) {
    if let Some(mut running) = guard.take() {
        running.stop.store(true, Ordering::SeqCst);
        if let Some(handle) = running.handle.take() {
            let _ = handle.join();
        }
        log::info!("[companion] 停止完了");
    }
}

/// 稼働中なら止めて立ち上げ直す（トークン・ポートを変えたとき）。止まっていれば何もしない。
fn restart_if_running(app: &AppHandle, guard: &mut Option<RunningServer>) -> Result<(), String> {
    if guard.is_some() {
        stop_locked(guard);
        start_locked(app, guard)?;
    }
    Ok(())
}

/// アプリ起動時、前回オンのままだったらサーバーを立ち上げる（#787）。失敗してもアプリの起動は止めない。
pub fn autostart(app: &AppHandle) {
    let Ok(path) = config_path(app) else { return };
    if !load_config(&path).enabled {
        return;
    }
    let state = app.state::<CompanionState>();
    let Ok(mut guard) = state.0.lock() else { return };
    match start_locked(app, &mut guard) {
        Ok(info) => log::info!("[companion] 起動時に自動開始 port={}", info.port),
        Err(e) => log::warn!("[companion] 起動時の自動開始に失敗: {e}"),
    }
}

/// コンパニオンサーバーを起動する（設定の「スマホで見る」をオン）。
///
/// 保存済みのトークン・ポートで起動し、オンにしたことを保存する（次回のアプリ起動時も立ち上がる）。
/// 既に稼働中なら現行の情報をそのまま返す（多重起動しない）。
#[tauri::command]
pub fn companion_start(
    app: AppHandle,
    state: State<'_, CompanionState>,
) -> Result<CompanionInfo, String> {
    let mut guard = state.0.lock().map_err(|e| e.to_string())?;
    let info = start_locked(&app, &mut guard)?;
    update_config(&app, |c| c.enabled = true)?;
    Ok(info)
}

/// コンパニオンサーバーを停止する（設定の「スマホで見る」をオフ。次回のアプリ起動時も立ち上げない）。
#[tauri::command]
pub fn companion_stop(app: AppHandle, state: State<'_, CompanionState>) -> Result<(), String> {
    let mut guard = state.0.lock().map_err(|e| e.to_string())?;
    stop_locked(&mut guard);
    update_config(&app, |c| c.enabled = false)?;
    Ok(())
}

/// トークンを作り直す。古いトークンと、それで作った Cookie は使えなくなる（スマホは QR を読み直す）。
#[tauri::command]
pub fn companion_regenerate_token(
    app: AppHandle,
    state: State<'_, CompanionState>,
) -> Result<(), String> {
    let mut guard = state.0.lock().map_err(|e| e.to_string())?;
    update_config(&app, |c| c.token = generate_token())?;
    restart_if_running(&app, &mut guard)
}

/// ポートを変える。稼働中なら新しいポートで立ち上げ直す（失敗したら止まったままエラーを返す）。
#[tauri::command]
pub fn companion_set_port(
    app: AppHandle,
    state: State<'_, CompanionState>,
    port: u16,
) -> Result<(), String> {
    validate_port(port)?;
    let mut guard = state.0.lock().map_err(|e| e.to_string())?;
    update_config(&app, |c| c.port = port)?;
    restart_if_running(&app, &mut guard)
}

/// 稼働状態を返す。`configured_port` は止まっているときも設定画面に出すための保存済みポート。
#[tauri::command]
pub fn companion_status(app: AppHandle, state: State<'_, CompanionState>) -> Result<CompanionStatus, String> {
    let guard = state.0.lock().map_err(|e| e.to_string())?;
    let configured_port = config_path(&app).map(|p| load_config(&p).port).unwrap_or(DEFAULT_PORT);
    Ok(CompanionStatus {
        running: guard.is_some(),
        port: guard.as_ref().map(|r| r.port),
        configured_port,
    })
}

/// 接続トラブルの自己診断材料を返す（#363）。フロントはこれを見て、Windows の
/// ネットワークプロファイルが Public のとき「プライベートに変更してください」等を案内する。
#[tauri::command]
pub fn companion_diagnostics() -> CompanionDiagnostics {
    let network_category = detect_network_category();
    CompanionDiagnostics {
        os: std::env::consts::OS.to_string(),
        inbound_allowed: detect_inbound_allowed(&network_category),
        network_category,
        has_lan_ip: !host_ipv4s().is_empty(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{Read, Write};
    use std::path::{Path, PathBuf};

    /// バトルアイコンのキャッシュルート（`app_data_dir()/images`）。
    fn images_root() -> &'static Path {
        Path::new("/app/images")
    }

    /// テスト用: `(iface 名, "a.b.c.d")` の列を `filter_host_ipv4s` に渡し、文字列で受け取る。
    fn filtered(pairs: &[(&str, &str)]) -> Vec<String> {
        let input = pairs
            .iter()
            .map(|(name, ip)| (name.to_string(), ip.parse::<Ipv4Addr>().unwrap()))
            .collect();
        filter_host_ipv4s(input)
            .iter()
            .map(|ip| ip.to_string())
            .collect()
    }

    #[test]
    fn drops_apipa_link_local() {
        // #369: 169.254.0.0/16 は原理的に LAN の別端末から到達できないので載せない。
        let got = filtered(&[
            ("イーサネット", "192.168.3.8"),
            ("Wi-Fi", "169.254.121.53"),
            ("Bluetooth ネットワーク接続", "169.254.65.55"),
        ]);
        assert_eq!(got, vec!["192.168.3.8"]);
    }

    #[test]
    fn keeps_all_ordinary_private_ranges() {
        // #369 の最重要事項: 172.16-31.x.x を含む正当なプライベート IP を絶対に除外しない。
        for ip in [
            "192.168.3.8",
            "192.168.0.1",
            "10.0.0.5",
            "10.255.255.254",
            "172.16.0.1",
            "172.20.10.1",
            "172.31.255.254",
        ] {
            assert_eq!(filtered(&[("イーサネット", ip)]), vec![ip], "{ip} が消えた");
        }
    }

    #[test]
    fn keeps_172_even_on_virtual_iface() {
        // 仮想 NIC 名でも「除外」はしない（後ろに回すだけ）。誤除外で繋がらなくなるのを防ぐ。
        let got = filtered(&[("vEthernet (WSL (Hyper-V firewall))", "172.31.144.1")]);
        assert_eq!(got, vec!["172.31.144.1"]);
    }

    #[test]
    fn ranks_common_lan_before_172_and_virtual() {
        // 実機（#369 の実測）に近い並び。本命 192.168.3.8 が先頭に来ること。
        let got = filtered(&[
            ("vEthernet (WSL (Hyper-V firewall))", "172.31.144.1"),
            ("vEthernet (Default Switch)", "172.23.32.1"),
            ("Wi-Fi", "169.254.88.185"),
            ("イーサネット", "192.168.3.8"),
        ]);
        assert_eq!(got, vec!["192.168.3.8", "172.31.144.1", "172.23.32.1"]);
    }

    #[test]
    fn ranks_physical_172_before_virtual_ifaces() {
        // 172 系を使う実 LAN の環境: 物理 NIC の 172 が仮想 NIC より前に来る。
        let got = filtered(&[
            ("vEthernet (Default Switch)", "172.23.32.1"),
            ("イーサネット", "172.20.10.9"),
        ]);
        assert_eq!(got, vec!["172.20.10.9", "172.23.32.1"]);
    }

    #[test]
    fn keeps_global_ip_without_panicking() {
        // グローバル IP が混ざっていても落ちない。192.168 / 10 系より後ろ、172 系より前。
        let got = filtered(&[
            ("イーサネット", "172.16.5.5"),
            ("ppp0", "203.0.113.7"),
            ("Wi-Fi", "192.168.1.2"),
        ]);
        assert_eq!(got, vec!["192.168.1.2", "203.0.113.7", "172.16.5.5"]);
    }

    #[test]
    fn stable_within_same_rank() {
        // 同ランクなら if_addrs の列挙順を保つ（無用な並び替えをしない）。
        let got = filtered(&[
            ("イーサネット", "192.168.3.8"),
            ("Wi-Fi", "10.0.0.5"),
            ("イーサネット 2", "192.168.4.9"),
        ]);
        assert_eq!(got, vec!["192.168.3.8", "10.0.0.5", "192.168.4.9"]);
    }

    #[test]
    fn empty_input_yields_empty() {
        // 候補ゼロでも panic しない。has_lan_ip=false の既存警告経路がそのまま働く。
        assert!(filtered(&[]).is_empty());
    }

    #[test]
    fn all_apipa_yields_empty_not_panic() {
        assert!(filtered(&[("Wi-Fi", "169.254.1.2"), ("イーサネット", "169.254.9.9")]).is_empty());
    }

    #[test]
    fn resolves_valid_image_path() {
        let data = Path::new("/data");
        // ギア画像は従来どおり data_dir 側（#324 の挙動を変えない）。
        let got = resolve_image_path("/images/gear/head/abc.gti", data, images_root());
        assert_eq!(got, Some(data.join("images/gear/head/abc.gti")));
    }

    #[test]
    fn routes_gear_kinds_to_data_dir() {
        let data = Path::new("/data");
        for kind in ["gear", "brand", "skill"] {
            let got = resolve_image_path(&format!("/images/{kind}/x.gti"), data, images_root());
            assert_eq!(got, Some(data.join(format!("images/{kind}/x.gti"))));
        }
    }

    #[test]
    fn routes_battle_icon_kinds_to_images_root() {
        // #327: バトルアイコンは `app_data_dir()/images/<kind>/<sha256(name)>.gti` にある。
        // ブキ名から解決した `images/weapon/<hash>.gti` がそのまま引けること。
        let data = Path::new("/data");
        for kind in ["weapon", "sub_weapon", "special_weapon", "stage", "ability"] {
            let got = resolve_image_path(&format!("/images/{kind}/abc.gti"), data, images_root());
            assert_eq!(got, Some(images_root().join(format!("{kind}/abc.gti"))));
        }
    }

    #[test]
    fn rejects_non_images_prefix() {
        let data = Path::new("/data");
        // gear_db.bin 等の直接パスや任意ファイルは画像エンドポイントでは配信しない。
        assert_eq!(resolve_image_path("/gear_db.bin", data, images_root()), None);
        assert_eq!(resolve_image_path("/secrets.txt", data, images_root()), None);
    }

    #[test]
    fn rejects_path_traversal() {
        let data = Path::new("/data");
        assert_eq!(
            resolve_image_path("/images/../../etc/passwd", data, images_root()),
            None
        );
        assert_eq!(
            resolve_image_path("/images/../gear_db.bin", data, images_root()),
            None
        );
        // バトルアイコン側へ振り分けられる kind でも脱出は許さない。
        assert_eq!(
            resolve_image_path("/images/weapon/../../secrets.txt", data, images_root()),
            None
        );
    }

    // --- HTTP レイヤ（実ソケットで handle_request を駆動する） ---

    fn temp_root(tag: &str) -> PathBuf {
        static COUNTER: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
        let n = COUNTER.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
        let dir = std::env::temp_dir().join(format!(
            "splabo_companion_test_{}_{}_{}",
            std::process::id(),
            tag,
            n
        ));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    // --- スマホ Web 版（#786） ---

    /// テスト用: 1 リクエストだけ `route_web` で捌く。コマンドは受け取った名前と引数をそのまま返す。
    fn serve_web_once(raw_request: &str, data_dir: PathBuf, images_root: PathBuf) -> String {
        let server = tiny_http::Server::http("127.0.0.1:0").unwrap();
        let addr = server.server_addr().to_ip().unwrap();
        let raw = raw_request.to_string();
        let handle = std::thread::spawn(move || {
            let request = server.recv().unwrap();
            let url = request.url().to_string();
            let path = url.split('?').next().unwrap_or("").to_string();
            let method = request.method().clone();
            route_web(request, &method, &path, "tok", &data_dir, &images_root, &|cmd, args| {
                if crate::web_api::is_allowed(cmd) {
                    Ok(serde_json::json!({ "cmd": cmd, "args": args }))
                } else {
                    Err(crate::web_api::ApiError::NotFound)
                }
            });
        });
        let mut stream = std::net::TcpStream::connect(addr).unwrap();
        stream.write_all(raw.as_bytes()).unwrap();
        let mut response = Vec::new();
        stream.read_to_end(&mut response).unwrap();
        handle.join().unwrap();
        String::from_utf8_lossy(&response).into_owned()
    }

    fn post_web(path: &str, headers: &str, body: &str) -> String {
        let raw = format!(
            "POST {path} HTTP/1.1\r\nHost: localhost\r\n{headers}Content-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
            body.len()
        );
        serve_web_once(&raw, temp_root("web_data"), temp_root("web_images"))
    }

    #[test]
    fn session_sets_cookie_for_matching_token() {
        let res = post_web("/api/session", "", r#"{"token":"tok"}"#);
        assert!(res.starts_with("HTTP/1.1 204"), "unexpected: {res}");
        assert!(res.contains("Set-Cookie: splabo_session=tok;"), "cookie missing: {res}");
        assert!(res.contains("HttpOnly"), "{res}");
    }

    #[test]
    fn session_rejects_wrong_token() {
        let res = post_web("/api/session", "", r#"{"token":"nope"}"#);
        assert!(res.starts_with("HTTP/1.1 401"), "unexpected: {res}");
        assert!(!res.contains("Set-Cookie"), "{res}");
        let res = post_web("/api/session", "", "not json");
        assert!(res.starts_with("HTTP/1.1 401"), "unexpected: {res}");
    }

    #[test]
    fn cmd_requires_cookie() {
        let res = post_web("/api/cmd/db_summary", "", "{}");
        assert!(res.starts_with("HTTP/1.1 401"), "unexpected: {res}");
        let res = post_web("/api/cmd/db_summary", "Cookie: splabo_session=nope\r\n", "{}");
        assert!(res.starts_with("HTTP/1.1 401"), "unexpected: {res}");
        // Bearer（Android viewer 用だった）では通さない。
        let res = post_web("/api/cmd/db_summary", "Authorization: Bearer tok\r\n", "{}");
        assert!(res.starts_with("HTTP/1.1 401"), "unexpected: {res}");
    }

    #[test]
    fn cmd_passes_camel_case_args_through() {
        let res = post_web(
            "/api/cmd/db_list_battles",
            "Cookie: other=1; splabo_session=tok\r\n",
            r#"{"limit":20,"offset":0,"resultFilter":"win"}"#,
        );
        assert!(res.starts_with("HTTP/1.1 200"), "unexpected: {res}");
        assert!(res.contains(r#""cmd":"db_list_battles""#), "{res}");
        assert!(res.contains(r#""resultFilter":"win""#), "{res}");
    }

    #[test]
    fn cmd_accepts_empty_body() {
        let res = post_web("/api/cmd/db_list_weapons", "Cookie: splabo_session=tok\r\n", "");
        assert!(res.starts_with("HTTP/1.1 200"), "unexpected: {res}");
        assert!(res.contains(r#""args":null"#), "{res}");
    }

    #[test]
    fn cmd_not_in_allowlist_is_404() {
        let res = post_web("/api/cmd/start_login", "Cookie: splabo_session=tok\r\n", "{}");
        assert!(res.starts_with("HTTP/1.1 404"), "unexpected: {res}");
    }

    #[test]
    fn cmd_with_broken_json_is_400() {
        let res = post_web("/api/cmd/db_summary", "Cookie: splabo_session=tok\r\n", "{broken");
        assert!(res.starts_with("HTTP/1.1 400"), "unexpected: {res}");
    }

    #[test]
    fn img_returns_descrambled_png_with_cookie() {
        let data_dir = temp_root("web_img_data");
        let images_root = temp_root("web_img_root");
        std::fs::create_dir_all(data_dir.join("images/gear/head")).unwrap();
        std::fs::write(
            data_dir.join("images/gear/head/a.gti"),
            crate::crypto::scramble_image(b"PNG-BYTES"),
        )
        .unwrap();

        let raw = "GET /img/images/gear/head/a.gti HTTP/1.1\r\nHost: localhost\r\nCookie: splabo_session=tok\r\nConnection: close\r\n\r\n";
        let res = serve_web_once(raw, data_dir.clone(), images_root.clone());
        assert!(res.starts_with("HTTP/1.1 200"), "unexpected: {res}");
        assert!(res.contains("image/png"), "{res}");
        assert!(res.contains("PNG-BYTES"), "not descrambled: {res}");
        assert!(res.contains("Cache-Control: private, max-age=86400"), "{res}");

        let raw = "GET /img/images/gear/head/a.gti HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n";
        let res = serve_web_once(raw, data_dir.clone(), images_root.clone());
        assert!(res.starts_with("HTTP/1.1 401"), "unexpected: {res}");

        let raw = "GET /img/images/../secret HTTP/1.1\r\nHost: localhost\r\nCookie: splabo_session=tok\r\nConnection: close\r\n\r\n";
        let res = serve_web_once(raw, data_dir, images_root);
        assert!(res.starts_with("HTTP/1.1 403"), "unexpected: {res}");
    }

    #[test]
    fn routes_web_paths() {
        assert!(is_web_path("/api/session"));
        assert!(is_web_path("/api/cmd/db_summary"));
        assert!(is_web_path("/img/images/weapon/x.gti"));
        assert!(!is_web_path("/gear_db.bin"));
        assert!(!is_web_path("/images/gear/x.gti"));
        assert!(!is_web_path("/update"));
    }

    // --- スマホ画面の静的ファイル（#788） ---

    #[test]
    fn maps_mobile_entry_and_assets() {
        assert_eq!(static_asset_name("/m").as_deref(), Some("mobile.html"));
        assert_eq!(static_asset_name("/m/").as_deref(), Some("mobile.html"));
        assert_eq!(static_asset_name("/assets/mobile-AbC_12.js").as_deref(), Some("assets/mobile-AbC_12.js"));
        assert_eq!(static_asset_name("/mobile.webmanifest").as_deref(), Some("mobile.webmanifest"));
        assert_eq!(static_asset_name("/splabo-favicon.png").as_deref(), Some("splabo-favicon.png"));
        assert_eq!(static_asset_name("/splabo-logo.png").as_deref(), Some("splabo-logo.png"));
    }

    #[test]
    fn does_not_serve_desktop_page_or_escape_assets() {
        // デスクトップの画面は配らない。
        assert_eq!(static_asset_name("/"), None);
        assert_eq!(static_asset_name("/index.html"), None);
        // assets/ の外・下の階層・隠しファイルは配らない。
        assert_eq!(static_asset_name("/assets/../secret"), None);
        assert_eq!(static_asset_name("/assets/a/b.js"), None);
        assert_eq!(static_asset_name("/assets/..js"), None);
        assert_eq!(static_asset_name("/assets/"), None);
        assert_eq!(static_asset_name("/assets/a%2Fb.js"), None);
    }

    #[test]
    fn only_update_paths_ask_for_auth() {
        for p in ["/update", "/update_status"] {
            assert!(is_update_path(p), "{p}");
        }
        // Android viewer 用だった経路は 404（認証も求めない）。
        for p in ["/", "/m/x", "/favicon.ico", "/api", "/ping", "/gear_db.bin", "/battle_db.bin", "/coordinates.bin", "/icons/manifest", "/images/gear/x.gti"] {
            assert!(!is_update_path(p), "{p}");
        }
    }

    #[test]
    fn img_returns_304_when_etag_matches() {
        let data_dir = temp_root("web_etag_data");
        let images_root = temp_root("web_etag_root");
        std::fs::create_dir_all(images_root.join("stage")).unwrap();
        let bytes = crate::crypto::scramble_image(b"STAGE-BYTES");
        std::fs::write(images_root.join("stage").join("s1.gti"), &bytes).unwrap();

        let etag = hash_bytes(&bytes);
        let raw = format!(
            "GET /img/images/stage/s1.gti HTTP/1.1\r\nHost: localhost\r\nCookie: splabo_session=tok\r\nIf-None-Match: \"{etag}\"\r\nConnection: close\r\n\r\n"
        );
        let res = serve_web_once(&raw, data_dir, images_root);
        // 変わっていないので再転送しない。
        assert!(res.starts_with("HTTP/1.1 304"), "unexpected: {res}");
        assert!(!res.contains("STAGE-BYTES"), "body should not be sent: {res}");
    }

    #[test]
    fn hashes_are_stable_and_content_sensitive() {
        assert_eq!(hash_bytes(b"IMG-A"), hash_bytes(b"IMG-A"));
        assert_ne!(hash_bytes(b"IMG-A"), hash_bytes(b"IMG-B"));
        // sha256 hex は 64 文字。
        assert_eq!(hash_bytes(b"IMG-A").len(), 64);
    }

    #[test]
    fn etag_matches_quoted_and_bare() {
        assert!(etag_matches(Some("\"abc123\""), "abc123"));
        assert!(etag_matches(Some("abc123"), "abc123"));
        assert!(etag_matches(Some("W/\"abc123\""), "abc123"));
        // 複数候補のいずれかに一致すれば 304。
        assert!(etag_matches(Some("\"zzz\", \"abc123\""), "abc123"));
        // ワイルドカード。
        assert!(etag_matches(Some("*"), "abc123"));
    }

    #[test]
    fn etag_mismatch_or_absent_transfers() {
        assert!(!etag_matches(Some("\"other\""), "abc123"));
        assert!(!etag_matches(None, "abc123"));
        assert!(!etag_matches(Some(""), "abc123"));
    }

    // --- 多重起動防止 ---

    #[test]
    fn begins_job_from_idle() {
        let mut status = UpdateStatus::default();
        assert!(try_begin(&mut status, 100, UpdateTarget::Both));
        assert_eq!(status.state, UpdateState::Running);
        assert_eq!(status.step, Some(UpdateStep::Battles));
        assert_eq!(status.started_at, Some(100));
    }

    #[test]
    fn rejects_second_job_while_running() {
        let mut status = UpdateStatus::default();
        assert!(try_begin(&mut status, 100, UpdateTarget::Both));
        // 実行中に再度命令が来ても走らせない（進行中の状態を保つ）。
        assert!(!try_begin(&mut status, 200, UpdateTarget::Both));
        assert_eq!(status.state, UpdateState::Running);
        assert_eq!(status.started_at, Some(100));
    }

    #[test]
    fn rejects_second_job_even_with_different_target() {
        // #395: 対象を分けても並走はさせない（任天堂 API を同時に叩かせない）。
        let mut status = UpdateStatus::default();
        assert!(try_begin(&mut status, 100, UpdateTarget::Battle));
        assert!(!try_begin(&mut status, 200, UpdateTarget::Gear));
        assert_eq!(status.started_at, Some(100));
        assert_eq!(status.step, Some(UpdateStep::Battles));
    }

    #[test]
    fn allows_rerun_after_done_or_failed() {
        let mut status = UpdateStatus::default();
        assert!(try_begin(&mut status, 100, UpdateTarget::Both));
        status.state = UpdateState::Done;
        assert!(try_begin(&mut status, 200, UpdateTarget::Both));
        assert_eq!(status.started_at, Some(200));

        let mut failed = UpdateStatus::failed("NOT_LOGGED_IN", "未ログイン", None);
        assert!(try_begin(&mut failed, 300, UpdateTarget::Both));
        assert_eq!(failed.state, UpdateState::Running);
        // 前回の失敗情報は引きずらない。
        assert_eq!(failed.error_code, None);
    }

    // --- #395: 更新対象の指定 ---

    #[test]
    fn parses_explicit_targets() {
        assert_eq!(parse_update_target(r#"{"target":"battle"}"#), UpdateTarget::Battle);
        assert_eq!(parse_update_target(r#"{"target":"gear"}"#), UpdateTarget::Gear);
        assert_eq!(parse_update_target(r#"{"target":"both"}"#), UpdateTarget::Both);
    }

    #[test]
    fn falls_back_to_both_for_missing_or_invalid_body() {
        // ボディ無し・空ボディ・JSON でないもの・未知の値は、すべて both。
        for body in [
            "",
            "{}",
            r#"{"target":null}"#,
            r#"{"target":"weapons"}"#,
            r#"{"target":123}"#,
            "not json",
        ] {
            assert_eq!(parse_update_target(body), UpdateTarget::Both, "body={body:?}");
        }
    }

    #[test]
    fn ignores_unknown_fields_in_body() {
        // 知らないフィールドがあっても target だけ読めればよい。
        assert_eq!(
            parse_update_target(r#"{"target":"gear","since":"2026-01-01"}"#),
            UpdateTarget::Gear
        );
    }

    #[test]
    fn first_step_follows_target() {
        // ギア単独なら、取りに行かない battles を進捗に出さない。
        assert_eq!(
            UpdateStatus::running(1, UpdateTarget::Gear).step,
            Some(UpdateStep::Gear)
        );
        assert_eq!(
            UpdateStatus::running(1, UpdateTarget::Battle).step,
            Some(UpdateStep::Battles)
        );
        assert_eq!(
            UpdateStatus::running(1, UpdateTarget::Both).step,
            Some(UpdateStep::Battles)
        );
    }

    #[test]
    fn target_selects_phases() {
        assert!(UpdateTarget::Battle.includes_battle() && !UpdateTarget::Battle.includes_gear());
        assert!(UpdateTarget::Gear.includes_gear() && !UpdateTarget::Gear.includes_battle());
        assert!(UpdateTarget::Both.includes_battle() && UpdateTarget::Both.includes_gear());
    }

    #[test]
    fn skipped_phase_counts_are_null() {
        // #395: 実行しなかった側は 0 ではなく null（「更新して 0 件」と区別するため）。
        let result = UpdateResult {
            gear: Some(10),
            ..UpdateResult::default()
        };
        let json = serde_json::to_value(result).unwrap();
        assert_eq!(json["gear"], 10);
        assert_eq!(json["battles"], serde_json::Value::Null);
        assert_eq!(json["details"], serde_json::Value::Null);
    }

    // --- エラー分類 ---

    #[test]
    fn classifies_errors() {
        assert_eq!(
            classify_error("NOT_LOGGED_IN: Nintendo アカウントでログインしていません。"),
            "NOT_LOGGED_IN"
        );
        assert_eq!(
            classify_error("FETCH_IN_PROGRESS: 既にバトル取得が進行中です。"),
            "FETCH_IN_PROGRESS"
        );
        assert_eq!(classify_error("bullet token 取得失敗: invalid_grant"), "TOKEN_EXPIRED");
        assert_eq!(classify_error("HTTP クライアント構築失敗: dns"), "FETCH_FAILED");
    }

    /// #399: znca-api の一時障害を TOKEN_EXPIRED にしない。
    ///
    /// 実際に出たログ（2026-07-22）が UPSTREAM_UNAVAILABLE になること、
    /// 401/403・invalid_grant は従来どおり TOKEN_EXPIRED のままであることを固定する。
    #[test]
    fn classifies_upstream_failure_separately_from_auth() {
        assert_eq!(
            classify_error(
                "UPSTREAM_UNAVAILABLE: bullet token 取得失敗: [znca-api] Non-200 status code: 500 (status=500 upstream_error=timeout)"
            ),
            "UPSTREAM_UNAVAILABLE"
        );
        assert_eq!(
            classify_error("AUTH_EXPIRED: bullet token 取得失敗: [znca-api] Non-200 status code: 401 (status=401 upstream_error=-)"),
            "TOKEN_EXPIRED"
        );
        // ローカルのネットワーク断は汎用コードに寄せる
        assert_eq!(
            classify_error("NETWORK: bullet token 取得失敗: fetch failed (status=- upstream_error=-)"),
            "FETCH_FAILED"
        );
        assert_eq!(
            classify_error("CORAL_UPGRADE: bullet token 取得失敗: [znc] Upgrade required. (status=200 upstream_error=-)"),
            "CORAL_UPGRADE"
        );
        // 理由不明の bullet token 失敗を「失効」と決めつけない（本 Issue の核心）
        assert_eq!(
            classify_error("bullet token 取得失敗: 何かよく分からない失敗"),
            "FETCH_FAILED"
        );
    }

    /// Rust の分類（nxapi::FailureKind）と companion の error_code が結線されていること。
    #[test]
    fn nxapi_failure_kind_maps_to_expected_error_code() {
        let cases: &[(Option<u16>, Option<&str>, &str, &str)] = &[
            (Some(500), Some("timeout"), "[znca-api] Non-200 status code: 500", "UPSTREAM_UNAVAILABLE"),
            (Some(503), None, "[znca-api] Non-200 status code: 503", "UPSTREAM_UNAVAILABLE"),
            (Some(401), None, "unauthorized", "TOKEN_EXPIRED"),
            (Some(403), None, "forbidden", "TOKEN_EXPIRED"),
            (Some(400), Some("invalid_grant"), "bad request", "TOKEN_EXPIRED"),
            (None, None, "fetch failed", "FETCH_FAILED"),
            (Some(200), None, "[znc] Upgrade required.", "CORAL_UPGRADE"),
        ];
        for (status, upstream, message, expected) in cases {
            let kind = crate::nxapi::classify_failure(*status, *upstream, message);
            let rendered = match kind.code() {
                Some(code) => format!("{code}: bullet token 取得失敗: {message}"),
                None => format!("bullet token 取得失敗: {message}"),
            };
            assert_eq!(&classify_error(&rendered), expected, "message={message}");
        }
    }

    // --- JSON 形（スマホの `pcUpdate.ts` が読む） ---

    #[test]
    fn serializes_status_shape() {
        let mut status = UpdateStatus::running(1700000000, UpdateTarget::Both);
        status.state = UpdateState::Done;
        status.step = None;
        status.finished_at = Some(1700000042);
        status.result = Some(UpdateResult {
            battles: Some(3),
            details: Some(2),
            gear: Some(10),
        });
        let json = serde_json::to_value(&status).unwrap();
        assert_eq!(json["state"], "done");
        assert_eq!(json["step"], serde_json::Value::Null);
        assert_eq!(json["started_at"], 1700000000_i64);
        assert_eq!(json["finished_at"], 1700000042_i64);
        assert_eq!(json["result"]["battles"], 3);

        let failed = UpdateStatus::failed("NOT_LOGGED_IN", "未ログイン", None);
        let json = serde_json::to_value(&failed).unwrap();
        assert_eq!(json["state"], "failed");
        assert_eq!(json["error_code"], "NOT_LOGGED_IN");

        let running = UpdateStatus::running(1, UpdateTarget::Both);
        let json = serde_json::to_value(&running).unwrap();
        assert_eq!(json["state"], "running");
        assert_eq!(json["step"], "battles");
    }

    // --- #787: 設定（固定トークン・固定ポート・オン/オフ） ---

    #[test]
    fn missing_or_broken_config_falls_back_to_defaults() {
        let dir = temp_root("cfg_missing");
        let path = dir.join(CONFIG_FILE);
        assert_eq!(load_config(&path), CompanionConfig::default());
        assert_eq!(load_config(&path).port, DEFAULT_PORT);
        std::fs::write(&path, b"{broken").unwrap();
        assert_eq!(load_config(&path), CompanionConfig::default());
    }

    #[test]
    fn config_round_trips_and_keeps_token() {
        let dir = temp_root("cfg_roundtrip");
        let path = dir.join(CONFIG_FILE);
        let mut cfg = CompanionConfig::default();
        assert!(ensure_token(&mut cfg));
        assert_eq!(cfg.token.len(), 32);
        cfg.enabled = true;
        cfg.port = 50000;
        save_config(&path, &cfg).unwrap();

        let mut loaded = load_config(&path);
        assert_eq!(loaded, cfg);
        // 既にあるトークンは作り直さない（スマホのショートカットを壊さない）。
        assert!(!ensure_token(&mut loaded));
        assert_eq!(loaded.token, cfg.token);
    }

    #[test]
    fn config_with_missing_fields_uses_defaults() {
        let dir = temp_root("cfg_partial");
        let path = dir.join(CONFIG_FILE);
        std::fs::write(&path, br#"{"enabled":true}"#).unwrap();
        let cfg = load_config(&path);
        assert!(cfg.enabled);
        assert_eq!(cfg.port, DEFAULT_PORT);
        assert!(cfg.token.is_empty());
    }

    #[test]
    fn rejects_reserved_ports() {
        assert!(validate_port(80).is_err());
        assert!(validate_port(1023).is_err());
        assert!(validate_port(1024).is_ok());
        assert!(validate_port(DEFAULT_PORT).is_ok());
        assert!(validate_port(65535).is_ok());
    }

    // --- #363: 接続トラブルの自己診断 ---

    #[test]
    fn diagnostics_reports_os_and_nonempty_category() {
        // フロント（#363）が読む JSON 契約の固定。os は実行 OS、network_category は
        // どの OS でも空文字にはならない（非 Windows は "unsupported"）。
        let d = companion_diagnostics();
        assert_eq!(d.os, std::env::consts::OS);
        assert!(!d.network_category.is_empty());

        let json = serde_json::to_value(&d).unwrap();
        assert!(json.get("os").is_some());
        assert!(json.get("network_category").is_some());
        assert!(json.get("has_lan_ip").is_some());
    }

    #[test]
    #[cfg(not(target_os = "windows"))]
    fn network_category_is_unsupported_off_windows() {
        // 判定は Windows(NLM) 専用。非 Windows は誤判定せず "unsupported" を返す。
        assert_eq!(detect_network_category(), "unsupported");
    }

    fn rule(allow: bool, profiles: i32) -> FwRule {
        FwRule { inbound: true, enabled: true, allow, profiles }
    }

    #[test]
    fn inbound_allowed_needs_rule_for_the_current_profile() {
        let (private, public) = (profile_bit("private").unwrap(), profile_bit("public").unwrap());
        // #370 の状態: パブリック用の許可しか無いまま、プライベートに変えた
        let public_only = [rule(true, 4), rule(true, 4)];
        assert!(!inbound_allowed(&public_only, private));
        assert!(inbound_allowed(&public_only, public));
        // プライベートにチェックを足した・すべてのプロファイル
        assert!(inbound_allowed(&[rule(true, 4 | 2)], private));
        assert!(inbound_allowed(&[rule(true, 0x7FFF_FFFF)], private));
        // 規則が無い
        assert!(!inbound_allowed(&[], private));
    }

    #[test]
    fn inbound_allowed_ignores_disabled_and_outbound_and_blocks_win() {
        let private = profile_bit("private").unwrap();
        let disabled = FwRule { enabled: false, ..rule(true, 2) };
        let outbound = FwRule { inbound: false, ..rule(true, 2) };
        assert!(!inbound_allowed(&[disabled, outbound], private));
        // 許可ダイアログでキャンセルすると、ブロックの規則ができる。ブロックは許可より強い
        assert!(!inbound_allowed(&[rule(true, 2), rule(false, 2)], private));
    }

    #[test]
    fn profile_bit_maps_only_known_categories() {
        assert_eq!(profile_bit("domain"), Some(1));
        assert_eq!(profile_bit("unknown"), None);
        assert_eq!(profile_bit("unsupported"), None);
    }

    #[test]
    fn same_exe_compares_paths_loosely() {
        let exe = r"C:\Users\me\AppData\Local\splabo\splabo.exe";
        assert!(same_exe(r"c:\users\me\appdata\local\splabo\SPLABO.EXE", exe));
        assert!(same_exe(r"\\?\C:\Users\me\AppData\Local\splabo\splabo.exe", exe));
        assert!(!same_exe(r"C:\Users\me\AppData\Local\other\other.exe", exe));
        // プログラムを指定しない規則（ポートだけの規則など）は splabo の規則とみなさない
        assert!(!same_exe("", exe));
    }

    #[test]
    fn expand_env_vars_replaces_known_and_keeps_unknown() {
        // SAFETY: このテストだけが使う名前の環境変数
        unsafe { std::env::set_var("SPLABO_TEST_DIR", r"C:\Apps") };
        assert_eq!(expand_env_vars(r"%SPLABO_TEST_DIR%\splabo.exe"), r"C:\Apps\splabo.exe");
        assert_eq!(expand_env_vars(r"%SPLABO_NO_SUCH%\x.exe"), r"%SPLABO_NO_SUCH%\x.exe");
        assert_eq!(expand_env_vars("100%"), "100%");
    }
}

