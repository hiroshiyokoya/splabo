import { useState, useEffect } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'
import type { AppSettings } from '../types'
import { THEMES, saveTheme, getThemeId } from '../utils/appSettings'

interface Props {
  settings: AppSettings
  onSave: (s: AppSettings) => void
  loginVersion: number
}

export function Settings({ settings, onSave, loginVersion }: Props) {
  const [draft, setDraft] = useState<AppSettings>(settings)
  const [saved, setSaved] = useState(false)
  const [loggedIn, setLoggedIn] = useState(false)
  const [authLoading, setAuthLoading] = useState(false)
  const [masterRefreshing, setMasterRefreshing] = useState(false)
  const [masterResult, setMasterResult] = useState<string | null>(null)
  const [fullFetching, setFullFetching] = useState(false)
  const [fullProgress, setFullProgress] = useState<string | null>(null)
  const [themeId, setThemeId] = useState(getThemeId)

  useEffect(() => {
    invoke<boolean>('check_auth_status').then(setLoggedIn).catch(() => setLoggedIn(false))
  }, [loginVersion])

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

  async function handleFetchAllBattles() {
    setFullFetching(true)
    setFullProgress('取得開始...')
    const unlisten = await listen<{ mode: string; page: number; page_inserted: number; total: number; done: boolean }>(
      'fetch_all_progress',
      ({ payload: p }) => {
        if (p.done) {
          setFullProgress(`完了 — 合計 ${p.total} 件取得`)
          setFullFetching(false)
        } else {
          setFullProgress(`${p.mode} p${p.page}: +${p.page_inserted} 件 (累計 ${p.total} 件)`)
        }
      }
    )
    try {
      await invoke<number>('fetch_all_battles')
    } catch (e) {
      setFullProgress(`エラー: ${String(e)}`)
      setFullFetching(false)
    } finally {
      unlisten()
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

  function save() {
    onSave(draft)
    setSaved(true)
    setTimeout(() => setSaved(false), 2000)
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
        <h3>AI API</h3>
        <label>
          プロバイダー
          <select
            value={draft.ai.provider}
            onChange={(e) => setDraft(d => ({ ...d, ai: { ...d.ai, provider: e.target.value as 'openai' | 'gemini' } }))}
          >
            <option value="openai">OpenAI (ChatGPT)</option>
            <option value="gemini">Google Gemini</option>
          </select>
        </label>
        <label>
          APIキー
          <input
            type="password"
            value={draft.ai.apiKey}
            onChange={(e) => setDraft(d => ({ ...d, ai: { ...d.ai, apiKey: e.target.value } }))}
            placeholder="sk-... または AIzaSy..."
          />
        </label>
        <label>
          モデル
          <input
            type="text"
            value={draft.ai.model}
            onChange={(e) => setDraft(d => ({ ...d, ai: { ...d.ai, model: e.target.value } }))}
            placeholder={draft.ai.provider === 'openai' ? 'gpt-4o-mini' : 'gemini-1.5-flash'}
          />
        </label>
      </section>

      <section className="settings-section">
        <h3>自動取得</h3>
        <label className="checkbox-label">
          <input
            type="checkbox"
            checked={draft.autoFetchEnabled}
            onChange={(e) => setDraft(d => ({ ...d, autoFetchEnabled: e.target.checked }))}
          />
          毎日自動でバトルデータを取得する
        </label>
        <label>
          取得時刻（時）
          <input
            type="number"
            min={0}
            max={23}
            value={draft.autoFetchHour}
            onChange={(e) => setDraft(d => ({ ...d, autoFetchHour: Number(e.target.value) }))}
            disabled={!draft.autoFetchEnabled}
          />
        </label>
      </section>

      <section className="settings-section">
        <h3>全バトル履歴取得</h3>
        <p style={{ color: 'var(--text-muted)', fontSize: 13, marginBottom: 10 }}>
          SplatNet3 の全ページを遡って過去バトルデータを取得します。初回や長期間未取得のときに使用してください。
        </p>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          <button className="btn-secondary" onClick={handleFetchAllBattles} disabled={fullFetching}>
            {fullFetching ? '取得中...' : '全バトルを取得'}
          </button>
          {fullProgress && (
            <span style={{ fontSize: 13, color: fullProgress.startsWith('エラー') ? 'var(--lose)' : 'var(--text-muted)' }}>
              {fullProgress}
            </span>
          )}
        </div>
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

      <button className="btn-primary" onClick={save}>
        {saved ? '保存しました' : '保存'}
      </button>
    </div>
  )
}
