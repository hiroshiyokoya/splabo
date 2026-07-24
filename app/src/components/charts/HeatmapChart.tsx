import { useId, useMemo, useState } from 'react'
import type { GroupedStatsRow2D, MetricKey } from '../../types'
import { METRIC_LABELS, getMetric2D, formatMetric, metricGroup } from '../../types'
import {
  rateCellColor, RATE_LEGEND_COLORS, sequentialCellColor, seqLegendColors,
  integerRange, SparseHatchPattern, EmptyHatchPattern, hatchFill,
  weightedProjection, sumBy, axisLabelColor, AXIS_MIN_TOTAL_SAMPLES,
} from '../../utils/heatmapColors'

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
 * - X / Y の軸ラベルは、その軸に射影した値でセルと同じ色スケールに従って色付けする
 *   （#409。環境分析の Heatmap.tsx = #405 と揃えた挙動）。射影はその軸の
 *   **全セル**（サンプル不足セルも含む）から算出する。詳細は #411 / heatmapColors。
 */

const CELL_W  = 32
const CELL_H  = 24
const GAP     = 1
const PAD_LEFT_BASE = 110  // Y 軸 tick ラベルスペース
const PAD_TOP_BASE  = 80   // X 軸 tick ラベルスペース
const TITLE_PAD     = 22   // 軸タイトル（xTitle / yTitle）がある場合の追加スペース

// ナワバリ（ルール軸）はバトル数が多く先頭に来がちだが、慣例的に最後に置く
// （EnvAnalysis の RULE_HEATMAP_ORDER と揃える）。キーは FE スラッグ 'turf_war'
// （旧マスターの 'nawabari' も一応拾う）。ルール軸にしか現れないため軸種別は不要。
const NAWABARI_KEYS = new Set(['turf_war', 'nawabari'])
function nawabariLast(keys: string[]): string[] {
  return [
    ...keys.filter(k => !NAWABARI_KEYS.has(k)),
    ...keys.filter(k =>  NAWABARI_KEYS.has(k)),
  ]
}

type Group = ReturnType<typeof metricGroup>

/**
 * 値 → 色スケール上の色（欠損・サンプル不足の判定は含まない）。
 * セル塗りと軸ラベルの文字色で共有し、色スケールを二重定義しない（#409）。
 * 色を決められない（カウント系で max<=0）ときは null。
 */
function scaleColor(value: number, group: Group, min: number, max: number, metric: MetricKey): string | null {
  if (group === 'count') {
    if (max <= 0) return null
    return sequentialCellColor(value / max, metric)
  }
  if (group === 'rate') return rateCellColor(value)
  // average
  if (max <= min) return sequentialCellColor(0.5, metric)
  return sequentialCellColor((value - min) / (max - min), metric)
}

/**
 * 値 → 強度（0=淡い/中立 〜 1=濃い/極）。scaleColor と同じ正規化を使う。
 * 軸ラベルの文字色を「薄すぎるときは既定色に落とす」判定に使う（#409）。
 */
function scaleIntensity(value: number, group: Group, min: number, max: number): number {
  // 勝率は 0–100% 固定の divergent。50% からの隔たりが強度。
  if (group === 'rate') return Math.min(1, Math.abs(value - 0.5) / 0.5)
  if (group === 'count') return max > 0 ? value / max : 0
  return max > min ? (value - min) / (max - min) : 0
}

