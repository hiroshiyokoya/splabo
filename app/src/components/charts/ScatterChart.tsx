import { useMemo, useRef, useState, type CSSProperties } from 'react'
import {
  ScatterChart as RScatterChart, Scatter, XAxis, YAxis, ZAxis, CartesianGrid, ReferenceLine, ResponsiveContainer, Cell,
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

/** 目盛りラベルの小数を詰める（浮動小数の誤差も除去）。 */
const fmtTick = (v: number) => String(Math.round(v * 1000) / 1000)

/**
 * ログ軸に載せられる値か (#381)。
 *
 * `log(0)` は定義されず、キルレは `D=0` で無限大になる。**0 以下と非有限は描けない**ので
 * 除外する（現実的にはどちらも試合数が少ないケース）。
 */
export const isLogPlottable = (v: number | null): v is number =>
  v !== null && Number.isFinite(v) && v > 0

/**
 * ログ軸の domain を実データから作る (#381)。
 *
 * 🔴 Recharts の `scale="log"` は **`domain={['auto','auto']}` と併用すると壊れる**ので、
 * 残った点の min/max を明示的に渡す必要がある。
 *
 * 全点が同じ値だと min === max になり軸が潰れるため、**1 桁ぶん広げる**。
 * 値が無ければ null（呼び出し側はログを諦めてリニアに落ちる）。
 *
 * min/max をそのまま渡すと端の点が軸線上に載ってドットが半分切れるため、余白を足す（#385）。
 * ログ軸はログ空間がピクセルに線形対応するので、余白も加算ではなく**乗除**で作る。
 * span に対する割合で広げるので、データの桁数によらず見た目の余白が一定になる。
 */
const LOG_PAD_RATIO = 0.05  // 軸長に対する片側の余白

export function logDomain(values: number[]): [number, number] | null {
  const usable = values.filter(v => Number.isFinite(v) && v > 0)
  if (usable.length === 0) return null
  const min = Math.min(...usable)
  const max = Math.max(...usable)
  if (min === max) return [min / 10, max * 10]
  const pad = (Math.log10(max) - Math.log10(min)) * LOG_PAD_RATIO
  return [min / 10 ** pad, max * 10 ** pad]
}

export function ScatterChart({
  points, xLabel, yLabel, xIsRate, yIsRate, xDomain, yDomain, xRefLine, yRefLine, hasSize, xLogScale, yLogScale, fillOpacity = 0.85, constSize = 120, height = 320,
}: {
  points:       ScatterPoint[]
  xLabel:       string
  yLabel:       string
  xIsRate?:     boolean
  yIsRate?:     boolean
  /** X 軸をログスケールにする (#381)。0 以下・非有限の点は描けないので除外される。 */
  xLogScale?:   boolean
  /** Y 軸をログスケールにする (#381)。 */
  yLogScale?:   boolean
  /** 明示ドメイン [min, max]。指定時は xIsRate の [0,1] 既定より優先（オートスケール用）。 */
  xDomain?:     [number, number]
  yDomain?:     [number, number]
  /** 基準線（例: 勝率 0.5）。指定軸に破線を引く。 */
  xRefLine?:    number
  yRefLine?:    number
  hasSize?:     boolean
  /** ドットの塗り透過度。バトル単位 (重なり多) では 0.4 程度を渡して密度を見せる。 */
  fillOpacity?: number
  /** サイズメトリクス未指定時の一定サイズ。武器/ステージは大きめ (280)、バトルは小さめ (120) を想定。
   *  ZAxis range のピクセル面積。 */
  constSize?:   number
  height?:      number
}) {
  const [hover, setHover] = useState<ScatterPoint | null>(null)
  const areaRef = useRef<HTMLDivElement>(null)

  // X / Y どちらか null は描画対象外
  const plotted = useMemo(() => points.filter(p => p.x !== null && p.y !== null), [points])

  // ログ軸に載る点だけに絞る (#381)。リニアなら plotted と同じ。
  const drawable = useMemo(() => {
    if (!xLogScale && !yLogScale) return plotted
    return plotted.filter(p =>
      (!xLogScale || isLogPlottable(p.x)) && (!yLogScale || isLogPlottable(p.y)),
    )
  }, [plotted, xLogScale, yLogScale])

  // ログ軸で落ちた件数。**黙って消さない**ための注記に使う（切り替えた瞬間に点が減るので、
  // 理由が見えないとバグに見える）。
  const droppedByLog = plotted.length - drawable.length

  // 🔴 Recharts の scale="log" は domain={['auto','auto']} と併用すると壊れるので、
  // 残った点から min/max を作って明示的に渡す。点が全部落ちたらリニアに落とす。
  const xLogDomain = useMemo(
    () => (xLogScale ? logDomain(drawable.map(p => p.x as number)) : null),
    [drawable, xLogScale],
  )
  const yLogDomain = useMemo(
    () => (yLogScale ? logDomain(drawable.map(p => p.y as number)) : null),
    [drawable, yLogScale],
  )
  const xLog = xLogDomain !== null
  const yLog = yLogDomain !== null

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

  // サイズ範囲 (sqrt スケール)。指定なしは ZAxis で一定サイズ。
  const zRange: [number, number] = hasSize ? [40, 600] : [constSize, constSize]

  return (
    <div className="chart-hover-area" ref={areaRef} style={{ position: 'relative' }}>
    <ResponsiveContainer width="100%" height={height}>
      <RScatterChart
        margin={{ top: 4, right: 8, left: 0, bottom: 24 }}
        onMouseLeave={() => setHover(null)}
      >
        <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" />
        {/* ログ軸では 0 以下の基準線は載らない（extendDomain で軸ごと壊れるため出さない）。 */}
        {xRefLine != null && (!xLog || xRefLine > 0) && (
          <ReferenceLine x={xRefLine} stroke="var(--text-muted)" strokeDasharray="5 4" ifOverflow="extendDomain" />
        )}
        {yRefLine != null && (!yLog || yRefLine > 0) && (
          <ReferenceLine y={yRefLine} stroke="var(--text-muted)" strokeDasharray="5 4" ifOverflow="extendDomain" />
        )}
        <XAxis
          type="number"
          dataKey="x"
          name={xLabel}
          tick={{ fill: 'var(--text)', fontSize: 10, fontWeight: 600 } as object}
          tickFormatter={xIsRate ? (v: number) => `${(v * 100).toFixed(0)}%` : fmtTick}
          scale={xLog ? 'log' : 'auto'}
          allowDataOverflow={xLog}
          domain={xLogDomain ?? xDomain ?? (xIsRate ? [0, 1] : ['auto', 'auto'])}
          label={{ value: xLabel, position: 'insideBottom', offset: -10, fill: 'var(--text)', fontSize: 11, fontWeight: 600 } as object}
        />
        <YAxis
          type="number"
          dataKey="y"
          name={yLabel}
          tick={{ fill: 'var(--text)', fontSize: 10, fontWeight: 600 } as object}
          width={56}
          tickFormatter={yIsRate ? (v: number) => `${(v * 100).toFixed(0)}%` : fmtTick}
          scale={yLog ? 'log' : 'auto'}
          allowDataOverflow={yLog}
          domain={yLogDomain ?? yDomain ?? (yIsRate ? [0, 1] : ['auto', 'auto'])}
          label={{ value: yLabel, angle: -90, position: 'insideLeft', offset: 12, fill: 'var(--text)', fontSize: 11, fontWeight: 600, style: { textAnchor: 'middle' } } as object}
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
    {droppedByLog > 0 && (
      <div
        style={{
          fontSize: 10,
          color: 'var(--text-muted)',
          textAlign: 'right',
          marginTop: -18,
          paddingRight: 8,
          pointerEvents: 'none',
        }}
      >
        {droppedByLog} 件を非表示（ログ軸に載らない 0 以下・∞）
      </div>
    )}
    {hover && (() => {
      // ホバー中のドット座標 (cx, cy) 付近にツールチップを出す。
      // 端に近いときは内側へ反転させてはみ出しを防ぐ。
      const hx = (hover as unknown as { cx?: number }).cx ?? 0
      const hy = (hover as unknown as { cy?: number }).cy ?? 0
      const w = areaRef.current?.clientWidth ?? 0
      const h = areaRef.current?.clientHeight ?? height
      const flipX = w > 0 && hx > w * 0.6
      const flipY = h > 0 && hy > h * 0.6
      const tipStyle: CSSProperties = {
        position: 'absolute',
        left: hx,
        top: hy,
        transform: `translate(${flipX ? 'calc(-100% - 14px)' : '14px'}, ${flipY ? 'calc(-100% - 10px)' : '10px'})`,
        pointerEvents: 'none',
        minWidth: 160,
        maxWidth: 280,
        zIndex: 5,
      }
      return (
      <div className="cal-tooltip" style={tipStyle}>
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
      )
    })()}
    </div>
  )
}
