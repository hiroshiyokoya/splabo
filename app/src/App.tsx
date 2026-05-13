import { useState } from 'react'
import { useGearDB } from './hooks/useGearDB'
import { GearCard } from './components/GearCard'
import type { GearCategory } from './types'

const TABS: { key: GearCategory; label: string; icon: string }[] = [
  { key: 'head',     label: '頭ギア',  icon: '🪖' },
  { key: 'clothing', label: '服ギア',  icon: '👕' },
  { key: 'shoes',    label: '靴ギア',  icon: '👟' },
]

function App() {
  const { data, loading, error } = useGearDB()
  const [activeTab, setActiveTab] = useState<GearCategory>('head')

  if (loading) return <div className="status">ギアデータを読み込み中...</div>
  if (error)   return <div className="status status--error">エラー: {error}</div>
  if (!data)   return null

  const items = data[activeTab]
  const total = data.head.length + data.clothing.length + data.shoes.length

  return (
    <div className="app">
      <header className="app-header">
        <div className="app-header__left">
          <img src="/geartoon-logo.png" alt="geartoon" height="68" style={{ display: 'block' }} />
          <p className="app-subtitle">Splatoon Gear Collection</p>
        </div>
        <span className="app-count">{total.toLocaleString()} ギア</span>
      </header>

      <div className="header-divider" />

      <nav className="tabs">
        {TABS.map(({ key, label, icon }) => (
          <button
            key={key}
            className={`tab ${activeTab === key ? 'tab--active' : ''}`}
            onClick={() => setActiveTab(key)}
          >
            <span className="tab__icon">{icon}</span>
            {label}
            <span className="tab__badge">{data[key].length}</span>
          </button>
        ))}
      </nav>

      <div className="gear-grid">
        {items.map((gear) => (
          <GearCard key={gear.id} gear={gear} />
        ))}
 