//! AI が書いた SQL を安全に実行する（#573 の 2/2）。
//!
//! AI に分析コードを書かせる以上、**返ってきた SQL は信頼できない**。悪意より現実的なのは
//! 「単純な間違い」で、重いクエリでアプリが固まる・意図せず書き込む・出すべきでない列を
//! 読む、といった事故を構造的に防ぐ。
//!
//! # 守りは 4 段
//!
//! 1. **読み取り専用コネクション**（`mode=ro`）— 書き込みはファイル層で不可能にする。
//!    本体のプールとは別に開くので、通常動作に影響しない
//! 2. **authorizer** — `ATTACH` / `PRAGMA` / 書き込み系 / 拡張ロードを拒否し、
//!    さらに**個人情報を含む列の読み取りを拒否**する
//! 3. **タイムアウト** — `sqlite3_progress_handler` で長いクエリを中断する。
//!    `CROSS JOIN` を書き間違えただけで固まるのを防ぐ
//! 4. **行数上限** — 巨大な結果セットでフロントを落とさない
//!
//! # authorizer の設計方針
//!
//! 「AI 用ビュー以外を読ませない」形にはしていない。ビューを引くと SQLite は**内部で
//! 展開して土台のテーブルも読む**ため、ビュー名だけを許可すると正当なクエリまで
//! 弾いてしまう。
//!
//! そこで
//!
//! - **読み取り自体は許す**（そもそも読み取り専用で開いている）
//! - **危険な操作は種類ごとに拒否**する（ホワイトリスト方式）
//! - **出すべきでない列だけを名指しで拒否**する（生 JSON・他プレイヤー名）
//!
//! 「ビューだけを使う」ことはプロンプト側で伝える。仮に AI が土台のテーブルを引いても、
//! 個人情報には手が届かない、という多層防御にしてある。

use std::os::raw::{c_char, c_int, c_void};
use std::time::{Duration, Instant};

use libsqlite3_sys as ffi;
use serde::{Deserialize, Serialize};
use sqlx::sqlite::SqliteConnectOptions;
use sqlx::{Column, Connection, Row, SqliteConnection};
use tauri::AppHandle;

/// 返す行数の上限。超えた分は切り、`truncated` で知らせる。
pub const MAX_ROWS: usize = 5_000;

/// クエリの時間上限。書き間違えた `CROSS JOIN` で固まらせない。
pub const QUERY_TIMEOUT: Duration = Duration::from_secs(10);

/// 読み取りを拒否する列。**生 JSON と他プレイヤーの識別情報**。
///
/// 分析に不要なうえ、AI が `SELECT *` した結果を画面や保存グラフに出したときに
/// 漏れると困るもの。AI 用ビューはこれらを含まないので（#572）、正当なクエリは影響を受けない。
const DENIED_COLUMNS: &[(&str, &str)] = &[
    // SplatNet の生レスポンス。他プレイヤー名を含み、巨大。
    ("battle", "raw_json"),
    ("battle", "parent_json"),
    ("battle", "my_team"),
    ("battle", "other_teams"),
    ("battles", "raw_json"),
    ("battles", "parent_json"),
    ("battles", "my_team"),
    ("battles", "other_teams"),
    // 他プレイヤーの表示名。
    ("battle_player", "name"),
    ("battle_player", "name_id"),
    ("battle_players", "name"),
    ("battle_players", "name_id"),
];

/// AI の SQL の実行結果。
/// `ai_apply_presentation` でフロントから受け取り直すので `Deserialize` も要る。
#[derive(Debug, Serialize, Deserialize)]
pub struct AnalysisResult {
    pub columns: Vec<String>,
    /// 行 × 列。値は数値 / 文字列 / null のいずれか。
    pub rows: Vec<Vec<serde_json::Value>>,
    /// 行数上限で切ったか。切ったまま「全部だ」と見せないための印。
    pub truncated: bool,
}

/// AI が書いた SELECT を実行する。
///
/// 書き込み・`ATTACH`・`PRAGMA` は authorizer が拒否し、長すぎるクエリは中断される。
pub async fn run_analysis_sql(app: &AppHandle, sql: &str) -> Result<AnalysisResult, String> {
    let path = crate::db::db_file_path(app)?;
    if !path.exists() {
        return Err("データベースがまだありません".into());
    }

    // 本体のプールとは別に、読み取り専用で開く。
    // create_if_missing は付けない（存在しないなら上で弾いている）。
    let opts = SqliteConnectOptions::new()
        .filename(&path)
        .read_only(true)
        .busy_timeout(Duration::from_secs(5));
    let mut conn = SqliteConnection::connect_with(&opts)
        .await
        .map_err(|e| format!("分析用の接続を開けませんでした: {e}"))?;

    // 統計関数（corr / stddev 等）はコネクションごとの登録なので、この接続にも入れる。
    // 入れ忘れると AI が corr を書いた瞬間に「no such function」になる。
    // 🔴 生ポインタを await 越しに持つと future が Send にならず、Tauri コマンドにできない。
    // アドレスを usize で持ち回し、await を挟まない unsafe ブロックの中だけでポインタに戻す。
    let deadline_addr = Box::into_raw(Box::new(Instant::now() + QUERY_TIMEOUT)) as usize;
    {
        let mut handle = conn
            .lock_handle()
            .await
            .map_err(|e| format!("接続ハンドルを取得できませんでした: {e}"))?;
        let raw = handle.as_raw_handle().as_ptr();
        // SAFETY: lock_handle を保持している間だけ生ポインタを使う。
        unsafe {
            let failed = crate::sql_functions::register_all(raw);
            if !failed.is_empty() {
                log::warn!("[ai_sql] 統計関数の登録に失敗: {}", failed.join(", "));
            }
            ffi::sqlite3_set_authorizer(raw, Some(authorizer), std::ptr::null_mut());
            // 第 2 引数は「何 VM 命令ごとにコールバックを呼ぶか」。
            ffi::sqlite3_progress_handler(raw, 1_000, Some(progress), deadline_addr as *mut c_void);
        }
    }

    let result = fetch_rows(&mut conn, sql).await;

    // ハンドラを外してから Box を回収する（外す前に落とすと解放済み領域を読む）。
    if let Ok(mut handle) = conn.lock_handle().await {
        let raw = handle.as_raw_handle().as_ptr();
        unsafe {
            ffi::sqlite3_progress_handler(raw, 0, None, std::ptr::null_mut());
            ffi::sqlite3_set_authorizer(raw, None, std::ptr::null_mut());
        }
    }
    // SAFETY: into_raw で作った 1 つだけのアドレスを、ここで 1 回だけ回収する。
    unsafe {
        drop(Box::from_raw(deadline_addr as *mut Instant));
    }
    let _ = conn.close().await;

    result
}

