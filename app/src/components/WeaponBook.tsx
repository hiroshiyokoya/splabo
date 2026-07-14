import { useEffect, useMemo, useState } from 'react'
import { invoke } from '@tauri-apps/api/core'
import type { GroupedStatsRow, WeaponRecord, BookView } from '../types'
import { avgKillRatio } from '../types'
import { WeaponDetailModal } from './WeaponDetailModal'
import { ViewToggle, BOOK_VIEWS } from './ViewToggle'
import { SortHeader } from './SortHeader'
import { loadViewPrefs, saveViewPrefs } from '../utils/viewPrefs'

// Dashboard.winRateColor と同期。
function winRateColor(rate: number): string {
  if (rate >= 0.55) return '#34d399'
  if (rate >= 0.45) return '#fb923c'
  return '#f472b6'
}

// 大きい数値を「12.3万」短縮表示。
/** 平均統計（K/D/A/SP/inked/duration）用の小行。 */
function statLine(label: string, value: string): { label: string; value: string } {
  return { label, value }
}

// カード一覧のソート種別。
// 仕様：ブキチャレパワー系・ビッグラン熟練度は WeaponRecordQuery で取れないため除外（#149 事前共有）。
type SortKey =
  | 'total'           // バトル数（既定）
  | 'wins'            // 勝ち W（DB バトル集計）
  | 'loses'           // 負け L（total - wins - draws）
  | 'draws'           // 引分 D
  | 'win_rate'        // 勝率
  | 'avg_kill'        // 平均キル数（db_grouped_stats から）
  | 'avg_death'       // 平均デス数（db_grouped_stats から・少ないほど上位）
  | 'kd'              // K/D（平均K ÷ 平均D）
  | 'knockout_rate'   // KO 率（db_grouped_stats の knockout_win / total）
  | 'avg_inked'       // 平均塗りポイント（db_grouped_stats から）
  | 'weapon_level'    // 熟練度（WeaponRecord）
  | 'win_count_total' // 通算勝利数（WeaponRecord）
  | 'paint_point_total' // 総塗りポイント（WeaponRecord）
  | 'name'            // 名前（あいうえお）

const SORT_LABELS: Record<SortKey, string> = {
  total:             'バトル数',
  wins:              '勝ち(W)',
  loses:             '負け(L)',
  draws:             '引分(D)',
  win_rate:          '勝率',
  avg_kill:          '平均キル',
  avg_death:         '平均デス',
  kd:                'K/D',
  knockout_rate:     'KO率',
  avg_inked:         '平均塗り',
  weapon_level:      '熟練度',
  win_count_total:   '通算勝利数',
  paint_point_total: '総塗',
  name:              '名前',
}

