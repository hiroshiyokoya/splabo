import { useEffect, useMemo, useState } from 'react'
import { invoke } from '@tauri-apps/api/core'
import type { GroupedStatsRow, BookView } from '../types'
import { avgKillRatio } from '../types'
import { StageDetailModal } from './StageDetailModal'
import { ViewToggle, BOOK_VIEWS } from './ViewToggle'
import { SortHeader } from './SortHeader'
import { loadViewPrefs, saveViewPrefs } from '../utils/viewPrefs'

// Dashboard / WeaponBook.winRateColor と同期。
function winRateColor(rate: number): string {
  if (rate >= 0.55) return '#34d399'
  if (rate >= 0.45) return '#fb923c'
  return '#f472b6'
}

/** ステージ図鑑のソートキー。 */
type SortKey = 'total' | 'win_rate' | 'avg_kill' | 'avg_death' | 'knockout_rate' | 'name'

const SORT_LABELS: Record<SortKey, string> = {
  total:          'バトル数',
  win_rate:       '勝率',
  avg_kill:       '平均K',
  avg_death:      '平均D',
  knockout_rate:  'KO 率',
  name:           '名前',
}

const SORT_KEYS: SortKey[] = ['total', 'win_rate', 'avg_kill', 'avg_death', 'knockout_rate', 'name']

/** compareRows が「昇順」で並べるキー（それ以外は降順）。一覧ビューの矢印表示に使う。 */
const ASC_SORT_KEYS: ReadonlySet<SortKey> = new Set<SortKey>(['name', 'avg_death'])

/** 比較関数（DESC を基本に、name / avg_death は ASC）。 */
function compareRows(a: GroupedStatsRow, b: GroupedStatsRow, sort: SortKey): number {
  switch (sort) {
    case 'total':
      return b.total - a.total
    case 'win_rate':
      return b.win_rate - a.win_rate
    case 'avg_kill': {
      const av = a.avg_kill ?? -1
      const bv = b.avg_kill ?? -1
      return bv - av
    }
    case 'avg_death': {
      // 平均D は小さいほど良いので昇順。null は末尾。
      const av = a.avg_death ?? Number.POSITIVE_INFINITY
      const bv = b.avg_death ?? Number.POSITIVE_INFINITY
      return av - bv
    }
    case 'knockout_rate': {
      const ar = a.total > 0 ? a.knockout_win / a.total : 0
      const br = b.total > 0 ? b.knockout_win / b.total : 0
      return br - ar
    }
    case 'name':
      return a.name.localeCompare(b.name, 'ja')
  }
}

export function StageBook() {
  const [rows,        setRows]        = useState<GroupedStatsRow[]>([])
  const [stageImages, setStageImages] = useState<Map<string, string>>(new Map())
  const [loading,     setLoading]     = useState(true)
  const [sort,        setSort]        = useState<SortKey>('total')
  const [selected,    setSelected]    = useState<GroupedStatsRow | null>(null)
  // パネル / 一覧の切替（#297）。前回選択を localStorage から復元する。
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
    // フィルター無し・全期間でステージ別集計を取得。
    invoke<GroupedStatsRow[]>('db_grouped_stats', { groupBy: 'stage' })
      .then(data => {
        setRows(data)

        // ステージ画像（BattleLog と同じ流儀で name を渡す）。
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
  }, [])

  // 一覧ビューの名前検索（パネルには出さない）。
  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase()
    if (view !== 'list' || !q) return rows
    return rows.filter(r => r.name.toLowerCase().includes(q))
  }, [rows, search, view])

  const sorted = useMemo(() => {
    const copy = [...filtered]
    copy.sort((a, b) => compareRows(a, b, sort))
    if (reversed) copy.reverse()
    return copy
  }, [filtered, sort, reversed])

  return (
    <div className="stage-book">
      <div className="stage-book-header">
        <h2>ステージ図鑑</h2>
        <span className="total-count">{filtered.length} ステージ</span>
        <ViewToggle
          options={BOOK_VIEWS}
          value={view}
          onChange={setView}
          ariaLabel="ステージ図鑑の表示切替"
        />
        {view === 'list' ? (
          <input
            className="book-search"
            type="search"
            value={search}
            onChange={e => setSearch(e.target.value)}
            placeholder="ステージ名で絞り込み"
            aria-label="ステージ名で絞り込み"
          />
        ) : (
          <div className="stage-sort">
            <label className="stage-sort-label">並び順</label>
            <select
              className="stage-sort-select"
              value={sort}
              onChange={e => setSort(e.target.value as SortKey)}
            >
              {SORT_KEYS.map(k => (
                <option key={k} value={k}>{SORT_LABELS[k]}</option>
              ))}
            </select>
          </div>
        )}
      </div>

      {loading ? (
        <div className="loading">読み込み中...</div>
      ) : rows.length === 0 ? (
        <div className="empty">
          プレイ実績のあるステージがありません。<br />
          バトルデータを取得してから再度表示してください。
        </div>
      ) : view === 'list' ? (
        <StageTable
          rows={sorted}
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
              onClick={() => setSelected(r)}
            />
          ))}
        </div>
      )}

      {selected && (
        <StageDetailModal
          row={selected}
          image={stageImages.get(selected.name) ?? null}
          onClose={() => setSelected(null)}
        />
      )}
    </div>
  )
}