/// AI に渡すプロンプトの土台（ビュー一覧 + データの規模 + ドメイン知識）をフロントへ返す。
///
/// フロント側で組み立てず Rust から取るのは、**ビュー定義とプロンプトを 1 つの出力元に
/// 保つ**ため（`ai_views::AI_VIEWS` が唯一の正）。
///
/// データの規模（件数と日付の範囲）は実 DB から引く。環境データは数千万行あり、
/// **期間を絞らない集計は必ずタイムアウトする**。AI に `source_date` の条件を書かせるには、
/// どこにデータがあるかを教える必要がある。バトルの中身は渡さない。
#[tauri::command]
pub async fn ai_analysis_prompt(app: AppHandle) -> String {
    let scale = data_scale(&app).await;
    crate::ai_views::analysis_prompt(scale.as_ref())
}

/// データの規模を DB から引く。
///
/// 🔴 日付の範囲は**基底表 `env_battles`** から取る。`ai_env_slots` は 7 分岐の
/// UNION ALL なのでインデックスが効かず、`MAX(source_date)` に 100 秒以上かかる。
/// 基底表なら 1 ミリ秒未満。
///
/// 失敗しても分析自体は続けられるので、取れなければ None（規模の節を省く）。
async fn data_scale(app: &AppHandle) -> Option<crate::ai_views::DataScale> {
    let path = crate::db::db_file_path(app).ok()?;
    let opts = SqliteConnectOptions::new().filename(path).read_only(true);
    let mut conn = SqliteConnection::connect_with(&opts).await.ok()?;

    let env_battles: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM env_battles")
        .fetch_one(&mut conn).await.unwrap_or(0);
    let my_battles: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM battle")
        .fetch_one(&mut conn).await.unwrap_or(0);
    // 0 件のときは MIN/MAX が NULL になり、期間の案内も出せない。
    let (env_min_date, env_max_date) = if env_battles > 0 {
        (
            sqlx::query_scalar("SELECT MIN(source_date) FROM env_battles")
                .fetch_one(&mut conn).await.unwrap_or(None),
            sqlx::query_scalar("SELECT MAX(source_date) FROM env_battles")
                .fetch_one(&mut conn).await.unwrap_or(None),
        )
    } else {
        (None, None)
    };
    // ロビーとルールの値は推測させない（実機で AI が値を当てにいった）。
    // どちらもマスタなので数十行しかなく、取得は一瞬。
    let lobbies: Vec<String> = sqlx::query_scalar("SELECT key FROM lobby ORDER BY key")
        .fetch_all(&mut conn).await.unwrap_or_default();
    let rules: Vec<String> = sqlx::query_scalar("SELECT key FROM rule ORDER BY key")
        .fetch_all(&mut conn).await.unwrap_or_default();
    let _ = conn.close().await;

    Some(crate::ai_views::DataScale {
        env_battles,
        env_min_date,
        env_max_date,
        my_battles,
        lobbies,
        rules,
    })
}

/// AI が書いた SELECT を実行する。
#[tauri::command]
pub async fn ai_run_sql(app: AppHandle, sql: String) -> Result<AnalysisResult, String> {
    run_analysis_sql(&app, &sql).await
}

/// AI②（見せ方を決める段）に渡す指示を返す。
#[tauri::command]
pub fn ai_presentation_prompt() -> String {
    crate::ai_present::presentation_prompt()
}

/// AI② が返した見せ方を集計結果に適用し、表の形にする。
///
/// **数値はここで作らない。** 行・列の組み替え、セルの連結、系列への振り分けだけを行う。
/// 指定が結果と合っていなければ、実際の列名を添えて `Err` を返す（AI が読んで直せる形）。
#[tauri::command]
pub fn ai_apply_presentation(
    result: AnalysisResult,
    spec: crate::ai_present::PresentationSpec,
) -> Result<crate::ai_present::Presentation, String> {
    crate::ai_present::apply(&result.columns, &result.rows, &spec)
}

async fn fetch_rows(conn: &mut SqliteConnection, sql: &str) -> Result<AnalysisResult, String> {
    // 上限 + 1 件取って、超えたかどうかを判定する。
    let rows = sqlx::query(sql)
        .fetch_all(&mut *conn)
        .await
        .map_err(|e| classify_error(&e.to_string(), sql))?;

    let truncated = rows.len() > MAX_ROWS;
    let rows = &rows[..rows.len().min(MAX_ROWS)];

    let columns: Vec<String> = rows
        .first()
        .map(|r| r.columns().iter().map(|c| c.name().to_string()).collect())
        .unwrap_or_default();

    let out = rows
        .iter()
        .map(|r| (0..r.len()).map(|i| value_at(r, i)).collect())
        .collect();

    Ok(AnalysisResult { columns, rows: out, truncated })
}

/// SQLite の動的型付けに合わせて、整数 → 実数 → 文字列の順に試す。
fn value_at(row: &sqlx::sqlite::SqliteRow, idx: usize) -> serde_json::Value {
    if let Ok(Some(v)) = row.try_get::<Option<i64>, _>(idx) {
        return serde_json::json!(v);
    }
    if let Ok(Some(v)) = row.try_get::<Option<f64>, _>(idx) {
        return serde_json::json!(v);
    }
    if let Ok(Some(v)) = row.try_get::<Option<String>, _>(idx) {
        return serde_json::json!(v);
    }
    serde_json::Value::Null
}

