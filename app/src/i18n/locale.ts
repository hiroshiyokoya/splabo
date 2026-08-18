/**
 * 表示言語の希望値と、実際に使う locale（#688）。
 *
 * `system` は OS の言語から ja / en を決める。保存は希望値のほう
 * （システムに合わせる、を後から変えられるように）。
 */
export type LocalePref = 'system' | 'ja' | 'en'
export type AppLocale = 'ja' | 'en'

export const LOCALE_PREF_KEY = 'splabo:localePref'

export function detectOsLocale(): AppLocale {
  const lang = (typeof navigator !== 'undefined' ? navigator.language : 'ja') || 'ja'
  return lang.toLowerCase().startsWith('ja') ? 'ja' : 'en'
}

export function isLocalePref(v: string | null): v is LocalePref {
  return v === 'system' || v === 'ja' || v === 'en'
}

export function resolveLocale(pref: LocalePref): AppLocale {
  return pref === 'system' ? detectOsLocale() : pref
}

export function applyDocumentLang(locale: AppLocale): void {
  if (typeof document !== 'undefined') document.documentElement.lang = locale
}
