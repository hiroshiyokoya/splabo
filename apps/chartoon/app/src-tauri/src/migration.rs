//! v2.0 統合時のデータ移行モジュール（Phase C・#242）。
//!
//! 旧 `com.chartoon.app` / `com.geartoon.app` の app data（戦績 SQLite・ギア DB・
//! 画像キャッシュ・store）を新 `com.splabo.app` 配下へ **非破壊コピー** する。
//!
//! # 設計原則
//! - **原本非破壊**: 旧ディレクトリは読み取りのみ。checkpoint も打たない
//!   （WAL `-wal`/`-shm` ごと 3 点セットでコピーする）。
//! - **tmp→rename**: `tmp-migration-<ts>/` に一旦コピーし、完成後に個別ファイルを
//!   移行先へ rename で確定する（部分コピー状態を残さない）。
//! - **マーカー**: `<new_root>/migration.json` があれば即 skip（二重移行防止）。
//! - **上書きしない**: 移行先に既存ファイルがあればスキップしてレポートに記録
//!   （既存 splabo データ優先）。
//! - **no-op 保証**: 移行元 == 移行先（識別子据え置きの dev 環境）のときは何もしない。
//!
//! # テスト
//! コアは `migrate(old_chartoon, old_geartoon, new_root)` のパス注入シグネチャで、
//! `app_data_dir` に依存せず tempdir で単体テストできる。Tauri 層
//! (`run_startup_migration`) はパス解決だけを行う。

use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

/// 移行結果マーカーのファイル名。`<new_root>/migration.json` に置く。
pub const MARKER_FILE: &str = "migration.json";

/// 旧 chartoon の識別子ディレクトリ名。
const OLD_CHARTOON_ID: &str = "com.chartoon.app";
/// 旧 geartoon の識別子ディレクトリ名。
const OLD_GEARTOON_ID: &str = "com.geartoon.app";

/// 移行元ごとの結果内訳。
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct SourceReport {
    /// コピーに成功したファイル数。
    pub copied_files: usize,
    /// コピーした総バイト数。
    pub copied_bytes: u64,
    /// 既存ファイルがあり上書きせずスキップした相対パス。
    pub skipped: Vec<String>,
    /// コピーに失敗した項目（相対パスとエラー文字列）。
    pub errors: Vec<String>,
}

/// 移行全体の結果。`migration.json` にシリアライズして記録する。
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct MigrationReport {
    /// 実際に移行を行ったか（false = clean / no-op / マーカー既存でスキップ）。
    pub migrated: bool,
    /// スキップ理由（no-op・マーカー既存など）。migrated=false のときのみ非 None。
    pub skip_reason: Option<String>,
    /// chartoon 由来の内訳（旧ディレクトリが存在した場合のみ Some）。
    pub chartoon: Option<SourceReport>,
    /// geartoon 由来の内訳（旧ディレクトリが存在した場合のみ Some）。
    pub geartoon: Option<SourceReport>,
    /// ギア `data/` の二重ソース解決で採用した側（"chartoon" / "geartoon"）。
    pub gear_source: Option<String>,
    /// ISO8601 タイムスタンプ。
    pub timestamp: String,
}

impl MigrationReport {
    fn now_ts() -> String {
        chrono::Utc::now().to_rfc3339()
    }

    fn skipped(reason: &str) -> Self {
        Self {
            migrated: false,
            skip_reason: Some(reason.to_string()),
            timestamp: Self::now_ts(),
            ..Default::default()
        }
    }
}

// ---------------------------------------------------------------------------
// コア: パス注入シグネチャ（単体テスト対象）
// ---------------------------------------------------------------------------