/// AI に返しても意味が通るエラー文にする。原因の区別が付かないと再試行できない。
///
/// 列名・テーブル名の間違いには、**使っているビューの実際の列一覧を添える**。
/// ビューごとに列が違うので取り違えが起きやすく（`ai_battles` の `rank_before` を
/// `ai_env_slots` に書く等）、一覧が手元にないと AI は同じ間違いを繰り返す。
fn classify_error(msg: &str, sql: &str) -> String {
    let lower = msg.to_ascii_lowercase();
    if lower.contains("interrupted") {
        return format!(
            "クエリが {} 秒を超えたため中断しました。{}",
            QUERY_TIMEOUT.as_secs(),
            slow_query_hint(sql)
        );
    }
    // authorizer が弾いたとき SQLite が返す文言は 2 種類ある。
    // 操作ごとの拒否は "not authorized"、列単位の拒否は "access to X.Y is prohibited"。
    if lower.contains("not authorized") || lower.contains("prohibited") {
        return format!("許可されていない操作が含まれています（読み取り専用の SELECT のみ実行できます）: {msg}");
    }
    if lower.contains("readonly") || lower.contains("attempt to write") {
        return format!("書き込みはできません: {msg}");
    }
    if lower.contains("no such column") || lower.contains("no such table") {
        if let Some(hint) = view_columns_hint(msg, sql) {
            return format!("{msg}\n\n{hint}");
        }
    }
    msg.to_string()
}

/// SQL が使っている AI 用ビューの列一覧と、**探している列が別のビューにあるならその案内**。
///
/// 「列名を間違えた」の実体はたいてい**ビューの選び間違い**なので、
/// 列一覧を並べるだけでなく「その列は X にあります」まで言う。
fn view_columns_hint(msg: &str, sql: &str) -> Option<String> {
    let used: Vec<&crate::ai_views::ViewDoc> = crate::ai_views::AI_VIEWS
        .iter()
        .filter(|v| sql.contains(v.name))
        .collect();

    let mut s = String::new();

    // 探していた列が他のビューにあるなら、そこへ誘導する。
    if let Some(col) = missing_column(msg) {
        let owners: Vec<&str> = crate::ai_views::AI_VIEWS
            .iter()
            .filter(|v| v.columns.iter().any(|(c, _)| *c == col))
            .map(|v| v.name)
            .collect();
        if !owners.is_empty() {
            s.push_str(&format!(
                "`{col}` があるのは {} です。使うビューを間違えていないか確認してください。\n\n",
                owners.iter().map(|n| format!("`{n}`")).collect::<Vec<_>>().join(" / ")
            ));
        }
    }

    if used.is_empty() {
        return if s.is_empty() { None } else { Some(s) };
    }
    s.push_str("使っているビューに実際にある列は次のとおりです。ここに無い列は使えません。");
    for v in used {
        let cols: Vec<&str> = v.columns.iter().map(|(c, _)| *c).collect();
        s.push_str(&format!("\n\n- `{}`: {}", v.name, cols.join(", ")));
    }
    Some(s)
}

/// 遅い SQL に対して、**何をどう直すか**を具体的に返す。
///
/// 「絞り込みを足してください」だけでは AI は LIMIT を小さくするなど的外れな直し方をする。
/// 実機で踏んだのは**相関副問い合わせ**（`(SELECT COUNT(*) ... WHERE x = es.x)`）で、
/// 1 行ごとに再実行されるため環境データでは必ずタイムアウトする。
fn slow_query_hint(sql: &str) -> String {
    let upper = sql.to_ascii_uppercase();
    let mut hints: Vec<&str> = Vec::new();

    // 最も効く順に並べる。実データでは全期間 77 秒 → 直近 30 日 0.7 秒。
    if sql.contains("ai_env_slots") && !sql.contains("source_date") {
        hints.push(
            "環境データは数千万行あります。**`source_date` で期間を絞ってください**\n\
             例: `WHERE source_date >= date('now', '-30 days')`\n\
             どの期間で集計したかは explanation に書いてください",
        );
    }
    // 同じビューを何度も読んでいる = UNION ALL の分岐ごとにスキャンしている。
    // 実測で 4 分岐 5.0 秒 → 1 スキャン 0.59 秒。
    if sql.matches("ai_env_slots").count() >= 3 {
        hints.push(
            "`ai_env_slots` を何度も読んでいます。**スキャンは 1 回で済ませてください**\n\
             指標ごとに `UNION ALL` で分けるのではなく、まず\n\
             `SELECT corr(won, kill) AS キル, corr(won, death) AS デス, ... FROM ... WHERE ...`\n\
             と**横に並べて 1 行で取り**、その結果を `UNION ALL` で縦に展開してください",
        );
    }
    // 副問い合わせがあってウィンドウ関数が無い = 割合の出し方を間違えている可能性が高い。
    if upper.contains("(SELECT") && !upper.contains(" OVER ") {
        hints.push(
            "大きいビューを 1 行ごとに数え直す副問い合わせ（相関副問い合わせ）が入っていませんか。\n\
             群ごとの合計に対する割合は**ウィンドウ関数**で出してください。\n\
             悪い例: `COUNT(*) * 100.0 / (SELECT COUNT(*) FROM ai_env_slots WHERE poster_rank = es.poster_rank)`\n\
             良い例: `COUNT(*) * 100.0 / SUM(COUNT(*)) OVER (PARTITION BY poster_rank)`",
        );
    }
    if hints.is_empty() {
        hints.push(
            "絞り込みを足すか、集計を軽くしてください。\
             大きいビューを 2 回以上スキャンする書き方（自己結合・副問い合わせ）は避けてください",
        );
    }
    hints.join("\n\n")
}

