// タブ内ビュー（#296 / #297）の選択状態を localStorage に永続化する。
//
// 1 キー（`splabo:shellViews`）に全タブ分の選択を JSON で持つ。タブが増えても
// キーが散らばらないようにするため。値は settings.json へもミラーされる
// （settingsStore の MIRROR_KEYS に VIEWS_KEY を含めている）。

import type { BattlesView, BookView, SettingsTab } from '../types'
import { VIEWS_KEY, lsGet, mirrorToStore } from './settingsStore'

export interface ViewPrefs {
  /** 「バトル」タブ: ダッシュボード / 一覧 */
  battles: BattlesView
  /** 武器図鑑: パネル / 一覧 */
  weapons: BookView
  /** ステージ図鑑: パネル / 一覧 */
  stages: BookView
  /** 設定タブ: 連携 / データ / 表示（#428） */
  settings: SettingsTab
}

export const DEFAULT_VIEW_PREFS: ViewPrefs = {
  battles: 'dashboard',
  weapons: 'panel',
  stages: 'panel',
  settings: 'link',
}

export function loadViewPrefs(): ViewPrefs {
  try {
    const raw = lsGet(VIEWS_KEY)
    if (!raw) return DEFAULT_VIEW_PREFS
    // 未知のキー・欠けたキーは既定値で埋める（前方/後方互換）
    return { ...DEFAULT_VIEW_PREFS, ...JSON.parse(raw) }
  } catch {
    return DEFAULT_VIEW_PREFS
  }
}

export function saveViewPrefs(prefs: Partial<ViewPrefs>): void {
  const next = { ...loadViewPrefs(), ...prefs }
  localStorage.setItem(VIEWS_KEY, JSON.stringify(next))
  void mirrorToStore()
}