/// 旧ディレクトリから `new_root` へ非破壊コピー移行する。
///
/// - `old_chartoon` / `old_geartoon`: 旧識別子ディレクトリ（`None` or 非存在なら対象外）。
/// - `new_root`: 移行先（新識別子の app_data_dir）。
///
/// マーカー既存なら即 skip。移行元 == 移行先の場合も skip（no-op）。
/// 成功時は `new_root/migration.json` にレポートを書き込む。
pub fn migrate(
    old_chartoon: Option<&Path>,
    old_geartoon: Option<&Path>,
    new_root: &Path,
) -> MigrationReport {
    // マーカーがあれば二重移行を防止する。
    let marker = new_root.join(MARKER_FILE);
    if marker.exists() {
        return MigrationReport::skipped("marker-exists");
    }

    // 移行元が移行先と同じ（識別子据え置きの dev 環境）なら no-op。
    let same = |old: Option<&Path>| -> bool {
        old.map(|p| same_dir(p, new_root)).unwrap_or(false)
    };
    if same(old_chartoon) || same(old_geartoon) {
        return MigrationReport::skipped("noop-same-dir");
    }

    // 存在しない旧ディレクトリは対象外に落とす。
    let chartoon_src = old_chartoon.filter(|p| p.is_dir());
    let geartoon_src = old_geartoon.filter(|p| p.is_dir());

    if chartoon_src.is_none() && geartoon_src.is_none() {
        // clean 環境: 旧データ無し。マーカーも書かず即 return
        // （後で旧アプリのインストール→再起動で発火する余地を残す）。
        return MigrationReport::skipped("no-source");
    }

    let ts = chrono::Utc::now().format("%Y%m%d%H%M%S").to_string();
    let tmp_root = new_root.join(format!("tmp-migration-{ts}"));

    let mut report = MigrationReport {
        migrated: true,
        skip_reason: None,
        timestamp: MigrationReport::now_ts(),
        ..Default::default()
    };

    // --- chartoon 移行 -----------------------------------------------------
    if let Some(src) = chartoon_src {
        let mut sr = SourceReport::default();
        // 戦績 DB 3 点セット（WAL/SHM は無いこともある = エラー扱いしない）
        for name in ["chartoon.db", "chartoon.db-wal", "chartoon.db-shm"] {
            copy_file_if_exists(src, new_root, &tmp_root, Path::new(name), &mut sr);
        }
        // store（B2 の設定ミラー + legacy 認証 store）
        for name in ["settings.json", "auth.json"] {
            copy_file_if_exists(src, new_root, &tmp_root, Path::new(name), &mut sr);
        }
        // 画像キャッシュ（.gti）
        copy_dir_if_exists(src, new_root, &tmp_root, Path::new("images"), &mut sr);
        report.chartoon = Some(sr);
    }

    // --- ギア data/ の二重ソース解決 --------------------------------------
    // v0.7 ユーザーは chartoon 側 `data/` にもギア DB が生成されている。
    // geartoon 側 `data/` と両方あれば mtime の新しい方を採用する。
    let chartoon_gear = chartoon_src.map(|p| p.join("data")).filter(|p| p.is_dir());
    let geartoon_gear = geartoon_src.map(|p| p.join("data")).filter(|p| p.is_dir());
    let gear_pick = pick_gear_source(chartoon_gear.as_deref(), geartoon_gear.as_deref());

    if let Some((label, gear_dir)) = gear_pick {
        report.gear_source = Some(label.to_string());
        // 採用した data/ を移行先の data/ へコピー。base はその親（相対 "data" を保つため）。
        let base = gear_dir.parent().unwrap_or(gear_dir);
        // geartoon 側を採用した場合、その内訳は geartoon レポートへ。chartoon 側なら chartoon へ。
        let mut sr = SourceReport::default();
        copy_dir_if_exists(base, new_root, &tmp_root, Path::new("data"), &mut sr);
        match label {
            "chartoon" => merge_into(&mut report.chartoon, sr),
            _ => merge_into(&mut report.geartoon, sr),
        }
    }

    // --- geartoon 画像等（gear data 以外） ---------------------------------
    // 現行 geartoon の出力は data/ 配下（gear_db.bin + images/**/*.gti）に集約されて
    // いるため、上の data/ コピーで画像も含まれる。data/ 外に独立した images/ は無い。

    // tmp ディレクトリを掃除（rename 済みなので残骸のみ）。
    let _ = std::fs::remove_dir_all(&tmp_root);

    // マーカー書き込み（失敗しても移行自体は成立している）。
    if let Ok(json) = serde_json::to_string_pretty(&report) {
        if let Err(e) = std::fs::write(&marker, json) {
            log::warn!("[migration] マーカー書き込み失敗: {e}");
        }
    }

    report
}

