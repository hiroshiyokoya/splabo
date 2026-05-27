import { useEffect, useMemo, useState } from 'react'
import { invoke } from '@tauri-apps/api/core'
import type { GroupedStatsRow, WeaponRecord } from '../types'
import { WeaponDetailModal } from './WeaponDetailModal'

// Dashboard.winRateColor と同期。
function winRateColor(rate: number): string {
  if (rate >= 0.55) return '#34d399'
  if (rate >= 0.45) return '#fb923c'
  return '#f472b6'
}

// 大きい数値を「12.3万」短縮表示。
function shortNum(n: number | null | undefined): string {
  if (n === null || n === undefined) return '—'
  if (n >= 100_000_000) return `${(n / 100_000_000).toFixed(2)}億`
  if (n >= 10_000)      return `${(n / 10_000).toFixed(n >= 100_000 ? 1 : 2)}万`
  return n.toLocaleString()
}

/** 平均統計（K/D/A/SP/inked/duration）用の小行。 */
function statLine(label: string, value: string): { label: string; value: string } {
  return { label, value }
}

// カード一覧のソート種別。
// 仕様：ブキチャレパワー系・ビッグラン熟練度は WeaponRecordQuery で取れないため除外（#149 事前共有）。
type SortKey =
  | 'total'           // バトル数（既定）
  | 'wins'            // 勝数（DB バトル集計）
  | 'win_rate'        // 勝率
  | 'avg_kill'        // 平均キル数（db_grouped_stats から）
  | 'weapon_level'    // 熟練度（WeaponRecord）
  | 'win_count_total' // 通算勝利数（WeaponRecord）
  | 'paint_point_total' // 総塗りポイント（WeaponRecord）
  | 'name'            // 名前（あいうえお）

const SORT_LABELS: Record<SortKey, string> = {
  total:             'バトル数',
  wins:              '勝数',
  win_rate:          '勝率',
  avg_kill:          '平均キル',
  weapon_level:      '熟練度',
  win_count_total:   '通算勝利数',
  paint_point_total: '総塗',
  name:              '名前',
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
  const [sortKey,        setSortKey]        = useState<SortKey>('total')
  const [selected,       setSelected]       = useState<WeaponRecord | null>(null)
  // 武器ごとの平均統計（K/D/A/SP/inked/duration）。db_grouped_stats(group_by='weapon') を 1 回呼んでマップ化。
  const [statsByWeapon,  setStatsByWeapon]  = useState<Map<string, GroupedStatsRow>>(new Map())

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

    // 武器ごとの平均統計を 1 回まとめて取得。フィルタ無しで全期間。
    invoke<GroupedStatsRow[]>('db_grouped_stats', { groupBy: 'weapon' })
      .then(rows => setStatsByWeapon(new Map(rows.map(r => [r.key, r]))))
      .catch(console.error)
  }, [])

  const categories     = [...new Set(weapons.map(w => w.category))].filter(Boolean).sort()
  const subWeapons     = [...new Set(weapons.map(w => w.sub_weapon).filter((s): s is string => !!s))].sort()
  const specialWeapons = [...new Set(weapons.map(w => w.special_weapon).filter((s): s is string => !!s))].sort()

  const filtered = useMemo(() => {
    const arr = weapons.filter(w =>
      (!category      || w.category       === category) &&
      (!subWeapon     || w.sub_weapon     === subWeapon) &&
      (!specialWeapon || w.special_weapon === specialWeapon)
    )
    // ソート：null は常に末尾に流す。
    const cmpNum = (a: number | null, b: number | null) => {
      if (a === null && b === null) return 0
      if (a === null) return  1
      if (b === null) return -1
      return b - a // 降順
    }
    const winRate = (w: WeaponRecord): number | null => {
      const dec = w.total - w.draws
      return dec > 0 ? w.wins / dec : null
    }
    const avgKill = (w: WeaponRecord): number | null =>
      statsByWeapon.get(w.name)?.avg_kill ?? null
    return [...arr].sort((a, b) => {
      switch (sortKey) {
        case 'total':             return b.total - a.total
        case 'wins':              return b.wins  - a.wins
        case 'win_rate':          return cmpNum(winRate(a), winRate(b))
        case 'avg_kill':          return cmpNum(avgKill(a), avgKill(b))
        case 'weapon_level':      return cmpNum(a.weapon_level,      b.weapon_level)
        case 'win_count_total':   return cmpNum(a.win_count_total,   b.win_count_total)
        case 'paint_point_total': return cmpNum(a.paint_point_total, b.paint_point_total)
        case 'name':              return a.name.localeCompare(b.name, 'ja')
      }
    })
  }, [weapons, category, subWeapon, specialWeapon, sortKey, statsByWeapon])

  const hasFilter = !!(category || subWeapon || specialWeapon)

  // 公式統計（熟練度・勝利数・塗りポイント）が 1 件でも取得できているか。
  // WeaponRecordQuery が nxapi 同梱ハッシュ廃止（#162）で取れていない場合、
  // 全武器 0/null になるためソート項目から外す。
  const hasOfficialStats = useMemo(
    () => weapons.some(w =>
      (w.weapon_level     !== null && w.weapon_level     > 0) ||
      (w.win_count_total  !== null && w.win_count_total  > 0) ||
      (w.paint_point_total!== null && w.paint_point_total> 0)
    ),
    [weapons]
  )

  // 取得できないキーが選択されていたら 'total' に戻す。
  useEffect(() => {
    if (!hasOfficialStats &&
        (sortKey === 'weapon_level' || sortKey === 'win_count_total' || sortKey === 'paint_point_total')) {
      setSortKey('total')
    }
  }, [hasOfficialStats, sortKey])

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
        <div className="weapon-book-sort">
          <label htmlFor="weapon-sort">並び替え</label>
          <select
            id="weapon-sort"
            value={sortKey}
            onChange={e => setSortKey(e.target.value as SortKey)}
          >
            {(Object.keys(SORT_LABELS) as SortKey[]).map(k => {
              const isOfficial = k === 'weapon_level' || k === 'win_count_total' || k === 'paint_point_total'
              if (isOfficial && !hasOfficialStats) return null
              return <option key={k} value={k}>{SORT_LABELS[k]}</option>
            })}
          </select>
        </div>
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
              avgStats={statsByWeapon.get(w.name) ?? null}
              image={weaponImages.get(w.name) ?? null}
              subImage={w.sub_weapon ? (subImages.get(w.sub_weapon) ?? null) : null}
              spImage={w.special_weapon ? (spImages.get(w.special_weapon) ?? null) : null}
              onClick={() => setSelected(w)}
            />
          ))}
        </div>
      )}

      {selected && (
        <WeaponDetailModal
          weapon={selected}
          image={weaponImages.get(selected.name) ?? null}
          subImage={selected.sub_weapon ? (subImages.get(selected.sub_weapon) ?? null) : null}
          spImage={selected.special_weapon ? (spImages.get(selected.special_weapon) ?? null) : null}
          onClose={() => setSelected(null)}
        />
      )}
    </div>
  )
}

