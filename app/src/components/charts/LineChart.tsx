import { useState } from 'react'
import {
  LineChart as RLineChart, Line, XAxis, YAxis, CartesianGrid, ResponsiveContainer, Legend,
} from 'recharts'
import type { GroupedStatsRow, MetricKey, GroupByKey, AxisGroup } from '../../types'
import { METRIC_LABELS, getMetric, formatMetric, axisGroupOf } from '../../types'
import { buildTimeSeries, formatTickDate, formatBucketLabel } from '../../utils/timeBuckets'
import { HoverTooltip } from './HoverTooltip'

/** 系列の自動配色（#436）。1 系列目は既存の単一メトリクス折れ線と同じ accent を使う。 */
const LINE_COLORS = [
  'var(--accent)', 'var(--accent2)', 'var(--win)', 'var(--lose)', 'var(--draw)',
  '#8b5cf6', '#06b6d4', '#ec4899', '#84cc16', '#6366f1',
]

/**
 * 時系列の線グラフ。X 軸は db_grouped_stats が返す時系列キー（日 / 3日 / 週 / 月）。
 *
 * - シリーズ: 複数メトリクス対応（#436）。軸グループごとに左右 2 軸へ自動割当。
 * - X 軸は実時間軸（timestamp の number 軸）。欠測バケットは null 埋めして線を切る
 *   （connectNulls={false}）。孤立バケット（両隣が欠測）は点のみ描かれる。
 * - 勝率グループの軸は固定 0–100% スケール、その他は相対スケール。
 */
export function LineChart({
  data, metrics, groupBy, height = 260,
}: {
  data:     GroupedStatsRow[]
  metrics:  MetricKey[]
  groupBy:  GroupByKey
  height?:  number
}) {
  const [activeIndex, setActiveIndex] = useState<number | null>(null)

  const slots = buildTimeSeries(data, groupBy)
  const chartData = slots.map(s => ({
    t:      s.t,
    label:  formatBucketLabel(s.t, groupBy),
    row:    s.row,
    values: Object.fromEntries(metrics.map(m => [m, s.row ? getMetric(s.row, m) : null])) as Record<MetricKey, number | null>,
  }))

  // 軸の左右割当: 最初に選んだ系列のグループ = 左軸、2 つ目に現れた別グループ = 右軸。
  // それ以降の同グループ系列は同じ軸に同居する（UI 側で軸グループは 2 つまでに制限済み）。
  const axisOf = new Map<MetricKey, 'left' | 'right'>()
  let leftGroup: AxisGroup | null = null
  let rightGroup: AxisGroup | null = null
  for (const m of metrics) {
    const g = axisGroupOf(m)
    if (leftGroup === null || leftGroup === g) { leftGroup = g; axisOf.set(m, 'left') }
    else { rightGroup = g; axisOf.set(m, 'right') }
  }
  const hasRightAxis = rightGroup !== null

  const domainOf = (g: AxisGroup | null): [number, number] | ['auto', 'auto'] =>
    g === 'win_rate' ? [0, 1] : ['auto', 'auto']
  const tickFormatterOf = (g: AxisGroup | null) =>
    g === 'win_rate' ? (v: number) => `${(v * 100).toFixed(0)}%` : undefined

  const leftPad  = 42
  const rightPad = hasRightAxis ? 42 : 8

  const tMin = chartData[0]?.t
  const tMax = chartData[chartData.length - 1]?.t
  const ratioOf = (t: number): number =>
    tMax === undefined || tMin === undefined || tMax === tMin ? 0.5 : (t - tMin) / (tMax - tMin)

  const activePoint = activeIndex != null ? chartData[activeIndex] : null

  return (
    <div className="chart-hover-area" style={{ position: 'relative' }}>
    <ResponsiveContainer width="100%" height={height}>
      <RLineChart
        data={chartData}
        margin={{ top: 4, right: 8, left: 0, bottom: 4 }}
        onMouseLeave={() => setActiveIndex(null)}
        onMouseMove={(state: any) => {
          const idx = state?.activeTooltipIndex
          // 欠測バケット（値なし）の上ではツールチップを出さない。
          setActiveIndex(typeof idx === 'number' && chartData[idx]?.row ? idx : null)
        }}
      >
        <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" vertical={false} />
        <XAxis
          dataKey="t"
          type="number"
          domain={['dataMin', 'dataMax']}
          tickFormatter={formatTickDate}
          height={28}
          tick={{ fill: 'var(--text)', fontSize: 10, fontWeight: 600 } as object}
        />
        <YAxis
          yAxisId="left"
          tick={{ fill: 'var(--text)', fontSize: 10, fontWeight: 600 } as object}
          width={leftPad}
          tickFormatter={tickFormatterOf(leftGroup)}
          domain={domainOf(leftGroup)}
        />
        {hasRightAxis && (
          <YAxis
            yAxisId="right"
            orientation="right"
            tick={{ fill: 'var(--text)', fontSize: 10, fontWeight: 600 } as object}
            width={rightPad}
            tickFormatter={tickFormatterOf(rightGroup)}
            domain={domainOf(rightGroup)}
          />
        )}
        {metrics.map((m, i) => (
          <Line
            key={m}
            yAxisId={axisOf.get(m)}
            type="linear"
            dataKey={(d: { values: Record<MetricKey, number | null> }) => d.values[m]}
            name={METRIC_LABELS[m]}
            stroke={LINE_COLORS[i % LINE_COLORS.length]}
            strokeWidth={2}
            dot={{ fill: LINE_COLORS[i % LINE_COLORS.length], r: 3 }}
            activeDot={{ r: 5 }}
            connectNulls={false}
            isAnimationActive={false}
          />
        ))}
        {metrics.length > 1 && (
          <Legend verticalAlign="bottom" height={24} wrapperStyle={{ fontSize: 11 }} />
        )}
      </RLineChart>
    </ResponsiveContainer>
    <HoverTooltip
      activeIndex={activeIndex}
      dataLength={chartData.length}
      leftPad={leftPad}
      rightPad={rightPad}
      ratio={activePoint ? ratioOf(activePoint.t) : undefined}
    >
      {activePoint && activePoint.row && (
        <>
          <div className="hover-tt-title">{activePoint.label}</div>
          {metrics.map((m, i) => (
            <div key={m} className="hover-tt-row" style={{ color: LINE_COLORS[i % LINE_COLORS.length] }}>
              {METRIC_LABELS[m]}: {formatMetric(activePoint.values[m], m)}
            </div>
          ))}
          <div className="hover-tt-row hover-tt-row--muted">バトル数: {activePoint.row.total}</div>
        </>
      )}
    </HoverTooltip>
    </div>
  )
}