/// ギア `data/` の二重ソースから採用する側を決める。
/// 両方あれば mtime（gear_db.bin 優先、無ければディレクトリ）の新しい方。
fn pick_gear_source<'a>(
    chartoon: Option<&'a Path>,
    geartoon: Option<&'a Path>,
) -> Option<(&'static str, &'a Path)> {
    match (chartoon, geartoon) {
        (Some(c), Some(g)) => {
            let cm = gear_mtime(c);
            let gm = gear_mtime(g);
            // 新しい方を採用。同点なら chartoon 優先（実コード側の生成元）。
            if gm > cm {
                Some(("geartoon", g))
            } else {
                Some(("chartoon", c))
            }
        }
        (Some(c), None) => Some(("chartoon", c)),
        (None, Some(g)) => Some(("geartoon", g)),
        (None, None) => None,
    }
}

/// ギア data ディレクトリの代表 mtime。`gear_db.bin` の mtime を優先し、
/// 無ければディレクトリ自身の mtime。取得できなければ UNIX_EPOCH。
fn gear_mtime(dir: &Path) -> std::time::SystemTime {
    let bin = dir.join("gear_db.bin");
    let target = if bin.exists() { bin } else { dir.to_path_buf() };
    std::fs::metadata(&target)
        .and_then(|m| m.modified())
        .unwrap_or(std::time::UNIX_EPOCH)
}

/// SourceReport を Option に統合する（既存があれば加算、無ければ new をセット）。
fn merge_into(slot: &mut Option<SourceReport>, add: SourceReport) {
    match slot {
        Some(existing) => {
            existing.copied_files += add.copied_files;
            existing.copied_bytes += add.copied_bytes;
            existing.skipped.extend(add.skipped);
            existing.errors.extend(add.errors);
        }
        None => *slot = Some(add),
    }
}

// ---------------------------------------------------------------------------
// コピーヘルパー（tmp→rename・非破壊・上書き回避）
// ---------------------------------------------------------------------------

/// 単一ファイルを非破壊コピーする。
/// `src_base/rel` を `tmp_base/rel` にコピー → `dst_base/rel` へ rename で確定。
/// 移行先に既存ファイルがあれば上書きせず skip 記録。src が無ければ何もしない。
fn copy_file_if_exists(
    src_base: &Path,
    dst_base: &Path,
    tmp_base: &Path,
    rel: &Path,
    report: &mut SourceReport,
) {
    let src = src_base.join(rel);
    if !src.is_file() {
        return;
    }
    let dst = dst_base.join(rel);
    if dst.exists() {
        report.skipped.push(rel.display().to_string());
        return;
    }
    if let Err(e) = copy_one(&src, tmp_base, dst_base, rel) {
        report.errors.push(format!("{}: {e}", rel.display()));
        return;
    }
    if let Ok(meta) = std::fs::metadata(&dst) {
        report.copied_bytes += meta.len();
    }
    report.copied_files += 1;
}

/// ディレクトリを再帰的に非破壊コピーする。個々のファイル単位で tmp→rename。
fn copy_dir_if_exists(
    src_base: &Path,
    dst_base: &Path,
    tmp_base: &Path,
    rel: &Path,
    report: &mut SourceReport,
) {
    let src = src_base.join(rel);
    if !src.is_dir() {
        return;
    }
    let mut files: Vec<PathBuf> = Vec::new();
    if let Err(e) = collect_files(&src, &mut files) {
        report.errors.push(format!("{}: 列挙失敗 {e}", rel.display()));
        return;
    }
    for abs in files {
        // src_base からの相対パスを保つ。
        let Ok(file_rel) = abs.strip_prefix(src_base) else {
            continue;
        };
        let dst = dst_base.join(file_rel);
        if dst.exists() {
            report.skipped.push(file_rel.display().to_string());
            continue;
        }
        if let Err(e) = copy_one(&abs, tmp_base, dst_base, file_rel) {
            report.errors.push(format!("{}: {e}", file_rel.display()));
            continue;
        }
        if let Ok(meta) = std::fs::metadata(&dst) {
            report.copied_bytes += meta.len();
        }
        report.copied_files += 1;
    }
}

/// 1 ファイルを tmp 経由でコピーし、rename で移行先へ確定する。
/// tmp と移行先は同一ボリューム（同じ new_root 配下）なので rename は原子的。
fn copy_one(src: &Path, tmp_base: &Path, dst_base: &Path, rel: &Path) -> std::io::Result<()> {
    let tmp = tmp_base.join(rel);
    let dst = dst_base.join(rel);
    if let Some(parent) = tmp.parent() {
        std::fs::create_dir_all(parent)?;
    }
    std::fs::copy(src, &tmp)?;
    if let Some(parent) = dst.parent() {
        std::fs::create_dir_all(parent)?;
    }
    std::fs::rename(&tmp, &dst)?;
    Ok(())
}

