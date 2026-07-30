//! SQLite に統計関数を足す（#573）。
//!
//! AI に分析コードを書かせる土台。「勝率と最も相関の高い指標は？」のような問いを
//! **SQL で書けるようにする**のが目的。SQLite には `corr` も `stddev` も無い。
//!
//! ```sql
//! SELECT 'death' AS metric, corr(won, death) AS r FROM ai_battles
//! UNION ALL SELECT 'kill',  corr(won, kill)  FROM ai_battles
//! ORDER BY abs(r) DESC
//! ```
//!
//! # なぜ FFI を直に触るのか
//!
//! sqlx には関数登録の API が無いので、`LockedSqliteHandle::as_raw_handle()` で生の
//! `sqlite3*` を取り、`sqlite3_create_function_v2` を呼ぶ。sqlx 自身が `regexp` 機能を
//! 同じ方法で実装している（`sqlx-sqlite/src/regexp.rs`）ので、それに倣う。
//! `libsqlite3-sys` は sqlx 経由で既に依存ツリーに入っており、`bundled` 済みなので
//! 直接依存に足しても同じ SQLite にリンクされる。
//!
//! # NULL の扱い
//!
//! **引数に NULL がある行は母数から外す。** SQLite の組み込み集約（`AVG` 等）と同じ挙動。
//! これは意図した設計で、AI 用ビューは
//!
//! - 引き分けを `won = NULL`
//! - 0 除算になる比率を NULL
//!
//! で表現する（#572）。おかげで `corr(won, death)` と素朴に書くだけで引き分けが
//! 自動的に除外される。「引き分けを除いてください」と AI に伝える必要がない。
//!
//! # 数値の安定性
//!
//! 素朴に Σx / Σx² を足し込むと、`inked`（数十万）の二乗和で桁が溢れて精度が落ちる。
//! Welford のオンライン算法（平均と二次モーメントを逐次更新）を使う。

use libsqlite3_sys as ffi;
use std::os::raw::c_int;

/// 二変量の逐次統計量。`sqlite3_aggregate_context` がゼロ初期化して返すため、
/// **全ゼロが妥当な初期状態**であること（= `Default` と一致）が前提。
#[repr(C)]
#[derive(Clone, Copy, Default)]
struct Acc {
    n:      f64,
    mean_x: f64,
    mean_y: f64,
    /// Σ(x - x̄)²
    m2_x:   f64,
    /// Σ(y - ȳ)²
    m2_y:   f64,
    /// Σ(x - x̄)(y - ȳ)
    c_xy:   f64,
}

impl Acc {
    /// Welford の更新。`m2_y` / `c_xy` は y を使う関数のときだけ意味を持つ。
    fn push(&mut self, x: f64, y: f64) {
        self.n += 1.0;
        let dx = x - self.mean_x;
        self.mean_x += dx / self.n;
        let dy = y - self.mean_y;
        self.mean_y += dy / self.n;
        self.m2_x += dx * (x - self.mean_x);
        self.m2_y += dy * (y - self.mean_y);
        // 🔴 更新後の mean_y を使う。更新前を使うと共分散がずれる。
        self.c_xy += dx * (y - self.mean_y);
    }

    /// 標本分散（n-1 で割る）。2 件未満は None。
    fn variance(&self) -> Option<f64> {
        if self.n < 2.0 {
            return None;
        }
        Some(self.m2_x / (self.n - 1.0))
    }

    /// ピアソン相関。2 件未満、またはどちらかの分散が 0 なら None（定義できない）。
    fn corr(&self) -> Option<f64> {
        if self.n < 2.0 {
            return None;
        }
        let d = self.m2_x * self.m2_y;
        if d <= 0.0 {
            return None;
        }
        // (n-1) は分子・分母で打ち消えるのでそのまま割れる。
        Some(self.c_xy / d.sqrt())
    }

    /// 回帰直線の傾き。`regr_slope(y, x)` の呼び出し順に合わせ、x が説明変数。
    fn slope(&self) -> Option<f64> {
        if self.n < 2.0 || self.m2_x <= 0.0 {
            return None;
        }
        Some(self.c_xy / self.m2_x)
    }
}

/// この集約関数が引数を何個取り、何を返すか。
///
/// 🔴 判別値を **user data（ポインタ）に詰めて xStep / xFinal へ渡す**ので、
/// 値は明示しておくこと。並び替えで暗黙の判別値が変わると、別の関数として振る舞う。
#[derive(Clone, Copy)]
#[repr(usize)]
enum Kind {
    /// `corr(x, y)`
    Corr = 0,
    /// `variance(x)` — 標本分散
    Variance = 1,
    /// `stddev(x)` — 標本標準偏差
    Stddev = 2,
    /// `regr_slope(y, x)`
    RegrSlope = 3,
    /// `regr_intercept(y, x)`
    RegrIntercept = 4,
}

