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
}

const SETTINGS_KEY = 'chartoon:settings'

function loadSettings(): AppSettings {
  try {
    const raw = localStorage.getItem(SETTINGS_KEY)
    return raw ? { ...DEFAULT_SETTINGS, ...JSON.parse(raw) } : DEFAULT_SETTINGS
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
        <NavItem id="ai"        label="AI分析"         active={tab} onClick={setTab} />
        <NavItem id="battles"   label="バトルログ"     active={tab} onClick={setTab} />
        <NavItem id="weapons"   label="武器図鑑"       active={tab} onClick={setTab} />
        <NavItem id="settings"  label="設定"           active={tab} onClick={setTab} />
      </nav>

      <main className="content">
        {(tab === 'dashboard' || tab === 'battles') && (
          <FilterBar filters={filters} onChange={setFilters} />
        )}
        {tab === 'dashboard' && <Dashboard filters={filters} aiChart={aiChart} />}
        {tab === 'battles'   && <BattleLog filters={filters} />}
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
