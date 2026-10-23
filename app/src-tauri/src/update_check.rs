//! 新しい版があるかを GitHub Releases で確かめる（#542）。
//!
//! 自動更新（Tauri updater）は入れない（#535 で決定）。代わりに最新リリースの版だけを見て、
//! 今の版より新しければ画面で案内し、ダウンロードは利用者にリリースのページでしてもらう。
//! 送るのは GitHub への普通の HTTP リクエストだけで、利用者の情報は付けない。

use serde::Serialize;
use tauri::AppHandle;

/// 最新リリースを返す API。`/releases/latest` は draft と prerelease を除いた最新を返す。
const LATEST_RELEASE_URL: &str = "https://api.github.com/repos/hiroshiyokoya/splabo/releases/latest";

/// リリースのタグの頭（`splabo-v1.0.0` の `splabo-v`）。
const TAG_PREFIX: &str = "splabo-v";

/// 今より新しい版。
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct NewerRelease {
    /// 版（`1.0.1`）
    pub version: String,
    /// リリースのページ
    pub url: String,
}

/// 最新リリースを確かめ、今の版より新しければ返す。同じか古ければ `None`。
///
/// 開発ビルド（`1.0.0-dev` のように版に `-dev` が付く・#898）は、まだ出していない版を名乗るので
/// 比べても意味がない。問い合わせずに `None` を返す。
#[tauri::command]
pub async fn check_for_update(app: AppHandle) -> Result<Option<NewerRelease>, String> {
    let current = app.package_info().version.clone();
    if !current.pre.is_empty() {
        return Ok(None);
    }
    let client = crate::http::client_builder()
        // GitHub の API は User-Agent が無いと断る
        .user_agent(format!("splabo/{current}"))
        .build()
        .map_err(|e| format!("HTTP クライアント作成失敗: {e}"))?;
    let json: serde_json::Value = client
        .get(LATEST_RELEASE_URL)
        .header("Accept", "application/vnd.github+json")
        .send()
        .await
        .map_err(|e| format!("最新版の確認失敗: {e}"))?
        .error_for_status()
        .map_err(|e| format!("最新版の確認失敗: {e}"))?
        .json()
        .await
        .map_err(|e| format!("最新版の応答解析失敗: {e}"))?;
    Ok(newer_release(&current, &json))
}

/// `/releases/latest` の応答から、`current` より新しい版を取り出す。
fn newer_release(current: &semver::Version, json: &serde_json::Value) -> Option<NewerRelease> {
    let tag = json["tag_name"].as_str()?;
    let version = semver::Version::parse(tag.strip_prefix(TAG_PREFIX)?).ok()?;
    if version <= *current {
        return None;
    }
    Some(NewerRelease {
        version: version.to_string(),
        url: json["html_url"].as_str()?.to_string(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn v(s: &str) -> semver::Version {
        semver::Version::parse(s).unwrap()
    }

    fn release(tag: &str) -> serde_json::Value {
        serde_json::json!({
            "tag_name": tag,
            "html_url": format!("https://github.com/hiroshiyokoya/splabo/releases/tag/{tag}"),
        })
    }

    #[test]
    fn returns_newer_release() {
        assert_eq!(
            newer_release(&v("0.12.1"), &release("splabo-v1.0.0")),
            Some(NewerRelease {
                version: "1.0.0".into(),
                url: "https://github.com/hiroshiyokoya/splabo/releases/tag/splabo-v1.0.0".into(),
            })
        );
        // 数字の大小で比べる（文字列なら 0.12.10 < 0.12.9 になってしまう）
        assert!(newer_release(&v("0.12.9"), &release("splabo-v0.12.10")).is_some());
    }

    #[test]
    fn ignores_same_or_older_release() {
        assert_eq!(newer_release(&v("1.0.0"), &release("splabo-v1.0.0")), None);
        assert_eq!(newer_release(&v("1.0.1"), &release("splabo-v1.0.0")), None);
    }

    #[test]
    fn ignores_unexpected_tags() {
        // 旧アプリのタグや、形の崩れた応答では案内しない
        assert_eq!(newer_release(&v("0.12.1"), &release("chartoon-v9.0.0")), None);
        assert_eq!(newer_release(&v("0.12.1"), &release("splabo-vnext")), None);
        assert_eq!(newer_release(&v("0.12.1"), &serde_json::json!({ "message": "Not Found" })), None);
    }
}
