import { useState, useEffect } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'
import { Dashboard } from './components/Dashboard'
import { BattleLog } from './components/BattleLog'
import { FilterBar } from './components/FilterBar'
import { WeaponBook } from './components/WeaponBook'
import { StageBook } from './components/StageBook'
import { AiAnalysis } from './components/AiAnalysis'
import { Settings } from './components/Settings'
import { About } from './components/About'
import type { Tab, AppSettings, ChartSpec, Filters } from './types'
import { DEFAULT_FILTERS } from './types'
import { initAppSettings } from './utils/appSettings'
import { useNotify, parseFetchError } from './utils/notify'
import './App.css'

initAppSettings()

const DEFAULT_SETTINGS: AppSettings = {
  ai: { provider: 'openai', apiKey: '', model: '' },
  autoFetchEnabled: false,
  autoFetchIntervalMin: 1440, // 24h
  statink: { apiKey: '', autoUpload: false, screenName: null },
}

const SETTINGS_KEY         = 'chartoon:settings'
const LAST_FETCHED_KEY     = 'chartoon:lastFetchedAt'
const LAST_WEAPONS_FETCH_K = 'chartoon:lastWeaponsFetchAt'
/** 武器マスターを再取得するインターバル（ミリ秒）。24 時間。 */
const WEAPONS_FETCH_INTERVAL_MS = 24 * 60 * 60 * 1000

function loadSettings(): AppSettings {
  try {
    const raw = localStorage.getItem(SETTINGS_KEY)
    if (!raw) return DEFAULT_SETTINGS
    const saved = JSON.parse(raw)
    return {
      ...DEFAULT_SETTINGS,
      ...saved,
      statink: { ...DEFAULT_SETTINGS.statink, ...(saved.statink ?? {}) },
    }
  } catch {
    return DEFAULT_SETTINGS
  }
}