function WeaponCard({ weapon, avgStats, image, subImage, spImage, onClick }: {
  weapon:   WeaponRecord
  avgStats: GroupedStatsRow | null
  image:    string | null
  subImage: string | null
  spImage:  string | null
  onClick:  () => void
}) {
  const decisive = weapon.total - weapon.draws
  const winRate = decisive > 0 ? weapon.wins / decisive : null

  // 平均 K/D = K/D 比。0 除算は '—'。
  const kdStr =
    !avgStats || avgStats.avg_kill === null || avgStats.avg_death === null
      ? '—'
      : avgStats.avg_death === 0
        ? '∞'
        : (avgStats.avg_kill / avgStats.avg_death).toFixed(2)

  // 2 列のサマリ：左に公式統計、右に平均統計。バトル 0 戦の武器は最小カードのままにする。
  const officialRows = weapon.total > 0 ? [
    statLine('Lv',  weapon.weapon_level    !== null ? String(weapon.weapon_level) : '—'),
    statLine('勝',  weapon.win_count_total !== null ? weapon.win_count_total.toLocaleString() : '—'),
    statLine('塗',  shortNum(weapon.paint_point_total)),
  ] : []
  const avgRows = (weapon.total > 0 && avgStats) ? [
    statLine('K',   avgStats.avg_kill    !== null ? avgStats.avg_kill.toFixed(1)    : '—'),
    statLine('A',   avgStats.avg_assist  !== null ? avgStats.avg_assist.toFixed(1)  : '—'),
    statLine('D',   avgStats.avg_death   !== null ? avgStats.avg_death.toFixed(1)   : '—'),
    statLine('K/D', kdStr),
    statLine('SP',  avgStats.avg_special !== null ? avgStats.avg_special.toFixed(1) : '—'),
    statLine('塗均', avgStats.avg_inked  !== null ? Math.round(avgStats.avg_inked).toLocaleString() : '—'),
  ] : []

  return (
    <div className="weapon-card weapon-card--clickable" onClick={onClick} role="button" tabIndex={0}
      onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onClick() } }}
    >
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
        <>
          <div className="weapon-card-stats">
            <span className="weapon-card-stat">{weapon.total}試合</span>
            <span
              className="weapon-card-stat weapon-card-winrate"
              style={{ color: winRateColor(winRate!) }}
            >{(winRate! * 100).toFixed(1)}%</span>
          </div>
          <div className="weapon-card-stats-grid">
            <div className="weapon-card-stats-col">
              {officialRows.map(r => (
                <div key={r.label} className="weapon-card-mini">
                  <span className="weapon-card-mini-label">{r.label}</span>
                  <span className="weapon-card-mini-value">{r.value}</span>
                </div>
              ))}
            </div>
            <div className="weapon-card-stats-col">
              {avgRows.map(r => (
                <div key={r.label} className="weapon-card-mini">
                  <span className="weapon-card-mini-label">{r.label}</span>
                  <span className="weapon-card-mini-value">{r.value}</span>
                </div>
              ))}
            </div>
          </div>
        </>
      ) : (
        <div className="weapon-card-stats weapon-card-stats--unused">未使用</div>
      )}
    </div>
  )
}
