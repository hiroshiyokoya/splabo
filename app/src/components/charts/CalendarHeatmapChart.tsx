import { useEffect, useId, useMemo, useRef, useState } from 'react'
import type { GroupedStatsRow, MetricKey } from '../../types'
import { METRIC_LABELS, getMetric, metricGroup } from '../../types'
import {
  rateCellColor, RATE_LEGEND_COLORS, sequentialCellColor, seqLegendColors,
  integerRange, SparseHatchPattern, hatchFill,
} from '../../utils/heatmapColors'

/**
 * GitHub contribution graph 風のカレンダーヒートマップ。
 *
 * - 1 マス = 1 日(9 時境界の「Splatoon 日」、BE 側で UTC 日付＝Splatoon 日として返ってくる)
 * - 縦軸: 曜日(月~日)
 * - 横軸: 週(左が古い)
 * - メトリクスのグループで色スケールを自動切替:
 *   - count   → 相対 5 段階 (緑系)
 *   - rate    → 固定 0–100% divergent (くすみ珊瑚 → くすみ黄緑 → くすみティール)
 *   - average → 相対 5 段階 (アクセント色)
 * - 率・平均系はサンプル数 < minSampleSize でグレーアウト
 * - データが無い日は空セル (薄いグレー)
 * - 表示範囲は FilterBar の since/until に合わせ、期間外は描かない(#461)
 * - 期間が「いま」まで開いているときは、今日をバトル 0 でも常に出す(#461)
 */

const CELL  = 16
const GAP   = 3
const PITCH = CELL + GAP
/** セルの下限＝素のサイズ。これより狭いコンテナでは広げず、従来どおり横スクロールさせる(#429)。 */
const CELL_MIN = CELL
/** セルの上限。直近 7 日のように列が 2~3 本しか無いと、幅いっぱいに広げる計算では
 *  セルが 100px 超になってカレンダーに見えなくなるので止める(残る余白は許容する)。 */
const CELL_MAX = 24
/** セル幅を合わせる基準にする列数の上限＝約 1 年ぶん(#431)。
 *  53 週 + 月境界の空列 12。データがこれより長くなっても、見える幅は 1 年ぶんに保ち、
 *  古いぶんは横スクロールで見に行く。CustomChartCard.calendarEstimatedWidth の見積もりと揃える。 */
const VISIBLE_COLS_MAX = 65
/** グリッド左端(曜日ラベルぶんのオフセット)。 */
const GRID_LEFT = 22
/** 1 日 = ミリ秒。 */
const DAY_MS = 24 * 60 * 60 * 1000

const DOW_LABELS = ['月', '火', '水', '木', '金', '土', '日']

/** カラーバー (凡例) を描画するための、メトリクスグループごとの色順序。
 *  count / average は 5 段階 (薄い→濃い)、rate は 11 段階 (ピンク→くすみ黄緑→青) divergent。 */
const COUNT_COLORS  = ['var(--cell-count-c1)', 'var(--cell-count-c2)', 'var(--cell-count-c3)', 'var(--cell-count-c4)', 'var(--cell-count-c5)']
// 平均系(シーケンシャル)の 7 段は utils/heatmapColors の SEQ_LEGEND_COLORS を共用する(#351)
// 勝率(発散)の 7 段は utils/heatmapColors の RATE_LEGEND_COLORS を共用する(#351)

const MONTH_LABELS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

/** メトリクス値を凡例ラベル用に短く整形。 */
function fmtLegend(v: number, metric: MetricKey): string {
  if (metric === 'win_rate') return `${Math.round(v * 100)}%`
  if (metric === 'total' || metric === 'wins' ||
      metric === 'sum_kill' || metric === 'sum_death' ||
      metric === 'sum_assist' || metric === 'sum_contrib_kill' ||
      metric === 'sum_inked') return Math.round(v).toString()
  return v.toFixed(1)
}

/** Date を UTC 基準で yyyy-mm-dd 文字列に。 */
function toIsoDate(d: Date): string {
  return d.toISOString().slice(0, 10)
}

/** ISO 日付文字列を UTC Date に。 */
function fromIsoDate(s: string): Date {
  return new Date(`${s}T00:00:00Z`)
}

/** UTC ベースの曜日インデックス。0=月 … 6=日 になるよう変換。 */
function weekdayMonStart(d: Date): number {
  const w = d.getUTCDay() // 0=Sun … 6=Sat
  return (w + 6) % 7
}

/** 同じ ISO 週の Monday の UTC 日付を返す。 */
function mondayOf(d: Date): Date {
  const wd = weekdayMonStart(d)
  const m = new Date(d)
  m.setUTCDate(d.getUTCDate() - wd)
  return m
}