export default function App() {
  const [tab, setTab] = useState<Tab>('dashboard')
  const [settings, setSettings] = useState<AppSettings>(loadSettings)
  const [aiChart, setAiChart] = useState<ChartSpec | null>(null)
  const [loginVersion, setLoginVersion] = useState(0)
  const [filters, setFilters] = useState<Filters>(DEFAULT_FILTERS)
  const [showAbout, setShowAbout] = useState(false)
  const [lastFetchedAt, setLastFetchedAt] = useState<string | null>(
    () => localStorage.getItem(LAST_FETCHED_KEY)
  )
  const { notify } = useNotify()

  /** フェッチ失敗を共通の流儀でトーストに変換する。
   *  ・未ログイン → 設定タブへ誘導するボタン付き
   *  ・期限切れ・ネットワーク → 再試行ボタン付き
   *  ・それ以外 → エラー詳細を出して再試行ボタン付き */
  function reportFetchError(err: unknown, retry?: () => void) {
    const fe = parseFetchError(err)
    const action =
      fe.hint === 'settings' ? { label: '設定を開く', onClick: () => setTab('settings') } :
      retry                  ? { label: '再試行',     onClick: retry } :
      undefined
    notify({ kind: fe.kind === 'not_logged_in' ? 'warning' : 'error', title: fe.title, message: fe.message, action, durationMs: 0 })
  }

  // 認証完了後にデータ取得を実行
  useEffect(() => {
    if (loginVersion > 0) {
      invoke('fetch_battles_full').catch(err => reportFetchError(err, () => invoke('fetch_battles_full').catch(e => reportFetchError(e))))
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loginVersion])

  useEffect(() => {
    const unlistenPromise = listen('fetch_complete', () => {
      const now = new Date().toLocaleString('ja-JP', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })
      setLastFetchedAt(now)
      localStorage.setItem(LAST_FETCHED_KEY, now)
    })
    return () => { unlistenPromise.then(fn => fn()) }
  }, [])

  // stat.ink の screen_name を初回アップロード時に自動取得して設定に保存
  useEffect(() => {
    const unlistenPromise = listen<string>('statink_screen_name_detected', (event) => {
      const name = event.payload
      setSettings(prev => {
        if (prev.statink.screenName === name) return prev
        const next = { ...prev, statink: { ...prev.statink, screenName: name } }
        localStorage.setItem(SETTINGS_KEY, JSON.stringify(next))
        return next
      })
    })
    return () => { unlistenPromise.then(fn => fn()) }
  }, [])

  // 起動時、screen_name が未取得 & API キーありなら既存アップロード済みバトルから逆引き
  useEffect(() => {
    if (settings.statink.screenName) return
    if (!settings.statink.apiKey) return
    invoke<string | null>('detect_statink_screen_name', { apiKey: settings.statink.apiKey }).then(name => {
      if (!name) return
      setSettings(prev => {
        if (prev.statink.screenName === name) return prev
        const next = { ...prev, statink: { ...prev.statink, screenName: name } }
        localStorage.setItem(SETTINGS_KEY, JSON.stringify(next))
        return next
      })
    }).catch(console.error)
  }, [settings.statink.apiKey])

  // 起動時に武器マスターの自動チェック。前回取得から 24h 経過していれば裏で再取得。
  // 失敗してもサイレント（UI ブロックしない）。
  useEffect(() => {
    const last = Number(localStorage.getItem(LAST_WEAPONS_FETCH_K) ?? 0)
    if (Date.now() - last < WEAPONS_FETCH_INTERVAL_MS) return
    invoke<number>('fetch_weapons')
      .then(count => {
        localStorage.setItem(LAST_WEAPONS_FETCH_K, String(Date.now()))
        console.log(`[startup] 武器マスター ${count} 件取得`)
      })
      .catch(err => console.warn('[startup] 武器マスター取得失敗:', err))
  }, [loginVersion])

  useEffect(() => {
    const unlistenPromise = listen<string>('deep-link-received', async (event) => {
      const url = event.payload
      if (url.startsWith('npf71b963c1b7b6d119://')) {
        try {
          await invoke('handle_auth_redirect', { url })
          setLoginVersion(v => v + 1)
        } catch (e) {
          console.error('認証リダイレクト処理失敗:', e)
        }
      }
    })
    return () => { unlistenPromise.then(fn => fn()) }
  }, [])

  function saveSettings(s: AppSettings) {
    setSettings(s)
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(s))
  }

  function handleAiChart(spec: ChartSpec) {
    setAiChart(spec)
    setTab('dashboard')
  }

  // サイドバーから呼ばれる「バトルデータ更新」処理
  const [fetching, setFetching] = useState(false)
  async function handleFetchFull() {
    if (fetching) return
    setFetching(true)
    try {
      await invoke('fetch_battles_full')
    } catch (e) {
      reportFetchError(e, handleFetchFull)
    } finally {
      setFetching(false)
    }
  }

  return (
    <div className="app">
      <nav className="sidebar">
        <button className="logo" onClick={() => setShowAbout(true)} aria-label="chartoon について">
          <img src="/chartoon-logo.png" alt="chartoon" />
        </button>
        <NavItem id="dashboard" icon="📊" label="ダッシュボード" active={tab} onClick={setTab} />
        <NavItem id="battles"   icon="⚔️" label="バトルログ"     active={tab} onClick={setTab} />
        <NavItem id="ai"        icon="🧙" label="AI分析"         active={tab} onClick={setTab} />
        <NavItem id="weapons"   icon="🔫" label="武器図鑑"       active={tab} onClick={setTab} />
        <NavItem id="stages"    icon="🗺" label="ステージ図鑑"   active={tab} onClick={setTab} />
        <NavItem id="settings"  icon="⚙️" label="設定"           active={tab} onClick={setTab} />
        <button
          className="btn-primary sidebar-fetch-btn"
          onClick={handleFetchFull}
          disabled={fetching}
          title="SplatNet3 から最新のバトル結果・詳細データを取得"
        >
          {fetching ? '取得中...' : 'バトルデータを取得'}
        </button>
        <div className="sidebar-last-fetched">
          {lastFetchedAt ? `データ最終更新日時: ${lastFetchedAt}` : '未取得'}
        </div>
      </nav>

      <main className="content">
        {(tab === 'dashboard' || tab === 'battles') && (
          <FilterBar filters={filters} onChange={setFilters} />
        )}
        {tab === 'dashboard' && (
          <Dashboard
            filters={filters}
            aiChart={aiChart}
            onFetchRequest={handleFetchFull}
            onOpenSettings={() => setTab('settings')}
            fetching={fetching}
          />
        )}
        {tab === 'battles'   && <BattleLog filters={filters} statinkScreenName={settings.statink.screenName} />}
        {tab === 'weapons'   && <WeaponBook />}
        {tab === 'stages'    && <StageBook />}
        {tab === 'ai' && <AiAnalysis settings={settings} onChartReady={handleAiChart} />}
        {tab === 'settings' && <Settings settings={settings} onSave={saveSettings} loginVersion={loginVersion} />}
      </main>

      {showAbout && <About onClose={() => setShowAbout(false)} />}
    </div>
  )
}

function NavItem({ id, icon, label, active, onClick }: { id: Tab; icon: string; label: string; active: Tab; onClick: (t: Tab) => void }) {
  return (
    <button className={`nav-item ${active === id ? 'active' : ''}`} onClick={() => onClick(id)}>
      <span className="nav-item-icon" aria-hidden="true">{icon}</span>
      <span className="nav-item-label">{label}</span>
    </button>
  )
}
