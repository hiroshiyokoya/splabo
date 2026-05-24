import { useState } from 'react'
import {
  BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, Cell, ReferenceLine,
} from 'recharts'
import type { GroupedStatsRow } from '../../types'

const COLOR_WIN  = '#22c55e'
const COLOR_LOSE = '#ef4444'
const COLOR_DRAW = '#9ca3af'
const WIN_RATE_HI  = '#34d399'
const WIN_RATE_MID = '#fb923c'
const WIN_RATE_LO  = '#f472b6'

function winRateLevel(rate: number): 'hi' | 'mid' | 'lo' {
  if (rate >= 0.55) return 'hi'
  if (rate >= 0.45) return 'mid'
  return 'lo'
}

/** 積み上げバーで「最上段のセグメントだけ上端を角丸」にする shape。
 *  Dashboard.tsx の WinRateChart と同じロジック。 */
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

/**
 * カスタムグラフ用の「勝/負/分積み上げ + 勝率線」チャート。
 *
 * Dashboard 内蔵の WinRateChart から画像ティック・hoverImage 関連を除いた汎用版。
 * カスタムグラフでは武器アイコンを並べない（ステージ・ルール・モード等、武器以外もありうるため）。
 */
export function StackedWinrateChart({
  data, height = 260, nameTransform, tickAngle,
}: {
  data:           GroupedStatsRow[]
  height?:        number
  nameTransform?: (name: string) => string
  tickAngle?:     number
}) {
  const [activeIndex, setActiveIndex] = useState<number | null>(null)
  const tickHeight = tickAngle ? 44 : 28

  const chartData = data.map(d => ({
    name:     d.name,
    total:    d.total,
    wins:     d.wins,
    draws:    d.draws,
    losses:   d.total - d.wins - d.draws,
    win_rate: d.win_rate,
  }))

  function cellOpacity(i: number) {
    return activeIndex === null || activeIndex === i ? 1 : 0.35
  }

  const gradients: { id: string; color: string }[] = [
    { id: 'grad-cs-win',      color: COLOR_WIN  },
    { id: 'grad-cs-lose',     color: COLOR_LOSE },
    { id: 'grad-cs-draw',     color: COLOR_DRAW },
    { id: 'grad-cs-rate-hi',  color: WIN_RATE_HI  },
    { id: 'grad-cs-rate-mid', color: WIN_RATE_MID },
    { id: 'grad-cs-rate-lo',  color: WIN_RATE_LO  },
  ]

  return (
    <ResponsiveContainer width="100%" height={height}>
      <BarChart
        data={chartData}
        margin={{ top: 4, right: 8, left: 0, bottom: 4 }}
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
          interval={0}
          height={tickHeight}
          tick={{ fill: 'var(--text)', fontSize: 10 } as object}
          tickFormatter={nameTransform}
          angle={tickAngle ? tickAngle : undefined}
          textAnchor={tickAngle ? 'start' : 'middle'}
        />
        <YAxis yAxisId="left" tick={{ fontSize: 10, fill: 'var(--text)' }} width={36} />
        <YAxis
          yAxisId="right"
          orientation="right"
          tickFormatter={(v) => `${(v * 100).toFixed(0)}%`}
          domain={[0, 1]}
          tick={{ fontSize: 10, fill: 'var(--text)' }}
          width={36}
        />
        <ReferenceLine yAxisId="right" y={0.5} stroke="#4b5563" strokeDasharray="4 4" />
        <Tooltip
          cursor={false}
          content={({ active, payload, label }: any) => {
            if (!active || !payload?.length) return null
            const entry = payload[0]?.payload as { total: number; wins: number; draws: number; win_rate: number }
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
        <Bar yAxisId="left" dataKey="wins"   stackId="s" maxBarSize={32} activeBar={false}
          shape={stackTopRoundedShape}
          onMouseEnter={(_: any, i: number) => setActiveIndex(i)}
        >
          {chartData.map((_, i) => <Cell key={i} fill="url(#grad-cs-win)" fillOpacity={cellOpacity(i)} />)}
        </Bar>
        <Bar yAxisId="left" dataKey="losses" stackId="s" maxBarSize={32} activeBar={false}
          shape={stackTopRoundedShape}
          onMouseEnter={(_: any, i: number) => setActiveIndex(i)}
        >
          {chartData.map((_, i) => <Cell key={i} fill="url(#grad-cs-lose)" fillOpacity={cellOpacity(i)} />)}
        </Bar>
        <Bar yAxisId="left" dataKey="draws"  stackId="s" maxBarSize={32} activeBar={false}
          shape={stackTopRoundedShape}
          onMouseEnter={(_: any, i: number) => setActiveIndex(i)}
        >
          {chartData.map((_, i) => <Cell key={i} fill="url(#grad-cs-draw)" fillOpacity={cellOpacity(i)} />)}
        </Bar>
        <Bar yAxisId="right" dataKey="win_rate" name="win_rate" maxBarSize={32} activeBar={false}
          radius={[4, 4, 0, 0]}
          onMouseEnter={(_: any, i: number) => setActiveIndex(i)}
        >
          {chartData.map((entry, i) => (
            <Cell key={i} fill={`url(#grad-cs-rate-${winRateLevel(entry.win_rate)})`} fillOpacity={cellOpacity(i)} />
          ))}
        </Bar>
      </BarChart>
    </ResponsiveContainer>
  )
}
