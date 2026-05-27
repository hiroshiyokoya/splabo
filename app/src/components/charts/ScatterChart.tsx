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
  /** 重なり判定用キー。同じ groupKey の点はツールチップで一緒に並べて表示する。
   *  バトル単位なら整数化された (x, y) 等、カテゴリ単位なら省略 (グループ化しない)。 */
  groupKey?:   string
  /** ツールチップ内で 1 行に詰める「個別ラベル」 (例: 日付 / 武器 / 勝敗)。
   *  groupKey で複数点まとまったとき、各点の name 部分として並ぶ。 */
  rowText?:    string
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

  // groupKey → siblings: 重なり判定用に同一 groupKey の点を集約
  const siblings = useMemo(() => {
    const m = new Map<string, ScatterPoint[]>()
    for (const p of drawable) {
      if (!p.groupKey) continue
      const arr = m.get(p.groupKey) ?? []
      arr.push(p)
      m.set(p.groupKey, arr)
    }
    return m
  }, [drawable])

  const hoverSiblings = hover?.groupKey ? (siblings.get(hover.groupKey) ?? [hover]) : (hover ? [hover] : [])
  const ROW_LIMIT = 12

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
      <div className="cal-tooltip" style={{ position: 'absolute', right: 12, top: 12, pointerEvents: 'none', minWidth: 180, maxWidth: 280 }}>
        {hoverSiblings.length > 1 ? (
          <>
            {/* 重なってる全件: 共通の x/y 等を 1 回 + 各点の rowText を並べる */}
            <div className="hover-tt-title">{hover.tooltipRows.slice(0, 2).map(r => `${r.label} ${r.value}`).join(' / ')} <span className="hover-tt-row--muted">({hoverSiblings.length} 件)</span></div>
            {hoverSiblings.slice(0, ROW_LIMIT).map((p, i) => (
              <div key={i} className="hover-tt-row hover-tt-row--muted">{p.rowText ?? p.name}</div>
            ))}
            {hoverSiblings.length > ROW_LIMIT && (
              <div className="hover-tt-row hover-tt-row--muted">他 {hoverSiblings.length - ROW_LIMIT} 件</div>
            )}
          </>
        ) : (
          <>
            <div className="hover-tt-title">{hover.name}</div>
            {hover.tooltipRows.map((r, i) => (
              <div key={i} className={r.muted ? 'hover-tt-row hover-tt-row--muted' : 'hover-tt-row'}>
                {r.label}: {r.value}
              </div>
            ))}
          </>
        )}
      </div>
    )}
    </div>
  )
}
