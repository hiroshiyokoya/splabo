import { useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { TFunction } from 'i18next'
import { invoke } from '@tauri-apps/api/core'
import type { GroupedStatsRow, BookView, Filters, StageRecord } from '../types'
import { avgKillRatio, filtersToBookArgs, fmtOfficialWinRate, fmtOfficialDate, METRIC_LABELS } from '../types'
import { StageDetailModal } from './StageDetailModal'
import { ViewToggle, getBookViews } from './ViewToggle'
import { SortHeader } from './SortHeader'
import { loadViewPrefs, saveViewPrefs } from '../utils/viewPrefs'
import { winRateColor } from '../utils/heatmapColors'
import { groupedStatsDisplayName } from '../i18n/displayName'

/** ステージタブのソートキー。official_* は公式アプリ由来(ルール別通算勝率・最終プレイ日)。 */
type SortKey =
  | 'total' | 'wins' | 'loses' | 'draws'
  | 'win_rate' | 'avg_kill' | 'avg_assist' | 'avg_death' | 'kd' | 'contrib_kd' | 'avg_inked' | 'name'
  | 'official_win_rate_tw' | 'official_win_rate_ar' | 'official_win_rate_lf'
  | 'official_win_rate_gl' | 'official_win_rate_cl' | 'last_played_at'

function stageSortLabels(t: TFunction): Record<SortKey, string> {
  return {
    total:          METRIC_LABELS.total,
    wins:           t('books.winsW'),
    loses:          t('books.losesL'),
    draws:          t('books.drawsD'),
    win_rate:       METRIC_LABELS.win_rate,
    avg_kill:       t('books.avgK'),
    avg_assist:     t('books.avgA'),
    avg_death:      t('books.avgD'),
    kd:             METRIC_LABELS.avg_kd,
    contrib_kd:     METRIC_LABELS.avg_contrib_kd,
    avg_inked:      t('books.avgInked'),
    name:           t('books.name'),
    official_win_rate_tw: `${METRIC_LABELS.official_win_rate_tw}`,
    official_win_rate_ar: `${METRIC_LABELS.official_win_rate_ar}`,
    official_win_rate_lf: `${METRIC_LABELS.official_win_rate_lf}`,
    official_win_rate_gl: `${METRIC_LABELS.official_win_rate_gl}`,
    official_win_rate_cl: `${METRIC_LABELS.official_win_rate_cl}`,
    last_played_at: METRIC_LABELS.official_last_used_at,
  }
}

const SORT_KEYS: SortKey[] = [
  'total', 'wins', 'loses', 'draws',
  'win_rate', 'avg_kill', 'avg_assist', 'avg_death', 'kd', 'contrib_kd', 'avg_inked', 'name',
]

/** 公式値のソートキー。1 件も取得できていなければソート項目から外す(WeaponBook の OFFICIAL_SORT と同じ流儀)。 */
const OFFICIAL_SORT_KEYS: SortKey[] = [
  'official_win_rate_tw', 'official_win_rate_ar', 'official_win_rate_lf',
  'official_win_rate_gl', 'official_win_rate_cl', 'last_played_at',
]

/** K/D = 平均K ÷ 平均D。デス 0 は上位(Infinity)、データ無しは null。 */
function kdOf(r: GroupedStatsRow): number | null {
  if (r.avg_kill === null || r.avg_death === null) return null
  if (r.avg_death === 0) return r.avg_kill > 0 ? Number.POSITIVE_INFINITY : null
  return r.avg_kill / r.avg_death
}

function contribKdOf(r: GroupedStatsRow): number | null {
  if (r.avg_kill === null || r.avg_assist === null || r.avg_death === null) return null
  if (r.avg_death === 0) return (r.avg_kill + r.avg_assist) > 0 ? Number.POSITIVE_INFINITY : null
  return (r.avg_kill + r.avg_assist) / r.avg_death
}

/** compareRows が「昇順」で並べるキー(それ以外は降順)。一覧ビューの矢印表示に使う。 */
const ASC_SORT_KEYS: ReadonlySet<SortKey> = new Set<SortKey>(['name', 'avg_death'])

/** 公式値(勝率 0-1・null 許容)の比較。大きいほど上位、null は末尾。 */
function cmpOfficialRate(a: number | null, b: number | null): number {
  if (a === null && b === null) return 0
  if (a === null) return  1
  if (b === null) return -1
  return b - a
}

/** 比較関数(DESC を基本に、name / avg_death は ASC)。official はローカル集計に無いので別引数で渡す。 */
function compareRows(
  a: GroupedStatsRow, b: GroupedStatsRow, sort: SortKey,
  officialByName: Map<string, StageRecord>,
): number {
  switch (sort) {
    case 'official_win_rate_tw':
      return cmpOfficialRate(officialByName.get(a.name)?.win_rate_tw ?? null, officialByName.get(b.name)?.win_rate_tw ?? null)
    case 'official_win_rate_ar':
      return cmpOfficialRate(officialByName.get(a.name)?.win_rate_ar ?? null, officialByName.get(b.name)?.win_rate_ar ?? null)
    case 'official_win_rate_lf':
      return cmpOfficialRate(officialByName.get(a.name)?.win_rate_lf ?? null, officialByName.get(b.name)?.win_rate_lf ?? null)
    case 'official_win_rate_gl':
      return cmpOfficialRate(officialByName.get(a.name)?.win_rate_gl ?? null, officialByName.get(b.name)?.win_rate_gl ?? null)
    case 'official_win_rate_cl':
      return cmpOfficialRate(officialByName.get(a.name)?.win_rate_cl ?? null, officialByName.get(b.name)?.win_rate_cl ?? null)
    case 'last_played_at':
      return cmpOfficialRate(officialByName.get(a.name)?.last_played_at ?? null, officialByName.get(b.name)?.last_played_at ?? null)
    case 'total':
      return b.total - a.total
    case 'wins':
      return b.wins - a.wins
    case 'loses':
      return (b.total - b.wins - b.draws) - (a.total - a.wins - a.draws)
    case 'draws':
      return b.draws - a.draws
    case 'win_rate':
      return b.win_rate - a.win_rate
    case 'kd': {
      // K/D は大きいほど良いので降順。データ無しは末尾。
      const av = kdOf(a) ?? Number.NEGATIVE_INFINITY
      const bv = kdOf(b) ?? Number.NEGATIVE_INFINITY
      return bv - av
    }
    case 'contrib_kd': {
      const av = contribKdOf(a) ?? Number.NEGATIVE_INFINITY
      const bv = contribKdOf(b) ?? Number.NEGATIVE_INFINITY
      return bv - av
    }
    case 'avg_kill': {
      const av = a.avg_kill ?? -1
      const bv = b.avg_kill ?? -1
      return bv - av
    }
    case 'avg_assist': {
      // 平均A は多いほど良いので降順。null は末尾。
      const av = a.avg_assist ?? -1
      const bv = b.avg_assist ?? -1
      return bv - av
    }
    case 'avg_death': {
      // 平均D は小さいほど良いので昇順。null は末尾。
      const av = a.avg_death ?? Number.POSITIVE_INFINITY
      const bv = b.avg_death ?? Number.POSITIVE_INFINITY
      return av - bv
    }
    case 'avg_inked': {
      const av = a.avg_inked ?? -1
      const bv = b.avg_inked ?? -1
      return bv - av
    }
    case 'name':
      return groupedStatsDisplayName(a).localeCompare(groupedStatsDisplayName(b))
  }
}

export function StageBook({ filters }: { filters: Filters }) {
  const { t } = useTranslation()
  const sortLabels = stageSortLabels(t)
  const [rows,        setRows]        = useState<GroupedStatsRow[]>([])
  const [stageImages, setStageImages] = useState<Map<string, string>>(new Map())
  const [officialByName, setOfficialByName] = useState<Map<string, StageRecord>>(new Map())
  const [loading,     setLoading]     = useState(true)
  const [sort,        setSort]        = useState<SortKey>('total')
  const [selected,    setSelected]    = useState<GroupedStatsRow | null>(null)
  // パネル / 一覧の切替(#297)。前回選択を localStorage から復元する。
  const [view,        setViewState]   = useState<BookView>(() => loadViewPrefs().stages)
  // compareRows は各キーの「自然な向き」を返すので、反転フラグで昇順/降順をトグルする。
  const [reversed,    setReversed]    = useState(false)
  const [search,      setSearch]      = useState('')

  function setView(next: BookView) {
    setViewState(next)
    saveViewPrefs({ ...loadViewPrefs(), stages: next })
  }

  /** テーブルヘッダのクリック: 同じキーなら向きを反転、違うキーなら自然な向きで並べ替え。 */
  function handleSort(key: SortKey) {
    if (key === sort) setReversed(r => !r)
    else { setSort(key); setReversed(false) }
  }

  useEffect(() => {
    setLoading(true)
    // 共通 FilterBar(期間・モード・ルール・結果)を集計に反映する(#298)。
    // ステージタブはローカル集計のみなので、全項目がフィルタに追従する。
    invoke<GroupedStatsRow[]>('db_grouped_stats', { groupBy: 'stage', ...filtersToBookArgs(filters) })
      .then(data => {
        setRows(data)

        // ステージ画像(BattleLog と同じ流儀で name を渡す)。
        Promise.all(
          data.map(r =>
            invoke<string | null>('read_image', { kind: 'stage', name: r.name })
              .then(url => (url ? ([r.name, url] as [string, string]) : null))
              .catch(() => null)
          )
        ).then(results => {
          setStageImages(new Map(results.filter((x): x is [string, string] => x !== null)))
        })
      })
      .catch(console.error)
      .finally(() => setLoading(false))
  }, [filters])

  useEffect(() => {
    invoke<StageRecord[]>('db_list_stage_records')
      .then(list => setOfficialByName(new Map(list.map(r => [r.stage_id, r]))))
      .catch(console.error)
  }, [])

  useEffect(() => {
    setSelected(prev => {
      if (!prev) return prev
      return rows.find(r => r.key === prev.key) ?? null
    })
  }, [rows])

  // 一覧ビューの名前検索(パネルには出さない)。
  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase()
    if (view !== 'list' || !q) return rows
    return rows.filter(r => {
      const label = groupedStatsDisplayName(r).toLowerCase()
      return label.includes(q) || r.name.toLowerCase().includes(q) || (r.name_en?.toLowerCase().includes(q) ?? false)
    })
  }, [rows, search, view])

  const sorted = useMemo(() => {
    const copy = [...filtered]
    copy.sort((a, b) => compareRows(a, b, sort, officialByName))
    if (reversed) copy.reverse()
    return copy
  }, [filtered, sort, reversed, officialByName])

  // 公式統計(ルール別通算勝率・最終プレイ日)が 1 件でも取得できているか(#739)。
  const hasOfficialStats = useMemo(
    () => [...officialByName.values()].some(r =>
      r.win_rate_tw != null || r.win_rate_ar != null || r.win_rate_lf != null ||
      r.win_rate_gl != null || r.win_rate_cl != null || r.last_played_at != null
    ),
    [officialByName],
  )

  useEffect(() => {
    if (!hasOfficialStats && OFFICIAL_SORT_KEYS.includes(sort)) {
      setSort('total')
    }
  }, [hasOfficialStats, sort])

  return (
    <div className={`stage-book${view === 'list' ? ' book--fill' : ''}`}>
      <div className="stage-book-header">
        <h2>{t('nav.stages')}</h2>
        <span className="total-count">{t('books.stagesCount', { count: filtered.length })}</span>
        <ViewToggle
          options={getBookViews(t)}
          value={view}
          onChange={setView}
          ariaLabel={t('books.stageViewAria')}
        />
        {view === 'list' ? (
          <input
            className="book-search"
            type="search"
            value={search}
            onChange={e => setSearch(e.target.value)}
            placeholder={t('books.stageFilter')}
            aria-label={t('books.stageFilter')}
          />
        ) : (
          <div className="stage-sort">
            <label className="stage-sort-label">{t('books.sortOrder')}</label>
            <select
              className="stage-sort-select"
              value={sort}
              onChange={e => setSort(e.target.value as SortKey)}
            >
              {SORT_KEYS.map(k => (
                <option key={k} value={k}>{sortLabels[k]}</option>
              ))}
              {hasOfficialStats && OFFICIAL_SORT_KEYS.map(k => (
                <option key={k} value={k}>{sortLabels[k]}</option>
              ))}
            </select>
          </div>
        )}
      </div>

      {loading ? (
        <div className="loading">{t('common.loading')}</div>
      ) : rows.length === 0 ? (
        <div className="empty">
          {t('books.noPlayedStages')}<br />
          {t('books.fetchThenRetry')}
        </div>
      ) : view === 'list' ? (
        <StageTable
          rows={sorted}
          stageImages={stageImages}
          officialByName={officialByName}
          sort={sort}
          ascending={ASC_SORT_KEYS.has(sort) !== reversed}
          onSort={handleSort}
          onSelect={setSelected}
        />
      ) : (
        <div className="stage-grid">
          {sorted.map(r => (
            <StageCard
              key={r.key}
              row={r}
              image={stageImages.get(r.name) ?? null}
              official={officialByName.get(r.name) ?? null}
              onClick={() => setSelected(r)}
            />
          ))}
        </div>
      )}

      {selected && (
        <StageDetailModal
          row={selected}
          image={stageImages.get(selected.name) ?? null}
          official={officialByName.get(selected.name) ?? null}
          filters={filters}
          onClose={() => setSelected(null)}
        />
      )}
    </div>
  )
}

