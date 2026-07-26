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
  /** カテゴリ色分け時のマーカー形（未指定は circle）。 */
  markerShape?: ScatterMarkerShape
  /** ツールチップ見出しの左に出すアイコン（#412）。`color` と同じく **呼び出し側で解決済み**の
   *  data URI を渡す。画像が無ければ省略（アイコンなしで名前だけ出す）。
   *  ここで画像を取りに行かないのは、ホバーのたびに invoke を飛ばさないため。 */
  iconUrl?:    string | null
  tooltipRows: { label: string; value: string; muted?: boolean }[]
  /** 重なり判定用キー。同じ groupKey の点はツールチップで一緒に並べて表示する。
   *  バトル単位なら整数化された (x, y) 等、カテゴリ単位なら省略 (グループ化しない)。 */
  groupKey?:   string
  /** ツールチップ内で 1 行に詰める「個別ラベル」 (例: 日付 / 武器 / 勝敗)。
   *  groupKey で複数点まとまったとき、各点の name 部分として並ぶ。 */
  rowText?:    string
}

/** 散布図カテゴリの第2軸（色と組み合わせて使う）。 */
export type ScatterMarkerShape =
  | 'circle'
  | 'square'
  | 'triangle'
  | 'diamond'
  | 'cross'
  | 'star'

export type SizeLegend  = { label: string; items: { label: string; area: number }[] }
export type ColorLegend = {
  label: string
  items: { label: string | null; color: string; shape?: ScatterMarkerShape }[]
  /** 連続値グラデーション（既定）か、カテゴリチップ列か。 */
  layout?: 'gradient' | 'chips'
  /** chips のとき「色」だけか「色・形」か。凡例タイトルに使う。 */
  encoding?: 'color' | 'color_shape'
}

/** 半径 r のマーカー SVG（チャート本体・凡例で共有）。 */
export function ScatterMarkerGlyph({
  shape = 'circle',
  color,
  size = 12,
  fillOpacity = 0.85,
  stroke = 'var(--surface)',
  strokeWidth = 0.5,
  className,
}: {
  shape?:       ScatterMarkerShape
  color:        string
  /** 外接円の直径（px）。 */
  size?:        number
  fillOpacity?: number
  stroke?:      string
  strokeWidth?: number
  className?:   string
}) {
  const r = size / 2
  const cx = r
  const cy = r
  const common = { fill: color, fillOpacity, stroke, strokeWidth }
  return (
    <svg
      className={className}
      width={size}
      height={size}
      viewBox={`0 0 ${size} ${size}`}
      aria-hidden
      style={{ display: 'block', flexShrink: 0 }}
    >
      {markerElement(shape, cx, cy, r * 0.92, common)}
    </svg>
  )
}

function markerElement(
  shape: ScatterMarkerShape,
  cx: number,
  cy: number,
  r: number,
  common: { fill: string; fillOpacity: number; stroke: string; strokeWidth: number },
) {
  switch (shape) {
    case 'square': {
      const s = r * 1.55
      return <rect x={cx - s / 2} y={cy - s / 2} width={s} height={s} {...common} />
    }
    case 'triangle': {
      const h = r * 1.85
      const w = r * 1.95
      return (
        <polygon
          points={`${cx},${cy - h * 0.62} ${cx - w * 0.55},${cy + h * 0.42} ${cx + w * 0.55},${cy + h * 0.42}`}
          {...common}
        />
      )
    }
    case 'diamond': {
      const s = r * 1.25
      return (
        <polygon
          points={`${cx},${cy - s} ${cx + s},${cy} ${cx},${cy + s} ${cx - s},${cy}`}
          {...common}
        />
      )
    }
    case 'cross': {
      const arm = r * 1.15
      const t = Math.max(r * 0.38, 1.2)
      return (
        <path
          d={`M ${cx - t} ${cy - arm} H ${cx + t} V ${cy - t} H ${cx + arm} V ${cy + t} H ${cx + t} V ${cy + arm} H ${cx - t} V ${cy + t} H ${cx - arm} V ${cy - t} H ${cx - t} Z`}
          {...common}
        />
      )
    }
    case 'star': {
      const pts: string[] = []
      for (let i = 0; i < 5; i++) {
        const a = -Math.PI / 2 + (i * 2 * Math.PI) / 5
        const a2 = a + Math.PI / 5
        pts.push(`${cx + Math.cos(a) * r * 1.25},${cy + Math.sin(a) * r * 1.25}`)
        pts.push(`${cx + Math.cos(a2) * r * 0.52},${cy + Math.sin(a2) * r * 0.52}`)
      }
      return <polygon points={pts.join(' ')} {...common} />
    }
    case 'circle':
    default:
      return <circle cx={cx} cy={cy} r={r} {...common} />
  }
}