/** カウント系: 0=空、1~5=濃さ。max を 5 段階に正規化。 */
function countColor(value: number, max: number): string {
  if (max <= 0) return 'var(--cell-count-empty)'
  const t = value / max
  if (value === 0)  return 'var(--cell-count-empty)'
  if (t <= 0.2)    return 'var(--cell-count-c1)'
  if (t <= 0.4)    return 'var(--cell-count-c2)'
  if (t <= 0.6)    return 'var(--cell-count-c3)'
  if (t <= 0.8)    return 'var(--cell-count-c4)'
  return 'var(--cell-count-c5)'
}

/** 平均系: min–max を 7 段階に正規化(#351)。 */
function averageColor(value: number, min: number, max: number, metric: MetricKey): string {
  if (max <= min) return sequentialCellColor(0.5, metric)
  return sequentialCellColor((value - min) / (max - min), metric)
}

export function CalendarHeatmapChart({
  data, metric, minSampleSize = 5, since = null, until = null,
}: {
  data:           GroupedStatsRow[]
  metric:         MetricKey
  minSampleSize?: number
  /** FilterBar の期間開始(YYYY-MM-DD)。未指定ならデータ最早日(#461)。 */
  since?:         string | null
  /** FilterBar の期間終了(YYYY-MM-DD)。未指定なら「いま」(今日まで・#461)。 */
  until?:         string | null
}) {
  // ツールチップ位置はマウスの clientX / clientY (viewport 基準) を使う。
  // チャート枠 (overflow:auto) の外にも飛び出せるように position: fixed で描く。
  const [hover, setHover] = useState<{ mx: number; my: number; date: string; value: number | null; total: number; wins: number; draws: number } | null>(null)
  const scrollRef = useRef<HTMLDivElement>(null)
  // カード幅に合わせてセルを広げるための実測幅(#429)。0 = 未計測(素のサイズで描く)。
  // ウィンドウリサイズやサイドバー幅の変化にも追従させたいので ResizeObserver で見る。
  const [availW, setAvailW] = useState(0)
  useEffect(() => {
    const el = scrollRef.current
    if (!el) return
    const ro = new ResizeObserver(entries => {
      for (const e of entries) setAvailW(e.contentRect.width)
    })
    ro.observe(el)
    setAvailW(el.clientWidth)
    return () => ro.disconnect()
  }, [])
  // サンプル不足セルのハッチ用。同一ページに複数チャートが載るので id は一意にする(#351)。
  const sparseId = `sparse-${useId()}`

  const group = metricGroup(metric)

  // データ map / min-max / セル配置(列は日単位で割り当て・#310)
  // 表示範囲は FilterBar の since/until を優先し、期間外は描かない(#461)。
  // until 未指定(または今日以降)なら右端を今日まで延ばし、バトル 0 でも今日のセルを出す。
  const { dataMap, minVal, maxVal, cells, monthLabels, maxCol } = useMemo(() => {
    const map = new Map<string, { value: number | null; total: number; wins: number; draws: number }>()
    let mn = Number.POSITIVE_INFINITY
    let mx = Number.NEGATIVE_INFINITY
    let earliest: Date | null = null
    let latest:   Date | null = null

    for (const row of data) {
      const date = fromIsoDate(row.name)
      if (isNaN(date.getTime())) continue
      const v = getMetric(row, metric)
      map.set(row.name, { value: v, total: row.total, wins: row.wins, draws: row.draws })
      if (v !== null && (group === 'count' || row.total >= minSampleSize)) {
        if (v < mn) mn = v
        if (v > mx) mx = v
      }
      if (!earliest || date < earliest) earliest = date
      if (!latest   || date > latest)   latest   = date
    }

    const now = new Date()
    const todayUtc = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()))
    const sinceDate = since ? fromIsoDate(since) : null
    const untilDate = until ? fromIsoDate(until) : null
    const sinceOk = sinceDate && !isNaN(sinceDate.getTime()) ? sinceDate : null
    const untilOk = untilDate && !isNaN(untilDate.getTime()) ? untilDate : null

    // 期間終了が「いま」まで開いているときだけ、今日を必ず右端に含める。
    let rangeEnd = (untilOk && untilOk < todayUtc) ? untilOk : todayUtc
    if (latest && latest > rangeEnd) rangeEnd = latest  // データが期間より新しい場合は追従(通常は起きない)

    let rangeStart: Date
    if (sinceOk) {
      rangeStart = sinceOk
    } else if (earliest) {
      rangeStart = earliest
    } else {
      // データも since も無い: 直近 1 年を空表示(右端は今日)
      rangeStart = new Date(rangeEnd)
      rangeStart.setUTCDate(rangeEnd.getUTCDate() - 364)
    }
    if (rangeStart > rangeEnd) rangeStart = rangeEnd

    // 列は「日単位」で割り当てる(#310)。
    //   - 月曜になったら列を +1(通常の週送り)
    //   - 月が変わったら列を +1(週の途中でも。新しい月はその月の 1 日から新しい列で始まる)
    //   - 月初が月曜なら列を +2 して、間に空列を 1 本挟む(#392)
    // レイアウトは rangeStart の週頭から組むが、期間外(rangeStart より前)の日は
    // cells に入れないので、空のゼロセルとして見えない(#461)。
    const startMonday = mondayOf(rangeStart)
    const cells: { date: Date; col: number; row: number }[] = []
    const labels: { col: number; month: number }[] = []
    let col = 0
    let prevMonth = -1
    let labeledMonth = -1

    for (let t = startMonday.getTime(); t <= rangeEnd.getTime(); t += DAY_MS) {
      const d = new Date(t)
      const row = weekdayMonStart(d)
      const m = d.getUTCMonth()
      const isFirstIter = t === startMonday.getTime()
      const isMonday = row === 0
      const monthChanged = m !== prevMonth
      if (!isFirstIter) {
        if (monthChanged && isMonday) col += 2
        else if (monthChanged || isMonday) col++
      }
      if (d >= rangeStart && d <= rangeEnd) {
        if (m !== labeledMonth) {
          labels.push({ col, month: m })
          labeledMonth = m
        }
        cells.push({ date: d, col, row })
      }
      prevMonth = m
    }

    const rawMin = mn === Number.POSITIVE_INFINITY ? 0 : mn
    const rawMax = mx === Number.NEGATIVE_INFINITY ? 0 : mx
    // カウント系は色スケール上限を 10 単位で切り上げると凡例が読みやすい (52 → 60 等)
    // 平均系は範囲を整数に丸める(凡例が「3.2 – 7.8」ではなく「3 – 8」に・#351)
    const finalMax = group === 'count' && rawMax > 0 ? Math.ceil(rawMax / 10) * 10 : rawMax
    const r = group === 'average' ? integerRange(rawMin, finalMax) : { min: rawMin, max: finalMax }
    return {
      dataMap: map,
      minVal:  r.min,
      maxVal:  r.max,
      cells,
      monthLabels: labels,
      maxCol: col,
    }
  }, [data, metric, group, minSampleSize, since, until])

  function cellFill(_date: string, value: number | null, total: number): string {
    // カレンダーは「バトルの無い日」が大半なので、データなしはハッチにせず静かなべた塗りのまま。
    // ヒートマップの空セル(その組み合わせを一度も使っていない)とは意味も頻度も違う。
    if (value === null) return group === 'count' ? 'var(--cell-count-empty)' : 'var(--cell-empty)'
    // 率・平均系はサンプル不足ならハッチ(色ではなく塗りの質で示す・#351)
    if ((group === 'rate' || group === 'average') && total < minSampleSize) {
      return hatchFill(sparseId)
    }
    if (group === 'count')   return countColor(value, maxVal)
    if (group === 'rate')    return rateCellColor(value)
    return averageColor(value, minVal, maxVal, metric)
  }

  const GRID_TOP = 32

  // セルはカード幅いっぱいまで広げる(#429)。SVG が固定幅だとカードとの差がそのまま
  // 右の死に幅になっていた(1 年 × 3 トラックで約 119px)。
  //
  //   幅 = GRID_LEFT + cols * (cell + GAP) + cell + 8   … これを availW に一致させる
  //
  // 🔴 セル幅を合わせる列数は最長 1 年(VISIBLE_COLS_MAX)で頭打ちにする(#431)。
  // データが増えるほど列が増え、幅いっぱいに合わせるとセルが際限なく縮む(下限 16px に
  // 張り付き、期間によって見た目が変わる)。1 年ぶんの列数を基準にすれば、見える幅が
  // ちょうど 1 年になり、それより古いデータは横スクロールで見に行く形になる。
  // SVG 全体幅(後述の width)は実データの maxCol から出すので、スクロール領域は保たれる。
  const fitCols = Math.min(maxCol, VISIBLE_COLS_MAX)
  const cell = availW > 0
    ? Math.min(CELL_MAX, Math.max(CELL_MIN, (availW - GRID_LEFT - fitCols * GAP - 8) / (fitCols + 1)))
    : CELL
  const pitch = cell + GAP
  const GRID_HEIGHT = 7 * pitch

  /** 列インデックス → x 座標。 */
  const colX = (col: number) => GRID_LEFT + col * pitch

  // 月境界で列がずれるぶん、幅は最大列インデックスから算出する
  const width  = Math.max(colX(maxCol) + cell + 8, 280)
  const height = GRID_TOP + GRID_HEIGHT + 8

  // カレンダーは左が古い・右が最新。初期表示・データ更新時に最新(右端)が見えるよう右端へスクロール。
  useEffect(() => {
    const el = scrollRef.current
    if (el) el.scrollLeft = el.scrollWidth
  }, [width])

  /** 凡例ラベル: 左端値・右端値(勝率の中央 50% は廃止・#351) */
  const legendColors = group === 'rate' ? RATE_LEGEND_COLORS : group === 'count' ? COUNT_COLORS : seqLegendColors(metric)
  const legendLeft   = group === 'rate' ? '0%'  : group === 'count' ? '0' : fmtLegend(minVal, metric)
  const legendRight  = group === 'rate' ? '100%' : fmtLegend(maxVal, metric)

  return (
    <div ref={scrollRef} className="chart-hover-area chart-hover-area--scroll" style={{ position: 'relative' }}>
      <svg width={width} height={height} role="img" aria-label="カレンダーヒートマップ">
        <defs><SparseHatchPattern id={sparseId} /></defs>
        {/* .cal-cell スタイルは App.css に定義(凡例バーの SVG rect と共有) */}
        {/* 月ラベル (横軸上部) */}
        {monthLabels.map((ml, i) => (
          <text
            key={`m-${i}`}
            x={colX(ml.col)}
            y={GRID_TOP - 6}
            fontSize={9}
            fontWeight={600}
            fill="var(--text)"
          >{MONTH_LABELS[ml.month]}</text>
        ))}
        {/* 曜日ラベル */}
        {DOW_LABELS.map((lbl, i) => (
          <text
            key={lbl}
            x={4}
            y={GRID_TOP + i * pitch + cell * 0.75}
            fontSize={9}
            fontWeight={600}
            fill="var(--text)"
          >{lbl}</text>
        ))}
        {/* セル: 列は日単位で割り当て済み(月境界で列がずれる・#310)。
            期間外は cells に入れていない。未来日も rangeEnd で今日までに制限済み(#461)。 */}
        {cells.map(({ date, col, row }) => {
          const dateStr = toIsoDate(date)
          const entry = dataMap.get(dateStr)
          const v = entry?.value ?? null
          const total = entry?.total ?? 0
          const wins  = entry?.wins ?? 0
          const draws = entry?.draws ?? 0
          const fill = cellFill(dateStr, v, total)
          return (
            <rect
              key={dateStr}
              className="cal-cell"
              x={colX(col)}
              y={GRID_TOP + row * pitch}
              width={cell}
              height={cell}
              rx={2}
              fill={fill}
              onMouseEnter={(e) => setHover({ mx: e.clientX, my: e.clientY, date: dateStr, value: v, total, wins, draws })}
              onMouseMove={(e) => setHover(prev => prev ? { ...prev, mx: e.clientX, my: e.clientY } : prev)}
              onMouseLeave={() => setHover(null)}
            />
          )
        })}
      </svg>
      {/* カラーバー (凡例) を SVG の下に HTML として配置 */}
      <div className="cal-legend">
        <span className="cal-legend-label">{METRIC_LABELS[metric]}</span>
        <span className="cal-legend-end">{legendLeft}</span>
        {(() => {
          const fills = group === 'count'
            ? ['var(--cell-count-empty)', ...legendColors]
            : legendColors
          // 凡例はグリッドとは別物なので固定サイズのまま(#429)。ここまで可変にすると
          // スウォッチが 24px に膨らんで不格好になる。
          const barWidth = fills.length * PITCH - GAP
          return (
            <svg className="cal-legend-bar" width={barWidth} height={CELL}>
              {fills.map((c, i) => (
                <rect
                  key={i}
                  className="cal-cell"
                  x={i * PITCH}
                  y={0}
                  width={CELL}
                  height={CELL}
                  rx={2}
                  fill={c}
                />
              ))}
            </svg>
          )
        })()}
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
            left:     Math.min(hover.mx + 14, window.innerWidth  - 200),
            top:      Math.min(hover.my + 14, window.innerHeight - 100),
            pointerEvents: 'none',
            zIndex: 1000,
          }}
        >
          <div className="hover-tt-title">{hover.date}</div>
          {(() => {
            const losses  = hover.total - hover.wins - hover.draws
            const decisive = hover.total - hover.draws
            const winRate = decisive > 0 ? (hover.wins / decisive) * 100 : null
            return (
              <>
                <div className="hover-tt-row">バトル数: {hover.total}</div>
                <div className="hover-tt-row">勝数: {hover.wins}</div>
                <div className="hover-tt-row">負数: {losses}</div>
                <div className="hover-tt-row">勝率: {winRate !== null ? `${winRate.toFixed(1)}%` : '-'}</div>
              </>
            )
          })()}
        </div>
      )}
    </div>
  )
}
