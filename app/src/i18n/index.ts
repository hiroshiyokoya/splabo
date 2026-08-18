import i18n from 'i18next'
import { initReactI18next } from 'react-i18next'
import ja from './locales/ja.json'
import en from './locales/en.json'
import { loadLocalePref } from './persist'
import { applyDocumentLang, LOCALE_PREF_KEY, resolveLocale, type LocalePref } from './locale'
import { lsSet, mirrorToStore } from '../utils/settingsStore'

void i18n.use(initReactI18next).init({
  resources: {
    ja: { translation: ja },
    en: { translation: en },
  },
  lng: resolveLocale(loadLocalePref()),
  fallbackLng: 'ja',
  interpolation: { escapeValue: false },
})

applyDocumentLang(resolveLocale(loadLocalePref()))

export function saveLocalePref(pref: LocalePref): void {
  lsSet(LOCALE_PREF_KEY, pref)
  const locale = resolveLocale(pref)
  void i18n.changeLanguage(locale)
  applyDocumentLang(locale)
  void mirrorToStore()
}

export default i18n