/** Recharts Scatter の shape コールバック。payload.markerShape を読む。 */
function scatterPointShape(props: {
  cx?: number
  cy?: number
  size?: number
  fill?: string
  fillOpacity?: number
  stroke?: string
  strokeWidth?: number
  payload?: ScatterPoint
}) {
  const cx = props.cx ?? 0
  const cy = props.cy ?? 0
  const area = props.size ?? 120
  const r = Math.sqrt(Math.max(area, 0) / Math.PI)
  const shape = props.payload?.markerShape ?? 'circle'
  const common = {
    fill: props.fill ?? props.payload?.color ?? 'var(--accent)',
    fillOpacity: props.fillOpacity ?? 0.55,
    stroke: props.stroke ?? 'var(--surface)',
    strokeWidth: props.strokeWidth ?? 0.5,
  }
  // g で包んで Recharts のヒット領域を保つ
  return <g>{markerElement(shape, cx, cy, r, common)}</g>
}

/** 目盛りラベルの小数を詰める（浮動小数の誤差も除去）。 */
const fmtTick = (v: number) => String(Math.round(v * 1000) / 1000)

/**
 * 比率（0–1）軸の目盛りラベル (#473)。
 *
 * ログ軸では 0.001 / 0.002 / 0.005 のような細かい目盛りが並ぶ。小数 0 桁固定だと
 * 全部 `0%` になって軸が読めないので、1% 未満は値に応じて桁を足す。
 */
const fmtRateTick = (v: number) => {
  const pct = v * 100
  if (!isFinite(pct) || pct === 0) return '0%'
  // 0.5% → 1 桁、0.05% → 2 桁。1e-9 は log10 の丸め誤差で 1 桁増えるのを防ぐため。
  const digits = Math.abs(pct) >= 1 ? 0 : Math.min(4, Math.ceil(-Math.log10(Math.abs(pct)) - 1e-9))
  return `${pct.toFixed(digits)}%`
}

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

/** ログ軸の目盛り候補。各桁に 1・2・5 を置く（1,2,5,10,20,50,100…）。 */
const LOG_MANTISSAS = [1, 2, 5]

/**
 * ログ軸の目盛りを「切りのいい値」で作る (#387)。
 *
 * Recharts の自動生成は domain を等分するので半端な値になる。桁ごとに 1/2/5 を置いて
 * 人が読める並びにする。レンジが広いと本数が増えすぎるため、収まらなければ
 * 「10 の冪のみ」→「2 桁ごと」→「3 桁ごと」と順に粗くする。
 *
 * 切りのいい値が 2 本未満しか入らない狭いレンジでは null を返し、Recharts に任せる。
 */
export function logTicks(domain: [number, number], maxTicks = 10): number[] | null {
  const [lo, hi] = domain
  if (!(lo > 0) || !(hi > lo)) return null

  const build = (mantissas: number[], expStep: number): number[] => {
    const out: number[] = []
    const startExp = Math.floor(Math.log10(lo))
    const endExp = Math.ceil(Math.log10(hi))
    for (let e = startExp; e <= endExp; e += expStep) {
      for (const m of mantissas) {
        const v = m * 10 ** e
        if (v >= lo && v <= hi) out.push(v)
      }
    }
    return out
  }

  // 細かい順に候補を並べ、maxTicks に収まる最初のものを採る。
  const usable = [build(LOG_MANTISSAS, 1), build([1], 1), build([1], 2), build([1], 3)]
    .filter(t => t.length >= 2)
  if (usable.length === 0) return null
  return usable.find(t => t.length <= maxTicks) ?? usable[usable.length - 1]
}

// ---------------------------------------------------------------------------
// 凡例（#420）
// ---------------------------------------------------------------------------
//
// サイズ・色にメトリクスを割り当てられる（#406）が、凡例が無いと「大きい＝何が多いのか」
// が画面から読めない。ホバーすればチップに出るが、全体を眺めているときに分からない。
//
// 凡例の中身（ラベル・値・色・面積）は **呼び出し側が組み立てて渡す**。環境分析と
// ダッシュボードで色スケールの作り方が違う（pointColor と colorOfValue）ため、
// それぞれの関数をそのまま使えるほうが破綻しない。

/** サイズ指標が割り当てられているときのドット面積レンジ（px²）。
 *
 *  🔴 凡例の円と実際のドットを一致させるため、ZAxis に渡す range と凡例の面積計算は
 *  **必ずこの定数を共有する**。片方だけ変えると凡例が嘘になる。 */
export const SIZE_AREA_RANGE: [number, number] = [40, 600]

/** 有限な値だけの min/max。値が無いときは null。 */
function finiteRange(values: (number | null | undefined)[]): { min: number; max: number } | null {
  let mn = Infinity, mx = -Infinity
  for (const v of values) {
    if (v == null || !isFinite(v)) continue
    if (v < mn) mn = v
    if (v > mx) mx = v
  }
  return isFinite(mn) ? { min: mn, max: mx } : null
}