/** 一覧ビュー（#297）。ヘッダクリックで並び替え、行クリックで詳細モーダル。 */
function StageTable({ rows, sort, ascending, onSort, onSelect }: {
  rows:      GroupedStatsRow[]
  sort:      SortKey
  ascending: boolean
  onSort:    (k: SortKey) => void
  onSelect:  (r: GroupedStatsRow) => void
}) {
  if (rows.length === 0) {
    return <div className="empty">条件に一致するステージがありません。</div>
  }
  return (
    <div className="book-table-wrap">
      <table className="book-table">
        <thead>
          <tr>
            <SortHeader label="ステージ" sortKey="name"          activeKey={sort} ascending={ascending} onSort={onSort} align="left" />
            <SortHeader label="バトル数" sortKey="total"         activeKey={sort} ascending={ascending} onSort={onSort} />
            <SortHeader label="W / L / D"                        activeKey={sort} ascending={ascending} onSort={onSort} />
            <SortHeader label="勝率"     sortKey="win_rate"      activeKey={sort} ascending={ascending} onSort={onSort} />
            <SortHeader label="平均K"    sortKey="avg_kill"      activeKey={sort} ascending={ascending} onSort={onSort} />
            <SortHeader label="平均D"    sortKey="avg_death"     activeKey={sort} ascending={ascending} onSort={onSort} />
            <SortHeader label="K/D"                              activeKey={sort} ascending={ascending} onSort={onSort} />
            <SortHeader label="KO率"     sortKey="knockout_rate" activeKey={sort} ascending={ascending} onSort={onSort} />
            <SortHeader label="平均塗り"                         activeKey={sort} ascending={ascending} onSort={onSort} />
          </tr>
        </thead>
        <tbody>
          {rows.map(r => {
            const decisive = r.total - r.draws
            const winRate  = decisive > 0 ? r.wins / decisive : null
            const loses    = r.total - r.wins - r.draws
            const koWin    = r.total > 0 ? r.knockout_win / r.total : 0
            return (
              <tr key={r.key} className="book-tr clickable-row" onClick={() => onSelect(r)}>
                <td className="book-td book-td--left">{r.name}</td>
                <td className="book-td">{r.total}</td>
                <td className="book-td">{r.wins} / {loses} / {r.draws}</td>
                <td className="book-td" style={{ color: winRate !== null ? winRateColor(winRate) : undefined }}>
                  {winRate !== null ? `${(winRate * 100).toFixed(1)}%` : '—'}
                </td>
                <td className="book-td">{r.avg_kill  !== null ? r.avg_kill.toFixed(2)  : '—'}</td>
                <td className="book-td">{r.avg_death !== null ? r.avg_death.toFixed(2) : '—'}</td>
                <td className="book-td">{avgKillRatio(r.avg_kill, r.avg_death)}</td>
                <td className="book-td">{(koWin * 100).toFixed(1)}%</td>
                <td className="book-td">{r.avg_inked !== null ? r.avg_inked.toFixed(0) : '—'}</td>
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}

function StageCard({ row, image, onClick }: {
  row:     GroupedStatsRow
  image:   string | null
  onClick: () => void
}) {
  const decisive = row.total - row.draws
  const winRate  = decisive > 0 ? row.wins / decisive : null
  const loses    = row.total - row.wins - row.draws

  const koWinRate  = row.total > 0 ? row.knockout_win  / row.total : 0
  const koLoseRate = row.total > 0 ? row.knockout_lose / row.total : 0

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
          ? <img src={image} alt={row.name} className="stage-card-image" />
          : <div className="stage-card-image stage-card-image--placeholder" />
        }
      </div>
      <div className="stage-card-name" title={row.name}>{row.name}</div>

      <div className="stage-card-stats">
        <div className="stage-card-stat-row">
          <span className="stage-card-stat-label">バトル数</span>
          <span className="stage-card-stat-value">{row.total}</span>
        </div>
        <div className="stage-card-stat-row">
          <span className="stage-card-stat-label">W / L / D</span>
          <span className="stage-card-stat-value">
            {row.wins} / {loses} / {row.draws}
          </span>
        </div>
        <div className="stage-card-stat-row">
          <span className="stage-card-stat-label">勝率</span>
          <span
            className="stage-card-stat-value stage-card-winrate"
            style={{ color: winRate !== null ? winRateColor(winRate) : undefined }}
          >
            {winRate !== null ? `${(winRate * 100).toFixed(1)}%` : '—'}
          </span>
        </div>
        <div className="stage-card-stat-row">
          <span className="stage-card-stat-label">平均K</span>
          <span className="stage-card-stat-value">
            {row.avg_kill !== null ? row.avg_kill.toFixed(2) : '—'}
          </span>
        </div>
        <div className="stage-card-stat-row">
          <span className="stage-card-stat-label">平均D</span>
          <span className="stage-card-stat-value">
            {row.avg_death !== null ? row.avg_death.toFixed(2) : '—'}
          </span>
        </div>
        <div className="stage-card-stat-row">
          <span className="stage-card-stat-label">K/D</span>
          <span className="stage-card-stat-value">
            {avgKillRatio(row.avg_kill, row.avg_death)}
          </span>
        </div>
        <div className="stage-card-stat-row">
          <span className="stage-card-stat-label">KO 率</span>
          <span className="stage-card-stat-value">
            {`${(koWinRate * 100).toFixed(1)}%`}
          </span>
        </div>
        <div className="stage-card-stat-row">
          <span className="stage-card-stat-label">被 KO 率</span>
          <span className="stage-card-stat-value">
            {`${(koLoseRate * 100).toFixed(1)}%`}
          </span>
        </div>
        <div className="stage-card-stat-row">
          <span className="stage-card-stat-label">平均塗り</span>
          <span className="stage-card-stat-value">
            {row.avg_inked !== null ? row.avg_inked.toFixed(0) : '—'}
          </span>
        </div>
      </div>
    </div>
  )
}