impl Kind {
    fn n_args(self) -> c_int {
        match self {
            Kind::Variance | Kind::Stddev => 1,
            Kind::Corr | Kind::RegrSlope | Kind::RegrIntercept => 2,
        }
    }

    /// 登録名（`sqlite3_create_function_v2` は 0 終端を要求する）。
    fn name(self) -> &'static [u8] {
        match self {
            Kind::Corr => b"corr\0",
            Kind::Variance => b"variance\0",
            Kind::Stddev => b"stddev\0",
            Kind::RegrSlope => b"regr_slope\0",
            Kind::RegrIntercept => b"regr_intercept\0",
        }
    }

    fn finalize(self, acc: &Acc) -> Option<f64> {
        match self {
            Kind::Corr => acc.corr(),
            Kind::Variance => acc.variance(),
            Kind::Stddev => acc.variance().map(f64::sqrt),
            Kind::RegrSlope => acc.slope(),
            // ȳ - slope * x̄
            Kind::RegrIntercept => acc.slope().map(|s| acc.mean_y - s * acc.mean_x),
        }
    }
}

const KINDS: &[Kind] = &[
    Kind::Corr,
    Kind::Variance,
    Kind::Stddev,
    Kind::RegrSlope,
    Kind::RegrIntercept,
];

/// AI に渡す関数の説明。**登録している関数と一致していること**をテストで検証する。
///
/// プロンプトに手書きの一覧を別に持つと、関数を足したときに書き忘れる。
pub const FUNCTION_DOCS: &[(&str, &str)] = &[
    ("corr(x, y)", "ピアソン相関。-1〜1。符号は向き、絶対値は強さ"),
    ("variance(x)", "標本分散（n-1 で割る）"),
    ("stddev(x)", "標本標準偏差"),
    ("regr_slope(y, x)", "回帰直線の傾き。**説明変数は第 2 引数**"),
    ("regr_intercept(y, x)", "回帰直線の切片"),
];

/// 生の接続ハンドルに全関数を登録する。
///
/// 失敗した関数名を返す（呼び出し側でログに出す用）。1 つ失敗しても残りは登録を試みる。
///
/// # Safety
///
/// `db` は有効な `sqlite3*` でなければならない。`LockedSqliteHandle` を保持している間に
/// 呼ぶこと（ロックを離すと他スレッドが同じ接続を触りうる）。
pub unsafe fn register_all(db: *mut ffi::sqlite3) -> Vec<&'static str> {
    let mut failed = Vec::new();
    for kind in KINDS {
        if register(db, *kind) != ffi::SQLITE_OK {
            // 名前は 0 終端を含むので落とす。
            let name = kind.name();
            failed.push(std::str::from_utf8(&name[..name.len() - 1]).unwrap_or("?"));
        }
    }
    failed
}

unsafe fn register(db: *mut ffi::sqlite3, kind: Kind) -> c_int {
    // xStep / xFinal から「どの関数か」を知るために、Kind を user data として渡す。
    // Kind は Copy な小さい enum なので、ポインタ幅に詰めて持たせる（解放不要）。
    let user_data = kind as usize as *mut std::os::raw::c_void;
    ffi::sqlite3_create_function_v2(
        db,
        kind.name().as_ptr().cast(),
        kind.n_args(),
        // 同じ入力なら同じ結果。UTF8 指定は文字列を扱わなくても定石。
        ffi::SQLITE_UTF8 | ffi::SQLITE_DETERMINISTIC,
        user_data,
        // xFunc = None で集約関数として登録する。
        None,
        Some(x_step),
        Some(x_final),
        None,
    )
}

/// `Kind` を user data から復元する。`register` が詰めた値をそのまま戻す。
unsafe fn kind_of(ctx: *mut ffi::sqlite3_context) -> Kind {
    match ffi::sqlite3_user_data(ctx) as usize {
        0 => Kind::Corr,
        1 => Kind::Variance,
        2 => Kind::Stddev,
        3 => Kind::RegrSlope,
        _ => Kind::RegrIntercept,
    }
}

