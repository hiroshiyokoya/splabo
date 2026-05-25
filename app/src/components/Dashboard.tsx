import { useEffect, useState } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'
import {
  BarChart, Bar, LineChart, Line, ScatterChart, Scatter,
  XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, Cell, ReferenceLine,
} from 'recharts'
import {
  DndContext, closestCenter, KeyboardSensor, PointerSensor, useSensor, useSensors,
  type DragEndEvent,
} from '@dnd-kit/core'
import {
  SortableContext, sortableKeyboardCoordinates, rectSortingStrategy, arrayMove,
} from '@dnd-kit/sortable'
import type { Summary, SummaryEntry, ChartSpec, Filters, BattleStats, GroupedStatsRow, CustomChart, GroupByKey } from '../types'
import { filtersToRange, stageAbbr, modeLabel, ruleLabel, avgKillRatio } from '../types'
import { CustomChartCard } from './CustomChartCard'
import { ChartConfigModal } from './ChartConfigModal'
import { loadCustomCharts, saveCustomCharts, generateChartId } from '../utils/customCharts'

const COLOR_WIN  = '#22c55e'
const COLOR_LOSE = '#ef4444'
const COLOR_DRAW = '#9ca3af'

// 勝率の閾値色。勝/負の緑/赤との衝突を避けつつ、
// まぶしくならないよう少しトーンを抑える。
//   ≥55% : emerald-400（緑＋青み、ライムの代わり）
//   45-55% : orange-400（落ち着いた橙）
//   <45% : pink-400（柔らかいピンク）
const WIN_RATE_HI  = '#34d399'
const WIN_RATE_MID = '#fb923c'
const WIN_RATE_LO  = '#f472b6'

function winRateColor(rate: number): string {
  if (rate >= 0.55) return WIN_RATE_HI
  if (rate >= 0.45) return WIN_RATE_MID
  return WIN_RATE_LO
}

function winRateLevel(rate: number): 'hi' | 'mid' | 'lo' {
  if (rate >= 0.55) return 'hi'
  if (rate >= 0.45) return 'mid'
  return 'lo'
}

// 積み上げバーで「最上段のセグメントだけ上端を角丸」にする shape。
// Recharts の radius={[r,r,0,0]} を全 stack に付けると各セグメントが
// 個別に丸まって境目に変な凹みが出るため、shape で制御する。
// 並び（下→上）: wins → losses → draws。
function stackTopRoundedShape(props: any) {
  const { x, y, width, height, fill, fillOpacity, payload, dataKey } = props
  if (height <= 0) return null
  const isTop =
    (dataKey === 'draws'  && payload.draws  > 0) ||
    (dataKey === 'losses' && payload.draws === 0 && payload.losses > 0) ||
    (dataKey === 'wins'   && payload.draws === 0 && payload.losses === 0 && payload.wins > 0)
  const r = isTop ? Math.min(4, height / 2, width / 2) : 0
  if (r === 0) {
    return <rect x={x} y={y} width={width} height={height} fill={fill} fillOpacity={fillOpacity} />
  }
  const d =
    `M ${x},${y + r} Q ${x},${y} ${x + r},${y} ` +
    `L ${x + width - r},${y} Q ${x + width},${y} ${x + width},${y + r} ` +
    `L ${x + width},${y + height} L ${x},${y + height} Z`
  return <path d={d} fill={fill} fillOpacity={fillOpacity} />
}

type SortBy = 'total' | 'wins' | 'win_rate'

interface Props {
  filters: Filters
  aiChart: ChartSpec | null
  /** サイドバーの「バトルデータを取得」と同じ処理を空状態のボタンからも呼べるようにする。 */
  onFetchRequest?: () => void
  /** 「設定タブを開く」ためのコールバック（ログイン誘導用）。 */
  onOpenSettings?: () => void
  /** 取得中はボタンを disable + 表示文言を変えるためのフラグ。 */
  fetching?: boolean
}

