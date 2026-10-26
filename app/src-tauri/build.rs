use std::env;
use std::path::Path;
use std::process::Command;

include!("src/statink_version.rs");

fn main() {
    emit_statink_version();
    tauri_build::build()
}

/// stat.ink に名乗る版を `SPLABO_STATINK_VERSION` として本体に渡す（#904）。
///
/// 開発ビルドはコミット ID まで付けるので、HEAD が動いたらこのスクリプトを走らせ直す。
fn emit_statink_version() {
    let var = |name: &str| env::var(name).unwrap_or_default();
    let pre = var("CARGO_PKG_VERSION_PRE");
    let sha = if pre.is_empty() { None } else { git_short_sha() };
    let version = statink_version(
        &var("CARGO_PKG_VERSION_MAJOR"),
        &var("CARGO_PKG_VERSION_MINOR"),
        &var("CARGO_PKG_VERSION_PATCH"),
        &pre,
        sha.as_deref(),
    );
    println!("cargo:rustc-env=SPLABO_STATINK_VERSION={version}");
    println!("cargo:rerun-if-changed=Cargo.toml");
    if !pre.is_empty() {
        rerun_if_head_moves();
    }
}

fn git(args: &[&str]) -> Option<String> {
    let out = Command::new("git").args(args).output().ok()?;
    if !out.status.success() {
        return None;
    }
    let s = String::from_utf8(out.stdout).ok()?.trim().to_string();
    (!s.is_empty()).then_some(s)
}

fn git_short_sha() -> Option<String> {
    git(&["rev-parse", "--short=7", "HEAD"])
}

/// HEAD・今のブランチの ref・packed-refs が変わったら走らせ直す。
/// 存在しないパスを渡すと毎回走らせ直しになるので、あるものだけ渡す。
fn rerun_if_head_moves() {
    let mut paths = vec!["HEAD".to_string(), "packed-refs".to_string()];
    if let Some(head_ref) = git(&["symbolic-ref", "-q", "HEAD"]) {
        paths.push(head_ref);
    }
    for p in paths {
        if let Some(path) = git(&["rev-parse", "--git-path", &p]) {
            if Path::new(&path).exists() {
                println!("cargo:rerun-if-changed={path}");
            }
        }
    }
}
