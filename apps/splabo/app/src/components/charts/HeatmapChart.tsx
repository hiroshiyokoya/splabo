import { useMemo, useState } from 'react'
import type { GroupedStatsRow2D, MetricKey } from '../../types'
import { METRIC_LABELS, getMetric2D, formatMetric, metricGroup } from '../../types'

/**
 * 2 軸ヒートマップ。X 軸・Y 軸ともにカテゴリ系（武器・ステージ・モード・ルール・サブ・SP）。
 *
 * - セル色: メトリクスのグループで自動切替
 *   - count   → 相対 5 段階
 *   - rate    → 固定 0–100% divergent
 *   - average → 相対 min-max 5 段階
 * - サンプル不足 (率・平均で N 未満) はグレーアウト
 * - 0 サンプルセルは薄いグレー
 * - X / Y の表示順は バトル数合計の多い順
 */

const CELL_W  = 32
const CELL_H  = 24
const GAP     = 1
const PAD_LEFT_BASE = 110  // Y 軸 tick ラベルスペース
const PAD_TOP_BASE  = 80   // X 軸 tick ラベルスペース
const TITLE_PAD     = 22   // 軸タイトル（xTitle / yTitle）がある場合の追加スペース

function cellColor(value: number | null, group: ReturnType<typeof metricGroup>, min: number, max: number, total: number, minSampleSize: number): string {
  if (value === null || total === 0) return 'var(--cell-empty)'
  if ((group === 'rate' || group === 'average') && total < minSampleSize) {
    return 'var(--cell-sparse)'
  }
  if (group === 'count') {
    if (max <= 0) return 'var(--cell-empty)'
    const t = value / max
    if (t <= 0.2) return 'var(--cell-c1)'
    if (t <= 0.4) return 'var(--cell-c2)'
    if (t <= 0.6) return 'var(--cell-c3)'
    if (t <= 0.8) return 'var(--cell-c4)'
    return 'var(--cell-c5)'
  }
  if (group === 'rate') {
    const t = (value - 0.5) * 2
    if (t < -0.4) return 'var(--cell-r1)'
    if (t < -0.1) return 'var(--cell-r2)'
    if (t <=  0.1) return 'var(--cell-r3)'
    if (t <=  0.4) return 'var(--cell-r4)'
    return 'var(--cell-r5)'
  }
  // average
  if (max <= min) return 'var(--cell-c3)'
  const t = (value - min) / (max - min)
  if (t <= 0.2) return 'var(--cell-c1)'
  if (t <= 0.4) return 'var(--cell-c2)'
  if (t <= 0.6) return 'var(--cell-c3)'
  if (t <= 0.8) return 'var(--cell-c4)'
  return 'var(--cell-c5)'
}

