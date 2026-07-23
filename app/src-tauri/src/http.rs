//! 外部通信用 reqwest クライアントの共通ファクトリ（#402）。
//!
//! すべての取得・アップロード系クライアントはここを通して生成し、必ず
//! **接続タイムアウト**と**読み取り（アイドル）タイムアウト**を持たせる。
//!
//! # なぜ read_timeout なのか
//! #402 の障害は「TCP 接続は確立する（Cloudflare エッジは 443 を受ける）が、
//! origin が応答を一切返さない」というものだった。この状態では
//! `connect_timeout` は**発火しない**（接続自体は成功しているため）。
//! かといって全体 `timeout` を短く固定すると、画像の一括ダウンロードや
//! stat.ink の全期間 ZIP 取り込みのように**正当に時間のかかる転送**まで
//! 途中で打ち切ってしまう。
//!
//! `read_timeout` は「一定時間 1 バイトも受信できない読み取り」だけを失敗に
//! するので、無応答ハングを潰しつつ、データが流れている限り長い転送は許容
//! できる。reqwest 0.12 では応答ヘッダ待ち（レスポンスがまだ来ない段階）にも
//! この読み取りタイムアウトが適用されるため、本件の「送ったきり返ってこない」
//! ケースをきちんと拾える。
//!
//! タイムアウトで返ったエラーは `?` で呼び出し元へ伝播し、`FetchInProgress`
//! フラグが解放される。文字列には "timed out" 等が含まれるので、フロントの
//! `parseFetchError` / Rust の `classify_failure`（#399）でネットワーク系として
//! 分類できる。

use std::time::Duration;

/// 接続確立の上限。ここを超えたら接続段でエラーにする。
pub const CONNECT_TIMEOUT: Duration = Duration::from_secs(10);

/// 読み取りのアイドル上限。この時間 1 バイトも受信できなければ失敗にする。
/// 応答ヘッダ待ち・ボディ読み取りの双方に効く（read が成功するたびリセット）。
pub const READ_TIMEOUT: Duration = Duration::from_secs(30);

/// タイムアウト付きの `reqwest::ClientBuilder` を返す。
/// 追加設定（ヘッダ・cookie 等）が要る呼び出しはこれを起点に組み立てる。
pub fn client_builder() -> reqwest::ClientBuilder {
    reqwest::Client::builder()
        .connect_timeout(CONNECT_TIMEOUT)
        .read_timeout(READ_TIMEOUT)
}

/// タイムアウト付きの共通クライアントを構築する。
/// 既存の `reqwest::Client::builder().build().map_err(...)` の置き換え。
pub fn build_client() -> Result<reqwest::Client, String> {
    client_builder()
        .build()
        .map_err(|e| format!("HTTP クライアント構築失敗: {e}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 構築したクライアントに read_timeout が設定されていること。
    /// reqwest の `Debug` 出力は read_timeout が Some のときだけ `read_timeout` を出す
    /// ため、これで「タイムアウトが載っている」ことを検証できる。
    #[test]
    fn build_client_has_read_timeout() {
        let client = build_client().expect("client builds");
        let dbg = format!("{client:?}");
        assert!(
            dbg.contains("read_timeout"),
            "read_timeout が設定されていない: {dbg}"
        );
    }

    /// タイムアウト値が意図した秒数であること（回帰防止）。
    #[test]
    fn timeout_values_are_sane() {
        assert_eq!(CONNECT_TIMEOUT, Duration::from_secs(10));
        assert_eq!(READ_TIMEOUT, Duration::from_secs(30));
        assert!(READ_TIMEOUT >= CONNECT_TIMEOUT);
    }
}
