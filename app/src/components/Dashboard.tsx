import { useEffect, useState } from 'react'
import { invoke } from '@tauri-apps/api/core'
import {
  BarChart, Bar, LineChart, Line, ScatterChart, Scatter,
  XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, Cell, ReferenceLine,
} from 'recharts'
import type { Summary, SummaryEntry, ChartSpec, Filters } from '../types'
import { filtersToRange, stageAbbr, modeLabel } from '../types'

const COLOR_TOTAL       = '#a8c0d0'
const COLOR_TOTAL_HOVER = '#cde0ec'

function winRateColor(rate: number): string {
  if (rate >= 0.55) return '#22c55e'
  if (rate >= 0.45) return '#f59e0b'
  return '#ef4444'
}

type SortBy = 'total' | 'win_rate'

interface Props {
  filters: Filters
  aiChart: ChartSpec | null
}

export function Dashboard({ filters, aiChart }: Props) {
  const [summary, setSummary] = useState<Summary | null>(null)
  const [loading, setLoading] = useState(true)
  const [refreshKey, setRefreshKey] = useState(0)
  const [fetching, setFetching] = useState(false)
  const [fetchingDetails, setFetchingDetails] = useState(false)
  const [fetchResult, setFetchResult] = useState<string | null>(null)
  const [fetchError, setFetchError] = useState<string | null>(null)
  const [weaponImages, setWeaponImages] = useState<Map<string, string>>(new Map())
  const [weaponSort, setWeaponSort] = useState<SortBy>('total')
  const [stageSort, setStageSort] = useState<SortBy>('total')
  const [ruleSort, setRuleSort] = useState<SortBy>('total')
  const [modeSort, setModeSort] = useState<SortBy>('total')

  useEffect(() => {
    const { since, until } = filtersToRange(filters)
    setLoading(true)
    invoke<Summary>('db_summary', {
      since,
      until,
      mode: filters.mode,
      rule: filters.rule,
      resultFilter: filters.result,
      weapon: filters.weapon,
      stage: filters.stage.length > 0 ? filters.stage.join('|') : null,
    })
      .then(setSummary)
      .catch(console.error)
      .finally(() => setLoading(false))
  }, [refreshKey, filters])

  // Load weapon images once
  useEffect(() => {
    invoke<string[]>('db_weapons_used').then(weapons => {
      Promise.all(
        weapons.map(name =>
          invoke<string | null>('read_image', { kind: 'weapon', name })
            .then(url => (url ? ([name, url] as [string, string]) : null))
            .catch(() => null)
        )
      ).then(results => {
        setWeaponImages(new Map(results.filter((r): r is [string, string] => r !== null)))
      })
    }).catch(() => {})
  }, [])

  async function handleFetch() {
    setFetching(true)
    setFetchResult(null)
    setFetchError(null)
    try {
      const count = await invoke<number>('fetch_battles')
      setFetchResult(`${count}件取得しました`)
      setRefreshKey(k => k + 1)
      invoke('fetch_weapons').catch(console.error)
    } catch (e) {
      setFetchError(String(e))
    } finally {
      setFetching(false)
    }
  }

  async function handleFetchDetails() {
    setFetchingDetails(true)
    setFetchResult(null)
    setFetchError(null)
    try {
      const count = await invoke<number>('fetch_battle_details')
      setFetchResult(`詳細データ ${count}件更新しました`)
      setRefreshKey(k => k + 1)
      invoke('fetch_weapons').catch(console.error)
    } catch (e) {
      setFetchError(String(e))
    } finally {
      setFetchingDetails(false)
    }
  }

  const totalBattles = summary?.by_mode.reduce((s, e) => s + e.total, 0) ?? 0
  const totalWins    = summary?.by_mode.reduce((s, e) => s + e.wins,  0) ?? 0
  const totalDraws   = summary?.by_mode.reduce((s, e) => s + e.draws, 0) ?? 0
  const totalLosses  = totalBattles - totalWins - totalDraws
  const overallWinRate = totalBattles > 0 ? totalWins / totalBattles : null

  function sorted(data: SummaryEntry[], by: SortBy): SummaryEntry[] {
    return [...data].sort((a, b) => b[by] - a[by])
  }

  return (
    <div className="dashboard">
      <div className="dashboard-header">
        <h2>ダッシュボード</h2>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          {fetchResult && (
            <span style={{ color: 'var(--win)', fontSize: 13 }}>{fetchResult}</span>
          )}
          <button className="btn-secondary" onClick={handleFetchDetails} disabled={fetchingDetails || fetching}>
            {fetchingDetails ? '取得中...' : '詳細データを取得'}
          </button>
          <button className="btn-primary" onClick={handleFetch} disabled={fetching || fetchingDetails}>
            {fetching ? '取得中...' : 'バトルデータを取得'}
          </button>
        </div>
      </div>

      {fetchError && <div className="error-box">{fetchError}</div>}

      {loading ? (
        <div className="loading">読み込み中...</div>
      ) : !summary ? (
        <div className="empty">データがありません</div>
      ) : (
        <>
          <div className="stat-cards">
            <StatCard label="総試合数" value={totalBattles.toLocaleString()} />
            <StatCard
              label="全体勝率"
              value={overallWinRate !== null ? `${(overallWinRate * 100).toFixed(1)}%` : '—'}
              valueColor={overallWinRate !== null ? winRateColor(overallWinRate) : undefined}
            />
            <StatCard label="Win / Lose (Draw)" value={`${totalWins} / ${totalLosses} (${totalDraws})`} />
            <StatCard label="使用武器数" value={summary.by_weapon.length.toString()} />
          </div>

          <div className="chart-grid">
            <ChartCard title="武器別 勝率 & 試合数" sortBy={weaponSort} onSortChange={setWeaponSort}>
              <WinRateChart data={sorted(summary.by_weapon.slice(0, 14), weaponSort)} height={260} images={weaponImages} hoverImageSize={64} />
            </ChartCard>

            <ChartCard title="ステージ別 勝率 & 試合数" sortBy={stageSort} onSortChange={setStageSort}>
              <WinRateChart data={sorted(summary.by_stage.slice(0, 14), stageSort)} height={260} images={new Map()} nameTransform={stageAbbr} tickAngle={30} />
            </ChartCard>

            <ChartCard title="ルール別 勝率 & 試合数" sortBy={ruleSort} onSortChange={setRuleSort}>
              <WinRateChart data={sorted(summary.by_rule, ruleSort)} height={220} images={new Map()} />
            </ChartCard>

            <ChartCard title="モード別 勝率 & 試合数" sortBy={modeSort} onSortChange={setModeSort}>
              <WinRateChart data={sorted(summary.by_mode, modeSort)} height={180} images={new Map()} nameTransform={modeLabel} />
            </ChartCard>

            {aiChart && (
              <ChartCard title={aiChart.title}>
                <AiChartRenderer spec={aiChart} />
              </ChartCard>
            )}
          </div>
        </>
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Custom XAxis tick — controlled by parent's activeIndex
// ---------------------------------------------------------------------------

function ImageTick(props: {
  x?: number; y?: number; payload?: { value: string }; index?: number
  images: Map<string, string>
  activeIndex: number | null
  onHoverIndex: (i: number | null) => void
  hoverSize: number
  nameTransform?: (name: string) => string
  tickAngle?: number
}) {
  const { x = 0, y = 0, payload, index, images, activeIndex, onHoverIndex, hoverSize, nameTransform, tickAngle } = props
  if (!payload) return null
  const isActive  = activeIndex === null || activeIndex === index
  const isHovered = activeIndex === index
  const url = images.get(payload.value)
  if (url) {
    const size   = isHovered ? hoverSize : 32
    const offset = -(size / 2)
    const yOff   = 36 - size  // bottom of image stays fixed at y+36
    return (
      <g
        transform={`translate(${x},${y})`}
        style={{ cursor: 'pointer', opacity: isActive ? 1 : 0.35 }}
        onMouseEnter={() => onHoverIndex(index ?? null)}
        onMouseLeave={() => onHoverIndex(null)}
      >
        <image
          href={url}
          x={offset} y={yOff}
          width={size} height={size}
          style={{ transition: 'all 0.15s' }}
        />
      </g>
    )
  }
  const raw = payload.value
  const label = nameTransform ? nameTransform(raw) : (raw.length > 6 ? raw.slice(0, 6) + '…' : raw)
  const textProps = {
    fill: 'var(--text)' as const,
    fontSize: 10,
    opacity: isActive ? 1 : 0.4,
    fontWeight: isHovered ? 700 : 400,
    onMouseEnter: () => onHoverIndex(index ?? null),
    onMouseLeave: () => onHoverIndex(null),
    style: { cursor: 'default' as const },
  }
  if (tickAngle) {
    return (
      <g transform={`translate(${x}, ${y + 4})`}>
        <text {...textProps} transform={`rotate(${tickAngle})`} textAnchor="start">
          {label}
        </text>
      </g>
    )
  }
  return (
    <text {...textProps} x={x} y={y + 10} textAnchor="middle">
      {label}
    </text>
  )
}

// ---------------------------------------------------------------------------
// WinRateChart — activeIndex shared between tick icons and bars
// ---------------------------------------------------------------------------

function WinRateChart({ data, height, images, hoverImageSize = 64, nameTransform, tickAngle }: {
  data: SummaryEntry[]
  height: number
  images: Map<string, string>
  hoverImageSize?: number
  nameTransform?: (name: string) => string
  tickAngle?: number
}) {
  const [activeIndex, setActiveIndex] = useState<number | null>(null)
  const hasImages = data.some(d => images.has(d.name))
  const tickHeight = hasImages ? 40 : tickAngle ? 36 : 16
  const tickStyle = { fontSize: 10, fill: 'var(--text)' }

  function cellOpacity(i: number) {
    return activeIndex === null || activeIndex === i ? 1 : 0.35
  }

  function totalCellFill(i: number) {
    if (activeIndex === i) return COLOR_TOTAL_HOVER
    return COLOR_TOTAL
  }

  return (
    <ResponsiveContainer width="100%" height={height}>
      <BarChart
        data={data}
        margin={{ top: 4, right: 8, left: 0, bottom: hasImages ? 8 : 4 }}
        onMouseLeave={() => setActiveIndex(null)}
      >
        <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" vertical={false} />
        <XAxis
          dataKey="name"
          tick={(props: any) => (
            <ImageTick
              {...props}
              images={images}
              activeIndex={activeIndex}
              onHoverIndex={setActiveIndex}
              hoverSize={hoverImageSize}
              nameTransform={nameTransform}
              tickAngle={tickAngle}
            />
          )}
          interval={0}
          height={tickHeight}
        />
        <YAxis yAxisId="left" tick={tickStyle} width={36} />
        <YAxis
          yAxisId="right"
          orientation="right"
          tickFormatter={(v) => `${(v * 100).toFixed(0)}%`}
          domain={[0, 1]}
          tick={tickStyle}
          width={36}
        />
        <ReferenceLine yAxisId="right" y={0.5} stroke="#4b5563" strokeDasharray="4 4" />
        <Tooltip
          cursor={false}
          content={({ active, payload, label }: any) => {
            if (!active || !payload?.length) return null
            const entry = payload[0]?.payload as SummaryEntry
            const displayLabel = nameTransform ? nameTransform(label) : label
            return (
              <div style={{ background: 'var(--surface2)', border: '1px solid var(--border)', borderRadius: 6, fontSize: 12, padding: '6px 10px' }}>
                <div style={{ color: 'var(--text)', fontWeight: 700, marginBottom: 4 }}>{displayLabel}</div>
                <div style={{ color: 'var(--text)' }}>試合数: {entry.total}</div>
                <div style={{ color: 'var(--text)' }}>勝ち数: {entry.wins}</div>
                <div style={{ color: 'var(--text)' }}>勝率: {(entry.win_rate * 100).toFixed(1)}%</div>
              </div>
            )
          }}
        />
        <Bar yAxisId="left" dataKey="total" name="total" maxBarSize={32} activeBar={false}
          onMouseEnter={(_: any, index: number) => setActiveIndex(index)}
        >
          {data.map((_, i) => (
            <Cell key={i} fill={totalCellFill(i)} fillOpacity={cellOpacity(i)} />
          ))}
        </Bar>
        <Bar yAxisId="right" dataKey="win_rate" name="win_rate" maxBarSize={32} activeBar={false}
          onMouseEnter={(_: any, index: number) => setActiveIndex(index)}
        >
          {data.map((entry, i) => (
            <Cell key={i} fill={winRateColor(entry.win_rate)} fillOpacity={cellOpacity(i)} />
          ))}
        </Bar>
      </BarChart>
    </ResponsiveContainer>
  )
}

// ---------------------------------------------------------------------------
// ChartCard with optional sort buttons
// ---------------------------------------------------------------------------

function StatCard({ label, value, valueColor, small }: { label: string; value: string; valueColor?: string; small?: boolean }) {
  return (
    <div className="stat-card">
      <div className="stat-label">{label}</div>
      <div className={`stat-value${small ? ' stat-value--small' : ''}`} style={valueColor ? { color: valueColor } : undefined}>{value}</div>
    </div>
  )
}

function ChartCard({
  title, children, sortBy, onSortChange,
}: {
  title: string
  children: React.ReactNode
  sortBy?: SortBy
  onSortChange?: (s: SortBy) => void
}) {
  return (
    <div className="chart-card">
      <div className="chart-card-header">
        <h3 className="chart-title">{title}</h3>
        {onSortChange && (
          <div className="chart-sort-btns">
            <button
              className={`chart-sort-btn${sortBy === 'total' ? ' active' : ''}`}
              onClick={() => onSortChange('total')}
            >試合数</button>
            <button
              className={`chart-sort-btn${sortBy === 'win_rate' ? ' active' : ''}`}
              onClick={() => onSortChange('win_rate')}
            >勝率</button>
          </div>
        )}
      </div>
      {children}
    </div>
  )
}

// ---------------------------------------------------------------------------
// AI chart renderer
// ---------------------------------------------------------------------------

function AiChartRenderer({ spec }: { spec: ChartSpec }) {
  const { chartType, data, xKey, yKey } = spec
  return (
    <ResponsiveContainer width="100%" height={240}>
      {chartType === 'bar' ? (
        <BarChart data={data}>
          <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" />
          <XAxis dataKey={xKey} />
          <YAxis />
          <Tooltip contentStyle={{ background: 'var(--surface2)', border: '1px solid var(--border)', color: 'var(--text)' }} />
          <Bar dataKey={yKey} fill="var(--accent)" />
        </BarChart>
      ) : chartType === 'line' ? (
        <LineChart data={data}>
          <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" />
          <XAxis dataKey={xKey} />
          <YAxis />
          <Tooltip contentStyle={{ background: 'var(--surface2)', border: '1px solid var(--border)', color: 'var(--text)' }} />
          <Line dataKey={yKey} stroke="var(--accent)" dot={false} />
        </LineChart>
      ) : (
        <ScatterChart>
          <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" />
          <XAxis dataKey={xKey} />
          <YAxis dataKey={yKey} />
          <Tooltip contentStyle={{ background: 'var(--surface2)', border: '1px solid var(--border)', color: 'var(--text)' }} />
          <Scatter data={data} fill="var(--accent)" />
        </ScatterChart>
      )}
    </ResponsiveContainer>
  )
}
