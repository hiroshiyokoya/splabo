//! シーズン名と日付範囲の対応（#585）。
//!
//! # なぜ計算するのか
//!
//! `env_battles.season` に stat.ink 由来のシーズン名が入っているが、**この列で絞ってはいけない。**
//! インデックスが無く、実測（554 万バトル）で相関 4 指標の集計が
//!
//! | 絞り方 | 時間 |
//! |---|---|
//! | `season = 'Sizzle Season 2026'` | 8.7 秒 |
//! | `source_date >= '2026-06-01'` | 0.59 秒 |
//!
//! と **15 倍**違う。シーズン名は表示に使い、**絞り込みは日付範囲に変換して行う**。
//!
//! # 境界は固定
//!
//! シーズンは **3 / 6 / 9 / 12 月の 1 日**に切り替わり、名前は Fresh → Sizzle → Drizzle → Chill。
//! 12 月開始のシーズンは翌年 2 月まで続くが、名前は**開始年**を使う
//! （Chill Season 2025 は 2025-12-01〜2026-02-28）。DB を引かずに求められる。

/// シーズンの名前と、その期間（`until` は**含む**）。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Season {
    pub name: String,
    /// 開始日（`YYYY-MM-DD`）。
    pub since: String,
    /// 終了日（`YYYY-MM-DD`）。次のシーズン開始日の前日。
    pub until: String,
}

/// 開始月 → 名前。
const NAMES: [(u32, &str); 4] = [(3, "Fresh"), (6, "Sizzle"), (9, "Drizzle"), (12, "Chill")];

/// `YYYY-MM-DD` を (年, 月, 日) に分ける。形が違えば None。
fn parse(date: &str) -> Option<(i32, u32, u32)> {
    let b = date.as_bytes();
    if b.len() < 10 || b[4] != b'-' || b[7] != b'-' {
        return None;
    }
    Some((
        date[0..4].parse().ok()?,
        date[5..7].parse().ok()?,
        date[8..10].parse().ok()?,
    ))
}

/// その日が属するシーズンの (開始年, 開始月)。
fn start_of(year: i32, month: u32) -> (i32, u32) {
    match month {
        // 1〜2 月は前年 12 月開始の Chill。
        1 | 2 => (year - 1, 12),
        3..=5 => (year, 3),
        6..=8 => (year, 6),
        9..=11 => (year, 9),
        _ => (year, 12),
    }
}

fn name_of(year: i32, month: u32) -> String {
    let base = NAMES.iter().find(|(m, _)| *m == month).map(|(_, n)| *n).unwrap_or("Unknown");
    format!("{base} Season {year}")
}

/// 次のシーズンの開始年・開始月。
fn next_start(year: i32, month: u32) -> (i32, u32) {
    if month == 12 {
        (year + 1, 3)
    } else {
        (year, month + 3)
    }
}

/// 月の日数。シーズン境界は 3/6/9/12 月なので、その前月（2/5/8/11 月）だけ正しければよいが、
/// 汎用に書いておく（閏年を含む）。
fn days_in(year: i32, month: u32) -> u32 {
    match month {
        1 | 3 | 5 | 7 | 8 | 10 | 12 => 31,
        4 | 6 | 9 | 11 => 30,
        _ => {
            if (year % 4 == 0 && year % 100 != 0) || year % 400 == 0 {
                29
            } else {
                28
            }
        }
    }
}

/// シーズン開始日の**前日**（= 前のシーズンの最終日）。
fn day_before(year: i32, month: u32) -> String {
    let (py, pm) = if month == 1 { (year - 1, 12) } else { (year, month - 1) };
    format!("{py:04}-{pm:02}-{:02}", days_in(py, pm))
}

/// その日が属するシーズン。
pub fn season_of(date: &str) -> Option<Season> {
    let (y, m, _) = parse(date)?;
    let (sy, sm) = start_of(y, m);
    let (ny, nm) = next_start(sy, sm);
    Some(Season {
        name: name_of(sy, sm),
        since: format!("{sy:04}-{sm:02}-01"),
        until: day_before(ny, nm),
    })
}

