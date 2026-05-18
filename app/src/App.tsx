import { useState } from 'react'
import { Dashboard } from './components/Dashboard'
import { BattleLog } from './components/BattleLog'
import { AiAnalysis } from './components/AiAnalysis'
import { Settings } from './components/Settings'
import type { Tab, AppSettings, ChartSpec } from './types'
import './App.css'

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
        <div className="logo">chartoon</div>
        <NavItem id="dashboard" label="ダッシュボード" active={tab} onClick={setTab} />
        <NavItem id="battles" label="バトルログ" active={tab} onClick={setTab} />
        <NavItem id="ai" label="AI分析" active={tab} onClick={setTab} />
        <NavItem id="settings" label="設定" active={tab} onClick={setTab} />
      </nav>

      <main className="content">
        {tab === 'dashboard' && <Dashboard aiChart={aiChart} />}
        {tab === 'battles' && <BattleLog />}
        {tab === 'ai' && <AiAnalysis settings={settings} onChartReady={handleAiChart} />}
        {tab === 'settings' && <Settings settings={settings} onSave={saveSettings} />}
      </main>
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