/// `no such column: t.rank_before` から `rank_before` を取り出す。
fn missing_column(msg: &str) -> Option<String> {
    let idx = msg.to_ascii_lowercase().find("no such column:")?;
    let rest = msg[idx + "no such column:".len()..].trim();
    let name = rest.split_whitespace().next()?;
    // 修飾子（別名）が付いていれば落とす。
    Some(name.rsplit('.').next()?.trim().to_string())
}

/// 進行コールバック。0 以外を返すとクエリが中断される。
unsafe extern "C" fn progress(arg: *mut c_void) -> c_int {
    if arg.is_null() {
        return 0;
    }
    let deadline = &*(arg as *const Instant);
    if Instant::now() >= *deadline { 1 } else { 0 }
}

/// 危険な操作を種類ごとに拒否する（ホワイトリスト方式）。
///
/// `arg1` / `arg2` の意味は action によって違う。`SQLITE_READ` では
/// arg1 = テーブル名、arg2 = 列名。
unsafe extern "C" fn authorizer(
    _user:  *mut c_void,
    action: c_int,
    arg1:   *const c_char,
    arg2:   *const c_char,
    _db:    *const c_char,
    _tvf:   *const c_char,
) -> c_int {
    match action {
        // 読み取りは許す。ただし出すべきでない列は名指しで拒否する。
        ffi::SQLITE_READ => {
            let table = cstr(arg1);
            let column = cstr(arg2);
            if DENIED_COLUMNS
                .iter()
                .any(|(t, c)| *t == table && *c == column)
            {
                ffi::SQLITE_DENY
            } else {
                ffi::SQLITE_OK
            }
        }
        // SELECT 本体と、再帰 CTE（WITH RECURSIVE）を許す。
        ffi::SQLITE_SELECT | ffi::SQLITE_RECURSIVE => ffi::SQLITE_OK,
        // 関数呼び出し。拡張ロードだけ拒否し、他（corr 等）は通す。
        ffi::SQLITE_FUNCTION => {
            if cstr(arg2).eq_ignore_ascii_case("load_extension") {
                ffi::SQLITE_DENY
            } else {
                ffi::SQLITE_OK
            }
        }
        // それ以外（書き込み・DDL・ATTACH・PRAGMA・トランザクション等）は一律拒否。
        _ => ffi::SQLITE_DENY,
    }
}

unsafe fn cstr(p: *const c_char) -> String {
    if p.is_null() {
        return String::new();
    }
    std::ffi::CStr::from_ptr(p).to_string_lossy().into_owned()
}

#[cfg(test)]
mod tests {
    use super::*;
    use sqlx::sqlite::SqlitePoolOptions;

    /// 失敗を期待する箇所のヘルパー。`SqliteRow` が Debug を実装していないので
    /// `unwrap_err()` が使えない。
    fn err_of<T>(r: Result<T, sqlx::Error>) -> String {
        match r {
            Ok(_) => panic!("拒否されるべきクエリが成功した"),
            Err(e) => e.to_string(),
        }
    }

    /// authorizer と統計関数を仕込んだ、テスト用のメモリ接続。
    ///
    /// 本番は読み取り専用でファイルを開くが、メモリ DB では土台を作れないので
    /// **authorizer だけを本番と同じにして**検証する（書き込み拒否は authorizer が担う）。
    async fn conn_with_guards() -> SqliteConnection {
        let mut conn = SqliteConnection::connect("sqlite::memory:").await.unwrap();
        sqlx::raw_sql(
            "CREATE TABLE battle (id TEXT, raw_json TEXT, kill INTEGER, death INTEGER);
             CREATE TABLE battle_player (battle_id TEXT, name TEXT, kill INTEGER);
             CREATE VIEW ai_battles AS SELECT id, kill, death FROM battle;
             INSERT INTO battle VALUES ('b1', '{\"secret\":1}', 6, 3);
             INSERT INTO battle VALUES ('b2', '{\"secret\":2}', 2, 5);
             INSERT INTO battle_player VALUES ('b1', 'ひみつ', 1);",
        )
        .execute(&mut conn)
        .await
        .unwrap();

        let mut handle = conn.lock_handle().await.unwrap();
        let raw = handle.as_raw_handle().as_ptr();
        unsafe {
            crate::sql_functions::register_all(raw);
            ffi::sqlite3_set_authorizer(raw, Some(authorizer), std::ptr::null_mut());
        }
        drop(handle);
        conn
    }

    #[tokio::test]
    async fn ビューを引ける_土台のテーブル展開で弾かれない() {
        let mut conn = conn_with_guards().await;
        // ビューは内部で battle を読む。ビュー名だけ許可する作りだとここで落ちる。
        let n: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM ai_battles")
            .fetch_one(&mut conn).await.unwrap();
        assert_eq!(n, 2);
    }

    #[tokio::test]
    async fn 統計関数がこの接続でも使える() {
        let mut conn = conn_with_guards().await;
        let r: Option<f64> = sqlx::query_scalar("SELECT corr(kill, death) FROM ai_battles")
            .fetch_one(&mut conn).await.unwrap();
        assert!(r.is_some(), "分析用の接続に corr が登録されていない");
    }

    #[tokio::test]
    async fn 生_json_と他プレイヤー名は読めない() {
        let mut conn = conn_with_guards().await;
        // 列単位の拒否は "access to battle.raw_json is prohibited" になる。
        let e = err_of(sqlx::query("SELECT raw_json FROM battle").fetch_all(&mut conn).await);
        assert!(e.contains("prohibited"), "raw_json が読めてしまう: {e}");
        assert!(classify_error(&e, "SELECT raw_json FROM battle").contains("許可されていない"),
                "エラー文が AI に伝わらない");

        let e = err_of(sqlx::query("SELECT name FROM battle_player").fetch_all(&mut conn).await);
        assert!(e.contains("prohibited"), "他プレイヤー名が読めてしまう: {e}");

        // 同じテーブルの他の列は読める（テーブルごと塞いでいるのではない）。
        let n: i64 = sqlx::query_scalar("SELECT COUNT(kill) FROM battle_player")
            .fetch_one(&mut conn).await.unwrap();
        assert_eq!(n, 1);
    }