unsafe extern "C" fn x_step(
    ctx:   *mut ffi::sqlite3_context,
    argc:  c_int,
    argv:  *mut *mut ffi::sqlite3_value,
) {
    let kind = kind_of(ctx);
    let expected = kind.n_args();
    if argc != expected {
        return;
    }

    // NULL を含む行は母数から外す（組み込み集約と同じ挙動・モジュール冒頭の説明参照）。
    let mut vals = [0.0_f64; 2];
    for i in 0..expected {
        let v = *argv.offset(i as isize);
        if ffi::sqlite3_value_type(v) == ffi::SQLITE_NULL {
            return;
        }
        let d = ffi::sqlite3_value_double(v);
        // TEXT が数値にならなかった場合など。NaN/∞ を混ぜると以降の統計が全部壊れる。
        if !d.is_finite() {
            return;
        }
        vals[i as usize] = d;
    }

    let acc = ffi::sqlite3_aggregate_context(ctx, std::mem::size_of::<Acc>() as c_int) as *mut Acc;
    if acc.is_null() {
        // メモリ確保に失敗している。SQLite が別途エラーにするのでここでは何もしない。
        return;
    }

    // `corr(x, y)` は x が第 1 引数。`regr_slope(y, x)` は **説明変数が第 2 引数**なので
    // 入れ替えて Acc の x に説明変数を入れる（Postgres の引数順に合わせている）。
    let (x, y) = match kind {
        Kind::Variance | Kind::Stddev => (vals[0], 0.0),
        Kind::Corr => (vals[0], vals[1]),
        Kind::RegrSlope | Kind::RegrIntercept => (vals[1], vals[0]),
    };
    (*acc).push(x, y);
}

