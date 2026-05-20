import { useEffect, useState } from 'react'
import { invoke } from '@tauri-apps/api/core'
import type { WeaponRecord } from '../types'

// Dashboard.winRateColor と同期。
function winRateColor(rate: number): string {
  if (rate >= 0.55) return '#34d399'
  if (rate >= 0.45) return '#fb923c'
  return '#f472b6'
}

export function WeaponBook() {
  const [weapons,        setWeapons]        = useState<WeaponRecord[]>([])
  const [weaponImages,   setWeaponImages]   = useState<Map<string, string>>(new Map())
  const [subImages,      setSubImages]      = useState<Map<string, string>>(new Map())
  const [spImages,       setSpImages]       = useState<Map<string, string>>(new Map())
  const [loading,        setLoading]        = useState(true)
  const [category,       setCategory]       = useState<string | null>(null)
  const [subWeapon,      setSubWeapon]      = useState<string | null>(null)
  const [specialWeapon,  setSpecialWeapon]  = useState<string | null>(null)

  useEffect(() => {
    invoke<WeaponRecord[]>('db_list_weapons')
      .then(rows => {
        setWeapons(rows)

        // 主武器画像
        Promise.all(
          rows.map(w =>
            invoke<string | null>('read_image', { kind: 'weapon', name: w.name })
              .then(url => (url ? ([w.name, url] as [string, string]) : null))
              .catch(() => null)
          )
        ).then(results => {
          setWeaponImages(new Map(results.filter((r): r is [string, string] => r !== null)))
        })

        // サブウェポン画像（ユニーク名のみ）
        const uniqueSubs = [...new Map(
          rows.filter(w => w.sub_weapon).map(w => [w.sub_weapon!, w.sub_weapon!])
        ).keys()]
        Promise.all(
          uniqueSubs.map(name =>
            invoke<string | null>('read_image', { kind: 'sub_weapon', name })
              .then(url => (url ? ([name, url] as [string, string]) : null))
              .catch(() => null)
          )
        ).then(results => {
          setSubImages(new Map(results.filter((r): r is [string, string] => r !== null)))
        })

        // スペシャルウェポン画像（ユニーク名のみ）
        const uniqueSps = [...new Map(
          rows.filter(w => w.special_weapon).map(w => [w.special_weapon!, w.special_weapon!])
        ).keys()]
        Promise.all(
          uniqueSps.map(name =>
            invoke<string | null>('read_image', { kind: 'special_weapon', name })
              .then(url => (url ? ([name, url] as [string, string]) : null))
              .catch(() => null)
          )
        ).then(results => {
          setSpImages(new Map(results.filter((r): r is [string, string] => r !== null)))
        })
      })
      .catch(console.error)
      .finally(() => setLoading(false))
  }, [])

  const categories     = [...new Set(weapons.map(w => w.category))].filter(Boolean).sort()
  const subWeapons     = [...new Set(weapons.map(w => w.sub_weapon).filter((s): s is string => !!s))].sort()
  const specialWeapons = [...new Set(weapons.map(w => w.special_weapon).filter((s): s is string => !!s))].sort()

  const filtered = weapons.filter(w =>
    (!category      || w.category       === category) &&
    (!subWeapon     || w.sub_weapon     === subWeapon) &&
    (!specialWeapon || w.special_weapon === specialWeapon)
  )

  const hasFilter = !!(category || subWeapon || specialWeapon)

  function reset() {
    setCategory(null)
    setSubWeapon(null)
    setSpecialWeapon(null)
  }

  return (
    <div className="weapon-book">
      <div className="weapon-book-header">
        <h2>武器図鑑</h2>
        <span className="total-count">{filtered.length} 種</span>
        {hasFilter && (
          <button className="filter-reset-btn" onClick={reset} style={{ marginLeft: 8 }}>✕ リセット</button>
        )}
      </div>

      <div className="category-tabs">
        {categories.map(c => (
          <button
            key={c}
            className={`category-tab${category === c ? ' active' : ''}`}
            onClick={() => setCategory(prev => prev === c ? null : c)}
          >{c}</button>
        ))}
      </div>

      {subWeapons.length > 0 && (
        <div className="weapon-filter-row">
          <span className="weapon-filter-label">サブ</span>
          <div className="weapon-filter-btns">
            {subWeapons.map(s => (
              <button
                key={s}
                className={`filter-btn filter-btn--icon${subWeapon === s ? ' active' : ''}`}
                onClick={() => setSubWeapon(prev => prev === s ? null : s)}
                title={s}
              >
                {subImages.get(s)
                  ? <img src={subImages.get(s)} alt={s} className="filter-btn-icon" />
                  : s}
              </button>
            ))}
          </div>
        </div>
      )}

      {specialWeapons.length > 0 && (
        <div className="weapon-filter-row">
          <span className="weapon-filter-label">SP</span>
          <div className="weapon-filter-btns">
            {specialWeapons.map(s => (
              <button
                key={s}
                className={`filter-btn filter-btn--icon${specialWeapon === s ? ' active' : ''}`}
                onClick={() => setSpecialWeapon(prev => prev === s ? null : s)}
                title={s}
              >
                {spImages.get(s)
                  ? <img src={spImages.get(s)} alt={s} className="filter-btn-icon" />
                  : s}
              </button>
            ))}
          </div>
        </div>
      )}

      {loading ? (
        <div className="loading">読み込み中...</div>
      ) : weapons.length === 0 ? (
        <div className="empty">
          武器データがありません。<br />
          設定 › マスターデータ › 「武器データを更新」を実行してください。
        </div>
      ) : filtered.length === 0 ? (
        <div className="empty">条件に一致する武器がありません。</div>
      ) : (
        <div className="weapon-grid">
          {filtered.map(w => (
            <WeaponCard
              key={w.name}
              weapon={w}
              image={weaponImages.get(w.name) ?? null}
              subImage={w.sub_weapon ? (subImages.get(w.sub_weapon) ?? null) : null}
              spImage={w.special_weapon ? (spImages.get(w.special_weapon) ?? null) : null}
            />
          ))}
        </div>
      )}
    </div>
  )
}

function WeaponCard({ weapon, image, subImage, spImage }: {
  weapon: WeaponRecord
  image: string | null
  subImage: string | null
  spImage: string | null
}) {
  const decisive = weapon.total - weapon.draws
  const winRate = decisive > 0 ? weapon.wins / decisive : null

  return (
    <div className="weapon-card">
      <div className="weapon-card-icon-wrap">
        {image
          ? <img src={image} alt={weapon.name} className="weapon-card-icon" />
          : <div className="weapon-card-icon weapon-card-icon--placeholder" />
        }
      </div>
      {(spImage || subImage) && (
        <div className="weapon-card-sub-sp">
          {spImage && <img src={spImage} alt={weapon.special_weapon ?? ''} className="weapon-sub-sp-icon weapon-sub-sp-icon--sp" title={weapon.special_weapon ?? ''} />}
          {subImage && <img src={subImage} alt={weapon.sub_weapon ?? ''} className="weapon-sub-sp-icon" title={weapon.sub_weapon ?? ''} />}
        </div>
      )}
      <div className="weapon-card-name" title={weapon.name}>{weapon.name}</div>
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