export function Dashboard({ filters, aiChart, onFetchRequest, onOpenSettings, fetching }: Props) {
  const [summary, setSummary] = useState<Summary | null>(null)
  const [stats, setStats]     = useState<BattleStats | null>(null)
  // #86 PR B: ユーザーが追加したカスタムグラフ。localStorage に永続化。
  const [customCharts, setCustomCharts] = useState<CustomChart[]>(() => loadCustomCharts())
  // 各 groupBy のデータをキャッシュ（同じキーを複数カードで参照するので 1 回で済ませる）。
  const [groupedStatsCache, setGroupedStatsCache] = useState<Partial<Record<GroupByKey, GroupedStatsRow[]>>>({})
  // モーダル状態：null=閉じる、{ chart: null }=新規、{ chart: 既存 }=編集
  const [modalState, setModalState] = useState<{ chart: CustomChart | null } | null>(null)
  const [loading, setLoading] = useState(true)
  const [refreshKey, setRefreshKey] = useState(0)
  const [weaponImages, setWeaponImages] = useState<Map<string, string>>(new Map())
  const [weaponSort, setWeaponSort] = useState<SortBy>('total')
  const [stageSort, setStageSort] = useState<SortBy>('total')
  const [ruleSort, setRuleSort] = useState<SortBy>('total')
  const [modeSort, setModeSort] = useState<SortBy>('total')

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  )

  useEffect(() => {
    const { since, until } = filtersToRange(filters)
    setLoading(true)
    const filterArgs = {
      since,
      until,
      mode: filters.mode,
      rule: filters.rule,
      resultFilter: filters.result,
      weapon: filters.weapon.length > 0 ? filters.weapon.join('|') : null,
      stage: filters.stage.length > 0 ? filters.stage.join('|') : null,
    }
    // カスタムグラフが必要としている group_by を unique にまとめて 1 回ずつ取得。
    const neededGroups = Array.from(new Set(customCharts.map(c => c.groupBy)))
    Promise.all([
      invoke<Summary>('db_summary', filterArgs),
      invoke<BattleStats>('db_battle_stats', filterArgs),
      ...neededGroups.map(g => invoke<GroupedStatsRow[]>('db_grouped_stats', { ...filterArgs, groupBy: g }).then(rows => [g, rows] as const)),
    ])
      .then((results) => {
        const [s, st, ...gpairs] = results as [Summary, BattleStats, ...(readonly [GroupByKey, GroupedStatsRow[]])[]]
        setSummary(s)
        setStats(st)
        const cache: Partial<Record<GroupByKey, GroupedStatsRow[]>> = {}
        for (const [g, rows] of gpairs) cache[g] = rows
        setGroupedStatsCache(cache)
      })
      .catch(console.error)
      .finally(() => setLoading(false))
  }, [refreshKey, filters, customCharts])

  // fetch_complete イベントでデータを自動リフレッシュ
  useEffect(() => {
    const unlistenPromise = listen('fetch_complete', () => setRefreshKey(k => k + 1))
    return () => { unlistenPromise.then(fn => fn()) }
  }, [])

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

  const totalBattles = summary?.by_mode.reduce((s, e) => s + e.total, 0) ?? 0
  const totalWins    = summary?.by_mode.reduce((s, e) => s + e.wins,  0) ?? 0
  const totalDraws   = summary?.by_mode.reduce((s, e) => s + e.draws, 0) ?? 0
  const totalLosses  = totalBattles - totalWins - totalDraws
  const decisiveBattles = totalBattles - totalDraws
  const overallWinRate  = decisiveBattles > 0 ? totalWins / decisiveBattles : null

  function sorted(data: SummaryEntry[], by: SortBy): SummaryEntry[] {
    return [...data].sort((a, b) => b[by] - a[by])
  }

  // ---- カスタムグラフ操作 ----
  function persist(charts: CustomChart[]) {
    setCustomCharts(charts)
    saveCustomCharts(charts)
  }
  function handleAdd() {
    setModalState({ chart: null })
  }
  function handleEdit(id: string) {
    const c = customCharts.find(x => x.id === id)
    if (c) setModalState({ chart: c })
  }
  function handleDelete(id: string) {
    persist(customCharts.filter(c => c.id !== id))
  }
  function handleSaveFromModal(saved: CustomChart) {
    if (saved.id) {
      // 編集モード：同じ ID で置換
      persist(customCharts.map(c => c.id === saved.id ? saved : c))
    } else {
      // 新規モード：ID を生成して末尾に追加
      persist([...customCharts, { ...saved, id: generateChartId() }])
    }
    setModalState(null)
  }
  function handleDragEnd(event: DragEndEvent) {
    const { active, over } = event
    if (!over || active.id === over.id) return
    const oldIdx = customCharts.findIndex(c => c.id === active.id)
    const newIdx = customCharts.findIndex(c => c.id === over.id)
    if (oldIdx < 0 || newIdx < 0) return
    persist(arrayMove(customCharts, oldIdx, newIdx))
  }

  return (
    <div className="dashboard">
      <div className="dashboard-header">
        <h2>ダッシュボード</h2>
      </div>

      {loading ? (
        <div className="loading">読み込み中...</div>
      ) : !summary || totalBattles === 0 ? (
        <DashboardEmptyState
          onFetchRequest={onFetchRequest}
          onOpenSettings={onOpenSettings}
          fetching={fetching}
        />
      ) : (
        <>
          <div className="stat-cards">
            <StatCard label="総バトル数" value={totalBattles.toLocaleString()} />
            <StatCard label="Win / Lose (Draw)" value={`${totalWins} / ${totalLosses} (${totalDraws})`} />
            <StatCard
              label="全体勝率"
              value={overallWinRate !== null ? `${(overallWinRate * 100).toFixed(1)}%` : '—'}
              valueColor={overallWinRate !== null ? winRateColor(overallWinRate) : undefined}
            />
            <StatCard label="平均キル" value={stats?.avg_kill  != null ? stats.avg_kill.toFixed(2)  : '—'} />
            <StatCard label="平均デス" value={stats?.avg_death != null ? stats.avg_death.toFixed(2) : '—'} />
            <StatCard label="キルレシオ" value={avgKillRatio(stats?.avg_kill ?? null, stats?.avg_death ?? null)} />
          </div>

          <div className="chart-grid">
            <ChartCard title="武器別 バトル数 & 勝率" sortBy={weaponSort} onSortChange={setWeaponSort}>
              <WinRateChart data={sorted(summary.by_weapon.slice(0, 14), weaponSort)} height={260} images={weaponImages} hoverImageSize={64} />
            </ChartCard>

            <ChartCard title="ステージ別 バトル数 & 勝率" sortBy={stageSort} onSortChange={setStageSort}>
              <WinRateChart data={sorted(summary.by_stage.slice(0, 14), stageSort)} height={260} images={new Map()} nameTransform={stageAbbr} tickAngle={30} />
            </ChartCard>

            <ChartCard title="ルール別 バトル数 & 勝率" sortBy={ruleSort} onSortChange={setRuleSort}>
              <WinRateChart data={sorted(summary.by_rule, ruleSort)} height={220} images={new Map()} nameTransform={ruleLabel} />
            </ChartCard>

            <ChartCard title="モード別 バトル数 & 勝率" sortBy={modeSort} onSortChange={setModeSort}>
              <WinRateChart data={sorted(summary.by_mode, modeSort)} height={220} images={new Map()} nameTransform={modeLabel} />
            </ChartCard>

            {/* #86 PR B: カスタムグラフ。ドラッグで並び替え可能、⚙で編集・✕で削除 */}
            <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleDragEnd}>
              <SortableContext items={customCharts.map(c => c.id)} strategy={rectSortingStrategy}>
                {customCharts.map(c => (
                  <CustomChartCard
                    key={c.id}
                    chart={c}
                    data={groupedStatsCache[c.groupBy] ?? []}
                    onEdit={() => handleEdit(c.id)}
                    onDelete={() => handleDelete(c.id)}
                    weaponImages={weaponImages}
                  />
                ))}
              </SortableContext>
            </DndContext>

            {aiChart && (
              <ChartCard title={aiChart.title}>
                <AiChartRenderer spec={aiChart} />
              </ChartCard>
            )}
          </div>

          <div className="dashboard-add-row">
            <button className="btn-secondary dashboard-add-btn" onClick={handleAdd}>
              + グラフを追加
            </button>
          </div>
        </>
      )}

      {modalState && (
        <ChartConfigModal
          initial={modalState.chart}
          onSave={handleSaveFromModal}
          onClose={() => setModalState(null)}
        />
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------
// 空状態（DB にバトルが 1 件も無いとき）
// ---------------------------------------------------------------------------

function DashboardEmptyState({ onFetchRequest, onOpenSettings, fetching }: {
  onFetchRequest?: () => void
  onOpenSettings?: () => void
  fetching?: boolean
}) {
  return (
    <div className="dashboard-empty">
      <div className="dashboard-empty-icon" aria-hidden="true">📊</div>
      <h3 className="dashboard-empty-title">まだバトルデータがありません</h3>
      <p className="dashboard-empty-desc">
        SplatNet 3 から最新のバトルデータを取得すると、ここに勝率グラフ・武器/ステージ別の集計が表示されます。
      </p>
      <ol className="dashboard-empty-steps">
        <li>初回は <strong>設定</strong> から Nintendo アカウントでログイン</li>
        <li><strong>バトルデータを取得</strong> ボタンを押す</li>
      </ol>
      <div className="dashboard-empty-actions">
        {onFetchRequest && (
          <button className="btn-primary" onClick={onFetchRequest} disabled={fetching}>
            {fetching ? '取得中…' : 'バトルデータを取得'}
          </button>
        )}
        {onOpenSettings && (
          <button className="btn-secondary" onClick={onOpenSettings}>
            設定を開く
          </button>
        )}
      </div>
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

  const chartData = data.map(d => ({ ...d, losses: d.total - d.wins - d.draws }))

  function cellOpacity(i: number) {
    return activeIndex === null || activeIndex === i ? 1 : 0.35
  }

  // バーごとに上→下のグラデーション。上端で 95%、下端で 50% の不透明度。
  // SVG gradient ID はチャート間で衝突しないよう React useId を使うのが安全だが、
  // 1 ページに複数置いてもブラウザ的には問題ない（同一定義のため）。
  const gradients: { id: string; color: string }[] = [
    { id: 'grad-win',      color: COLOR_WIN  },
    { id: 'grad-lose',     color: COLOR_LOSE },
    { id: 'grad-draw',     color: COLOR_DRAW },
    { id: 'grad-rate-hi',  color: WIN_RATE_HI  },
    { id: 'grad-rate-mid', color: WIN_RATE_MID },
    { id: 'grad-rate-lo',  color: WIN_RATE_LO  },
  ]

  return (
    <ResponsiveContainer width="100%" height={height}>
      <BarChart
        data={chartData}
        margin={{ top: 4, right: 8, left: 0, bottom: hasImages ? 8 : 4 }}
        onMouseLeave={() => setActiveIndex(null)}
      >
        <defs>
          {gradients.map(g => (
            <linearGradient key={g.id} id={g.id} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%"   stopColor={g.color} stopOpacity="0.95" />
              <stop offset="100%" stopColor={g.color} stopOpacity="0.5"  />
            </linearGradient>
          ))}
        </defs>
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
                <div style={{ color: 'var(--text)' }}>バトル数: {entry.total}</div>
                <div style={{ color: COLOR_WIN }}>勝ち: {entry.wins}</div>
                <div style={{ color: COLOR_LOSE }}>負け: {entry.total - entry.wins - entry.draws}</div>
                {entry.draws > 0 && <div style={{ color: COLOR_DRAW }}>引き分け: {entry.draws}</div>}
                <div style={{ color: 'var(--text)' }}>勝率: {(entry.win_rate * 100).toFixed(1)}%</div>
              </div>
            )
          }}
        />
        <Bar yAxisId="left" dataKey="wins" stackId="s" maxBarSize={32} activeBar={false}
          shape={stackTopRoundedShape}
          onMouseEnter={(_: any, index: number) => setActiveIndex(index)}
        >
          {chartData.map((_, i) => <Cell key={i} fill="url(#grad-win)" fillOpacity={cellOpacity(i)} />)}
        </Bar>
        <Bar yAxisId="left" dataKey="losses" stackId="s" maxBarSize={32} activeBar={false}
          shape={stackTopRoundedShape}
          onMouseEnter={(_: any, index: number) => setActiveIndex(index)}
        >
          {chartData.map((_, i) => <Cell key={i} fill="url(#grad-lose)" fillOpacity={cellOpacity(i)} />)}
        </Bar>
        <Bar yAxisId="left" dataKey="draws" stackId="s" maxBarSize={32} activeBar={false}
          shape={stackTopRoundedShape}
          onMouseEnter={(_: any, index: number) => setActiveIndex(index)}
        >
          {chartData.map((_, i) => <Cell key={i} fill="url(#grad-draw)" fillOpacity={cellOpacity(i)} />)}
        </Bar>
        <Bar yAxisId="right" dataKey="win_rate" name="win_rate" maxBarSize={32} activeBar={false}
          radius={[4, 4, 0, 0]}
          onMouseEnter={(_: any, index: number) => setActiveIndex(index)}
        >
          {chartData.map((entry, i) => (
            <Cell key={i} fill={`url(#grad-rate-${winRateLevel(entry.win_rate)})`} fillOpacity={cellOpacity(i)} />
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
            >バトル数</button>
            <button
              className={`chart-sort-btn${sortBy === 'wins' ? ' active' : ''}`}
              onClick={() => onSortChange('wins')}
            >勝数</button>
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
