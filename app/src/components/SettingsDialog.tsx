import { useEffect, useState, useCallback } from 'react'
import { isTauri, openExternal } from '../utils/tauri'
import {
  THEMES, DENSITIES, COMBO_LIMITS, NEAR_LIMITS,
  loadThemeId, loadDensityId,
  applyTheme, applyDensity,
} from '../utils/appSettings'
import type { DensityId, ComboLimitValue, NearLimitValue } from '../utils/appSettings'

async function resolveVersion(): Promise<string> {
  try {
    const { getVersion } = await import('@tauri-apps/api/app')
    return await getVersion()
  } catch {
    return '0.1.0'
  }
}

type Tab = 'account' | 'settings' | 'tips' | 'about'

interface Props {
  open: boolean
  onClose: () => void
  onGearDataDeleted?: () => void
  comboLimit?:          ComboLimitValue
  nearLimit?:           NearLimitValue
  onComboLimitChange?:  (v: ComboLimitValue) => void
  onNearLimitChange?:   (v: NearLimitValue) => void
}

export function SettingsDialog({ open, onClose, onGearDataDeleted, comboLimit = 50, nearLimit = 10, onComboLimitChange, onNearLimitChange }: Props) {
  const [tab, setTab]                   = useState<Tab>('account')
  const [version, setVersion]           = useState<string>('')
  const [loggedIn, setLoggedIn]         = useState<boolean | null>(null)
  const [logoutLoading, setLogoutLoading]       = useState(false)
  const [deleteGearLoading, setDeleteGearLoading] = useState(false)
  const [deleteAllLoading, setDeleteAllLoading]   = useState(false)
  const [themeId, setThemeId]     = useState(loadThemeId)
  const [densityId, setDensityId] = useState<DensityId>(loadDensityId)

  useEffect(() => { resolveVersion().then(setVersion) }, [])

  useEffect(() => {
    if (!open || !isTauri()) return
    import('@tauri-apps/api/core').then(({ invoke }) => {
      invoke<boolean>('nxapi_check_login').then(setLoggedIn).catch(() => setLoggedIn(false))
    })
  }, [open])

  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, onClose])

  const handleLogout = useCallback(async () => {
    setLogoutLoading(true)
    try {
      const { invoke } = await import('@tauri-apps/api/core')
      await invoke('logout')
      setLoggedIn(false)
    } finally {
      setLogoutLoading(false)
    }
  }, [])

  const handleDeleteGearData = useCallback(async () => {
    if (!window.confirm('ギアデータ（gear_db・画像キャッシュ）を削除します。\nアプリを再起動するまでギアデータは表示されません。\n続行しますか？')) return
    setDeleteGearLoading(true)
    try {
      const { invoke } = await import('@tauri-apps/api/core')
      await invoke('delete_gear_data')
      onGearDataDeleted?.()
    } finally {
      setDeleteGearLoading(false)
    }
  }, [onGearDataDeleted])

  const handleDeleteAll = useCallback(async () => {
    if (!window.confirm('認証情報とギアデータをすべて削除します。\n次回起動時に再ログインが必要になります。\n続行しますか？')) return
    setDeleteAllLoading(true)
    try {
      const { invoke } = await import('@tauri-apps/api/core')
      await invoke('logout')
      await invoke('delete_gear_data')
      setLoggedIn(false)
      onGearDataDeleted?.()
    } finally {
      setDeleteAllLoading(false)
    }
  }, [onGearDataDeleted])

  const handleThemeChange = useCallback((id: string) => {
    setThemeId(id)
    applyTheme(id)
  }, [])

  const handleDensityChange = useCallback((id: DensityId) => {
    setDensityId(id)
    applyDensity(id)
  }, [])

  return (
    <>
      <div
        className={`about-overlay${open ? ' about-overlay--visible' : ''}`}
        onClick={onClose}
        aria-hidden="true"
      />
      <div
        className={`about-dialog settings-dialog${open ? ' about-dialog--open' : ''}`}
        role="dialog"
        aria-modal="true"
        aria-label="設定"
      >
        <button className="about-close" onClick={onClose} aria-label="閉じる">✕</button>

        {/* タブバー */}
        <div className="settings-tabs">
          {(['account', 'settings', 'tips', 'about'] as Tab[]).map(t => (
            <button
              key={t}
              className={`settings-tab${tab === t ? ' settings-tab--active' : ''}`}
              onClick={() => setTab(t)}
            >
              {t === 'account' ? 'アカウント'
                : t === 'settings' ? '設定'
                : t === 'tips' ? 'Tips'
                : 'About'}
            </button>
          ))}
        </div>

        {/* タブコンテンツ */}
        <div className="settings-tab-content">

          {/* ── アカウント ── */}
          {tab === 'account' && (
            isTauri() ? (
              <>
                <div className="settings-account">
                  <span className="settings-account__status">
                    {loggedIn === null ? '確認中...' : loggedIn ? '認証済み' : '未認証'}
                  </span>
                  {loggedIn && (
                    <button className="settings-logout-btn" onClick={handleLogout} disabled={logoutLoading}>
                      {logoutLoading ? '処理中...' : '認証解除'}
                    </button>
                  )}
                </div>
                <div className="settings-danger-zone">
                  <div className="settings-danger-row">
                    <div className="settings-danger-row__desc">
                      <span className="settings-danger-row__label">ギアデータを削除</span>
                      <span className="settings-danger-row__note">gear_db・画像キャッシュを削除します。再度「データ更新」で取得できます。</span>
                    </div>
                    <button className="settings-danger-btn" onClick={handleDeleteGearData} disabled={deleteGearLoading || deleteAllLoading}>
                      {deleteGearLoading ? '削除中...' : '削除'}
                    </button>
                  </div>
                  <div className="settings-danger-row">
                    <div className="settings-danger-row__desc">
                      <span className="settings-danger-row__label">すべてのデータを削除</span>
                      <span className="settings-danger-row__note">認証情報・gear_db・画像キャッシュをすべて削除します。再ログインが必要になります。</span>
                    </div>
                    <button className="settings-danger-btn settings-danger-btn--all" onClick={handleDeleteAll} disabled={deleteGearLoading || deleteAllLoading}>
                      {deleteAllLoading ? '削除中...' : 'すべて削除'}
                    </button>
                  </div>
                </div>
              </>
            ) : (
              <p style={{ color: 'var(--text-muted)', fontSize: '0.85rem', padding: '0 0.75rem' }}>
                アカウント管理はデスクトップアプリでのみ利用できます。
              </p>
            )
          )}

          {/* ── 設定 ── */}
          {tab === 'settings' && (
            <>
              <h3 className="settings-section__title">カラーテーマ</h3>
              <div className="settings-theme-dots">
                {THEMES.map(t => (
                  <button
                    key={t.id}
                    className={`settings-theme-dot${themeId === t.id ? ' settings-theme-dot--active' : ''}`}
                    style={{ background: t.dot }}
                    onClick={() => handleThemeChange(t.id)}
                    aria-label={t.id}
                    title={t.id}
                  />
                ))}
              </div>

              <h3 className="settings-section__title" style={{ marginTop: '1.25rem' }}>表示密度</h3>
              <div className="settings-density-btns">
                {DENSITIES.map(d => (
                  <button
                    key={d.id}
                    className={`settings-density-btn${densityId === d.id ? ' settings-density-btn--active' : ''}`}
                    onClick={() => handleDensityChange(d.id)}
                  >
                    {d.label}
                  </button>
                ))}
              </div>

              <h3 className="settings-section__title" style={{ marginTop: '1.25rem' }}>コーデ候補の表示件数</h3>
              <div className="settings-density-btns">
                {COMBO_LIMITS.map(v => (
                  <button
                    key={v}
                    className={`settings-density-btn${comboLimit === v ? ' settings-density-btn--active' : ''}`}
                    onClick={() => onComboLimitChange?.(v)}
                  >
                    {v}件
                  </button>
                ))}
              </div>

              <h3 className="settings-section__title" style={{ marginTop: '1.25rem' }}>惜しい候補の上限</h3>
              <div className="settings-density-btns">
                {NEAR_LIMITS.map(v => (
                  <button
                    key={v}
                    className={`settings-density-btn${nearLimit === v ? ' settings-density-btn--active' : ''}`}
                    onClick={() => onNearLimitChange?.(v)}
                  >
                    {v}件
                  </button>
                ))}
              </div>
            </>
          )}

          {/* ── Tips ── */}
          {tab === 'tips' && (
            <ul className="settings-help-list">
              <li className="settings-help-item">
                <kbd className="settings-kbd">Shift</kbd> + クリック: ステッパーで最大値 / 最小値に一気に移動
              </li>
              <li className="settings-help-item">
                データ更新の5分クールダウン: 更新成功後5分以内は再更新できない
              </li>
            </ul>
          )}

          {/* ── About ── */}
          {tab === 'about' && (
            <>
              <div className="about-header">
                <img src="/favicon.png" alt="geartoon logo" className="about-logo" />
                <div className="about-title-group">
                  <h2 className="about-appname">geartoon</h2>
                  {version && <span className="about-version">v{version}</span>}
                </div>
              </div>
              <p className="about-subtitle">Splatoon 3 Gear Wardrobe</p>
              <div className="about-meta">
                <div className="about-meta__row">
                  <span className="about-meta__label">Author</span>
                  <button
                    className="about-meta__value about-link about-link-btn"
                    onClick={() => openExternal('https://github.com/hiroshiyokoya')}
                  >
                    hiroshiyokoya
                  </button>
                </div>
                <div className="about-meta__row">
                  <span className="about-meta__label">Repository</span>
                  <button
                    className="about-meta__value about-link about-link-btn"
                    onClick={() => openExternal('https://github.com/hiroshiyokoya/geartoon')}
                  >
                    github.com/hiroshiyokoya/geartoon
                  </button>
                </div>
                <div className="about-meta__row">
                  <span className="about-meta__label">License</span>
                  <span className="about-meta__value">MIT License</span>
                </div>
              </div>
              <div className="about-divider" />
              <div className="about-feedback">
                <p className="about-feedback__text">バグ報告・機能要望など、フィードバックを歓迎します。</p>
                <button
                  className="about-feedback__btn"
                  onClick={() => openExternal('https://docs.google.com/forms/d/e/1FAIpQLScAP6LH9JDHaJGs4c7UJakF-YNU1UJRN10H4uSePqiknN-apQ/viewform')}
                >
                  フィードバックフォームを開く
                </button>
              </div>
              <div className="about-divider" />
              <p className="about-disclaimer">
                geartoon は非公式のファンツールです。任天堂株式会社、およびスプラトゥーンシリーズとは一切関係ありません。
                Splatoon™ は任天堂株式会社の商標です。
              </p>
            </>
          )}

        </div>
      </div>
    </>
  )
}

export async function listenAboutMenuEvent(onAbout: () => void): Promise<() => void> {
  try {
    const { listen } = await import('@tauri-apps/api/event')
    const unlisten = await listen('show-about', onAbout)
    return unlisten
  } catch {
    return () => {}
  }
}
