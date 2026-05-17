import { useEffect, useState, useCallback } from 'react'
import { isTauri } from '../utils/tauri'

async function resolveVersion(): Promise<string> {
  try {
    const { getVersion } = await import('@tauri-apps/api/app')
    return await getVersion()
  } catch {
    return '0.1.0'
  }
}

interface Props {
  open: boolean
  onClose: () => void
  onGearDataDeleted?: () => void
}

export function SettingsDialog({ open, onClose, onGearDataDeleted }: Props) {
  const [version, setVersion] = useState<string>('')
  const [loggedIn, setLoggedIn] = useState<boolean | null>(null)
  const [logoutLoading, setLogoutLoading] = useState(false)
  const [deleteGearLoading, setDeleteGearLoading] = useState(false)
  const [deleteAllLoading, setDeleteAllLoading] = useState(false)

  useEffect(() => {
    resolveVersion().then(setVersion)
  }, [])

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

        {/* アカウント（Tauriのみ） */}
        {isTauri() && (
          <>
            <h3 className="settings-section__title">アカウント</h3>
            <div className="settings-account">
              <span className="settings-account__status">
                {loggedIn === null ? '確認中...' : loggedIn ? 'ログイン済み' : '未ログイン'}
              </span>
              {loggedIn && (
                <button
                  className="settings-logout-btn"
                  onClick={handleLogout}
                  disabled={logoutLoading}
                >
                  {logoutLoading ? '処理中...' : 'ログアウト'}
                </button>
              )}
            </div>
            <div className="settings-danger-zone">
              <div className="settings-danger-row">
                <div className="settings-danger-row__desc">
                  <span className="settings-danger-row__label">ギアデータを削除</span>
                  <span className="settings-danger-row__note">gear_db・画像キャッシュを削除します。再度「データ更新」で取得できます。</span>
                </div>
                <button
                  className="settings-danger-btn"
                  onClick={handleDeleteGearData}
                  disabled={deleteGearLoading || deleteAllLoading}
                >
                  {deleteGearLoading ? '削除中...' : '削除'}
                </button>
              </div>
              <div className="settings-danger-row">
                <div className="settings-danger-row__desc">
                  <span className="settings-danger-row__label">すべてのデータを削除</span>
                  <span className="settings-danger-row__note">認証情報・gear_db・画像キャッシュをすべて削除します。再ログインが必要になります。</span>
                </div>
                <button
                  className="settings-danger-btn settings-danger-btn--all"
                  onClick={handleDeleteAll}
                  disabled={deleteGearLoading || deleteAllLoading}
                >
                  {deleteAllLoading ? '削除中...' : 'すべて削除'}
                </button>
              </div>
            </div>
            <div className="about-divider" />
          </>
        )}

        {/* Tips */}
        <h3 className="settings-section__title">Tips</h3>
        <ul className="settings-help-list">
          <li className="settings-help-item">
            <kbd className="settings-kbd">Shift</kbd> + クリック: ステッパーで最大値 / 最小値に一気に移動
          </li>
          <li className="settings-help-item">
            データ更新の5分クールダウン: 更新成功後5分以内は再更新できない
          </li>
        </ul>
        <div className="about-divider" />

        {/* このアプリについて */}
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
            <a className="about-meta__value about-link" href="https://github.com/hiroshiyokoya" target="_blank" rel="noreferrer">hiroshiyokoya</a>
          </div>
          <div className="about-meta__row">
            <span className="about-meta__label">Repository</span>
            <a className="about-meta__value about-link" href="https://github.com/hiroshiyokoya/geartoon" target="_blank" rel="noreferrer">github.com/hiroshiyokoya/geartoon</a>
          </div>
          <div className="about-meta__row">
            <span className="about-meta__label">License</span>
            <span className="about-meta__value">MIT License</span>
          </div>
        </div>
        <div className="about-divider" />
        <p className="about-disclaimer">
          geartoon は非公式のファンツールです。任天堂株式会社、およびスプラトゥーンシリーズとは一切関係ありません。
          Splatoon™ は任天堂株式会社の商標です。
        </p>
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