export function HeatmapChart({
  data, metric, xLabelTransform, yLabelTransform, minSampleSize = 5,
  xNumeric = false, yNumeric = false, xTitle, yTitle,
}: {
  data:             GroupedStatsRow2D[]
  metric:           MetricKey
  xLabelTransform?: (s: string) => string
  yLabelTransform?: (s: string) => string
  minSampleSize?:   number
  /** X 軸が数値メトリクス bin の場合 true（並び順を数値昇順にする、#134）。 */
  xNumeric?:        boolean
  yNumeric?:        boolean
  /** X 軸タイトル（軸ラベルの上に表示）。#145 */
  xTitle?:          string
  yTitle?:          string
}) {
  // 軸タイトルがある場合は、tick ラベルスペースに追加で TITLE_PAD ぶん確保する。
  const PAD_LEFT = PAD_LEFT_BASE + (yTitle ? TITLE_PAD : 0)
  const PAD_TOP  = PAD_TOP_BASE  + (xTitle ? TITLE_PAD : 0)
  // ツールチップ位置はマウスの clientX / clientY (viewport 基準)。
  // チャート枠 (overflow:auto) の外にも飛び出せるように position: fixed で描く。
  const [hover, setHover] = useState<{
    mx: number; my: number; xKey: string; yKey: string; value: number | null; total: number
  } | null>(null)

  const group = metricGroup(metric)

  // useMemo の依存に xNumeric/yNumeric も含める。
  const { xKeys, yKeys, cells, nameMap, minVal, maxVal } = useMemo(() => {
    // X / Y の存在キーを「バトル数合計が多い順」で抽出
    const xTotals = new Map<string, number>()
    const yTotals = new Map<string, number>()
    const cellMap = new Map<string, GroupedStatsRow2D>()
    const nameMap = new Map<string, string>()  // key → display name

    for (const row of data) {
      xTotals.set(row.key_x, (xTotals.get(row.key_x) ?? 0) + row.total)
      yTotals.set(row.key_y, (yTotals.get(row.key_y) ?? 0) + row.total)
      cellMap.set(`${row.key_x}|${row.key_y}`, row)
      nameMap.set(row.key_x, row.name_x ?? row.key_x)
      nameMap.set(row.key_y, row.name_y ?? row.key_y)
    }

    // 数値軸（#134）は bin 値の数値昇順、それ以外はバトル数の多い順。
    const xKeys = xNumeric
      ? Array.from(xTotals.keys()).sort((a, b) => Number(a) - Number(b))
      : Array.from(xTotals.entries()).sort((a, b) => b[1] - a[1]).map(e => e[0])
    const yKeys = yNumeric
      ? Array.from(yTotals.keys()).sort((a, b) => Number(a) - Number(b))
      : Array.from(yTotals.entries()).sort((a, b) => b[1] - a[1]).map(e => e[0])

    let mn = Number.POSITIVE_INFINITY
    let mx = Number.NEGATIVE_INFINITY
    for (const row of data) {
      const v = getMetric2D(row, metric)
      if (v === null) continue
      // 率・平均ではサンプル不足を min/max 算出から除外
      if ((group === 'rate' || group === 'average') && row.total < minSampleSize) continue
      if (v < mn) mn = v
      if (v > mx) mx = v
    }

    return {
      xKeys, yKeys,
      cells: cellMap,
      nameMap,
      minVal: mn === Number.POSITIVE_INFINITY ? 0 : mn,
      maxVal: mx === Number.NEGATIVE_INFINITY ? 0 : mx,
    }
  }, [data, metric, group, minSampleSize, xNumeric, yNumeric])

  const GRID_H = yKeys.length * (CELL_H + GAP)
  const width  = Math.max(PAD_LEFT + xKeys.length * (CELL_W + GAP) + 8, 360)
  const height = PAD_TOP + GRID_H + 8

  /** カラーバー（凡例）用の色順・ラベル */
  const LEGEND_COUNT  = ['var(--cell-c1)', 'var(--cell-c2)', 'var(--cell-c3)', 'var(--cell-c4)', 'var(--cell-c5)']
  const LEGEND_RATE   = ['var(--cell-r1)', 'var(--cell-r2)', 'var(--cell-r3)', 'var(--cell-r4)', 'var(--cell-r5)']
  const legendColors = group === 'rate' ? LEGEND_RATE : LEGEND_COUNT
  const fmtLegend = (v: number): string => {
    if (metric === 'win_rate') return `${Math.round(v * 100)}%`
    if (metric === 'avg_duration') return `${Math.round(v)}s`
    if (metric === 'total' || metric === 'wins') return Math.round(v).toString()
    return v.toFixed(1)
  }
  const legendLeft  = group === 'rate' ? '0%'  : group === 'count' ? '0' : fmtLegend(minVal)
  const legendMid   = group === 'rate' ? '50%' : null
  const legendRight = group === 'rate' ? '100%' : fmtLegend(maxVal)

  // 表示ラベル: nameMap (BE が返す display name) を引いてから、必要ならカテゴリ別に整形。
  function xLabel(k: string): string {
    const display = nameMap.get(k) ?? k
    return xLabelTransform ? xLabelTransform(display) : display
  }
  function yLabel(k: string): string {
    const display = nameMap.get(k) ?? k
    return yLabelTransform ? yLabelTransform(display) : display
  }

  return (
    <div className="chart-hover-area" style={{ position: 'relative', overflow: 'auto' }}>
      <svg width={width} height={height} role="img" aria-label="ヒートマップ">
        {/* 軸タイトル（#145）。tick ラベルの上 / 左に表示。 */}
        {xTitle && (
          <text
            x={PAD_LEFT + (xKeys.length * (CELL_W + GAP)) / 2}
            y={14}
            fontSize={12}
            fontWeight={600}
            fill="var(--text)"
            textAnchor="middle"
          >{xTitle}</text>
        )}
        {yTitle && (() => {
          const cy = PAD_TOP + GRID_H / 2
          return (
            <text
              x={14}
              y={cy}
              fontSize={12}
              fontWeight={600}
              fill="var(--text)"
              textAnchor="middle"
              transform={`rotate(-90 14 ${cy})`}
            >{yTitle}</text>
          )
        })()}
        {/* X 軸ラベル（上に斜め配置） */}
        {xKeys.map((k, i) => {
          const x = PAD_LEFT + i * (CELL_W + GAP) + CELL_W / 2
          return (
            <text
              key={`x-${k}`}
              x={x}
              y={PAD_TOP - 6}
              fontSize={10}
              fontWeight={600}
              fill="var(--text)"
              textAnchor="start"
              transform={`rotate(-35 ${x} ${PAD_TOP - 6})`}
            >{xLabel(k)}</text>
          )
        })}
        {/* Y 軸ラベル（左） */}
        {yKeys.map((k, i) => (
          <text
            key={`y-${k}`}
            x={PAD_LEFT - 6}
            y={PAD_TOP + i * (CELL_H + GAP) + CELL_H * 0.7}
            fontSize={10}
            fontWeight={600}
            fill="var(--text)"
            textAnchor="end"
          >{yLabel(k)}</text>
        ))}
        {/* セル */}
        {yKeys.map((yk, yi) =>
          xKeys.map((xk, xi) => {
            const row = cells.get(`${xk}|${yk}`)
            const v = row ? getMetric2D(row, metric) : null
            const total = row?.total ?? 0
            const fill = cellColor(v, group, minVal, maxVal, total, minSampleSize)
            const x = PAD_LEFT + xi * (CELL_W + GAP)
            const y = PAD_TOP  + yi * (CELL_H + GAP)
            return (
              <rect
                key={`${xk}|${yk}`}
                x={x}
                y={y}
                width={CELL_W}
                height={CELL_H}
                rx={2}
                fill={fill}
                stroke="var(--surface)"
                strokeWidth={0.5}
                onMouseEnter={(e) => setHover({ mx: e.clientX, my: e.clientY, xKey: xk, yKey: yk, value: v, total })}
                onMouseMove={(e) => setHover(prev => prev ? { ...prev, mx: e.clientX, my: e.clientY } : prev)}
                onMouseLeave={() => setHover(null)}
              />
            )
          })
        )}
      </svg>
      {/* カラーバー (凡例) を SVG の下に HTML として配置 */}
      <div className="cal-legend">
        <span className="cal-legend-label">{METRIC_LABELS[metric]}</span>
        <span className="cal-legend-end">{legendLeft}</span>
        <span className="cal-legend-bar">
          {legendColors.map((c, i) => (
            <span key={i} className="cal-legend-swatch" style={{ background: c }} />
          ))}
        </span>
        {legendMid && <span className="cal-legend-mid">{legendMid}</span>}
        <span className="cal-legend-end">{legendRight}</span>
        {(group === 'rate' || group === 'average') && (
          <span className="cal-legend-sparse">
            <span className="cal-legend-swatch cal-legend-swatch--sparse" />
            <span className="cal-legend-sparse-text">サンプル不足</span>
          </span>
        )}
      </div>
      {hover && (
        <div
          className="cal-tooltip"
          style={{
            position: 'fixed',
            left:     Math.min(hover.mx + 14, window.innerWidth  - 220),
            top:      Math.min(hover.my + 14, window.innerHeight - 100),
            pointerEvents: 'none',
            zIndex: 1000,
          }}
        >
          <div className="hover-tt-title">{xLabel(hover.xKey)} × {yLabel(hover.yKey)}</div>
          <div className="hover-tt-row">{METRIC_LABELS[metric]}: {formatMetric(hover.value, metric)}</div>
          <div className="hover-tt-row hover-tt-row--muted">バトル数: {hover.total}</div>
          {(group === 'rate' || group === 'average') && hover.value !== null && hover.total < minSampleSize && (
            <div className="hover-tt-row hover-tt-row--muted">サンプル不足 (&lt; {minSampleSize})</div>
          )}
        </div>
      )}
    </div>
  )
}