/** ソート関数が「昇順」で並べるキー（それ以外は降順）。一覧ビューの矢印表示に使う。 */
const ASC_SORT_KEYS: ReadonlySet<SortKey> = new Set<SortKey>(['name', 'avg_death'])

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
  // パネル / 一覧の切替（#297）。前回選択を localStorage から復元する。
  const [view,           setViewState]      = useState<BookView>(() => loadViewPrefs().weapons)
  // 各ソートキーの「自然な向き」を反転するフラグ（一覧ビューのヘッダ再クリック）。
  const [reversed,       setReversed]       = useState(false)

  function setView(next: BookView) {
    setViewState(next)
    saveViewPrefs({ ...loadViewPrefs(), weapons: next })
  }

  /** テーブルヘッダのクリック: 同じキーなら向きを反転、違うキーなら自然な向きで並べ替え。 */
  function handleSort(key: SortKey) {
    if (key === sortKey) setReversed(r => !r)
    else { setSortKey(key); setReversed(false) }
  }

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
    // 平均デスは「少ないほど良い」ので昇順。null は末尾。
    const cmpNumAsc = (a: number | null, b: number | null) => {
      if (a === null && b === null) return 0
      if (a === null) return  1
      if (b === null) return -1
      return a - b
    }
    const winRate = (w: WeaponRecord): number | null => {
      const dec = w.total - w.draws
      return dec > 0 ? w.wins / dec : null
    }
    const avgKill = (w: WeaponRecord): number | null =>
      statsByWeapon.get(w.name)?.avg_kill ?? null
    const avgDeath = (w: WeaponRecord): number | null =>
      statsByWeapon.get(w.name)?.avg_death ?? null
    const avgInked = (w: WeaponRecord): number | null =>
      statsByWeapon.get(w.name)?.avg_inked ?? null
    const koRate = (w: WeaponRecord): number | null => {
      const s = statsByWeapon.get(w.name)
      if (!s || s.total === 0) return null
      return s.knockout_win / s.total
    }
    const loses = (w: WeaponRecord): number => w.total - w.wins - w.draws
    // K/D = 平均K ÷ 平均D。デス 0 は上位（Infinity）、データ無しは null。
    const kd = (w: WeaponRecord): number | null => {
      const ak = avgKill(w)
      const ad = avgDeath(w)
      if (ak === null || ad === null) return null
      if (ad === 0) return ak > 0 ? Number.POSITIVE_INFINITY : null
      return ak / ad
    }
    const sorted = [...arr].sort((a, b) => {
      switch (sortKey) {
        case 'total':             return b.total - a.total
        case 'wins':              return b.wins  - a.wins
        case 'loses':             return loses(b) - loses(a)
        case 'draws':             return b.draws - a.draws
        case 'win_rate':          return cmpNum(winRate(a), winRate(b))
        case 'avg_kill':          return cmpNum(avgKill(a), avgKill(b))
        case 'avg_death':         return cmpNumAsc(avgDeath(a), avgDeath(b))
        case 'kd':                return cmpNum(kd(a),      kd(b))
        case 'knockout_rate':     return cmpNum(koRate(a),   koRate(b))
        case 'avg_inked':         return cmpNum(avgInked(a), avgInked(b))
        case 'weapon_level':      return cmpNum(a.weapon_level,      b.weapon_level)
        case 'win_count_total':   return cmpNum(a.win_count_total,   b.win_count_total)
        case 'paint_point_total': return cmpNum(a.paint_point_total, b.paint_point_total)
        case 'name':              return a.name.localeCompare(b.name, 'ja')
      }
    })
    // 各キーの「自然な向き」を基準に、一覧ビューのヘッダ再クリックで反転する（#297）。
    if (reversed) sorted.reverse()
    return sorted
  }, [weapons, category, subWeapon, specialWeapon, sortKey, statsByWeapon, reversed])

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
        <ViewToggle
          options={BOOK_VIEWS}
          value={view}
          onChange={setView}
          ariaLabel="武器図鑑の表示切替"
        />
        {view === 'panel' && (
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
      ) : view === 'list' ? (
        <WeaponTable
          rows={filtered}
          statsByWeapon={statsByWeapon}
          subImages={subImages}
          spImages={spImages}
          sortKey={sortKey}
          ascending={ASC_SORT_KEYS.has(sortKey) !== reversed}
          onSort={handleSort}
          onSelect={setSelected}
        />
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
          stats={statsByWeapon.get(selected.name) ?? null}
          onClose={() => setSelected(null)}
        />
      )}
    </div>
  )
}

/** 一覧のサブ／スペシャル欄。画像があればアイコン、無ければ名前でフォールバックする。 */
function BookIcon({ src, name }: { src: string | null; name: string | null }) {
  if (!name) return <>—</>
  if (!src)  return <>{name}</>
  return <img src={src} alt={name} title={name} className="book-icon" />
}

/** 一覧ビュー（#297）。ヘッダクリックで並び替え、行クリックで詳細モーダル。
 *  列はローカル集計中心（任天堂由来の熟練度・通算勝利数はパネル／詳細モーダルに任せる）。 */
