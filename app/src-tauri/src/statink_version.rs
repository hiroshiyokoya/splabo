// stat.ink に名乗る版を組み立てる（#904）。
//
// ビルド時に版を決める `build.rs` と、`statink.rs` のテストの両方から `include!` で読み込む。
// モジュールとしては登録していない（本体のコードは `build.rs` が渡す `SPLABO_STATINK_VERSION` を使う）。

/// stat.ink の `agent_version` に送る版。
///
/// - リリースビルド（版が数字だけ）: `v1.0.0`
/// - 開発ビルド（版が `1.0.0-dev`）: `v1.0.0-dev+c0d78c3`。コミット ID が取れなければ `v1.0.0-dev`
fn statink_version(major: &str, minor: &str, patch: &str, pre: &str, sha: Option<&str>) -> String {
    let mut version = format!("v{major}.{minor}.{patch}");
    if pre.is_empty() {
        return version;
    }
    version.push('-');
    version.push_str(pre);
    if let Some(sha) = sha.filter(|s| !s.is_empty()) {
        version.push('+');
        version.push_str(sha);
    }
    version
}