unsafe extern "C" fn x_final(ctx: *mut ffi::sqlite3_context) {
    let kind = kind_of(ctx);
    // サイズ 0 は「確保せず、既にあれば返す」。xStep が一度も呼ばれていなければ null。
    let acc = ffi::sqlite3_aggregate_context(ctx, 0) as *mut Acc;
    let result = if acc.is_null() {
        None
    } else {
        kind.finalize(&*acc)
    };
    match result {
        Some(v) if v.is_finite() => ffi::sqlite3_result_double(ctx, v),
        // 定義できない（件数不足・分散 0）ときは NULL。0 を返すと「相関なし」と読めてしまう。
        _ => ffi::sqlite3_result_null(ctx),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Welford の実装が既知の値と合うか。SQL を経由せず Acc だけ検算する。
    fn acc_of(pairs: &[(f64, f64)]) -> Acc {
        let mut a = Acc::default();
        for &(x, y) in pairs {
            a.push(x, y);
        }
        a
    }

    /// 登録した関数がすべてプロンプト用の説明に載っているか。
    /// 関数を足して説明を書き忘れると、AI はその関数を知らないままになる。
    #[test]
    fn 登録した関数がすべて説明されている() {
        for kind in KINDS {
            let name = kind.name();
            let name = std::str::from_utf8(&name[..name.len() - 1]).unwrap();
            assert!(
                FUNCTION_DOCS.iter().any(|(sig, _)| sig.starts_with(name)),
                "{name} の説明が FUNCTION_DOCS に無い"
            );
        }
        assert_eq!(FUNCTION_DOCS.len(), KINDS.len(), "説明の数と登録数が合わない");
    }

    #[test]
    fn 完全な正の相関は1になる() {
        let a = acc_of(&[(1.0, 2.0), (2.0, 4.0), (3.0, 6.0), (4.0, 8.0)]);
        let r = a.corr().unwrap();
        assert!((r - 1.0).abs() < 1e-12, "r = {r}");
    }

    #[test]
    fn 完全な負の相関は_マイナス1になる() {
        let a = acc_of(&[(1.0, 8.0), (2.0, 6.0), (3.0, 4.0), (4.0, 2.0)]);
        let r = a.corr().unwrap();
        assert!((r + 1.0).abs() < 1e-12, "r = {r}");
    }

    #[test]
    fn 既知の相関係数と一致する() {
        // x = [1,2,3,4,5], y = [2,4,5,4,5] は教科書的な例で r = 0.7745966692414834
        let a = acc_of(&[(1.0, 2.0), (2.0, 4.0), (3.0, 5.0), (4.0, 4.0), (5.0, 5.0)]);
        let r = a.corr().unwrap();
        assert!((r - 0.774_596_669_241_483_4).abs() < 1e-12, "r = {r}");
    }

    #[test]
    fn 標本分散と標準偏差が既知の値と一致する() {
        // [2,4,4,4,5,5,7,9] の標本分散は 4.571428571428571、標準偏差は約 2.13809
        let a = acc_of(&[
            (2.0, 0.0), (4.0, 0.0), (4.0, 0.0), (4.0, 0.0),
            (5.0, 0.0), (5.0, 0.0), (7.0, 0.0), (9.0, 0.0),
        ]);
        let v = a.variance().unwrap();
        assert!((v - 4.571_428_571_428_571).abs() < 1e-12, "variance = {v}");
        let s = v.sqrt();
        assert!((s - 2.138_089_935_299_395).abs() < 1e-12, "stddev = {s}");
    }

    #[test]
    fn 回帰の傾きと切片が既知の値と一致する() {
        // y = 2x + 1 上の点なら slope = 2 / intercept = 1
        // Acc の x が説明変数なので (x, y) の順で入れる
        let a = acc_of(&[(1.0, 3.0), (2.0, 5.0), (3.0, 7.0), (4.0, 9.0)]);
        let slope = a.slope().unwrap();
        assert!((slope - 2.0).abs() < 1e-12, "slope = {slope}");
        let intercept = a.mean_y - slope * a.mean_x;
        assert!((intercept - 1.0).abs() < 1e-12, "intercept = {intercept}");
    }

    #[test]
    fn 件数不足では定義できない() {
        assert!(Acc::default().variance().is_none());
        assert!(Acc::default().corr().is_none());
        assert!(acc_of(&[(1.0, 2.0)]).variance().is_none());
        assert!(acc_of(&[(1.0, 2.0)]).corr().is_none());
    }

    #[test]
    fn 分散0の軸との相関は定義できない() {
        // y が全部同じ = 分散 0。0 除算にせず None を返す
        let a = acc_of(&[(1.0, 5.0), (2.0, 5.0), (3.0, 5.0)]);
        assert!(a.corr().is_none());
        // x 側が定数なら傾きも定義できない
        let b = acc_of(&[(5.0, 1.0), (5.0, 2.0), (5.0, 3.0)]);
        assert!(b.slope().is_none());
    }

    /// 統計関数が **SQL 経由で呼べる**か。FFI の配線（登録・user data の復元・
    /// 集約コンテキスト）が効いていることを確認する。Acc の単体テストでは分からない部分。
    #[tokio::test]
    async fn sqlから呼び出せて_null行が母数から外れる() {
        use sqlx::sqlite::SqlitePoolOptions;

        // 🔴 メモリ DB は接続ごとに別物になるので、接続を 1 本に固定する。
        let pool = SqlitePoolOptions::new()
            .max_connections(1)
            .after_connect(|conn, _meta| {
                Box::pin(async move {
                    let mut handle = conn.lock_handle().await?;
                    let failed = unsafe { register_all(handle.as_raw_handle().as_ptr()) };
                    assert!(failed.is_empty(), "登録に失敗: {failed:?}");
                    Ok(())
                })
            })
            .connect("sqlite::memory:")
            .await
            .unwrap();

        sqlx::query("CREATE TABLE t (x REAL, y REAL)").execute(&pool).await.unwrap();
        for (x, y) in [(1.0, 2.0), (2.0, 4.0), (3.0, 6.0), (4.0, 8.0)] {
            sqlx::query("INSERT INTO t VALUES (?, ?)")
                .bind(x).bind(y).execute(&pool).await.unwrap();
        }

        let r: f64 = sqlx::query_scalar("SELECT corr(x, y) FROM t").fetch_one(&pool).await.unwrap();
        assert!((r - 1.0).abs() < 1e-12, "corr = {r}");

        let s: f64 = sqlx::query_scalar("SELECT stddev(x) FROM t").fetch_one(&pool).await.unwrap();
        assert!((s - 1.290_994_448_735_805_6).abs() < 1e-12, "stddev = {s}");

        let slope: f64 = sqlx::query_scalar("SELECT regr_slope(y, x) FROM t").fetch_one(&pool).await.unwrap();
        assert!((slope - 2.0).abs() < 1e-12, "slope = {slope}");

        // NULL を含む行は母数から外れる。AI 用ビューが引き分けを won = NULL で表すため、
        // ここが崩れると勝敗と各指標の相関が静かにずれる(#572)。
        sqlx::query("INSERT INTO t VALUES (5.0, NULL)").execute(&pool).await.unwrap();
        let r2: f64 = sqlx::query_scalar("SELECT corr(x, y) FROM t").fetch_one(&pool).await.unwrap();
        assert!((r2 - 1.0).abs() < 1e-12, "NULL 行が母数に混ざっている: corr = {r2}");

        // 件数不足・分散 0 は NULL（0 を返すと「相関なし」と誤読される）。
        let one: Option<f64> = sqlx::query_scalar("SELECT corr(x, y) FROM t WHERE x = 1")
            .fetch_one(&pool).await.unwrap();
        assert!(one.is_none(), "1 件なら NULL のはず: {one:?}");
        let empty: Option<f64> = sqlx::query_scalar("SELECT stddev(x) FROM t WHERE x < 0")
            .fetch_one(&pool).await.unwrap();
        assert!(empty.is_none(), "0 件なら NULL のはず: {empty:?}");
    }

    #[test]
    fn 大きな値でも精度が落ちない() {
        // inked は数十万のオーダー。素朴な Σx² だと桁が溢れて分散がずれる。
        // 平均 300000・差が ±1 の系列で、標本分散が 1.0 になることを確認する。
        let a = acc_of(&[(299_999.0, 0.0), (300_000.0, 0.0), (300_001.0, 0.0)]);
        let v = a.variance().unwrap();
        assert!((v - 1.0).abs() < 1e-9, "variance = {v}");
    }
}
