import { lsGet } from '../utils/settingsStore'
import { isLocalePref, LOCALE_PREF_KEY, type LocalePref } from './locale'

export function loadLocalePref(): LocalePref {
  const v = lsGet(LOCALE_PREF_KEY)
  return isLocalePref(v) ? v : 'system'
}