    #[tokio::test]
    async fn 書き込みと_ddl_は拒否される() {
        let mut conn = conn_with_guards().await;
        for sql in [
            "INSERT INTO battle VALUES ('x', '{}', 1, 1)",
            "UPDATE battle SET kill = 0",
            "DELETE FROM battle",
            "DROP VIEW ai_battles",
            "CREATE TABLE evil (x INTEGER)",
            "ALTER TABLE battle ADD COLUMN evil TEXT",
        ] {
            let r = sqlx::query(sql).execute(&mut conn).await;
            assert!(r.is_err(), "拒否されるべき SQL が通った: {sql}");
        }
    }

    #[tokio::test]
    async fn attach_と_pragma_は拒否される() {
        let mut conn = conn_with_guards().await;
        let r = sqlx::query("ATTACH DATABASE ':memory:' AS other").execute(&mut conn).await;
        assert!(r.is_err(), "ATTACH が通ってしまう");

        let r = sqlx::query("PRAGMA journal_mode").execute(&mut conn).await;
        assert!(r.is_err(), "PRAGMA が通ってしまう");
    }

    #[tokio::test]
    async fn タイムアウトでクエリが中断される() {
        let mut conn = SqliteConnection::connect("sqlite::memory:").await.unwrap();
        // 期限を過ぎた状態にして、必ず中断させる。
        let deadline = Box::new(Instant::now() - Duration::from_secs(1));
        let ptr = Box::into_raw(deadline);
        {
            let mut handle = conn.lock_handle().await.unwrap();
            let raw = handle.as_raw_handle().as_ptr();
            unsafe { ffi::sqlite3_progress_handler(raw, 1, Some(progress), ptr.cast()) };
        }

        // 何 VM 命令か回れば中断される。
        let e = err_of(
            sqlx::query("WITH RECURSIVE c(x) AS (SELECT 1 UNION ALL SELECT x+1 FROM c WHERE x < 1000000) SELECT COUNT(*) FROM c")
                .fetch_all(&mut conn).await,
        );
        assert!(
            e.to_ascii_lowercase().contains("interrupt"),
            "中断されていない: {e}"
        );
        assert!(classify_error(&e, "").contains("中断"), "エラー文が AI に伝わらない");

        {
            let mut handle = conn.lock_handle().await.unwrap();
            let raw = handle.as_raw_handle().as_ptr();
            unsafe { ffi::sqlite3_progress_handler(raw, 0, None, std::ptr::null_mut()) };
        }
        unsafe { drop(Box::from_raw(ptr)) };
    }

    #[tokio::test]
    async fn 行数上限で切って印を付ける() {
        let pool = SqlitePoolOptions::new().max_connections(1)
            .connect("sqlite::memory:").await.unwrap();
        let mut conn = pool.acquire().await.unwrap();

        // MAX_ROWS + 10 行を作る
        let sql = format!(
            "WITH RECURSIVE c(x) AS (SELECT 1 UNION ALL SELECT x+1 FROM c WHERE x < {}) SELECT x FROM c",
            MAX_ROWS + 10
        );
        let res = fetch_rows(&mut conn, &sql).await.unwrap();
        assert_eq!(res.rows.len(), MAX_ROWS, "上限で切れていない");
        assert!(res.truncated, "切ったのに印が付いていない");
        assert_eq!(res.columns, vec!["x".to_string()]);
    }

    #[tokio::test]
    async fn 結果の値が型ごとに変換される() {
        let pool = SqlitePoolOptions::new().max_connections(1)
            .connect("sqlite::memory:").await.unwrap();
        let mut conn = pool.acquire().await.unwrap();
        let res = fetch_rows(
            &mut conn,
            "SELECT 1 AS i, 1.5 AS f, 'a' AS s, NULL AS n",
        ).await.unwrap();
        assert_eq!(res.columns, vec!["i", "f", "s", "n"]);
        assert_eq!(res.rows[0][0], serde_json::json!(1));
        assert_eq!(res.rows[0][1], serde_json::json!(1.5));
        assert_eq!(res.rows[0][2], serde_json::json!("a"));
        assert_eq!(res.rows[0][3], serde_json::Value::Null);
        assert!(!res.truncated);
    }

    /// 列名を間違えたときに、**使っているビューの列一覧が添えられる**か。
    ///
    /// 実機で AI が `ai_env_slots` に `rank_before`（`ai_battles` の列）を書いて落ちた。
    /// 一覧が手元にないと同じ間違いを繰り返すので、エラーに載せる。
    #[test]
    fn 列名の間違いには使っているビューの列一覧が付く() {
        let sql = "SELECT rank_before FROM ai_env_slots GROUP BY rank_before";
        let out = classify_error("no such column: rank_before", sql);

        assert!(out.contains("no such column"), "元のエラーが消えている: {out}");
        assert!(out.contains("ai_env_slots"), "どのビューか分からない: {out}");
        // 正解の列名が含まれていること
        assert!(out.contains("poster_rank"), "正しい列名が示されていない: {out}");
        // 「その列があるのは ai_battles」まで言えていること。
        // 列名の間違いは実体としてビューの選び間違いなので、行き先を示す。
        assert!(out.contains("ai_battles"), "列がどのビューにあるか示していない: {out}");
        // 関係ないビューの列は混ぜない（プロンプトを無駄に太らせない）
        assert!(!out.contains("ai_battle_players"), "使っていないビューまで載っている: {out}");
        // 実際に AI へ渡る文面を目で確認できるようにしておく（cargo test -- --nocapture）
        println!("--- AI に返る文面 ---\n{out}\n---");
    }

    /// 実機 2 例目。`ai_battle_players` にウデマエで絞ろうとした。
    /// ビュー自体の選び間違いなので、正しい行き先（ai_battles / ai_env_slots）を示す。
    #[test]
    fn 別のビューを選んでいても行き先を示す() {
        let sql = "SELECT weapon FROM ai_battle_players GROUP BY rank_before, weapon";
        let out = classify_error("no such column: rank_before", sql);

        assert!(out.contains("ai_battles"), "行き先が示されていない: {out}");
        assert!(out.contains("ai_battle_players"), "今使っているビューの列が無い: {out}");
        println!("--- AI に返る文面 ---\n{out}\n---");
    }

