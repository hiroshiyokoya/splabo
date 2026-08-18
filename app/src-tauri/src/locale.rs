//! 表示言語の解決（#694）。
//!
//! フロントの `settingsStore.ts` が `splabo:localePref` を `settings.json` に
//! ミラーするので、Rust 側も同じキーを読む。`system` は OS の UI 言語から
//! ja / en を決める（`app/src/i18n/locale.ts` と同じ方針）。

use tauri::AppHandle;
use tauri_plugin_store::StoreExt;

pub const LOCALE_PREF_KEY: &str = "splabo:localePref";
const SETTINGS_STORE: &str = "settings.json";

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AppLocale {
    Ja,
    En,
}

/// `settings.json` の希望値を解決した表示言語。
pub fn app_locale(app: &AppHandle) -> AppLocale {
    let pref = read_locale_pref(app).unwrap_or_else(|| "system".to_string());
    resolve_locale(&pref)
}

fn read_locale_pref(app: &AppHandle) -> Option<String> {
    app.store(SETTINGS_STORE).ok().and_then(|store| {
        store
            .get(LOCALE_PREF_KEY)
            .and_then(|v| v.as_str().map(String::from))
    })
}

pub fn resolve_locale(pref: &str) -> AppLocale {
    match pref {
        "ja" => AppLocale::Ja,
        "en" => AppLocale::En,
        _ => detect_os_locale(),
    }
}

pub fn detect_os_locale() -> AppLocale {
    #[cfg(target_os = "windows")]
    {
        return detect_os_locale_windows();
    }
    #[cfg(not(target_os = "windows"))]
    {
        detect_os_locale_unix()
    }
}

#[cfg(target_os = "windows")]
fn detect_os_locale_windows() -> AppLocale {
    use windows::Win32::Globalization::GetUserDefaultUILanguage;
    let lang = unsafe { GetUserDefaultUILanguage() };
    if lang & 0x3FF == 0x11 {
        AppLocale::Ja
    } else {
        AppLocale::En
    }
}

#[cfg(not(target_os = "windows"))]
fn detect_os_locale_unix() -> AppLocale {
    for key in ["LC_ALL", "LC_MESSAGES", "LANG"] {
        if let Ok(v) = std::env::var(key) {
            let base = v.split('.').next().unwrap_or(&v).to_lowercase();
            if base.starts_with("ja") {
                return AppLocale::Ja;
            }
            if !base.is_empty() && base != "c" {
                return AppLocale::En;
            }
        }
    }
    AppLocale::Ja
}

impl AppLocale {
    pub fn fetch_success_body(self, battles: usize) -> String {
        match self {
            AppLocale::Ja => format!("バトル +{}件取得しました", battles),
            AppLocale::En if battles == 1 => "Fetched 1 new battle".to_string(),
            AppLocale::En => format!("Fetched {battles} new battles"),
        }
    }

    pub fn fetch_error_body(self, now: chrono::DateTime<chrono::Local>) -> String {
        let ts = now.format("%m/%d %H:%M");
        match self {
            AppLocale::Ja => format!("バトルデータの取得に失敗しました（{ts}）"),
            AppLocale::En => format!("Failed to fetch battle data ({ts})"),
        }
    }

    pub fn companion_not_logged_in(self) -> &'static str {
        match self {
            AppLocale::Ja => {
                "Nintendo アカウントでログインしていません。デスクトップの設定からログインしてください。"
            }
            AppLocale::En => {
                "Not signed in with a Nintendo Account. Sign in from Settings on the desktop app."
            }
        }
    }

    pub fn companion_fetch_in_progress(self) -> &'static str {
        match self {
            AppLocale::Ja => {
                "デスクトップ側でバトル取得が進行中です。完了後に再試行してください。"
            }
            AppLocale::En => {
                "A battle fetch is already running on the desktop. Try again when it finishes."
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn resolve_locale_pref() {
        assert_eq!(resolve_locale("ja"), AppLocale::Ja);
        assert_eq!(resolve_locale("en"), AppLocale::En);
        assert_eq!(resolve_locale("system"), detect_os_locale());
    }

    #[test]
    fn fetch_error_body_ja() {
        use chrono::TimeZone;
        let now = chrono::Local.with_ymd_and_hms(2026, 8, 14, 9, 40, 0).unwrap();
        assert_eq!(
            AppLocale::Ja.fetch_error_body(now),
            "バトルデータの取得に失敗しました（08/14 09:40）"
        );
    }

    #[test]
    fn fetch_error_body_en() {
        use chrono::TimeZone;
        let now = chrono::Local.with_ymd_and_hms(2026, 8, 14, 9, 40, 0).unwrap();
        assert_eq!(
            AppLocale::En.fetch_error_body(now),
            "Failed to fetch battle data (08/14 09:40)"
        );
    }

    #[test]
    fn fetch_success_body_en_plural() {
        assert_eq!(AppLocale::En.fetch_success_body(1), "Fetched 1 new battle");
        assert_eq!(AppLocale::En.fetch_success_body(3), "Fetched 3 new battles");
    }
}