/**
 * 値 → ドットの面積（px²）。
 *
 * 🔴 Recharts の ZAxis のドメインは **[0, データ最大]** であって [最小, 最大] ではない。
 * `<ZAxis>` に domain を渡さないと `implicitZAxis.domain = [0, 'auto']` が効くため。
 * 実測で確認済み: range=[40,600]・データ [10,30,55,100] のとき、値 30 のドットは
 * 直径 16.27px = 面積 208 = 40 + (30/100)×560。[最小,最大] で正規化すると
 * 最小値のドットが 7.1px のはずが実際は 11.1px で、凡例が嘘になる。
 */
function valueToArea(v: number, max: number): number {
  const [aMin, aMax] = SIZE_AREA_RANGE
  const t = Math.min(1, Math.max(0, v / max))
  return aMin + (aMax - aMin) * t
}

/**
 * サイズ凡例を作る。データの 最小 / 中間 / 最大 を並べる。
 *
 * Recharts は面積を `radius = sqrt(面積 / π)` で描く（recharts/es6/cartesian/Scatter.js）。
 * 凡例の円も同じ式で描くので実際のドットと一致する。
 */
export function buildSizeLegend(
  label: string, values: (number | null)[], fmt: (v: number) => string, steps = 3,
): SizeLegend | null {
  const r = finiteRange(values)
  // max <= 0 だと面積の比率が作れない（実データでは件数・平均値なので起きない）。
  if (!r || r.max <= 0) return null
  // 全部同じ値ならドットの大小が無いので 1 つだけ出す（段を並べても全部同じ大きさになる）。
  const vals = r.max > r.min
    ? Array.from({ length: steps }, (_, i) => r.min + (r.max - r.min) * (i / (steps - 1)))
    : [r.max]
  return { label, items: vals.map(v => ({ label: fmt(v), area: valueToArea(v, r.max) })) }
}

/** 面積（px²）→ 半径。Recharts のドットと同じ式。 */
export function areaToRadius(area: number): number {
  return Math.sqrt(Math.max(area, 0) / Math.PI)
}

/**
 * 色凡例を作る。`colorOf` は **本体のドットと同じ関数**を渡すこと（色がズレないため）。
 * 値のラベルは両端と中央だけに付ける（全段に付けると数字が潰れて読めない）。
 */
export function buildColorLegend(
  label: string, values: (number | null)[], fmt: (v: number) => string,
  colorOf: (v: number) => string, steps = 7,
): ColorLegend | null {
  const r = finiteRange(values)
  // 幅が無いと全ドットが同じ色なので、帯にして説明することが無い。
  if (!r || r.max <= r.min) return null
  const mid = Math.floor(steps / 2)
  const items = Array.from({ length: steps }, (_, i) => {
    const v = r.min + (r.max - r.min) * (i / (steps - 1))
    const showLabel = i === 0 || i === steps - 1 || i === mid
    return { label: showLabel ? fmt(v) : null, color: colorOf(v) }
  })
  return { label, items }
}

function ScatterLegends({ sizeLegend, colorLegend }: { sizeLegend?: SizeLegend | null; colorLegend?: ColorLegend | null }) {
  if (!sizeLegend && !colorLegend) return null
  // 一番大きい円に合わせて行の高さを取る（円が上下で切れないように）。
  const maxR = sizeLegend ? areaToRadius(Math.max(...sizeLegend.items.map(i => i.area))) : 0
  // サイズ凡例の円の色。色にもメトリクスを割り当てているときは実際のドットが
  // そのスケールの色になるので、accent のままだと凡例だけ違う色で浮く。
  // 色凡例の**中央のスウォッチ**を借りれば、常に実際のドットと同じパレットになる。
  const dotColor = colorLegend
    ? colorLegend.items[Math.floor(colorLegend.items.length / 2)].color
    : 'var(--accent)'
  return (
    <div className="scatter-legend">
      {sizeLegend && (
        <div className="scatter-legend-group">
          <span className="scatter-legend-title">サイズ: {sizeLegend.label}</span>
          <span className="scatter-legend-items" style={{ minHeight: maxR * 2 }}>
            {sizeLegend.items.map((it, i) => (
              <span className="scatter-legend-size" key={i}>
                <span
                  className="scatter-legend-dot"
                  style={{ width: areaToRadius(it.area) * 2, height: areaToRadius(it.area) * 2, background: dotColor }}
                />
                <span className="scatter-legend-value">{it.label}</span>
              </span>
            ))}
          </span>
        </div>
      )}
      {colorLegend && (
        <div className="scatter-legend-group">
          <span className="scatter-legend-title">
            {colorLegend.encoding === 'color_shape' ? '色・形' : '色'}: {colorLegend.label}
          </span>
          <span className="scatter-legend-items">
            {colorLegend.layout === 'chips' ? (
              <span className="scatter-legend-chips">
                {colorLegend.items.map((it, i) => (
                  <span className="scatter-legend-chip-item" key={i} title={it.label ?? undefined}>
                    {colorLegend.encoding === 'color_shape' ? (
                      <ScatterMarkerGlyph
                        shape={it.shape ?? 'circle'}
                        color={it.color}
                        size={12}
                        className="scatter-legend-marker"
                      />
                    ) : (
                      <span className="scatter-legend-chip" style={{ background: it.color }} />
                    )}
                    <span className="scatter-legend-value">{it.label ?? ' '}</span>
                  </span>
                ))}
              </span>
            ) : (
              <span className="scatter-legend-bar">
                {colorLegend.items.map((it, i) => (
                  <span className="scatter-legend-band" key={i}>
                    <span className="scatter-legend-chip" style={{ background: it.color }} />
                    <span className="scatter-legend-value">{it.label ?? ' '}</span>
                  </span>
                ))}
              </span>
            )}
          </span>
        </div>
      )}
    </div>
  )
}