    /// 別名付き（`t.rank_before`）でも列名を取り出せるか。
    #[test]
    fn 別名が付いた列名からも行き先を引ける() {
        let out = classify_error("no such column: t.poster_rank", "SELECT 1 FROM x");
        assert!(out.contains("ai_env_slots"), "別名を落とせていない: {out}");
    }

    /// タイムアウトのとき、**何をどう直すか**が返るか。
    ///
    /// 実機で相関副問い合わせ（行ごとにビュー全体を数え直す）を書かれて中断した。
    /// 「絞り込みを足して」だけでは LIMIT を小さくするなど的外れな直し方をされる。
    #[test]
    fn 遅いクエリにはウィンドウ関数への直し方が返る() {
        let sql = "SELECT poster_rank, COUNT(*) * 100.0 / \
                   (SELECT COUNT(*) FROM ai_env_slots WHERE poster_rank = es.poster_rank) \
                   FROM ai_env_slots es GROUP BY poster_rank, weapon";
        let out = classify_error("interrupted", sql);

        assert!(out.contains("中断"), "中断だと分からない: {out}");
        assert!(out.contains("OVER (PARTITION BY"), "ウィンドウ関数へ誘導していない: {out}");
        assert!(out.contains("相関副問い合わせ"), "原因が示されていない: {out}");
        println!("--- AI に返る文面 ---\n{out}\n---");
    }

    /// すでにウィンドウ関数で書いているなら、書き換えを勧めても意味がない。
    #[test]
    fn ウィンドウ関数を使った遅いクエリには副問い合わせの話をしない() {
        let sql = "SELECT SUM(COUNT(*)) OVER (PARTITION BY poster_rank) FROM ai_env_slots \
                   WHERE source_date >= date('now', '-30 days') GROUP BY poster_rank";
        let out = classify_error("interrupted", sql);
        assert!(!out.contains("相関副問い合わせ"), "的外れな助言をしている: {out}");
        assert!(out.contains("集計を軽く"), "助言が無い: {out}");
    }

    /// 環境データを期間で絞っていない遅いクエリには、**まず期間の絞り込み**を勧めるか。
    ///
    /// 実データで全期間 77 秒 / 直近 30 日 0.7 秒。ここが一番効く。
    #[test]
    fn 期間を絞っていない環境クエリには絞り込みを勧める() {
        let sql = "SELECT weapon, COUNT(*) FROM ai_env_slots GROUP BY weapon";
        let out = classify_error("interrupted", sql);
        assert!(out.contains("source_date"), "期間の絞り込みを勧めていない: {out}");
        assert!(out.contains("-30 days"), "書き方が示されていない: {out}");
        println!("--- AI に返る文面 ---\n{out}\n---");
    }

    /// 実データの値を覗く用（普段は走らせない）。プロンプトに載せる値を確かめる。
    #[tokio::test]
    #[ignore]
    async fn 実データ探索() {
        use std::time::Instant;
        let path = std::env::var("SPLABO_DB").unwrap();
        let opts = sqlx::sqlite::SqliteConnectOptions::new().filename(&path).read_only(true);
        let pool = SqlitePoolOptions::new()
            .after_connect(|conn, _meta| {
                Box::pin(async move {
                    let mut handle = conn.lock_handle().await?;
                    let failed =
                        unsafe { crate::sql_functions::register_all(handle.as_raw_handle().as_ptr()) };
                    assert!(failed.is_empty(), "統計関数の登録に失敗: {failed:?}");
                    Ok(())
                })
            })
            .connect_with(opts)
            .await
            .unwrap();

        for (label, sql) in [
            ("lobby", "SELECT key FROM lobby ORDER BY key"),
            ("rule", "SELECT key FROM rule ORDER BY key"),
        ] {
            let v: Vec<String> = sqlx::query_scalar(sql).fetch_all(&pool).await.unwrap();
            println!("{label}: {v:?}");
        }

        // 「今シーズンのXマッチで勝率と最も相関の高い指標」の書き方を比べる。
        // 4 分岐の UNION ALL は 3900 万行を 4 回スキャンする。1 回で済む書き方があるはず。
        let branches = "SELECT '平均キル' AS 指標, corr(won, kill) AS 相関係数, COUNT(won) AS 件数
             FROM ai_env_slots WHERE lobby = 'xmatch' AND season = 'Sizzle Season 2026'
             UNION ALL SELECT '平均デス', corr(won, death), COUNT(won) FROM ai_env_slots
             WHERE lobby = 'xmatch' AND season = 'Sizzle Season 2026'
             UNION ALL SELECT '平均アシスト', corr(won, assist), COUNT(won) FROM ai_env_slots
             WHERE lobby = 'xmatch' AND season = 'Sizzle Season 2026'
             UNION ALL SELECT '平均塗り', corr(won, inked), COUNT(won) FROM ai_env_slots
             WHERE lobby = 'xmatch' AND season = 'Sizzle Season 2026'";
        let one_pass = "WITH 相関 AS (
               SELECT corr(won, kill) AS キル, corr(won, death) AS デス,
                      corr(won, assist) AS アシスト, corr(won, inked) AS 塗り, COUNT(won) AS 件数
               FROM ai_env_slots WHERE lobby = 'xmatch' AND season = 'Sizzle Season 2026'
             )
             SELECT * FROM (
               SELECT '平均キル' AS 指標, キル AS 相関係数, 件数 FROM 相関
               UNION ALL SELECT '平均デス', デス, 件数 FROM 相関
               UNION ALL SELECT '平均アシスト', アシスト, 件数 FROM 相関
               UNION ALL SELECT '平均塗り', 塗り, 件数 FROM 相関
             ) ORDER BY ABS(相関係数) DESC";
        // season にはインデックスが無い。source_date（複合インデックスの先頭）なら効くはず。
        let by_date = |s: &str| {
            s.replace(
                "season = 'Sizzle Season 2026'",
                "source_date >= '2026-06-01'",
            )
        };
        for (label, sql) in [
            ("4分岐 + season", branches.to_string()),
            ("1スキャン + season", one_pass.to_string()),
            ("4分岐 + source_date", by_date(branches)),
            ("1スキャン + source_date", by_date(one_pass)),
        ] {
            let t = Instant::now();
            let r = sqlx::query(&sql).fetch_all(&pool).await;
            println!("{label}: {:?} / {:?}", t.elapsed(), r.map(|v| v.len()));
        }
        // 環境分析の起動時に直列で待つ選択肢の取得コスト。
        // シーズンのプルダウンがこれらの後ろにあると、その間ずっと出てこない。
        for (label, sql) in [
            ("env_versions 相当", "SELECT game_ver, COUNT(*) FROM env_battles GROUP BY game_ver"),
            ("env_ranks 相当", "SELECT poster_rank, COUNT(*) FROM env_battles GROUP BY poster_rank"),
        ] {
            let t = Instant::now();
            let r = sqlx::query(sql).fetch_all(&pool).await;
            println!("{label}: {:?} / {:?}", t.elapsed(), r.map(|v| v.len()));
        }

