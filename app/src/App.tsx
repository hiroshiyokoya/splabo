import { useState, useMemo } from 'react'
import { useGearDB } from './hooks/useGearDB'
import { GearCard } from './components/GearCard'
import type { GearCategory, GearItem } from './types'

const TABS: { key: GearCategory; label: string; icon: string }[] = [
  { key: 'head',     label: '頭ギア',  icon: '🪖' },
  { key: 'clothing', label: '服ギア',  icon: '👕' },
  { key: 'shoes',    label: '靴ギア',  icon: '👟' },
]

type SortKey = 'name' | 'rarity' | 'exp' | 'brand' | 'skill'

const SORT_OPTIONS: { key: SortKey; label: string }[] = [
  { key: 'brand',  label: 'ブランド' },
  { key: 'skill',  label: 'メインパワー' },
  { key: 'name',   label: '名前' },
  { key: 'rarity', label: 'レアリティ' },
  { key: 'exp',    label: 'EXP' },
]

function sortItems(items: GearItem[], key: SortKey): GearItem[] {
  return [...items].sort((a, b) => {
    switch (key) {
      case 'name':   return a.name.localeCompare(b.name, 'ja')
      case 'rarity': return b.rarity - a.rarity
      case 'exp':    return b.exp - a.exp
      case 'brand':  return a.brand.localeCompare(b.brand, 'ja')
      case 'skill':  return a.primary_skill.name.localeCompare(b.primary_skill.name, 'ja')
    }
  })
}

function App() {
  const { data, loading, error } = useGearDB()
  const [activeTab, setActiveTab] = useState<GearCategory>('head')
  const [sortKey, setSortKey] = useState<SortKey>('name')

  const items = useMemo(() => {
    if (!data) return []
    return sortItems(data[activeTab], sortKey)
  }, [data, activeTab, sortKey])

  if (loading) return <div className="status">ギアデータを読み込み中...</div>
  if (error)   return <div className="status status--error">エラー: {error}</div>
  if (!data)   return null

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

        <select
          className="sort-select"
          value={sortKey}
          onChange={e => setSortKey(e.target.value as SortKey)}
          aria-label="並び替え"
        >
          {SORT_OPTIONS.map(({ key, label }) => (
            <option key={key} value={key}>{label}</option>
          ))}
        </select>
      </nav>

      <div className="gear-grid">
        {items.map((gear) => (
          <GearCard key={gear.id} gear={gear} />
        ))}
      </div>

      <footer className="app-footer">
        <span className="app-footer__copy">© 2026 Hiroshi Yokoya</span>
        <span className="app-footer__divider">·</span>
        <span className="app-footer__note">geartoon — personal gear collection for Splatoon 3</span>
      </footer>
    </div>
  )
}

export default App
