import { useState } from 'react'
import {
  BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, Cell,
} from 'recharts'
import type { GroupedStatsRow, MetricKey } from '../../types'
import { METRIC_LABELS, getMetric, formatMetric } from '../../types'

/**
 * 単一メトリクスを棒で見せるシンプルなチャート。
 *
 * - X 軸: カテゴリ名（武器・ステージ・ルール等）
 * - Y 軸: 選んだ 1 メトリクスの値
 * - 勝率系はバーごとに段階色（hi/mid/lo）、それ以外は単一色
 * - 値が null のカテゴリ（detail_fetched=0 しかない等）はバーを描かず、ツールチップで「—」表示
 */
export function SimpleBarChart({
  data, metric, height = 260, nameTransform,
}: {
  data:           GroupedStatsRow[]
  metric:         MetricKey
  height?:        number
  /** X 軸ラベルの整形（ステージ名の省略など）。 */
  nameTransform?: (name: string) => string
}) {
  const [activeIndex, setActiveIndex] = useState<number | null>(null)

  const chartData = data.map(d => ({
    name:    d.name,
    value:   getMetric(d, metric),
    rawRow:  d,
  }))

  function barColor(value: number | null): string {
    if (metric === 'win_rate' && value !== null) {
      if (value >= 0.55) return 'url(#grad-rate-hi)'
      if (value >= 0.45) return 'url(#grad-rate-mid)'
      return 'url(#grad-rate-lo)'
    }
    return 'url(#grad-accent)'
  }

  function cellOpacity(i: number) {
    return activeIndex === null || activeIndex === i ? 1 : 0.35
  }

  return (
    <ResponsiveContainer width="100%" height={height}>
      <BarChart
        data={chartData}
        margin={{ top: 4, right: 8, left: 0, bottom: 4 }}
        onMouseLeave={() => setActiveIndex(null)}
      >
        <defs>
          <linearGradient id="grad-accent" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%"   stopColor="var(--accent)" stopOpacity="0.95" />
            <stop offset="100%" stopColor="var(--accent)" stopOpacity="0.50" />
          </linearGradient>
          {/* 勝率用の色は Dashboard.tsx の WinRateChart 内 gradients と同名で揃える */}
          <linearGradient id="grad-rate-hi" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="#34d399" stopOpacity="0.95" />
            <stop offset="100%" stopColor="#34d399" stopOpacity="0.5" />
          </linearGradient>
          <linearGradient id="grad-rate-mid" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="#fb923c" stopOpacity="0.95" />
            <stop offset="100%" stopColor="#fb923c" stopOpacity="0.5" />
          </linearGradient>
          <linearGradient id="grad-rate-lo" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="#f472b6" stopOpacity="0.95" />
            <stop offset="100%" stopColor="#f472b6" stopOpacity="0.5" />
          </linearGradient>
        </defs>
        <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" vertical={false} />
        <XAxis
          dataKey="name"
          interval={0}
          height={28}
          tick={{ fill: 'var(--text)', fontSize: 10 } as object}
          tickFormatter={nameTransform}
        />
        <YAxis
          tick={{ fill: 'var(--text)', fontSize: 10 } as object}
          width={42}
          tickFormatter={metric === 'win_rate' ? (v: number) => `${(v * 100).toFixed(0)}%` : undefined}
        />
        <Tooltip
          cursor={false}
          content={({ active, payload, label }: any) => {
            if (!active || !payload?.length) return null
            const p = payload[0]?.payload as { name: string; value: number | null; rawRow: GroupedStatsRow }
            const displayLabel = nameTransform ? nameTransform(label) : label
            return (
              <div style={{ background: 'var(--surface2)', border: '1px solid var(--border)', borderRadius: 6, fontSize: 12, padding: '6px 10px' }}>
                <div style={{ color: 'var(--text)', fontWeight: 700, marginBottom: 4 }}>{displayLabel}</div>
                <div style={{ color: 'var(--text)' }}>{METRIC_LABELS[metric]}: {formatMetric(p.value, metric)}</div>
                <div style={{ color: 'var(--text-muted)', fontSize: 11, marginTop: 2 }}>バトル数: {p.rawRow.total}</div>
              </div>
            )
          }}
        />
        <Bar dataKey="value" maxBarSize={32} radius={[4, 4, 0, 0]} activeBar={false}
          onMouseEnter={(_: any, i: number) => setActiveIndex(i)}
        >
          {chartData.map((d, i) => (
            <Cell key={i} fill={barColor(d.value)} fillOpacity={cellOpacity(i)} />
          ))}
        </Bar>
      </BarChart>
    </ResponsiveContainer>
  )
}
