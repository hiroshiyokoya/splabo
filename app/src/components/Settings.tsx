import { useState, useEffect } from 'react'
import { invoke } from '@tauri-apps/api/core'
import type { AppSettings } from '../types'
import { THEMES, saveTheme, getThemeId } from '../utils/appSettings'

interface Props {
  settings: AppSettings
  onSave: (s: AppSettings) => void
  loginVersion: number
}

export function Settings({ settings, onSave, loginVersion }: Props) {
  const [loggedIn, setLoggedIn] = useState(false)
  const [authLoading, setAuthLoading] = useState(false)
  const [fetching, setFetching] = useState(false)
  const [fetchResult, setFetchResult] = useState<string | null>(null)
  const [masterRefreshing, setMasterRefreshing] = useState(false)
  const [masterResult, setMasterResult] = useState<string | null>(null)
  const [themeId, setThemeId] = useState(getThemeId)
  const [uploading, setUploading] = useState(false)
  const [uploadResult, setUploadResult] = useState<string | null>(null)
  const [deleting, setDeleting] = useState(false)
  const [deleteResult, setDeleteResult] = useState<string | null>(null)

  useEffect(() => {
    invoke<boolean>('check_auth_status').then(setLoggedIn).catch(() => setLoggedIn(false))
  }, [loginVersion])

  // 起動時にスケジューラー設定を Rust 側へ同期
  useEffect(() => {
    invoke('set_scheduler_config', {
      enabled: settings.autoFetchEnabled,
      hour: settings.autoFetchHour,
    }).catch(console.error)
    invoke('set_statink_config', {
      autoUpload: settings.statink.autoUpload,
      apiKey: settings.statink.apiKey,
    }).catch(console.error)
  }, [])

  function update(patch: Partial<AppSettings>) {
    const next = { ...settings, ...patch }
    onSave(next)
    // スケジューラー関連の変更は即 Rust 側へ同期
    if ('autoFetchEnabled' in patch || 'autoFetchHour' in patch) {
      invoke('set_scheduler_config', {
        enabled: next.autoFetchEnabled,
        hour: next.autoFetchHour,
      }).catch(console.error)
    }
    // stat.ink 設定の変更も即 Rust 側へ同期
    if ('statink' in patch) {
      invoke('set_statink_config', {
        autoUpload: next.statink.autoUpload,
        apiKey: next.statink.apiKey,
      }).catch(console.error)
    }
  }

  async function handleLogin() {
    setAuthLoading(true)
    try {
      await invoke('start_login')
    } catch (e) {
      console.error('ログイン開始失敗:', e)
    } finally {
      setAuthLoading(false)
    }
  }

  async function handleLogout() {
    setAuthLoading(true)
    try {
      await invoke('logout')
      setLoggedIn(false)
    } catch (e) {
      console.error('ログアウト失敗:', e)
    } finally {
      setAuthLoading(false)
    }
  }

  async function handleFetchFull() {
    setFetching(true)
    setFetchResult(null)
    try {
      const [battles] = await invoke<[number, number]>('fetch_battles_full')
      setFetchResult(`バトル +${battles}件`)
    } catch (e) {
      setFetchResult(`エラー: ${String(e)}`)
    } finally {
      setFetching(false)
    }
  }

  async function handleDeleteStatink() {
    if (!confirm('stat.ink にアップロード済みのバトルを全件削除し、再アップロード可能な状態に戻します。\nよろしいですか？')) return
    setDeleting(true)
    setDeleteResult(null)
    try {
      const count = await invoke<number>('delete_statink_all')
      setDeleteResult(count > 0 ? `${count}件削除しました` : '削除対象なし')
    } catch (e) {
      setDeleteResult(`エラー: ${String(e)}`)
    } finally {
      setDeleting(false)
    }
  }

  async function handleUploadStatink() {
    setUploading(true)
    setUploadResult(null)
    try {
      const count = await invoke<number>('upload_to_statink')
      setUploadResult(count > 0 ? `${count}件アップロードしました` : '新規アップロードなし')
    } catch (e) {
      setUploadResult(`エラー: ${String(e)}`)
    } finally {
      setUploading(false)
    }
  }

  async function handleRefreshMasterData() {
    setMasterRefreshing(true)
    setMasterResult(null)
    try {
      const count = await invoke<number>('fetch_weapons')
      setMasterResult(`武器データを ${count} 件更新しました`)
    } catch (e) {
      setMasterResult(`エラー: ${String(e)}`)
    } finally {
      setMasterRefreshing(false)
    }
  }

  return (
    <div className="settings-panel">
      <h2>設定</h2>

      <section className="settings-section">
        <h3>Nintendo アカウント</h3>
        {loggedIn ? (
          <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
            <span style={{ color: 'var(--win)', fontSize: 13 }}>連携済み</span>
            <button className="btn-primary" onClick={handleLogout} disabled={authLoading}>
              {authLoading ? '処理中...' : 'ログアウト'}
            </button>
          </div>
        ) : (
          <div>
            <p style={{ color: 'var(--text-muted)', fontSize: 13, marginBottom: 10 }}>
              バトルデータの取得には Nintendo アカウントへのログインが必要です。
            </p>
            <button className="btn-primary" onClick={handleLogin} disabled={authLoading}>
              {authLoading ? '処理中...' : 'Nintendo アカウントでログイン'}
            </button>
          </div>
        )}
      </section>

      <section className="settings-section">
        <h3>バトルデータ取得</h3>
        <p style={{ color: 'var(--text-muted)', fontSize: 13, marginBottom: 10 }}>
          SplatNet3 から最新のバトル結果・詳細データを取得します。
        </p>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          <button className="btn-primary" onClick={handleFetchFull} disabled={fetching}>
            {fetching ? '取得中...' : 'バトルデータを取得'}
          </button>
          {fetchResult && (
            <span style={{ fontSize: 13, color: fetchResult.startsWith('エラー') ? 'var(--lose)' : 'var(--win)' }}>
              {fetchResult}
            </span>
          )}
        </div>
      </section>

      <section className="settings-section">
        <h3>自動取得（有効時はトレイに常駐）</h3>
        <label className="checkbox-label">
          <input
            type="checkbox"
            checked={settings.autoFetchEnabled}
            onChange={(e) => update({ autoFetchEnabled: e.target.checked })}
          />
          毎日自動でバトルデータを取得する
        </label>
        <label>
          取得時刻（時）
          <input
            type="number"
            min={0}
            max={23}
            value={settings.autoFetchHour}
            onChange={(e) => update({ autoFetchHour: Number(e.target.value) })}
            disabled={!settings.autoFetchEnabled}
          />
        </label>
      </section>

      <section className="settings-section">
        <h3>AI API</h3>
        <label>
          プロバイダー
          <select
            value={settings.ai.provider}
            onChange={(e) => update({ ai: { ...settings.ai, provider: e.target.value as 'openai' | 'gemini' } })}
          >
            <option value="openai">OpenAI (ChatGPT)</option>
            <option value="gemini">Google Gemini</option>
          </select>
        </label>
        <label>
          APIキー
          <input
            type="password"
            value={settings.ai.apiKey}
            onChange={(e) => update({ ai: { ...settings.ai, apiKey: e.target.value } })}
            placeholder="sk-... または AIzaSy..."
          />
        </label>
        <label>
          モデル
          <input
            type="text"
            value={settings.ai.model}
            onChange={(e) => update({ ai: { ...settings.ai, model: e.target.value } })}
            placeholder={settings.ai.provider === 'openai' ? 'gpt-4o-mini' : 'gemini-1.5-flash'}
          />
        </label>
      </section>

      <section className="settings-section">
        <h3>マスターデータ</h3>
        <p style={{ color: 'var(--text-muted)', fontSize: 13, marginBottom: 10 }}>
          武器図鑑のデータを SplatNet3 から再取得します。武器が追加されたときなどに使用してください。
        </p>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          <button className="btn-secondary" onClick={handleRefreshMasterData} disabled={masterRefreshing}>
            {masterRefreshing ? '更新中...' : '武器データを更新'}
          </button>
          {masterResult && (
            <span style={{ fontSize: 13, color: masterResult.startsWith('エラー') ? 'var(--lose)' : 'var(--win)' }}>
              {masterResult}
            </span>
          )}
        </div>
      </section>

      <section className="settings-section">
        <h3>stat.ink 連携</h3>
        <p style={{ color: 'var(--text-muted)', fontSize: 13, marginBottom: 10 }}>
          <a href="https://stat.ink" target="_blank" rel="noopener noreferrer" style={{ color: 'var(--accent)' }}>stat.ink</a>
          {' '}のプロフィールページから API キーを取得してください。
        </p>
        <label>
          API キー
          <input
            type="password"
            value={settings.statink.apiKey}
            onChange={(e) => update({ statink: { ...settings.statink, apiKey: e.target.value } })}
            placeholder="stat.ink の API キーを入力"
          />
        </label>
        <label className="checkbox-label" style={{ marginTop: 8 }}>
          <input
            type="checkbox"
            checked={settings.statink.autoUpload}
            onChange={(e) => update({ statink: { ...settings.statink, autoUpload: e.target.checked } })}
            disabled={!settings.statink.apiKey}
          />
          バトルデータ取得後に自動でアップロードする
        </label>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginTop: 10 }}>
          <button
            className="btn-secondary"
            onClick={handleUploadStatink}
            disabled={uploading || !settings.statink.apiKey}
          >
            {uploading ? 'アップロード中...' : '今すぐアップロード'}
          </button>
          {uploadResult && (
            <span style={{ fontSize: 13, color: uploadResult.startsWith('エラー') ? 'var(--lose)' : 'var(--win)' }}>
              {uploadResult}
            </span>
          )}
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginTop: 8 }}>
          <button
            className="btn-secondary"
            onClick={handleDeleteStatink}
            disabled={deleting || !settings.statink.apiKey}
            style={{ color: 'var(--lose)' }}
          >
            {deleting ? '削除中...' : 'アップロード済みを全件削除（再アップロード用）'}
          </button>
          {deleteResult && (
            <span style={{ fontSize: 13, color: deleteResult.startsWith('エラー') ? 'var(--lose)' : 'var(--text-muted)' }}>
              {deleteResult}
            </span>
          )}
        </div>
      </section>

      <section className="settings-section">
        <h3>カラーテーマ</h3>
        <div className="theme-options">
          {THEMES.map(t => (
            <button
              key={t.id}
              className={`theme-option${themeId === t.id ? ' active' : ''}`}
              onClick={() => { saveTheme(t.id); setThemeId(t.id) }}
            >
              <span className="theme-dot" style={{ background: t.dot }} />
              {t.label}
            </button>
          ))}
        </div>
      </section>
    </div>
  )
}
