import { useMemo, useState } from 'react'
import {
  ScatterChart as RScatterChart, Scatter, XAxis, YAxis, ZAxis, CartesianGrid, ResponsiveContainer, Cell,
} from 'recharts'

/**
 * 散布図 (presentational)。
 *
 * 呼び出し側 (CustomChartCard) で「ドット単位ごとのデータ」を
 * 既に points: { name, x, y, size, color, tooltipRows }[] に正規化して渡す。
 * ScatterChart 自体は metric や dotUnit を知らない。
 */

export interface ScatterPoint {
  name:        string
  x:           number | null
  y:           number | null
  size:        number | null   // null = 一定サイズ
  color:       string          // 既に CSS color に解決済み
  tooltipRows: { label: string; value: string; muted?: boolean }[]
}

export function ScatterChart({
  points, xLabel, yLabel, xIsRate, yIsRate, hasSize, fillOpacity = 0.85, height = 320,
}: {
  points:       ScatterPoint[]
  xLabel:       string
  yLabel:       string
  xIsRate?:     boolean
  yIsRate?:     boolean
  hasSize?:     boolean
  /** ドットの塗り透過度。バトル単位 (重なり多) では 0.4 程度を渡して密度を見せる。 */
  fillOpacity?: number
  height?:      number
}) {
  const [hover, setHover] = useState<ScatterPoint | null>(null)

  // X / Y どちらか null は描画対象外
  const drawable = useMemo(() => points.filter(p => p.x !== null && p.y !== null), [points])

  // サイズ範囲 (sqrt スケール)。指定なしは ZAxis で一定。
  const zRange: [number, number] = hasSize ? [40, 600] : [120, 120]

  return (
    <div className="chart-hover-area" style={{ position: 'relative' }}>
    <ResponsiveContainer width="100%" height={height}>
      <RScatterChart
        margin={{ top: 4, right: 8, left: 0, bottom: 24 }}
        onMouseLeave={() => setHover(null)}
      >
        <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" />
        <XAxis
          type="number"
          dataKey="x"
          name={xLabel}
          tick={{ fill: 'var(--text)', fontSize: 10 } as object}
          tickFormatter={xIsRate ? (v: number) => `${(v * 100).toFixed(0)}%` : undefined}
          domain={xIsRate ? [0, 1] : ['auto', 'auto']}
          label={{ value: xLabel, position: 'insideBottom', offset: -10, fill: 'var(--text-muted)', fontSize: 11 } as object}
        />
        <YAxis
          type="number"
          dataKey="y"
          name={yLabel}
          tick={{ fill: 'var(--text)', fontSize: 10 } as object}
          width={56}
          tickFormatter={yIsRate ? (v: number) => `${(v * 100).toFixed(0)}%` : undefined}
          domain={yIsRate ? [0, 1] : ['auto', 'auto']}
          label={{ value: yLabel, angle: -90, position: 'insideLeft', offset: 12, fill: 'var(--text-muted)', fontSize: 11, style: { textAnchor: 'middle' } } as object}
        />
        <ZAxis type="number" dataKey="size" range={zRange} />
        <Scatter
          data={drawable}
          onMouseEnter={(p: any) => setHover(p)}
          isAnimationActive={false}
        >
          {drawable.map((p, i) => (
            <Cell key={i} fill={p.color} fillOpacity={fillOpacity} stroke="var(--surface)" strokeWidth={0.5} />
          ))}
        </Scatter>
      </RScatterChart>
    </ResponsiveContainer>
    {hover && (
      <div className="cal-tooltip" style={{ position: 'absolute', right: 12, top: 12, pointerEvents: 'none', minWidth: 160 }}>
        <div className="hover-tt-title">{hover.name}</div>
        {hover.tooltipRows.map((r, i) => (
          <div key={i} className={r.muted ? 'hover-tt-row hover-tt-row--muted' : 'hover-tt-row'}>
            {r.label}: {r.value}
          </div>
        ))}
      </div>
    )}
    </div>
  )
}
