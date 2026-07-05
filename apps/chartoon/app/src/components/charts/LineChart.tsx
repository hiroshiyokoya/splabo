import { useState } from 'react'
import {
  LineChart as RLineChart, Line, XAxis, YAxis, CartesianGrid, ResponsiveContainer,
} from 'recharts'
import type { GroupedStatsRow, MetricKey } from '../../types'
import { METRIC_LABELS, getMetric, formatMetric } from '../../types'
import { HoverTooltip } from './HoverTooltip'

/**
 * 時系列の線グラフ。X 軸は db_grouped_stats が返す時系列キー（日 / 3日 / 週 / 月）。
 *
 * - シリーズ: 単一メトリクス（v1.0.0）。多系列・2 軸対応は後続 PR。
 * - 欠損バケット: null skip でつなぐ（0 埋めしない）
 * - 勝率は固定 0–100% スケール、その他は相対スケール
 */
export function LineChart({
  data, metric, height = 260,
}: {
  data:    GroupedStatsRow[]
  metric:  MetricKey
  height?: number
}) {
  const [activeIndex, setActiveIndex] = useState<number | null>(null)

  // data は BE 側で時系列昇順 (key ASC) で返ってくる前提。
  const chartData = data.map(d => ({
    name:   d.name,
    value:  getMetric(d, metric),
    rawRow: d,
  }))

  const leftPad  = 42
  const rightPad = 8

  return (
    <div className="chart-hover-area" style={{ position: 'relative' }}>
    <ResponsiveContainer width="100%" height={height}>
      <RLineChart
        data={chartData}
        margin={{ top: 4, right: 8, left: 0, bottom: 4 }}
        onMouseLeave={() => setActiveIndex(null)}
        onMouseMove={(state: any) => {
          if (typeof state?.activeTooltipIndex === 'number') setActiveIndex(state.activeTooltipIndex)
        }}
      >
        <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" vertical={false} />
        <XAxis
          dataKey="name"
          interval="preserveStartEnd"
          height={28}
          tick={{ fill: 'var(--text)', fontSize: 10, fontWeight: 600 } as object}
        />
        <YAxis
          tick={{ fill: 'var(--text)', fontSize: 10, fontWeight: 600 } as object}
          width={leftPad}
          tickFormatter={metric === 'win_rate' ? (v: number) => `${(v * 100).toFixed(0)}%` : undefined}
          domain={metric === 'win_rate' ? [0, 1] : ['auto', 'auto']}
        />
        <Line
          type="linear"
          dataKey="value"
          stroke="var(--accent)"
          strokeWidth={2}
          dot={{ fill: 'var(--accent)', r: 3 }}
          activeDot={{ r: 5 }}
          connectNulls
          isAnimationActive={false}
        />
      </RLineChart>
    </ResponsiveContainer>
    <HoverTooltip activeIndex={activeIndex} dataLength={chartData.length} leftPad={leftPad} rightPad={rightPad}>
      {activeIndex != null && (() => {
        const p = chartData[activeIndex]
        return (
          <>
            <div className="hover-tt-title">{p.name}</div>
            <div className="hover-tt-row">{METRIC_LABELS[metric]}: {formatMetric(p.value, metric)}</div>
            <div className="hover-tt-row hover-tt-row--muted">バトル数: {p.rawRow.total}</div>
          </>
        )
      })()}
    </HoverTooltip>
    </div>
  )
}