/** 一覧ビュー(#297)。ヘッダクリックで並び替え、行クリックで詳細モーダル。
 *  ローカル集計に加え、公式アプリ由来のルール別通算勝率・最終プレイ日も列として出す(#739)。 */
function StageTable({ rows, stageImages, officialByName, sort, ascending, onSort, onSelect }: {
  rows:           GroupedStatsRow[]
  stageImages:    Map<string, string>
  officialByName: Map<string, StageRecord>
  sort:           SortKey
  ascending:      boolean
  onSort:         (k: SortKey) => void
  onSelect:       (r: GroupedStatsRow) => void
}) {
  const { t } = useTranslation()
  if (rows.length === 0) {
    return <div className="empty">{t('books.noStages')}</div>
  }
  return (
    <div className="book-table-wrap">
      <table className="book-table">
        <thead>
          <tr>
            <SortHeader label={t('nav.stages')} sortKey="name"          activeKey={sort} ascending={ascending} onSort={onSort} align="left" />
            <SortHeader label={METRIC_LABELS.total} sortKey="total"         activeKey={sort} ascending={ascending} onSort={onSort} />
            <SortHeader label="W"        sortKey="wins"          activeKey={sort} ascending={ascending} onSort={onSort} />
            <SortHeader label="L"        sortKey="loses"         activeKey={sort} ascending={ascending} onSort={onSort} />
            <SortHeader label="D"        sortKey="draws"         activeKey={sort} ascending={ascending} onSort={onSort} />
            <SortHeader label={METRIC_LABELS.win_rate}     sortKey="win_rate"      activeKey={sort} ascending={ascending} onSort={onSort} />
            <SortHeader label={t('books.avgK')}    sortKey="avg_kill"      activeKey={sort} ascending={ascending} onSort={onSort} />
            <SortHeader label={t('books.avgA')}    sortKey="avg_assist"    activeKey={sort} ascending={ascending} onSort={onSort} />
            <SortHeader label={t('books.avgD')}    sortKey="avg_death"     activeKey={sort} ascending={ascending} onSort={onSort} />
            <SortHeader label={METRIC_LABELS.avg_kd}     sortKey="kd"            activeKey={sort} ascending={ascending} onSort={onSort} />
            <SortHeader label={METRIC_LABELS.avg_contrib_kd} sortKey="contrib_kd"    activeKey={sort} ascending={ascending} onSort={onSort} />
            <SortHeader label={t('books.avgInked')}  sortKey="avg_inked"     activeKey={sort} ascending={ascending} onSort={onSort} />
            <SortHeader label={t('filter.rule_turf_war')} sortKey="official_win_rate_tw" activeKey={sort} ascending={ascending} onSort={onSort} />
            <SortHeader label={t('filter.rule_area')}     sortKey="official_win_rate_ar" activeKey={sort} ascending={ascending} onSort={onSort} />
            <SortHeader label={t('filter.rule_yagura')}   sortKey="official_win_rate_lf" activeKey={sort} ascending={ascending} onSort={onSort} />
            <SortHeader label={t('filter.rule_hoko')}     sortKey="official_win_rate_gl" activeKey={sort} ascending={ascending} onSort={onSort} />
            <SortHeader label={t('filter.rule_asari')}    sortKey="official_win_rate_cl" activeKey={sort} ascending={ascending} onSort={onSort} />
            <SortHeader label={METRIC_LABELS.official_last_used_at} sortKey="last_played_at" activeKey={sort} ascending={ascending} onSort={onSort} />
          </tr>
        </thead>
        <tbody>
          {rows.map(r => {
            const decisive = r.total - r.draws
            const winRate  = decisive > 0 ? r.wins / decisive : null
            const loses    = r.total - r.wins - r.draws
            const stageImg = stageImages.get(r.name) ?? null
            const official = officialByName.get(r.name) ?? null
            return (
              <tr key={r.key} className="book-tr clickable-row" onClick={() => onSelect(r)}>
                <td className="book-td book-td--left">
                  <span className="book-name-cell">
                    {stageImg
                      ? <img src={stageImg} alt="" className="book-name-icon book-name-icon--stage" />
                      : <span className="book-name-icon book-name-icon--stage book-name-icon--placeholder" />}
                    {groupedStatsDisplayName(r)}
                  </span>
                </td>
                <td className="book-td">{r.total}</td>
                <td className="book-td">{r.wins}</td>
                <td className="book-td">{loses}</td>
                <td className="book-td">{r.draws}</td>
                <td className="book-td" style={{ color: winRate !== null ? winRateColor(winRate) : undefined }}>
                  {winRate !== null ? `${(winRate * 100).toFixed(1)}%` : '-'}
                </td>
                <td className="book-td">{r.avg_kill   !== null ? r.avg_kill.toFixed(2)   : '-'}</td>
                <td className="book-td">{r.avg_assist !== null ? r.avg_assist.toFixed(2) : '-'}</td>
                <td className="book-td">{r.avg_death  !== null ? r.avg_death.toFixed(2)  : '-'}</td>
                <td className="book-td">{avgKillRatio(r.avg_kill, r.avg_death)}</td>
                <td className="book-td">{avgKillRatio(
                  r.avg_kill != null && r.avg_assist != null ? r.avg_kill + r.avg_assist : null,
                  r.avg_death,
                )}</td>
                <td className="book-td">{r.avg_inked !== null ? r.avg_inked.toFixed(0) : '-'}</td>
                <td className="book-td" style={{ color: official?.win_rate_tw != null ? winRateColor(official.win_rate_tw) : undefined }}>{fmtOfficialWinRate(official?.win_rate_tw)}</td>
                <td className="book-td" style={{ color: official?.win_rate_ar != null ? winRateColor(official.win_rate_ar) : undefined }}>{fmtOfficialWinRate(official?.win_rate_ar)}</td>
                <td className="book-td" style={{ color: official?.win_rate_lf != null ? winRateColor(official.win_rate_lf) : undefined }}>{fmtOfficialWinRate(official?.win_rate_lf)}</td>
                <td className="book-td" style={{ color: official?.win_rate_gl != null ? winRateColor(official.win_rate_gl) : undefined }}>{fmtOfficialWinRate(official?.win_rate_gl)}</td>
                <td className="book-td" style={{ color: official?.win_rate_cl != null ? winRateColor(official.win_rate_cl) : undefined }}>{fmtOfficialWinRate(official?.win_rate_cl)}</td>
                <td className="book-td">{fmtOfficialDate(official?.last_played_at)}</td>
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}

function StageCard({ row, image, official, onClick }: {
  row:      GroupedStatsRow
  image:    string | null
  official: StageRecord | null
  onClick:  () => void
}) {
  const { t } = useTranslation()
  const decisive = row.total - row.draws
  const winRate  = decisive > 0 ? row.wins / decisive : null
  const loses    = row.total - row.wins - row.draws
  const hasOfficial = official != null

  return (
    <div
      className="stage-card stage-card--clickable"
      onClick={onClick}
      role="button"
      tabIndex={0}
      onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onClick() } }}
    >
      <div className="stage-card-image-wrap">
        {image
          ? <img src={image} alt={groupedStatsDisplayName(row)} className="stage-card-image" />
          : <div className="stage-card-image stage-card-image--placeholder" />
        }
      </div>
      <div className="stage-card-name" title={groupedStatsDisplayName(row)}>{groupedStatsDisplayName(row)}</div>

      {hasOfficial && (
        <div className="weapon-card-official-grid">
          <div className="weapon-card-official-cell">
            <span className="weapon-card-official-label">{t('filter.rule_turf_war')}</span>
            <span className="weapon-card-official-value" style={official.win_rate_tw != null ? { color: winRateColor(official.win_rate_tw) } : undefined}>{fmtOfficialWinRate(official.win_rate_tw)}</span>
          </div>
          <div className="weapon-card-official-cell">
            <span className="weapon-card-official-label">{t('filter.rule_area')}</span>
            <span className="weapon-card-official-value" style={official.win_rate_ar != null ? { color: winRateColor(official.win_rate_ar) } : undefined}>{fmtOfficialWinRate(official.win_rate_ar)}</span>
          </div>
          <div className="weapon-card-official-cell">
            <span className="weapon-card-official-label">{t('filter.rule_yagura')}</span>
            <span className="weapon-card-official-value" style={official.win_rate_lf != null ? { color: winRateColor(official.win_rate_lf) } : undefined}>{fmtOfficialWinRate(official.win_rate_lf)}</span>
          </div>
          <div className="weapon-card-official-cell">
            <span className="weapon-card-official-label">{t('filter.rule_hoko')}</span>
            <span className="weapon-card-official-value" style={official.win_rate_gl != null ? { color: winRateColor(official.win_rate_gl) } : undefined}>{fmtOfficialWinRate(official.win_rate_gl)}</span>
          </div>
          <div className="weapon-card-official-cell">
            <span className="weapon-card-official-label">{t('filter.rule_asari')}</span>
            <span className="weapon-card-official-value" style={official.win_rate_cl != null ? { color: winRateColor(official.win_rate_cl) } : undefined}>{fmtOfficialWinRate(official.win_rate_cl)}</span>
          </div>
        </div>
      )}

      <div className={hasOfficial ? 'weapon-card-local' : undefined}>
      <div className="stage-card-stats">
        <div className="stage-card-stat-row">
          <span className="stage-card-stat-label">{METRIC_LABELS.total}</span>
          <span className="stage-card-stat-value">{row.total}</span>
        </div>
        <div className="stage-card-stat-row">
          <span className="stage-card-stat-label">W / L / D</span>
          <span className="stage-card-stat-value">
            {row.wins} / {loses} / {row.draws}
          </span>
        </div>
        <div className="stage-card-stat-row">
          <span className="stage-card-stat-label">{METRIC_LABELS.win_rate}</span>
          <span
            className="stage-card-stat-value stage-card-winrate"
            style={{ color: winRate !== null ? winRateColor(winRate) : undefined }}
          >
            {winRate !== null ? `${(winRate * 100).toFixed(1)}%` : '-'}
          </span>
        </div>
        <div className="stage-card-stat-row">
          <span className="stage-card-stat-label">{t('books.avgK')}</span>
          <span className="stage-card-stat-value">
            {row.avg_kill !== null ? row.avg_kill.toFixed(2) : '-'}
          </span>
        </div>
        <div className="stage-card-stat-row">
          <span className="stage-card-stat-label">{t('books.avgA')}</span>
          <span className="stage-card-stat-value">
            {row.avg_assist !== null ? row.avg_assist.toFixed(2) : '-'}
          </span>
        </div>
        <div className="stage-card-stat-row">
          <span className="stage-card-stat-label">{t('books.avgD')}</span>
          <span className="stage-card-stat-value">
            {row.avg_death !== null ? row.avg_death.toFixed(2) : '-'}
          </span>
        </div>
        <div className="stage-card-stat-row">
          <span className="stage-card-stat-label">{METRIC_LABELS.avg_kd}</span>
          <span className="stage-card-stat-value">
            {avgKillRatio(row.avg_kill, row.avg_death)}
          </span>
        </div>
        <div className="stage-card-stat-row">
          <span className="stage-card-stat-label">{METRIC_LABELS.avg_contrib_kd}</span>
          <span className="stage-card-stat-value">
            {avgKillRatio(
              row.avg_kill != null && row.avg_assist != null ? row.avg_kill + row.avg_assist : null,
              row.avg_death,
            )}
          </span>
        </div>
        <div className="stage-card-stat-row">
          <span className="stage-card-stat-label">{t('books.avgInked')}</span>
          <span className="stage-card-stat-value">
            {row.avg_inked !== null ? row.avg_inked.toFixed(0) : '-'}
          </span>
        </div>
      </div>
      </div>
    </div>
  )
}