/// `min_date` 〜 `max_date` に重なるシーズンを**新しい順**に返す。
///
/// `limit` で件数を絞る（プロンプトに載せる用。全部並べても読まれない）。
pub fn seasons_in(min_date: &str, max_date: &str, limit: usize) -> Vec<Season> {
    let Some(newest) = season_of(max_date) else { return Vec::new() };
    let mut out = Vec::new();
    let mut cur = newest;
    while out.len() < limit {
        // データの開始より前に行き過ぎたら止める。
        if cur.until.as_str() < min_date {
            break;
        }
        let (y, m, _) = match parse(&cur.since) {
            Some(v) => v,
            None => break,
        };
        out.push(cur);
        // 1 つ前のシーズン = 開始日の前日が属するシーズン。
        let prev_day = day_before(y, m);
        match season_of(&prev_day) {
            Some(s) => cur = s,
            None => break,
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 実データ（`env_battles`）から読み取った値をそのまま期待値にする。
    ///
    /// 計算で求めているので、**実際の stat.ink の値とずれていないこと**が要。
    /// 2026-07-30 に DB を引いて確認した並び。
    #[test]
    fn 実データのシーズン名と期間に一致する() {
        for (date, name, since, until) in [
            ("2026-07-29", "Sizzle Season 2026", "2026-06-01", "2026-08-31"),
            ("2026-06-01", "Sizzle Season 2026", "2026-06-01", "2026-08-31"),
            ("2026-05-31", "Fresh Season 2026", "2026-03-01", "2026-05-31"),
            ("2026-03-01", "Fresh Season 2026", "2026-03-01", "2026-05-31"),
            // 12 月開始は翌年 2 月まで。名前は開始年。
            ("2026-02-28", "Chill Season 2025", "2025-12-01", "2026-02-28"),
            ("2026-01-15", "Chill Season 2025", "2025-12-01", "2026-02-28"),
            ("2025-12-01", "Chill Season 2025", "2025-12-01", "2026-02-28"),
            ("2025-11-30", "Drizzle Season 2025", "2025-09-01", "2025-11-30"),
            ("2025-06-15", "Sizzle Season 2025", "2025-06-01", "2025-08-31"),
        ] {
            let s = season_of(date).unwrap_or_else(|| panic!("{date} が読めない"));
            assert_eq!(s.name, name, "{date} の名前");
            assert_eq!(s.since, since, "{date} の開始");
            assert_eq!(s.until, until, "{date} の終了");
        }
    }

    /// 閏年の 2 月をまたぐシーズンの終端。
    #[test]
    fn 閏年の二月末を正しく出す() {
        // 2024 は閏年。
        assert_eq!(season_of("2024-01-10").unwrap().until, "2024-02-29");
        // 2100 は閏年ではない（400 で割れない）。
        assert_eq!(season_of("2100-01-10").unwrap().until, "2100-02-28");
    }

    /// データがある範囲のシーズンを新しい順に並べる。
    #[test]
    fn データの範囲のシーズンを新しい順に並べる() {
        let list = seasons_in("2025-09-01", "2026-07-29", 10);
        let names: Vec<&str> = list.iter().map(|s| s.name.as_str()).collect();
        assert_eq!(
            names,
            vec![
                "Sizzle Season 2026",
                "Fresh Season 2026",
                "Chill Season 2025",
                "Drizzle Season 2025",
            ]
        );
    }

    /// 件数で切れる（プロンプトに全部並べない）。
    #[test]
    fn 件数で切れる() {
        let list = seasons_in("2022-09-26", "2026-07-29", 3);
        assert_eq!(list.len(), 3);
        assert_eq!(list[0].name, "Sizzle Season 2026");
    }

    /// データの開始より前まで遡らない。
    #[test]
    fn データの開始より前は出さない() {
        let list = seasons_in("2026-06-01", "2026-07-29", 10);
        assert_eq!(list.len(), 1, "{list:?}");
        assert_eq!(list[0].name, "Sizzle Season 2026");
    }

    /// 壊れた日付で落ちない。
    #[test]
    fn 壊れた日付でも落ちない() {
        assert!(season_of("").is_none());
        assert!(season_of("2026-7-29").is_none());
        assert!(season_of("abcd-ef-gh").is_none());
        assert!(seasons_in("x", "y", 5).is_empty());
    }

    /// 隣り合うシーズンに隙間も重なりも無い。
    #[test]
    fn シーズンの境界に隙間が無い() {
        let list = seasons_in("2022-09-01", "2026-07-29", 20);
        for pair in list.windows(2) {
            // list は新しい順なので、pair[1] の翌日が pair[0] の開始日。
            let (y, m, _) = parse(&pair[0].since).unwrap();
            assert_eq!(
                pair[1].until,
                day_before(y, m),
                "{} と {} の間に隙間がある",
                pair[1].name,
                pair[0].name
            );
        }
    }
}
