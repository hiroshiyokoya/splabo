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
use serde::Serialize;
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
#[derive(Debug, Serialize)]
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

/// AI に渡すプロンプトの土台（ビュー一覧 + ドメイン知識）をフロントへ返す。
///
/// フロント側で組み立てず Rust から取るのは、**ビュー定義とプロンプトを 1 つの出力元に
/// 保つ**ため（`ai_views::AI_VIEWS` が唯一の正）。
#[tauri::command]
pub fn ai_analysis_prompt() -> String {
    crate::ai_views::analysis_prompt()
}

/// AI が書いた SELECT を実行する。
#[tauri::command]
pub async fn ai_run_sql(app: AppHandle, sql: String) -> Result<AnalysisResult, String> {
    run_analysis_sql(&app, &sql).await
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
            "クエリが {} 秒を超えたため中断しました。絞り込みを足すか、集計を軽くしてください",
            QUERY_TIMEOUT.as_secs()
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
