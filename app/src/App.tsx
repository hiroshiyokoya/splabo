import { useState } from 'react'
import { useGearDB } from './hooks/useGearDB'
import { GearCard } from './components/GearCard'
import type { GearCategory } from './types'

const TABS: { key: GearCategory; label: string }[] = [
  { key: 'head',     label: '頭' },
  { key: 'clothing', label: '服' },
  { key: 'shoes',    label: '靴' },
]

function App() {
  const { data, loading, error } = useGearDB()
  const [activeTab, setActiveTab] = useState<GearCategory>('head')

  if (loading) return <div className="status">ギアデータを読み込み中...</div>
  if (error)   return <div className="status status--error">エラー: {error}</div>
  if (!data)   return null

  const items = data[activeTab]

  return (
    <div className="app">
      <header className="app-header">
        <h1 className="app-title">geartoon</h1>
        <span className="app-count">{items.length} 件</span>
      </header>

      <nav className="tabs">
        {TABS.map(({ key, label }) => (
          <button
            key={key}
            className={`tab ${activeTab === key ? 'tab--active' : ''}`}
            onClick={() => setActiveTab(key)}
          >
            {label}
          </button>
        ))}
      </nav>

      <div className="gear-grid">
        {items.map((gear) => (
          <GearCard key={gear.id} gear={gear} />
        ))}
      </div>
    </div>
  )
}

export default App