function WeaponTable({ rows, statsByWeapon, subImages, spImages, sortKey, ascending, onSort, onSelect }: {
  rows:          WeaponRecord[]
  statsByWeapon: Map<string, GroupedStatsRow>
  subImages:     Map<string, string>
  spImages:      Map<string, string>
  sortKey:       SortKey
  ascending:     boolean
  onSort:        (k: SortKey) => void
  onSelect:      (w: WeaponRecord) => void
}) {
  return (
    <div className="book-table-wrap">
      <table className="book-table">
        <thead>
          <tr>
            <SortHeader label="武器"     sortKey="name"          activeKey={sortKey} ascending={ascending} onSort={onSort} align="left" />
            <SortHeader label="カテゴリ"                         activeKey={sortKey} ascending={ascending} onSort={onSort} align="left" />
            <SortHeader label="サブ"                             activeKey={sortKey} ascending={ascending} onSort={onSort} align="left" />
            <SortHeader label="スペシャル"                       activeKey={sortKey} ascending={ascending} onSort={onSort} align="left" />
            <SortHeader label="バトル数" sortKey="total"         activeKey={sortKey} ascending={ascending} onSort={onSort} />
            <SortHeader label="W"        sortKey="wins"          activeKey={sortKey} ascending={ascending} onSort={onSort} />
            <SortHeader label="L"        sortKey="loses"         activeKey={sortKey} ascending={ascending} onSort={onSort} />
            <SortHeader label="D"        sortKey="draws"         activeKey={sortKey} ascending={ascending} onSort={onSort} />
            <SortHeader label="勝率"     sortKey="win_rate"      activeKey={sortKey} ascending={ascending} onSort={onSort} />
            <SortHeader label="平均K"    sortKey="avg_kill"      activeKey={sortKey} ascending={ascending} onSort={onSort} />
            <SortHeader label="平均D"    sortKey="avg_death"     activeKey={sortKey} ascending={ascending} onSort={onSort} />
            <SortHeader label="K/D"      sortKey="kd"            activeKey={sortKey} ascending={ascending} onSort={onSort} />
            <SortHeader label="KO率"     sortKey="knockout_rate" activeKey={sortKey} ascending={ascending} onSort={onSort} />
            <SortHeader label="平均塗り" sortKey="avg_inked"     activeKey={sortKey} ascending={ascending} onSort={onSort} />
          </tr>
        </thead>
        <tbody>
          {rows.map(w => {
            const decisive = w.total - w.draws
            const winRate  = decisive > 0 ? w.wins / decisive : null
            const loses    = w.total - w.wins - w.draws
            const stats    = statsByWeapon.get(w.name) ?? null
            const koRate   = stats && stats.total > 0 ? stats.knockout_win / stats.total : null
            const subImg   = w.sub_weapon     ? (subImages.get(w.sub_weapon)     ?? null) : null
            const spImg    = w.special_weapon ? (spImages.get(w.special_weapon)  ?? null) : null
            return (
              <tr key={w.name} className="book-tr clickable-row" onClick={() => onSelect(w)}>
                <td className="book-td book-td--left">{w.name}</td>
                <td className="book-td book-td--left">{w.category}</td>
                <td className="book-td book-td--left">
                  <BookIcon src={subImg} name={w.sub_weapon} />
                </td>
                <td className="book-td book-td--left">
                  <BookIcon src={spImg} name={w.special_weapon} />
                </td>
                <td className="book-td">{w.total}</td>
                <td className="book-td">{w.wins}</td>
                <td className="book-td">{loses}</td>
                <td className="book-td">{w.draws}</td>
                <td className="book-td" style={{ color: winRate !== null ? winRateColor(winRate) : undefined }}>
                  {winRate !== null ? `${(winRate * 100).toFixed(1)}%` : '—'}
                </td>
                <td className="book-td">{stats?.avg_kill  != null ? stats.avg_kill.toFixed(2)  : '—'}</td>
                <td className="book-td">{stats?.avg_death != null ? stats.avg_death.toFixed(2) : '—'}</td>
                <td className="book-td">{avgKillRatio(stats?.avg_kill ?? null, stats?.avg_death ?? null)}</td>
                <td className="book-td">{koRate !== null ? `${(koRate * 100).toFixed(1)}%` : '—'}</td>
                <td className="book-td">{stats?.avg_inked != null ? Math.round(stats.avg_inked).toLocaleString() : '—'}</td>
              </tr>
            )
          })}
        </tbody>
      </table>
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

  // 2 列のサマリ：左に戦績サマリー、右に平均統計。バトル 0 戦の武器は最小カードのままにする。
  const officialRows = weapon.total > 0 ? [
    statLine('Lv',    weapon.weapon_level !== null ? String(weapon.weapon_level) : '—'),
    ...(avgStats ? [
      statLine('勝',     avgStats.wins.toLocaleString()),
      statLine('KO勝',   avgStats.knockout_win.toLocaleString()),
      statLine('負け',   (avgStats.total - avgStats.wins - avgStats.draws).toLocaleString()),
      statLine('KO負け', avgStats.knockout_lose.toLocaleString()),
      statLine('平均塗', avgStats.avg_inked !== null ? Math.round(avgStats.avg_inked).toLocaleString() : '—'),
      statLine('総塗',   avgStats.sum_inked !== null ? avgStats.sum_inked.toLocaleString() : '—'),
    ] : []),
  ] : []
  const avgRows = (weapon.total > 0 && avgStats) ? [
    statLine('K',   avgStats.avg_kill    !== null ? avgStats.avg_kill.toFixed(1)    : '—'),
    statLine('A',   avgStats.avg_assist  !== null ? avgStats.avg_assist.toFixed(1)  : '—'),
    statLine('D',   avgStats.avg_death   !== null ? avgStats.avg_death.toFixed(1)   : '—'),
    statLine('K/D', kdStr),
    statLine('SP',  avgStats.avg_special !== null ? avgStats.avg_special.toFixed(1) : '—'),
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