export function ScatterChart({
  points, xLabel, yLabel, xIsRate, yIsRate, xDomain, yDomain, xRefLine, yRefLine, hasSize, xLogScale, yLogScale, fillOpacity = 0.55, constSize = 120, height = 320,
  sizeLegend, colorLegend,
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
  /** ドットの塗り透過度。未指定時は環境分析・ダッシュボードと同じ 0.55（#435）。 */
  fillOpacity?: number
  /** サイズメトリクス未指定時の一定サイズ。武器/ステージは大きめ (280)、バトルは小さめ (120) を想定。
   *  ZAxis range のピクセル面積。 */
  constSize?:   number
  height?:      number
  /** ドットのサイズ・色が何を表しているかの凡例（#420）。buildSizeLegend / buildColorLegend で作る。
   *  未指定（サイズ・色にメトリクスを割り当てていない）なら出さない。 */
  sizeLegend?:  SizeLegend | null
  colorLegend?: ColorLegend | null
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
  // ログ軸の目盛りは 1/2/5 系列で明示する（#387）。Recharts 任せだと domain を等分した
  // 半端な値になる。null のときは従来どおり Recharts に任せる。
  const xTicks = useMemo(() => (xLogDomain ? logTicks(xLogDomain) : null), [xLogDomain])
  const yTicks = useMemo(() => (yLogDomain ? logTicks(yLogDomain) : null), [yLogDomain])
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
  // 🔴 凡例と同じ定数を使う（SIZE_AREA_RANGE のコメント参照）。
  const zRange: [number, number] = hasSize ? SIZE_AREA_RANGE : [constSize, constSize]

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
          tickFormatter={xIsRate ? fmtRateTick : fmtTick}
          scale={xLog ? 'log' : 'auto'}
          allowDataOverflow={xLog}
          domain={xLogDomain ?? xDomain ?? (xIsRate ? [0, 1] : ['auto', 'auto'])}
          ticks={xTicks ?? undefined}
          label={{ value: xLabel, position: 'insideBottom', offset: -10, fill: 'var(--text)', fontSize: 11, fontWeight: 600 } as object}
        />
        <YAxis
          type="number"
          dataKey="y"
          name={yLabel}
          tick={{ fill: 'var(--text)', fontSize: 10, fontWeight: 600 } as object}
          width={56}
          tickFormatter={yIsRate ? fmtRateTick : fmtTick}
          scale={yLog ? 'log' : 'auto'}
          allowDataOverflow={yLog}
          domain={yLogDomain ?? yDomain ?? (yIsRate ? [0, 1] : ['auto', 'auto'])}
          ticks={yTicks ?? undefined}
          label={{ value: yLabel, angle: -90, position: 'insideLeft', offset: 12, fill: 'var(--text)', fontSize: 11, fontWeight: 600, style: { textAnchor: 'middle' } } as object}
        />
        <ZAxis type="number" dataKey="size" range={zRange} />
        <Scatter
          data={drawable}
          shape={scatterPointShape}
          onMouseEnter={(p: any) => setHover(p)}
          isAnimationActive={false}
        >
          {drawable.map((p, i) => (
            <Cell key={i} fill={p.color} fillOpacity={fillOpacity} stroke="var(--surface)" strokeWidth={0.5} />
          ))}
        </Scatter>
      </RScatterChart>
    </ResponsiveContainer>
    <ScatterLegends sizeLegend={sizeLegend} colorLegend={colorLegend} />
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
            <div className="hover-tt-title">
              {hover.iconUrl && <img className="hover-tt-icon" src={hover.iconUrl} alt="" />}
              {hover.name}
            </div>
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