        // 画面のシーズン選択（#585）に出る一覧を確かめる。
        for (label, sql) in [
            ("env", "SELECT MIN(source_date), MAX(source_date) FROM env_battles"),
            ("battle", "SELECT MIN(substr(played_at,1,10)), MAX(substr(played_at,1,10)) FROM battle"),
        ] {
            let (min, max): (Option<String>, Option<String>) =
                sqlx::query_as(sql).fetch_one(&pool).await.unwrap();
            println!("--- list_seasons({label}) {min:?}〜{max:?} ---");
            if let (Some(a), Some(b)) = (min, max) {
                for s in crate::season::seasons_in(&a, &b, 24).iter().take(5) {
                    println!("  {} : {} 〜 {}", s.name, s.since, s.until);
                }
            }
        }

        let t = Instant::now();
        let rows = sqlx::query(
            "SELECT season, COUNT(*) AS n, MIN(source_date) AS d0, MAX(source_date) AS d1
             FROM env_battles GROUP BY season ORDER BY d1 DESC LIMIT 6",
        )
        .fetch_all(&pool)
        .await
        .unwrap();
        println!("--- season（新しい順・{:?}）---", t.elapsed());
        for r in &rows {
            println!(
                "  {:?} n={} {:?}〜{:?}",
                r.get::<Option<String>, _>("season"),
                r.get::<i64, _>("n"),
                r.get::<Option<String>, _>("d0"),
                r.get::<Option<String>, _>("d1")
            );
        }
    }

    /// 実データでの計測用（普段は走らせない）。
    ///
    /// テスト DB は小さいので「実行できる」テストだけでは**遅さに気付けない**。
    /// プロンプトの実例を変えたら、実 DB で時間を測って `QUERY_TIMEOUT` に収まるか見る。
    ///
    /// ```text
    /// SPLABO_DB=<db path> cargo test --lib 実データ計測 -- --ignored --nocapture
    /// ```
    ///
    /// 2026-07-30 の計測（env_battles 554 万件）:
    /// 全期間の使用率集計 77 秒 / 直近 30 日 0.7 秒 / 直近 90 日 2.6 秒 /
    /// `MAX(source_date)` はビュー経由 113 秒・基底表 0.5 ミリ秒。
    #[tokio::test]
    #[ignore]
    async fn 実データ計測() {
        use std::time::Instant;
        let path = std::env::var("SPLABO_DB").unwrap();
        let opts = sqlx::sqlite::SqliteConnectOptions::new()
            .filename(&path)
            .read_only(true);
        // 本番と同じく統計関数を登録する（corr を使う実例が測れない）。
        let pool = SqlitePoolOptions::new()
            .after_connect(|conn, _meta| {
                Box::pin(async move {
                    let mut handle = conn.lock_handle().await?;
                    let failed =
                        unsafe { crate::sql_functions::register_all(handle.as_raw_handle().as_ptr()) };
                    assert!(failed.is_empty(), "統計関数の登録に失敗: {failed:?}");
                    Ok(())
                })
            })
            .connect_with(opts)
            .await
            .unwrap();

        for (label, sql) in [
            ("env_battles 件数", "SELECT COUNT(*) FROM env_battles"),
            ("battle 件数", "SELECT COUNT(*) FROM battle"),
        ] {
            let t = Instant::now();
            let n: i64 = sqlx::query_scalar(sql).fetch_one(&pool).await.unwrap();
            println!("{label}: {n} ({:?})", t.elapsed());
        }

        let win = "SELECT poster_rank, weapon, COUNT(*) AS c,
                   ROUND(COUNT(*) * 100.0 / SUM(COUNT(*)) OVER (PARTITION BY poster_rank), 2)
                   FROM ai_env_slots WHERE poster_rank IS NOT NULL
                   GROUP BY poster_rank, weapon ORDER BY 4 DESC LIMIT 10";
        let t = Instant::now();
        let rows = sqlx::query(win).fetch_all(&pool).await;
        println!("ウィンドウ関数版: {:?} / {:?}", t.elapsed(), rows.map(|r| r.len()));

        let recent = "SELECT poster_rank, weapon, COUNT(*) AS c
                      FROM ai_env_slots WHERE poster_rank IS NOT NULL
                      AND source_date >= date('now', '-30 days')
                      GROUP BY poster_rank, weapon ORDER BY c DESC LIMIT 10";
        let t = Instant::now();
        let rows = sqlx::query(recent).fetch_all(&pool).await;
        println!("直近30日版: {:?} / {:?}", t.elapsed(), rows.map(|r| r.len()));

        for (label, sql) in [
            ("MAX(source_date) 基底表", "SELECT MAX(source_date) FROM env_battles"),
            ("MIN(source_date) 基底表", "SELECT MIN(source_date) FROM env_battles"),
            ("MAX(source_date) ビュー", "SELECT MAX(source_date) FROM ai_env_slots"),
        ] {
            let t = Instant::now();
            let v: Result<Option<String>, _> = sqlx::query_scalar(sql).fetch_one(&pool).await;
            println!("{label}: {:?} ({:?})", v, t.elapsed());
        }

        let win30 = "SELECT poster_rank, weapon, COUNT(*) AS c,
                     ROUND(COUNT(*) * 100.0 / SUM(COUNT(*)) OVER (PARTITION BY poster_rank), 2)
                     FROM ai_env_slots
                     WHERE poster_rank IS NOT NULL AND source_date >= date('now', '-30 days')
                     GROUP BY poster_rank, weapon ORDER BY 4 DESC LIMIT 10";
        let t = Instant::now();
        let rows = sqlx::query(win30).fetch_all(&pool).await;
        println!("ウィンドウ関数+30日: {:?} / {:?}", t.elapsed(), rows.map(|r| r.len()));

        let win90 = win30.replace("-30 days", "-90 days");
        let t = Instant::now();
        let rows = sqlx::query(&win90).fetch_all(&pool).await;
        println!("ウィンドウ関数+90日: {:?} / {:?}", t.elapsed(), rows.map(|r| r.len()));

        // 🔴 実機で守られなかった指定「行はパワー帯、列は順位 1〜5」を、
        // AI① の実例 SQL（縦長）+ PresentationSpec で**本当に作れるか**を通しで確かめる。
        // これが第 1 段 B の成立条件。
        {
            let (_, sql) = crate::ai_views::SQL_EXAMPLES
                .iter()
                .find(|(q, _)| q.contains("Xパワー"))
                .expect("Xパワー帯の実例が無い");
            let rows = sqlx::query(sql).fetch_all(&pool).await.unwrap();
            let columns: Vec<String> = rows[0]
                .columns()
                .iter()
                .map(|c| c.name().to_string())
                .collect();
            let values: Vec<Vec<serde_json::Value>> = rows
                .iter()
                .map(|r| (0..r.len()).map(|i| value_at(r, i)).collect())
                .collect();

            let spec: crate::ai_present::PresentationSpec = serde_json::from_str(
                r#"{"shape":"pivot","title":"Xパワー帯ごとの勝率上位ブキ",
                    "row_key":"Xパワー帯","column_key":"順位","column_suffix":"位",
                    "cell_template":"{ブキ} {勝率}%"}"#,
            )
            .unwrap();

            let crate::ai_present::Presentation::Table(t) =
                crate::ai_present::apply(&columns, &values, &spec).unwrap()
            else {
                panic!("表を期待したのにグラフが返った")
            };
            println!("\n=== 通し確認: 行 = パワー帯 / 列 = 順位 ===");
            println!("{}", t.columns.join(" | "));
            for r in t.rows.iter().take(6) {
                println!(
                    "{}",
                    r.iter()
                        .map(|v| match v {
                            serde_json::Value::String(s) => s.clone(),
                            serde_json::Value::Null => "-".into(),
                            other => other.to_string(),
                        })
                        .collect::<Vec<_>>()
                        .join(" | ")
                );
            }
            println!("警告: {:?}\n", t.warnings);
        }

        // グラフ（#587）も同じ縦長の結果から作れるかを実データで通す。
        {
            let (_, sql) = crate::ai_views::SQL_EXAMPLES
                .iter()
                .find(|(q, _)| q.contains("ウデマエ帯"))
                .expect("ウデマエ帯の実例が無い");
            let rows = sqlx::query(sql).fetch_all(&pool).await.unwrap();
            let columns: Vec<String> =
                rows[0].columns().iter().map(|c| c.name().to_string()).collect();
            let values: Vec<Vec<serde_json::Value>> = rows
                .iter()
                .map(|r| (0..r.len()).map(|i| value_at(r, i)).collect())
                .collect();

            let spec: crate::ai_present::PresentationSpec = serde_json::from_str(
                r#"{"shape":"bar","title":"ウデマエ帯ごとの使用率","x":"ブキ","y":"使用率","series":"ウデマエ"}"#,
            )
            .unwrap();
            let crate::ai_present::Presentation::Chart(c) =
                crate::ai_present::apply(&columns, &values, &spec).unwrap()
            else {
                panic!("グラフを期待したのに表が返った")
            };
            println!("=== 通し確認: 棒グラフ ===");
            println!("x={} y={} 数値軸={}", c.x_label, c.y_label, c.x_numeric);
            for s in &c.series {
                println!("  系列 {}: {} 点 先頭={:?}", s.name, s.points.len(), s.points.first());
            }
            println!("警告: {:?}\n", c.warnings);
        }

        // プロンプトに載せている実例そのものを、実データで計測する。
        // ここが QUERY_TIMEOUT を超えていたら実例が壊れている。
        for (q, sql) in crate::ai_views::SQL_EXAMPLES {
            let t = Instant::now();
            let rows = sqlx::query(sql).fetch_all(&pool).await;
            let el = t.elapsed();
            println!(
                "実例「{q}」: {:?} / {:?}{}",
                el,
                rows.map(|r| r.len()),
                if el > QUERY_TIMEOUT { "  ← 制限超過" } else { "" }
            );
        }
    }

    #[test]
    fn ビューを使っていないエラーには一覧を付けない() {
        let out = classify_error("no such column: foo", "SELECT foo");
        assert_eq!(out, "no such column: foo");
    }

    /// 拒否列の一覧に、AI 用ビューが使っている列が混ざっていないか。
    /// 混ざるとビューを引いた瞬間に全部落ちる。
    #[test]
    fn 拒否列が_ai_用ビューの列と衝突しない() {
        for (_, col) in DENIED_COLUMNS {
            for v in crate::ai_views::AI_VIEWS {
                assert!(
                    !v.columns.iter().any(|(c, _)| c == col),
                    "拒否列 {col} が {} の列と衝突している",
                    v.name
                );
            }
        }
    }
}
