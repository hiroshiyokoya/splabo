import { useEffect, useMemo, useState } from 'react'
import { invoke } from '@tauri-apps/api/core'
import type { GroupedStatsRow } from '../types'
import { avgKillRatio } from '../types'

// Dashboard / WeaponBook.winRateColor と同期。
function winRateColor(rate: number): string {
  if (rate >= 0.55) return '#34d399'
  if (rate >= 0.45) return '#fb923c'
  return '#f472b6'
}

/** ステージ図鑑のソートキー。 */
type SortKey = 'total' | 'win_rate' | 'avg_kill' | 'knockout_rate' | 'name'

const SORT_LABELS: Record<SortKey, string> = {
  total:          'バトル数',
  win_rate:       '勝率',
  avg_kill:       '平均キル',
  knockout_rate:  'KO 率',
  name:           '名前',
}

const SORT_KEYS: SortKey[] = ['total', 'win_rate', 'avg_kill', 'knockout_rate', 'name']

/** 比較関数（DESC を基本に、name のみ ASC）。 */
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

  const sorted = useMemo(() => {
    const copy = [...rows]
    copy.sort((a, b) => compareRows(a, b, sort))
    return copy
  }, [rows, sort])

  return (
    <div className="stage-book">
      <div className="stage-book-header">
        <h2>ステージ図鑑</h2>
        <span className="total-count">{rows.length} ステージ</span>
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
      </div>

      {loading ? (
        <div className="loading">読み込み中...</div>
      ) : rows.length === 0 ? (
        <div className="empty">
          プレイ実績のあるステージがありません。<br />
          バトルデータを取得してから再度表示してください。
        </div>
      ) : (
        <div className="stage-grid">
          {sorted.map(r => (
            <StageCard key={r.key} row={r} image={stageImages.get(r.name) ?? null} />
          ))}
        </div>
      )}
    </div>
  )
}

function StageCard({ row, image }: { row: GroupedStatsRow; image: string | null }) {
  const decisive = row.total - row.draws
  const winRate  = decisive > 0 ? row.wins / decisive : null
  const loses    = row.total - row.wins - row.draws

  const koWinRate  = row.total > 0 ? row.knockout_win  / row.total : 0
  const koLoseRate = row.total > 0 ? row.knockout_lose / row.total : 0

  return (
    <div className="stage-card">
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
          <span className="stage-card-stat-label">平均K/D</span>
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
