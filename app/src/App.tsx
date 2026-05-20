import { useState, useEffect } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'
import { Dashboard } from './components/Dashboard'
import { BattleLog } from './components/BattleLog'
import { FilterBar } from './components/FilterBar'
import { WeaponBook } from './components/WeaponBook'
import { AiAnalysis } from './components/AiAnalysis'
import { Settings } from './components/Settings'
import { About } from './components/About'
import type { Tab, AppSettings, ChartSpec, Filters } from './types'
import { DEFAULT_FILTERS } from './types'
import { initAppSettings } from './utils/appSettings'
import './App.css'

initAppSettings()

const DEFAULT_SETTINGS: AppSettings = {
  ai: { provider: 'openai', apiKey: '', model: '' },
  autoFetchEnabled: false,
  autoFetchHour: 4,
  statink: { apiKey: '', autoUpload: false, screenName: null },
}

const SETTINGS_KEY     = 'chartoon:settings'
const LAST_FETCHED_KEY = 'chartoon:lastFetchedAt'

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

  // 認証完了後にデータ取得を実行
  useEffect(() => {
    if (loginVersion > 0) {
      invoke('fetch_battles_full').catch(console.error)
    }
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

  return (
    <div className="app">
      <nav className="sidebar">
        <button className="logo" onClick={() => setShowAbout(true)}>chartoon</button>
        <NavItem id="dashboard" label="ダッシュボード" active={tab} onClick={setTab} />
        <NavItem id="battles"   label="バトルログ"     active={tab} onClick={setTab} />
        <NavItem id="ai"        label="AI分析"         active={tab} onClick={setTab} />
        <NavItem id="weapons"   label="武器図鑑"       active={tab} onClick={setTab} />
        <NavItem id="settings"  label="設定"           active={tab} onClick={setTab} />
        <div className="sidebar-last-fetched">
          {lastFetchedAt ? `取得 ${lastFetchedAt}` : '未取得'}
        </div>
      </nav>

      <main className="content">
        {(tab === 'dashboard' || tab === 'battles') && (
          <FilterBar filters={filters} onChange={setFilters} />
        )}
        {tab === 'dashboard' && <Dashboard filters={filters} aiChart={aiChart} />}
        {tab === 'battles'   && <BattleLog filters={filters} statinkScreenName={settings.statink.screenName} />}
        {tab === 'weapons'   && <WeaponBook />}
        {tab === 'ai' && <AiAnalysis settings={settings} onChartReady={handleAiChart} />}
        {tab === 'settings' && <Settings settings={settings} onSave={saveSettings} loginVersion={loginVersion} />}
      </main>

      {showAbout && <About onClose={() => setShowAbout(false)} />}
    </div>
  )
}

function NavItem({ id, label, active, onClick }: { id: Tab; label: string; active: Tab; onClick: (t: Tab) => void }) {
  return (
    <button className={`nav-item ${active === id ? 'active' : ''}`} onClick={() => onClick(id)}>
      {label}
    </button>
  )
}