/// ディレクトリ配下のファイルを再帰的に集める。
fn collect_files(dir: &Path, out: &mut Vec<PathBuf>) -> std::io::Result<()> {
    for entry in std::fs::read_dir(dir)? {
        let entry = entry?;
        let path = entry.path();
        if path.is_dir() {
            collect_files(&path, out)?;
        } else if path.is_file() {
            out.push(path);
        }
    }
    Ok(())
}

/// 2 つのパスが同一ディレクトリを指すか（canonicalize ベース、失敗時は生比較）。
fn same_dir(a: &Path, b: &Path) -> bool {
    match (std::fs::canonicalize(a), std::fs::canonicalize(b)) {
        (Ok(ca), Ok(cb)) => ca == cb,
        _ => a == b,
    }
}

// ---------------------------------------------------------------------------
// Tauri 層: パス解決 + 起動時実行
// ---------------------------------------------------------------------------

/// 起動時にデータ移行を実行する。`lib.rs` の `.setup()` 冒頭・DB init より前に同期呼び出しする。
///
/// 旧識別子ディレクトリは `app_data_dir().parent().join(<旧識別子>)` で導出する
/// （識別子文字列の置換ではなく parent() ベースで OS 差を吸収する）。
pub fn run_startup_migration(app: &tauri::AppHandle) -> MigrationReport {
    use tauri::Manager;
    let new_root = match app.path().app_data_dir() {
        Ok(p) => p,
        Err(e) => {
            log::warn!("[migration] app_data_dir 解決失敗のため skip: {e}");
            return MigrationReport::skipped("no-app-data-dir");
        }
    };
    if let Err(e) = std::fs::create_dir_all(&new_root) {
        log::warn!("[migration] 移行先ディレクトリ作成失敗のため skip: {e}");
        return MigrationReport::skipped("mkdir-failed");
    }

    let parent = new_root.parent().map(|p| p.to_path_buf());
    let old_chartoon = parent.as_ref().map(|p| p.join(OLD_CHARTOON_ID));
    let old_geartoon = parent.as_ref().map(|p| p.join(OLD_GEARTOON_ID));

    let report = migrate(
        old_chartoon.as_deref(),
        old_geartoon.as_deref(),
        &new_root,
    );

    if report.migrated {
        log::info!(
            "[migration] 移行完了 chartoon={:?} geartoon={:?} gear_source={:?}",
            report.chartoon.as_ref().map(|r| r.copied_files),
            report.geartoon.as_ref().map(|r| r.copied_files),
            report.gear_source,
        );
    } else {
        log::info!("[migration] skip ({:?})", report.skip_reason);
    }
    report
}

/// 記録済みの `migration.json` を読み出す（フロントの移行完了トースト用）。
#[tauri::command]
pub fn get_migration_report(app: tauri::AppHandle) -> Option<MigrationReport> {
    use tauri::Manager;
    let root = app.path().app_data_dir().ok()?;
    let content = std::fs::read_to_string(root.join(MARKER_FILE)).ok()?;
    serde_json::from_str(&content).ok()
}