function cellColor(value: number | null, group: Group, min: number, max: number, total: number, minSampleSize: number, sparseId: string, emptyId: string, metric: MetricKey): string {
  // 値が無いセルは色ではなくハッチで示す（中立グレーの中央と紛れさせないため・#351）。
  // データなしはサンプル不足より強い（詰まった）ハッチ。
  if (value === null || total === 0) return hatchFill(emptyId)
  if ((group === 'rate' || group === 'average') && total < minSampleSize) {
    return hatchFill(sparseId)
  }
  return scaleColor(value, group, min, max, metric) ?? hatchFill(emptyId)
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
  // ハッチ（サンプル不足 / データなし）用。同一ページに複数チャートが載るので id は一意にする（#351）。
  const uid = useId()
  const sparseId = `sparse-${uid}`
  const emptyId  = `empty-${uid}`
  const [hover, setHover] = useState<{
    mx: number; my: number; xKey: string; yKey: string; value: number | null
    total: number; wins: number; draws: number
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
    // カテゴリ軸は最後に nawabariLast でナワバリ（ルール軸のみ該当）を末尾へ寄せる。
    const xKeys = nawabariLast(xNumeric
      ? Array.from(xTotals.keys()).sort((a, b) => Number(a) - Number(b))
      : Array.from(xTotals.entries()).sort((a, b) => b[1] - a[1]).map(e => e[0]))
    const yKeys = nawabariLast(yNumeric
      ? Array.from(yTotals.keys()).sort((a, b) => Number(a) - Number(b))
      : Array.from(yTotals.entries()).sort((a, b) => b[1] - a[1]).map(e => e[0]))

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

    const rawMin = mn === Number.POSITIVE_INFINITY ? 0 : mn
    const rawMax = mx === Number.NEGATIVE_INFINITY ? 0 : mx
    // 勝数・平均系は範囲を整数に丸める（凡例が「3.2 – 7.8」ではなく「3 – 8」に・#351）。
    // 勝率は 0–100% 固定なのでそのまま。
    const r = group === 'rate' ? { min: rawMin, max: rawMax } : integerRange(rawMin, rawMax)

    return {
      xKeys, yKeys,
      cells: cellMap,
      nameMap,
      minVal: r.min,
      maxVal: r.max,
    }
  }, [data, metric, group, minSampleSize, xNumeric, yNumeric])

  // 軸ラベル色付け用の射影値（#409 / #411）。X キー・Y キーごとに、そのキーの
  // **全セル**から算出する。セル単位の足切り（minSampleSize）は射影に掛けない:
  // どのセルが残るかは交差する軸で変わるため、掛けると「ガチエリアの勝率が
  // 武器×ルールとステージ×ルールで違う」ことになる（#411）。
  // 標本不足の軸は、セルではなく「軸の合計バトル数」（AXIS_MIN_TOTAL_SAMPLES）で落とす。
  //  - 率・平均 … サンプル数（バトル数）で加重平均。Σ(値×n)/Σn = Σ勝数/Σ試合数 で交差軸に依存しない。
  //  - カウント … 合計。件数を件数で加重平均しても意味を成さない（#411）。
  const { xProj, yProj, xSamples, ySamples } = useMemo(() => {
    const valueOf = (row: GroupedStatsRow2D): number | null => getMetric2D(row, metric)
    const project = (keyOf: (r: GroupedStatsRow2D) => string) =>
      group === 'count'
        ? sumBy(data, keyOf, valueOf)
        : weightedProjection(data, keyOf, valueOf, r => r.total)
    return {
      xProj:    project(r => r.key_x),
      yProj:    project(r => r.key_y),
      xSamples: sumBy(data, r => r.key_x, r => r.total),
      ySamples: sumBy(data, r => r.key_y, r => r.total),
    }
  }, [data, metric, group])

  /**
   * 軸ラベルの文字色。射影値が無い／軸の合計標本数が足りないキーは既定色（undefined）。
   *
   * カウント系だけは正規化基準がセルと違う（#411）。射影値は「合計」なので必ずセルの
   * 最大値以上になり、セルの max で正規化すると全ラベルが最濃で潰れて差が読めない。
   * その軸の射影値の max を 1 とする軸内の相対スケールにする（ラベル同士の比較として読む）。
   * 率・平均はセルと同じ絶対スケール（勝率は 0–100% 固定・平均はセルの min/max）のまま。
   */
  const labelColor = (proj: Map<string, number>, samples: Map<string, number>) => {
    const axisMin = group === 'count' ? 0 : minVal
    const axisMax = group === 'count' ? Math.max(0, ...proj.values()) : maxVal
    return (key: string): string | undefined => {
      if ((samples.get(key) ?? 0) < AXIS_MIN_TOTAL_SAMPLES) return undefined
      const v = proj.get(key)
      if (v === undefined) return undefined
      const c = scaleColor(v, group, axisMin, axisMax, metric)
      if (c === null) return undefined
      return axisLabelColor(c, scaleIntensity(v, group, axisMin, axisMax))
    }
  }
  const xLabelColor = labelColor(xProj, xSamples)
  const yLabelColor = labelColor(yProj, ySamples)

  const GRID_H = yKeys.length * (CELL_H + GAP)
  const width  = Math.max(PAD_LEFT + xKeys.length * (CELL_W + GAP) + 8, 360)
  const height = PAD_TOP + GRID_H + 8

  /** カラーバー（凡例）用の色順・ラベル */
  const legendColors = group === 'rate' ? RATE_LEGEND_COLORS : seqLegendColors(metric)
  const fmtLegend = (v: number): string => {
    if (metric === 'win_rate') return `${Math.round(v * 100)}%`
    if (metric === 'total' || metric === 'wins') return Math.round(v).toString()
    // 範囲は integerRange で整数化済み
    return Math.round(v).toString()
  }
  // 勝率は 0% / 100% の両端のみ。中央の 50% はバーの右に並んで出てしまい
  // 中央ラベルとして機能していなかったため廃止（#351）。
  const legendLeft  = group === 'rate' ? '0%'  : group === 'count' ? '0' : fmtLegend(minVal)
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
        <defs>
          <SparseHatchPattern id={sparseId} />
          <EmptyHatchPattern id={emptyId} />
        </defs>
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
          const c = xLabelColor(k)
          return (
            <text
              key={`x-${k}`}
              x={x}
              y={PAD_TOP - 6}
              fontSize={10}
              fontWeight={600}
              fill="var(--text)"
              // 射影値がある軸だけ style で上書きする（color-mix を確実に CSS として解釈させる）。
              style={c ? { fill: c } : undefined}
              textAnchor="start"
              transform={`rotate(-35 ${x} ${PAD_TOP - 6})`}
            >{xLabel(k)}</text>
          )
        })}
        {/* Y 軸ラベル（左） */}
        {yKeys.map((k, i) => {
          const c = yLabelColor(k)
          return (
            <text
              key={`y-${k}`}
              x={PAD_LEFT - 6}
              y={PAD_TOP + i * (CELL_H + GAP) + CELL_H * 0.7}
              fontSize={10}
              fontWeight={600}
              fill="var(--text)"
              style={c ? { fill: c } : undefined}
              textAnchor="end"
            >{yLabel(k)}</text>
          )
        })}
        {/* セル */}
        {yKeys.map((yk, yi) =>
          xKeys.map((xk, xi) => {
            const row = cells.get(`${xk}|${yk}`)
            const v = row ? getMetric2D(row, metric) : null
            const total = row?.total ?? 0
            const fill = cellColor(v, group, minVal, maxVal, total, minSampleSize, sparseId, emptyId, metric)
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
                onMouseEnter={(e) => setHover({
                  mx: e.clientX, my: e.clientY, xKey: xk, yKey: yk, value: v,
                  total, wins: row?.wins ?? 0, draws: row?.draws ?? 0,
                })}
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
          {/* バトル数の右に勝敗の内訳を並べる。引き分けは発生したときだけ出す。
              メトリクス自体が「バトル数」のときは上の行と同じ値になるので、
              ラベルと件数を省いて勝敗内訳だけ出す（#388）。 */}
          <div className="hover-tt-row hover-tt-row--muted">
            {metric !== 'total' && <>バトル数: {hover.total}</>}
            {hover.total > 0 && (
              <>
                {metric !== 'total' && ' '}（{hover.wins} 勝 {hover.total - hover.wins - hover.draws} 敗
                {hover.draws > 0 && ` ${hover.draws} 分`}）
              </>
            )}
          </div>
          {(group === 'rate' || group === 'average') && hover.value !== null && hover.total < minSampleSize && (
            <div className="hover-tt-row hover-tt-row--muted">サンプル不足 (&lt; {minSampleSize})</div>
          )}
        </div>
      )}
    </div>
  )
}
