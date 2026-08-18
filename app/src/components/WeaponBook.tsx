import { useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { TFunction } from 'i18next'
import { invoke } from '@tauri-apps/api/core'
import type { GroupedStatsRow, WeaponRecord, BookView, Filters } from '../types'
import { filtersToBookArgs, avgKillRatio, fmtOfficialDate, METRIC_LABELS } from '../types'
import { WeaponDetailModal } from './WeaponDetailModal'
import { ViewToggle, getBookViews } from './ViewToggle'
import { SortHeader } from './SortHeader'
import { loadViewPrefs, saveViewPrefs } from '../utils/viewPrefs'
import { winRateColor } from '../utils/heatmapColors'
import { weaponRecordDisplayName } from '../i18n/displayName'

// 大きい数値を「12.3万」短縮表示。
/** 平均統計(K/D/A/SP/inked/duration)用の小行。
 *  `title` はホバー時のツールチップ(カッコ内の意味を補足する用途・#313)。 */
function statLine(label: string, value: string, title?: string): { label: string; value: string; title?: string } {
  return { label, value, title }
}

// カード一覧のソート種別。
type SortKey =
  | 'total'           // バトル数(既定)
  | 'wins'            // 勝ち W(DB バトル集計)
  | 'loses'           // 負け L(total - wins - draws)
  | 'draws'           // 引分 D
  | 'win_rate'        // 勝率
  | 'avg_kill'        // 平均キル数(db_grouped_stats から)
  | 'avg_assist'      // 平均アシスト数(db_grouped_stats から)
  | 'avg_death'       // 平均デス数(db_grouped_stats から・少ないほど上位)
  | 'kd'              // K/D(平均K ÷ 平均D)
  | 'contrib_kd'      // 貢献キルレ (K+A)÷D
  | 'avg_inked'       // 平均塗りポイント(db_grouped_stats から)
  | 'weapon_level'    // 熟練度(公式)
  | 'win_count_total' // 通算勝利(公式)
  | 'paint_point_total' // 通算塗(公式)
  | 'last_used_at'    // 最終使用(公式)
  | 'weapon_power'    // ブキチャレパワー現在(公式)
  | 'weapon_power_max' // ブキチャレパワー最大(公式)
  | 'name'            // 名前(あいうえお)

function weaponSortLabels(t: TFunction): Record<SortKey, string> {
  return {
    total:             METRIC_LABELS.total,
    wins:              t('books.winsW'),
    loses:             t('books.losesL'),
    draws:             t('books.drawsD'),
    win_rate:          METRIC_LABELS.win_rate,
    avg_kill:          t('books.avgKill'),
    avg_assist:        t('books.avgAssist'),
    avg_death:         t('books.avgDeath'),
    kd:                METRIC_LABELS.avg_kd,
    contrib_kd:        METRIC_LABELS.avg_contrib_kd,
    avg_inked:         t('books.avgInked'),
    weapon_level:      METRIC_LABELS.official_weapon_level,
    win_count_total:   METRIC_LABELS.official_win_count,
    paint_point_total: METRIC_LABELS.official_paint,
    last_used_at:      METRIC_LABELS.official_last_used_at,
    weapon_power:      METRIC_LABELS.official_weapon_power,
    weapon_power_max:  t('books.maxParen'),
    name:              t('books.name'),
  }
}

const OFFICIAL_SORT: SortKey[] = [
  'weapon_level', 'win_count_total', 'paint_point_total',
  'last_used_at', 'weapon_power', 'weapon_power_max',
]

function fmtPower(n: number | null | undefined): string {
  if (n == null) return '-'
  return Math.round(n).toLocaleString()
}

/** ソート関数が「昇順」で並べるキー(それ以外は降順)。一覧ビューの矢印表示に使う。 */
const ASC_SORT_KEYS: ReadonlySet<SortKey> = new Set<SortKey>(['name', 'avg_death'])

export function WeaponBook({ filters }: { filters: Filters }) {
  const { t } = useTranslation()
  const sortLabels = weaponSortLabels(t)
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
  // ブキごとの平均統計(K/D/A/SP/inked/duration)。db_grouped_stats(group_by='weapon') を 1 回呼んでマップ化。
  const [statsByWeapon,  setStatsByWeapon]  = useState<Map<string, GroupedStatsRow>>(new Map())
  // パネル / 一覧の切替(#297)。前回選択を localStorage から復元する。
  const [view,           setViewState]      = useState<BookView>(() => loadViewPrefs().weapons)
  // 各ソートキーの「自然な向き」を反転するフラグ(一覧ビューのヘッダ再クリック)。
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

        // 主ブキ画像
        Promise.all(
          rows.map(w =>
            invoke<string | null>('read_image', { kind: 'weapon', name: w.name })
              .then(url => (url ? ([w.name, url] as [string, string]) : null))
              .catch(() => null)
          )
        ).then(results => {
          setWeaponImages(new Map(results.filter((r): r is [string, string] => r !== null)))
        })

        // サブウェポン画像(ユニーク名のみ)
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

        // スペシャルウェポン画像(ユニーク名のみ)
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

    // ブキごとの平均統計を 1 回まとめて取得。フィルタ無しで全期間。
    // 共通 FilterBar(期間・モード・ルール・結果)をローカル集計に反映する(#298)。
    // ※ 公式アプリの数字（熟練度・通算勝利・通算塗りPなど）は全期間固定でフィルタ不可。
    //    そちらは db_list_weapons 由来なので、この呼び出しには追従しない(「全期間」バッジで区別)。
    invoke<GroupedStatsRow[]>('db_grouped_stats', { groupBy: 'weapon', ...filtersToBookArgs(filters) })
      .then(rows => setStatsByWeapon(new Map(rows.map(r => [r.key, r]))))
      .catch(console.error)
  }, [filters])

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
    // バトル数・勝数・勝率・平均K/D・貢献キルレ・平均塗り はすべて db_grouped_stats
    // (フィルタ済み)を参照する。WeaponRecord.total/wins/draws は db_list_weapons
    // 由来で全期間固定のため使わない(#298)。
    const st       = (w: WeaponRecord) => statsByWeapon.get(w.name) ?? null
    const total    = (w: WeaponRecord): number => st(w)?.total ?? 0
    const wins     = (w: WeaponRecord): number => st(w)?.wins  ?? 0
    const winRate  = (w: WeaponRecord): number | null => st(w)?.win_rate  ?? null
    const avgKill   = (w: WeaponRecord): number | null => st(w)?.avg_kill   ?? null
    const avgAssist = (w: WeaponRecord): number | null => st(w)?.avg_assist ?? null
    const avgDeath  = (w: WeaponRecord): number | null => st(w)?.avg_death  ?? null
    const avgInked = (w: WeaponRecord): number | null => st(w)?.avg_inked ?? null
    const draws = (w: WeaponRecord): number => st(w)?.draws ?? 0
    const loses = (w: WeaponRecord): number => total(w) - wins(w) - draws(w)
    // K/D = 平均K ÷ 平均D。デス 0 は上位(Infinity)、データ無しは null。
    const kd = (w: WeaponRecord): number | null => {
      const ak = avgKill(w)
      const ad = avgDeath(w)
      if (ak === null || ad === null) return null
      if (ad === 0) return ak > 0 ? Number.POSITIVE_INFINITY : null
      return ak / ad
    }
    const contribKd = (w: WeaponRecord): number | null => {
      const ak = avgKill(w)
      const aa = avgAssist(w)
      const ad = avgDeath(w)
      if (ak === null || aa === null || ad === null) return null
      if (ad === 0) return (ak + aa) > 0 ? Number.POSITIVE_INFINITY : null
      return (ak + aa) / ad
    }
    const sorted = [...arr].sort((a, b) => {
      switch (sortKey) {
        case 'total':             return total(b) - total(a)
        case 'wins':              return wins(b)  - wins(a)
        case 'loses':             return loses(b) - loses(a)
        case 'draws':             return draws(b) - draws(a)
        case 'win_rate':          return cmpNum(winRate(a), winRate(b))
        case 'avg_kill':          return cmpNum(avgKill(a), avgKill(b))
        case 'avg_assist':        return cmpNum(avgAssist(a), avgAssist(b))
        case 'avg_death':         return cmpNumAsc(avgDeath(a), avgDeath(b))
        case 'kd':                return cmpNum(kd(a),      kd(b))
        case 'contrib_kd':        return cmpNum(contribKd(a), contribKd(b))
        case 'avg_inked':         return cmpNum(avgInked(a), avgInked(b))
        case 'weapon_level':      return cmpNum(a.weapon_level,      b.weapon_level)
        case 'win_count_total':   return cmpNum(a.win_count_total,   b.win_count_total)
        case 'paint_point_total': return cmpNum(a.paint_point_total, b.paint_point_total)
        case 'last_used_at':      return cmpNum(a.last_used_at,      b.last_used_at)
        case 'weapon_power':      return cmpNum(a.weapon_power,      b.weapon_power)
        case 'weapon_power_max':  return cmpNum(a.weapon_power_max,  b.weapon_power_max)
        case 'name':              return weaponRecordDisplayName(a).localeCompare(weaponRecordDisplayName(b))
      }
    })
    // 各キーの「自然な向き」を基準に、一覧ビューのヘッダ再クリックで反転する(#297)。
    if (reversed) sorted.reverse()
    return sorted
  }, [weapons, category, subWeapon, specialWeapon, sortKey, statsByWeapon, reversed])

  const hasFilter = !!(category || subWeapon || specialWeapon)

  // 公式統計(熟練度・勝利数・塗りポイント)が 1 件でも取得できているか。
  // 未取得（0/null）のときはソート項目から外す。取得は設定「ブキデータを更新」(#674)。
  const hasOfficialStats = useMemo(
    () => weapons.some(w =>
      (w.weapon_level      !== null && w.weapon_level      > 0) ||
      (w.win_count_total   !== null && w.win_count_total   > 0) ||
      (w.paint_point_total !== null && w.paint_point_total > 0) ||
      (w.last_used_at      !== null && w.last_used_at      > 0) ||
      (w.weapon_power      !== null && w.weapon_power      > 0) ||
      (w.weapon_power_max  !== null && w.weapon_power_max  > 0)
    ),
    [weapons]
  )

  useEffect(() => {
    if (!hasOfficialStats && OFFICIAL_SORT.includes(sortKey)) {
      setSortKey('total')
    }
  }, [hasOfficialStats, sortKey])

  function reset() {
    setCategory(null)
    setSubWeapon(null)
    setSpecialWeapon(null)
  }

  return (
    <div className={`weapon-book${view === 'list' ? ' book--fill' : ''}`}>
      <div className="weapon-book-header">
        <h2>{t('nav.weapons')}</h2>
        <span className="total-count">{t('common.speciesCount', { count: filtered.length })}</span>
        {hasFilter && (
          <button className="filter-reset-btn" onClick={reset} style={{ marginLeft: 8 }}>{t('filter.reset')}</button>
        )}
        <ViewToggle
          options={getBookViews(t)}
          value={view}
          onChange={setView}
          ariaLabel={t('books.weaponViewAria')}
        />
        {view === 'panel' && (
          <div className="weapon-book-sort">
            <label htmlFor="weapon-sort">{t('books.sort')}</label>
            <select
              id="weapon-sort"
              value={sortKey}
              onChange={e => setSortKey(e.target.value as SortKey)}
            >
              {(Object.keys(sortLabels) as SortKey[]).map(k => {
                if (OFFICIAL_SORT.includes(k) && !hasOfficialStats) return null
                return <option key={k} value={k}>{sortLabels[k]}</option>
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
          <span className="weapon-filter-label">{t('books.sub')}</span>
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
          <span className="weapon-filter-label">{t('books.special')}</span>
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
        <div className="loading">{t('common.loading')}</div>
      ) : weapons.length === 0 ? (
        <div className="empty">
          {t('books.noMaster')}<br />
          {t('books.updateMasterHint')}
        </div>
      ) : filtered.length === 0 ? (
        <div className="empty">{t('books.noWeapons')}</div>
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
          filters={filters}
          onClose={() => setSelected(null)}
        />
      )}
    </div>
  )
}

/** 一覧のサブ/スペシャル欄。画像があればアイコン、無ければ名前でフォールバックする。 */
function BookIcon({ src, name }: { src: string | null; name: string | null }) {
  if (!name) return <>-</>
  if (!src)  return <>{name}</>
  return <img src={src} alt={name} title={name} className="book-icon" />
}

/** 一覧ビュー(#297)。ヘッダクリックで並び替え、行クリックで詳細モーダル。
 *  列はローカル集計中心(任天堂由来の熟練度・通算勝利数はパネル/詳細モーダルに任せる)。 */
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
  const { t } = useTranslation()
  return (
    <div className="book-table-wrap">
      <table className="book-table">
        <thead>
          <tr>
            <SortHeader label={t('books.weapon')}     sortKey="name"          activeKey={sortKey} ascending={ascending} onSort={onSort} align="left" />
            <SortHeader label={t('books.category')}                         activeKey={sortKey} ascending={ascending} onSort={onSort} align="left" />
            <SortHeader label={t('books.sub')}                             activeKey={sortKey} ascending={ascending} onSort={onSort} align="left" />
            <SortHeader label={t('books.special')}                       activeKey={sortKey} ascending={ascending} onSort={onSort} align="left" />
            <SortHeader label={METRIC_LABELS.total} sortKey="total"         activeKey={sortKey} ascending={ascending} onSort={onSort} />
            <SortHeader label="W"        sortKey="wins"          activeKey={sortKey} ascending={ascending} onSort={onSort} />
            <SortHeader label="L"        sortKey="loses"         activeKey={sortKey} ascending={ascending} onSort={onSort} />
            <SortHeader label="D"        sortKey="draws"         activeKey={sortKey} ascending={ascending} onSort={onSort} />
            <SortHeader label={METRIC_LABELS.win_rate}     sortKey="win_rate"      activeKey={sortKey} ascending={ascending} onSort={onSort} />
            <SortHeader label={t('books.avgK')}    sortKey="avg_kill"      activeKey={sortKey} ascending={ascending} onSort={onSort} />
            <SortHeader label={t('books.avgA')}    sortKey="avg_assist"    activeKey={sortKey} ascending={ascending} onSort={onSort} />
            <SortHeader label={t('books.avgD')}    sortKey="avg_death"     activeKey={sortKey} ascending={ascending} onSort={onSort} />
            <SortHeader label={METRIC_LABELS.avg_kd}     sortKey="kd"            activeKey={sortKey} ascending={ascending} onSort={onSort} />
            <SortHeader label={METRIC_LABELS.avg_contrib_kd} sortKey="contrib_kd"    activeKey={sortKey} ascending={ascending} onSort={onSort} />
            <SortHeader label={t('books.avgInked')}  sortKey="avg_inked"     activeKey={sortKey} ascending={ascending} onSort={onSort} />
          </tr>
        </thead>
        <tbody>
          {rows.map(w => {
            // 集計値(バトル数・W/L/D・勝率・平均K/D・貢献キルレ・平均塗り)はすべて
            // フィルタ済みの db_grouped_stats 由来(#298)。
            const stats    = statsByWeapon.get(w.name) ?? null
            const total    = stats?.total ?? 0
            const wins     = stats?.wins  ?? 0
            const draws    = stats?.draws ?? 0
            const loses    = total - wins - draws
            const decisive = total - draws
            const winRate  = decisive > 0 ? (wins / decisive) : null
            const subImg   = w.sub_weapon     ? (subImages.get(w.sub_weapon)    ?? null) : null
            const spImg    = w.special_weapon ? (spImages.get(w.special_weapon) ?? null) : null
            return (
              <tr key={w.name} className="book-tr clickable-row" onClick={() => onSelect(w)}>
                <td className="book-td book-td--left">{weaponRecordDisplayName(w)}</td>
                <td className="book-td book-td--left">{w.category}</td>
                <td className="book-td book-td--left">
                  <BookIcon src={subImg} name={w.sub_weapon} />
                </td>
                <td className="book-td book-td--left">
                  <BookIcon src={spImg} name={w.special_weapon} />
                </td>
                <td className="book-td">{total}</td>
                <td className="book-td">{wins}</td>
                <td className="book-td">{loses}</td>
                <td className="book-td">{draws}</td>
                <td className="book-td" style={{ color: winRate !== null ? winRateColor(winRate) : undefined }}>
                  {winRate !== null ? `${(winRate * 100).toFixed(1)}%` : '-'}
                </td>
                <td className="book-td">{stats?.avg_kill   != null ? stats.avg_kill.toFixed(2)   : '-'}</td>
                <td className="book-td">{stats?.avg_assist != null ? stats.avg_assist.toFixed(2) : '-'}</td>
                <td className="book-td">{stats?.avg_death  != null ? stats.avg_death.toFixed(2)  : '-'}</td>
                <td className="book-td">{avgKillRatio(stats?.avg_kill ?? null, stats?.avg_death ?? null)}</td>
                <td className="book-td">{avgKillRatio(
                  stats?.avg_kill != null && stats?.avg_assist != null ? stats.avg_kill + stats.avg_assist : null,
                  stats?.avg_death ?? null,
                )}</td>
                <td className="book-td">{stats?.avg_inked != null ? Math.round(stats.avg_inked).toLocaleString() : '-'}</td>
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
  const { t } = useTranslation()
  const winRateLabel = METRIC_LABELS.win_rate
  // 試合数・勝率はフィルタ済みの db_grouped_stats 由来(#298)。
  // WeaponRecord.total/wins/draws は全期間固定なので使わない。
  const total    = avgStats?.total ?? 0
  const decisive = total - (avgStats?.draws ?? 0)
  const winRate  = decisive > 0 ? (avgStats!.wins / decisive) : null

  const kdStr =
    !avgStats || avgStats.avg_kill === null || avgStats.avg_death === null
      ? '-'
      : avgStats.avg_death === 0
        ? '∞'
        : (avgStats.avg_kill / avgStats.avg_death).toFixed(2)

  const hasOfficial =
    weapon.weapon_level != null ||
    weapon.win_count_total != null ||
    weapon.paint_point_total != null ||
    weapon.last_used_at != null ||
    weapon.weapon_power != null ||
    weapon.weapon_power_max != null

  const officialRows = hasOfficial ? [
    statLine(METRIC_LABELS.official_weapon_level, weapon.weapon_level != null ? String(weapon.weapon_level) : '-'),
    statLine(METRIC_LABELS.official_win_count, weapon.win_count_total != null ? weapon.win_count_total.toLocaleString() : '-'),
    statLine(METRIC_LABELS.official_paint, weapon.paint_point_total != null ? weapon.paint_point_total.toLocaleString() : '-'),
    statLine(METRIC_LABELS.official_weapon_power, fmtPower(weapon.weapon_power)),
    statLine(t('books.maxParen'), fmtPower(weapon.weapon_power_max)),
    statLine(METRIC_LABELS.official_last_used_at, fmtOfficialDate(weapon.last_used_at)),
  ] : []

  const localLeft = total > 0 && avgStats ? [
    statLine(
      t('books.win'),
      `${avgStats.wins.toLocaleString()} (${avgStats.knockout_win.toLocaleString()})`,
      t('books.winKo', { wins: avgStats.wins.toLocaleString(), ko: avgStats.knockout_win.toLocaleString() }),
    ),
    statLine(
      t('books.lose'),
      `${(avgStats.total - avgStats.wins - avgStats.draws).toLocaleString()} (${avgStats.knockout_lose.toLocaleString()})`,
      t('books.loseKo', { losses: (avgStats.total - avgStats.wins - avgStats.draws).toLocaleString(), ko: avgStats.knockout_lose.toLocaleString() }),
    ),
    statLine(winRateLabel, winRate !== null ? `${(winRate * 100).toFixed(1)}%` : '-'),
    statLine(t('books.avgPaintShort'), avgStats.avg_inked !== null ? Math.round(avgStats.avg_inked).toLocaleString() : '-'),
    statLine(t('books.sumInked'), avgStats.sum_inked !== null ? avgStats.sum_inked.toLocaleString() : '-'),
  ] : []
  const localRight = (total > 0 && avgStats) ? [
    statLine('K',   avgStats.avg_kill    !== null ? avgStats.avg_kill.toFixed(1)    : '-'),
    statLine('A',   avgStats.avg_assist  !== null ? avgStats.avg_assist.toFixed(1)  : '-'),
    statLine('D',   avgStats.avg_death   !== null ? avgStats.avg_death.toFixed(1)   : '-'),
    statLine(winRateLabel, kdStr),
    statLine(METRIC_LABELS.avg_contrib_kd, avgKillRatio(
      avgStats.avg_kill != null && avgStats.avg_assist != null
        ? avgStats.avg_kill + avgStats.avg_assist
        : null,
      avgStats.avg_death,
    )),
    statLine('SP',  avgStats.avg_special !== null ? avgStats.avg_special.toFixed(1) : '-'),
  ] : []

  return (
    <div className="weapon-card weapon-card--clickable" onClick={onClick} role="button" tabIndex={0}
      onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onClick() } }}
    >
      <div className="weapon-card-icon-wrap">
        {image
          ? <img src={image} alt={weaponRecordDisplayName(weapon)} className="weapon-card-icon" />
          : <div className="weapon-card-icon weapon-card-icon--placeholder" />
        }
      </div>
      {(spImage || subImage) && (
        <div className="weapon-card-sub-sp">
          {spImage && <img src={spImage} alt={weapon.special_weapon ?? ''} className="weapon-sub-sp-icon weapon-sub-sp-icon--sp" title={weapon.special_weapon ?? ''} />}
          {subImage && <img src={subImage} alt={weapon.sub_weapon ?? ''} className="weapon-sub-sp-icon" title={weapon.sub_weapon ?? ''} />}
        </div>
      )}
      <div className="weapon-card-name" title={weaponRecordDisplayName(weapon)}>{weaponRecordDisplayName(weapon)}</div>
      {hasOfficial && (
        <div className="weapon-card-official-grid">
          {officialRows.map(r => (
            <div key={r.label} className="weapon-card-official-cell" title={r.title}>
              <span className="weapon-card-official-label">{r.label}</span>
              <span className="weapon-card-official-value">{r.value}</span>
            </div>
          ))}
        </div>
      )}
      {total > 0 ? (
        <div className={hasOfficial ? 'weapon-card-local' : undefined}>
          <div className="weapon-card-stats-grid">
            <div className="weapon-card-stats-col">
              {localLeft.map(r => (
                <div key={r.label} className="weapon-card-mini" title={r.title}>
                  <span className="weapon-card-mini-label">{r.label}</span>
                  <span
                    className="weapon-card-mini-value"
                    style={r.label === winRateLabel && winRate !== null ? { color: winRateColor(winRate) } : undefined}
                  >{r.value}</span>
                </div>
              ))}
            </div>
            <div className="weapon-card-stats-col">
              {localRight.map(r => (
                <div key={r.label} className="weapon-card-mini">
                  <span className="weapon-card-mini-label">{r.label}</span>
                  <span className="weapon-card-mini-value">{r.value}</span>
                </div>
              ))}
            </div>
          </div>
        </div>
      ) : (
        <div className="weapon-card-stats weapon-card-stats--unused">
          {hasOfficial ? t('books.unusedHere') : t('books.unused')}
        </div>
      )}
    </div>
  )
}