// ---------------------------------------------------------------------------
// 単体テスト
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::path::PathBuf;

    /// 一意な一時ディレクトリを作る（gear.rs のテスト流儀に合わせ tempfile 非依存）。
    fn temp_root(tag: &str) -> PathBuf {
        static COUNTER: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
        let n = COUNTER.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
        let dir = std::env::temp_dir().join(format!(
            "splabo_migration_test_{}_{}_{}",
            std::process::id(),
            tag,
            n
        ));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn write(path: &Path, content: &[u8]) {
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(path, content).unwrap();
    }

    /// 旧 chartoon 相当のディレクトリを作る（DB 3 点・store・画像）。
    fn make_chartoon(root: &Path) -> PathBuf {
        let dir = root.join("com.chartoon.app");
        write(&dir.join("chartoon.db"), b"MAIN-DB-DATA");
        write(&dir.join("chartoon.db-wal"), b"WAL-DATA-RECENT-BATTLES");
        write(&dir.join("chartoon.db-shm"), b"SHM-DATA");
        write(&dir.join("settings.json"), b"{\"ai\":\"key\"}");
        write(&dir.join("auth.json"), b"{\"session_token\":\"tok\"}");
        write(&dir.join("images").join("weapon").join("a.gti"), b"IMG-A");
        write(&dir.join("images").join("special").join("b.gti"), b"IMG-B");
        dir
    }

    /// 旧 geartoon 相当のディレクトリを作る（data/ に gear_db.bin + 画像）。
    fn make_geartoon(root: &Path) -> PathBuf {
        let dir = root.join("com.geartoon.app");
        write(&dir.join("data").join("gear_db.bin"), b"GEAR-DB-BIN");
        write(&dir.join("data").join("images").join("head").join("h.gti"), b"GEAR-IMG");
        dir
    }

    // ケース 1: clean（旧データ無し）→ 何もしない・マーカー無し。
    #[test]
    fn case_clean_no_source() {
        let base = temp_root("clean");
        let new_root = base.join("com.splabo.app");
        fs::create_dir_all(&new_root).unwrap();

        let report = migrate(
            Some(&base.join("com.chartoon.app")), // 非存在
            Some(&base.join("com.geartoon.app")), // 非存在
            &new_root,
        );

        assert!(!report.migrated);
        assert_eq!(report.skip_reason.as_deref(), Some("no-source"));
        // clean ではマーカーを書かない（後日旧アプリ導入→再起動で発火余地を残す）。
        assert!(!new_root.join(MARKER_FILE).exists());
    }

    // ケース 2: chartoon のみ → DB 3 点・store・画像がコピーされ、原本は不変。
    #[test]
    fn case_chartoon_only() {
        let base = temp_root("chartoon_only");
        let chartoon = make_chartoon(&base);
        let new_root = base.join("com.splabo.app");
        fs::create_dir_all(&new_root).unwrap();

        let report = migrate(Some(&chartoon), Some(&base.join("com.geartoon.app")), &new_root);

        assert!(report.migrated);
        let cr = report.chartoon.expect("chartoon report");
        // DB3 + store2 + 画像2 = 7 ファイル
        assert_eq!(cr.copied_files, 7, "copied files: {cr:?}");
        assert!(cr.errors.is_empty(), "errors: {:?}", cr.errors);

        // WAL 3 点セットが移行先に揃っている。
        assert!(new_root.join("chartoon.db").exists());
        assert!(new_root.join("chartoon.db-wal").exists());
        assert!(new_root.join("chartoon.db-shm").exists());
        // 画像も相対パスを保って揃う。
        assert!(new_root.join("images/weapon/a.gti").exists());
        assert!(new_root.join("images/special/b.gti").exists());
        // store も揃う。
        assert!(new_root.join("settings.json").exists());
        assert!(new_root.join("auth.json").exists());

        // 内容一致（コピーが正しい）。
        assert_eq!(fs::read(new_root.join("chartoon.db-wal")).unwrap(), b"WAL-DATA-RECENT-BATTLES");

        // 非破壊: 原本が残っている。
        assert!(chartoon.join("chartoon.db").exists());
        assert!(chartoon.join("chartoon.db-wal").exists());
        assert_eq!(fs::read(chartoon.join("chartoon.db")).unwrap(), b"MAIN-DB-DATA");

        // tmp ディレクトリは残っていない（rename 済み + 掃除）。
        let leftover: Vec<_> = fs::read_dir(&new_root)
            .unwrap()
            .filter_map(|e| e.ok())
            .filter(|e| e.file_name().to_string_lossy().starts_with("tmp-migration-"))
            .collect();
        assert!(leftover.is_empty(), "tmp dir leftover: {leftover:?}");

        // マーカーが書かれ、migrated=true が記録されている。
        let marker = new_root.join(MARKER_FILE);
        assert!(marker.exists());
        let recorded: MigrationReport =
            serde_json::from_str(&fs::read_to_string(&marker).unwrap()).unwrap();
        assert!(recorded.migrated);
    }

    // ケース 3: geartoon のみ → data/ がコピーされ gear_source=geartoon。
    #[test]
    fn case_geartoon_only() {
        let base = temp_root("geartoon_only");
        let geartoon = make_geartoon(&base);
        let new_root = base.join("com.splabo.app");
        fs::create_dir_all(&new_root).unwrap();

        let report = migrate(Some(&base.join("com.chartoon.app")), Some(&geartoon), &new_root);

        assert!(report.migrated);
        assert_eq!(report.gear_source.as_deref(), Some("geartoon"));
        let gr = report.geartoon.expect("geartoon report");
        // gear_db.bin + 画像1 = 2 ファイル
        assert_eq!(gr.copied_files, 2, "{gr:?}");

        assert!(new_root.join("data/gear_db.bin").exists());
        assert!(new_root.join("data/images/head/h.gti").exists());
        assert_eq!(fs::read(new_root.join("data/gear_db.bin")).unwrap(), b"GEAR-DB-BIN");

        // 非破壊。
        assert!(geartoon.join("data/gear_db.bin").exists());
    }

    // ケース 4: both → chartoon 戦績 + ギア二重ソースを mtime で解決。
    #[test]
    fn case_both_gear_dual_source() {
        let base = temp_root("both");
        let chartoon = make_chartoon(&base);
        // chartoon 側にもギア data/ を作る（v0.7 ユーザー相当）＝先に生成して古くする。
        write(&chartoon.join("data").join("gear_db.bin"), b"CHARTOON-GEAR");
        // わずかに待って geartoon 側を後に生成し、mtime が確実に新しくなるようにする。
        std::thread::sleep(std::time::Duration::from_millis(50));
        let geartoon = make_geartoon(&base);

        let new_root = base.join("com.splabo.app");
        fs::create_dir_all(&new_root).unwrap();

        let report = migrate(Some(&chartoon), Some(&geartoon), &new_root);

        assert!(report.migrated);
        // geartoon 側が新しいので採用される。
        assert_eq!(report.gear_source.as_deref(), Some("geartoon"));
        assert_eq!(fs::read(new_root.join("data/gear_db.bin")).unwrap(), b"GEAR-DB-BIN");

        // chartoon 戦績も移行されている。
        assert!(new_root.join("chartoon.db").exists());
        assert!(new_root.join("chartoon.db-wal").exists());
        let cr = report.chartoon.expect("chartoon report");
        assert!(cr.copied_files >= 7);
    }

    // ケース 5: 途中失敗 = 移行先に既存ファイルがある → 上書きせず skip 記録。
    #[test]
    fn case_partial_existing_skipped() {
        let base = temp_root("partial");
        let chartoon = make_chartoon(&base);
        let new_root = base.join("com.splabo.app");
        fs::create_dir_all(&new_root).unwrap();
        // 既存 splabo データ（chartoon.db が既にある）。
        write(&new_root.join("chartoon.db"), b"EXISTING-SPLABO-DB");

        let report = migrate(Some(&chartoon), Some(&base.join("com.geartoon.app")), &new_root);

        assert!(report.migrated);
        let cr = report.chartoon.expect("chartoon report");
        // chartoon.db は既存のため skip、残り 6 ファイルはコピー。
        assert!(cr.skipped.iter().any(|s| s.contains("chartoon.db")), "skipped: {:?}", cr.skipped);
        assert_eq!(cr.copied_files, 6, "{cr:?}");
        // 既存ファイルは上書きされていない。
        assert_eq!(fs::read(new_root.join("chartoon.db")).unwrap(), b"EXISTING-SPLABO-DB");
        // WAL は既存が無かったのでコピーされている。
        assert!(new_root.join("chartoon.db-wal").exists());
    }

    // 二重移行防止: マーカーがあれば即 skip。
    #[test]
    fn case_marker_prevents_remigration() {
        let base = temp_root("marker");
        let chartoon = make_chartoon(&base);
        let new_root = base.join("com.splabo.app");
        fs::create_dir_all(&new_root).unwrap();
        write(&new_root.join(MARKER_FILE), b"{\"migrated\":true}");

        let report = migrate(Some(&chartoon), None, &new_root);
        assert!(!report.migrated);
        assert_eq!(report.skip_reason.as_deref(), Some("marker-exists"));
        // マーカーがあるので何もコピーしない。
        assert!(!new_root.join("chartoon.db").exists());
    }

    // no-op 保証: 移行元 == 移行先（識別子据え置き dev 環境）なら skip。
    #[test]
    fn case_noop_same_dir() {
        let base = temp_root("noop");
        let same = base.join("com.chartoon.app");
        fs::create_dir_all(&same).unwrap();

        let report = migrate(Some(&same), None, &same);
        assert!(!report.migrated);
        assert_eq!(report.skip_reason.as_deref(), Some("noop-same-dir"));
        assert!(!same.join(MARKER_FILE).exists());
    }
}
