import { useState, useEffect } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { openUrl } from '@tauri-apps/plugin-opener'
import type { AppSettings } from '../types'
import { THEMES, saveTheme, getThemeId } from '../utils/appSettings'
import { AI_MODELS, PROVIDER_LABELS, modelDisplayLabel, defaultModelFor, type AiProvider } from '../utils/aiModels'

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
  const [themeId, setThemeId] = useState(getThemeId)
  const [uploading, setUploading] = useState(false)
  const [uploadResult, setUploadResult] = useState<string | null>(null)

  useEffect(() => {
    invoke<boolean>('check_auth_status').then(setLoggedIn).catch(() => setLoggedIn(false))
  }, [loginVersion])

  // 起動時にスケジューラー設定を Rust 側へ同期
  useEffect(() => {
    invoke('set_scheduler_config', {
      enabled: settings.autoFetchEnabled,
      intervalMin: settings.autoFetchIntervalMin,
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
    if ('autoFetchEnabled' in patch || 'autoFetchIntervalMin' in patch) {
      invoke('set_scheduler_config', {
        enabled: next.autoFetchEnabled,
        intervalMin: next.autoFetchIntervalMin,
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
        <div className="settings-subitem" style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
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

      <section className="settings-section settings-section--sub">
        <h3>自動取得（有効時はトレイに常駐）</h3>
        <label className="checkbox-label">
          <input
            type="checkbox"
            checked={settings.autoFetchEnabled}
            onChange={(e) => update({ autoFetchEnabled: e.target.checked })}
          />
          自動でバトルデータを取得する
        </label>
        <label>
          取得間隔
          <select
            value={settings.autoFetchIntervalMin}
            onChange={(e) => update({ autoFetchIntervalMin: Number(e.target.value) })}
            disabled={!settings.autoFetchEnabled}
          >
            <option value={15}>15分ごと</option>
            <option value={30}>30分ごと</option>
            <option value={60}>1時間ごと</option>
            <option value={120}>2時間ごと</option>
            <option value={360}>6時間ごと</option>
            <option value={720}>12時間ごと</option>
            <option value={1440}>24時間ごと</option>
          </select>
        </label>
      </section>

      <section className="settings-section">
        <h3>stat.ink 連携</h3>
        <p style={{ color: 'var(--text-muted)', fontSize: 13, marginBottom: 10 }}>
          <a
            href="https://stat.ink"
            onClick={e => { e.preventDefault(); openUrl('https://stat.ink').catch(console.error) }}
            style={{ color: 'var(--accent)', cursor: 'pointer' }}
          >stat.ink</a>
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
      </section>

      <section className="settings-section">
        <h3>AI API</h3>
        <label>
          プロバイダー
          <select
            value={settings.ai.provider}
            onChange={(e) => {
              const provider = e.target.value as AiProvider
              // プロバイダ切替時、現プロバイダのプリセットに無いモデル名なら新プロバイダの既定モデルにリセット
              const stillValid = AI_MODELS[provider].some(m => m.id === settings.ai.model)
              update({ ai: {
                ...settings.ai,
                provider,
                model: stillValid ? settings.ai.model : defaultModelFor(provider),
              } })
            }}
          >
            {(Object.keys(PROVIDER_LABELS) as AiProvider[]).map(p => (
              <option key={p} value={p}>{PROVIDER_LABELS[p]}</option>
            ))}
          </select>
        </label>
        <label>
          APIキー
          <input
            type="password"
            value={settings.ai.apiKey}
            onChange={(e) => update({ ai: { ...settings.ai, apiKey: e.target.value } })}
            placeholder="sk-... / AIzaSy... / sk-ant-... / xai-..."
          />
        </label>
        <label>
          モデル
          <select
            value={AI_MODELS[settings.ai.provider].some(m => m.id === settings.ai.model)
              ? settings.ai.model : '__custom__'}
            onChange={(e) => {
              const v = e.target.value
              if (v === '__custom__') return    // 「カスタム…」選択時は何もしない（下のテキストフィールドで入力）
              update({ ai: { ...settings.ai, model: v } })
            }}
          >
            {AI_MODELS[settings.ai.provider].map(m => (
              <option key={m.id} value={m.id}>{modelDisplayLabel(m)}</option>
            ))}
            <option value="__custom__">カスタム（下のテキスト欄で指定）…</option>
          </select>
        </label>
        <label>
          カスタムモデル ID
          <input
            type="text"
            value={settings.ai.model}
            onChange={(e) => update({ ai: { ...settings.ai, model: e.target.value } })}
            placeholder={defaultModelFor(settings.ai.provider)}
          />
        </label>
        <p className="settings-note">
          価格・コンテキスト長は 2026 年 5 月時点の情報。最新は各プロバイダの公式料金ページを参照してください。
        </p>
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
