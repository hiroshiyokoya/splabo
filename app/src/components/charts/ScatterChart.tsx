import { useMemo, useState } from 'react'
import {
  ScatterChart as RScatterChart, Scatter, XAxis, YAxis, ZAxis, CartesianGrid, ResponsiveContainer, Cell,
} from 'recharts'
import type { GroupedStatsRow, MetricKey } from '../../types'
import { METRIC_LABELS, getMetric, formatMetric, metricGroup } from '../../types'

/**
 * 散布図。1 ドット = 1 カテゴリ (武器 or ステージ)。
 *
 * - X / Y 軸: 任意のメトリクス
 * - サイズ: 任意のメトリクス（指定なければ一定）。sqrt スケールで半径比例
 * - 色: 任意のメトリクス（指定なければ単色）。勝率は divergent (50% 中央)、
 *   それ以外は sequential (アクセント色の濃淡)
 * - 0 サンプル除外
 *
 * バトル単位の散布図は別 PR で対応予定。
 */

function colorForMetric(value: number | null, metric: MetricKey, min: number, max: number): string {
  if (value === null) return 'var(--cell-empty)'
  const g = metricGroup(metric)
  if (g === 'rate') {
    const t = (value - 0.5) * 2
    if (t < -0.4) return 'var(--cell-r1)'
    if (t < -0.1) return 'var(--cell-r2)'
    if (t <=  0.1) return 'var(--cell-r3)'
    if (t <=  0.4) return 'var(--cell-r4)'
    return 'var(--cell-r5)'
  }
  if (max <= min) return 'var(--cell-c3)'
  const t = (value - min) / (max - min)
  if (t <= 0.2) return 'var(--cell-c1)'
  if (t <= 0.4) return 'var(--cell-c2)'
  if (t <= 0.6) return 'var(--cell-c3)'
  if (t <= 0.8) return 'var(--cell-c4)'
  return 'var(--cell-c5)'
}

export function ScatterChart({
  data, xMetric, yMetric, sizeMetric, colorMetric, height = 300, nameTransform,
}: {
  data:          GroupedStatsRow[]
  xMetric:       MetricKey
  yMetric:       MetricKey
  sizeMetric?:   MetricKey
  colorMetric?:  MetricKey
  height?:       number
  nameTransform?: (s: string) => string
}) {
  const [hover, setHover] = useState<{ name: string; x: number | null; y: number | null; size: number | null; color: number | null } | null>(null)

  const points = useMemo(() => {
    // 0 サンプルは除外。X, Y どちらかが null も除外（ドットを置けないため）。
    return data
      .filter(d => d.total > 0)
      .map(d => ({
        name:  d.name,
        x:     getMetric(d, xMetric),
        y:     getMetric(d, yMetric),
        size:  sizeMetric  ? getMetric(d, sizeMetric)  : null,
        color: colorMetric ? getMetric(d, colorMetric) : null,
        total: d.total,
      }))
      .filter(p => p.x !== null && p.y !== null)
  }, [data, xMetric, yMetric, sizeMetric, colorMetric])

  // 色マッピング用 min/max
  const colorMinMax = useMemo(() => {
    if (!colorMetric) return { min: 0, max: 0 }
    const vs = points.map(p => p.color).filter((v): v is number => v !== null)
    return { min: vs.length ? Math.min(...vs) : 0, max: vs.length ? Math.max(...vs) : 0 }
  }, [points, colorMetric])

  // サイズ範囲 (sqrt スケール)。ZAxis の range で recharts に任せる。
  const zRange: [number, number] = sizeMetric ? [40, 600] : [120, 120]

  const colorOf = (v: number | null): string => {
    if (!colorMetric) return 'var(--accent)'
    return colorForMetric(v, colorMetric, colorMinMax.min, colorMinMax.max)
  }

  return (
    <div className="chart-hover-area" style={{ position: 'relative' }}>
    <ResponsiveContainer width="100%" height={height}>
      <RScatterChart
        margin={{ top: 4, right: 8, left: 0, bottom: 4 }}
        onMouseLeave={() => setHover(null)}
      >
        <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" />
        <XAxis
          type="number"
          dataKey="x"
          name={METRIC_LABELS[xMetric]}
          tick={{ fill: 'var(--text)', fontSize: 10 } as object}
          tickFormatter={xMetric === 'win_rate' ? (v: number) => `${(v * 100).toFixed(0)}%` : undefined}
          domain={xMetric === 'win_rate' ? [0, 1] : ['auto', 'auto']}
        />
        <YAxis
          type="number"
          dataKey="y"
          name={METRIC_LABELS[yMetric]}
          tick={{ fill: 'var(--text)', fontSize: 10 } as object}
          width={48}
          tickFormatter={yMetric === 'win_rate' ? (v: number) => `${(v * 100).toFixed(0)}%` : undefined}
          domain={yMetric === 'win_rate' ? [0, 1] : ['auto', 'auto']}
        />
        <ZAxis type="number" dataKey="size" range={zRange} />
        <Scatter
          data={points}
          onMouseEnter={(p: any) => setHover(p)}
          isAnimationActive={false}
        >
          {points.map((p, i) => (
            <Cell key={i} fill={colorOf(p.color)} fillOpacity={0.85} stroke="var(--surface)" strokeWidth={0.5} />
          ))}
        </Scatter>
      </RScatterChart>
    </ResponsiveContainer>
    {hover && (
      <div className="cal-tooltip" style={{ position: 'absolute', right: 12, top: 12, pointerEvents: 'none', minWidth: 160 }}>
        <div className="hover-tt-title">{nameTransform ? nameTransform(hover.name) : hover.name}</div>
        <div className="hover-tt-row">{METRIC_LABELS[xMetric]}: {formatMetric(hover.x, xMetric)}</div>
        <div className="hover-tt-row">{METRIC_LABELS[yMetric]}: {formatMetric(hover.y, yMetric)}</div>
        {sizeMetric && (
          <div className="hover-tt-row hover-tt-row--muted">{METRIC_LABELS[sizeMetric]}: {formatMetric(hover.size, sizeMetric)}</div>
        )}
        {colorMetric && (
          <div className="hover-tt-row hover-tt-row--muted">{METRIC_LABELS[colorMetric]}: {formatMetric(hover.color, colorMetric)}</div>
        )}
      </div>
    )}
    </div>
  )
}
