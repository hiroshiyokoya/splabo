import { useEffect, useState } from 'react'
import { invoke } from '@tauri-apps/api/core'
import type { WeaponRecord } from '../types'

function winRateColor(rate: number): string {
  if (rate >= 0.55) return '#22c55e'
  if (rate >= 0.45) return '#f59e0b'
  return '#ef4444'
}

export function WeaponBook() {
  const [weapons,      setWeapons]      = useState<WeaponRecord[]>([])
  const [weaponImages, setWeaponImages] = useState<Map<string, string>>(new Map())
  const [loading,      setLoading]      = useState(true)
  const [category,     setCategory]     = useState<string | null>(null)

  useEffect(() => {
    invoke<WeaponRecord[]>('db_list_weapons')
      .then(rows => {
        setWeapons(rows)
        Promise.all(
          rows.map(w =>
            invoke<string | null>('read_image', { kind: 'weapon', name: w.name })
              .then(url => (url ? ([w.name, url] as [string, string]) : null))
              .catch(() => null)
          )
        ).then(results => {
          setWeaponImages(new Map(results.filter((r): r is [string, string] => r !== null)))
        })
      })
      .catch(console.error)
      .finally(() => setLoading(false))
  }, [])

  const categories = [...new Set(weapons.map(w => w.category))].filter(Boolean)
  const filtered   = category ? weapons.filter(w => w.category === category) : weapons

  return (
    <div className="weapon-book">
      <div className="weapon-book-header">
        <h2>武器図鑑</h2>
        <span className="total-count">{filtered.length} 種</span>
      </div>

      <div className="category-tabs">
        <button
          className={`category-tab${category === null ? ' active' : ''}`}
          onClick={() => setCategory(null)}
        >全て</button>
        {categories.map(c => (
          <button
            key={c}
            className={`category-tab${category === c ? ' active' : ''}`}
            onClick={() => setCategory(c)}
          >{c}</button>
        ))}
      </div>

      {loading ? (
        <div className="loading">読み込み中...</div>
      ) : weapons.length === 0 ? (
        <div className="empty">
          武器データがありません。<br />
          設定 › マスターデータ › 「武器データを更新」を実行してください。
        </div>
      ) : (
        <div className="weapon-grid">
          {filtered.map(w => (
            <WeaponCard key={w.name} weapon={w} image={weaponImages.get(w.name) ?? null} />
          ))}
        </div>
      )}
    </div>
  )
}

function WeaponCard({ weapon, image }: { weapon: WeaponRecord; image: string | null }) {
  const winRate = weapon.total > 0 ? weapon.wins / weapon.total : null

  return (
    <div className="weapon-card">
      <div className="weapon-card-icon-wrap">
        {image
          ? <img src={image} alt={weapon.name} className="weapon-card-icon" />
          : <div className="weapon-card-icon weapon-card-icon--placeholder" />
        }
      </div>
      <div className="weapon-card-name" title={weapon.name}>{weapon.name}</div>
      <div className="weapon-card-sub-sp">
        {weapon.sub_weapon     && <span className="weapon-card-sub">サブ: {weapon.sub_weapon}</span>}
        {weapon.special_weapon && <span className="weapon-card-sp">SP: {weapon.special_weapon}</span>}
      </div>
      {weapon.total > 0 ? (
        <div className="weapon-card-stats">
          <span className="weapon-card-stat">{weapon.total}試合</span>
          <span
            className="weapon-card-stat weapon-card-winrate"
            style={{ color: winRateColor(winRate!) }}
          >{(winRate! * 100).toFixed(1)}%</span>
        </div>
      ) : (
        <div className="weapon-card-stats weapon-card-stats--unused">未使用</div>
      )}
    </div>
  )
}
