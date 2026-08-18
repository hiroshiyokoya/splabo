import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import { useSortable } from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import type { CustomChart, GroupedStatsRow, GroupedStatsRow2D, BattleRow, MetricKey, BattleMetricKey } from '../types'
import {
  stageAbbr, modeLabel, ruleLabel, autoChartTitle, chartMetrics,
  METRIC_LABELS, BATTLE_METRIC_LABELS, BATTLE_NUMERIC_METRIC_LABELS,
  GROUP_BY_LABELS, formatMetric, winLoseBreakdown,
  scatterAggMetric, scatterAggMetricLabel, scatterAggColorMetric,
  SCATTER_WIN_COUNT_METRICS, type GroupByKey,
  SCATTER_IMAGE_PX, isScatterImageMode, isOfficialRateMetric,
} from '../types'
import { SimpleBarChart } from './charts/SimpleBarChart'
import { AttackDefenseChart } from './charts/AttackDefenseChart'
import { StackedWinrateChart } from './charts/StackedWinrateChart'
import { LineChart } from './charts/LineChart'
import { CalendarHeatmapChart } from './charts/CalendarHeatmapChart'
import { HeatmapChart } from './charts/HeatmapChart'
import {
  ScatterChart, buildSizeLegend, buildColorLegend, metricRefLine,
  type ScatterPoint, type SizeLegend, type ColorLegend,
} from './charts/ScatterChart'
import { rateCellColor, sequentialCellColor } from '../utils/heatmapColors'
import {
  isScatterCategoryColorKey, categoryStyleOf, buildCategoryColorLegend,
  categoryValueForWeaponName, categoryValueForBattle, kitIconsForWeapon, type WeaponMeta,
} from '../utils/scatterCategoryColors'
import { weaponAxisTip } from '../utils/weaponKitImages'
import { PanelExportButton, PanelExportCaption, PanelExportLogo } from './PanelExport'
import { EXPORT_HIDE_CLASS } from '../utils/panelExport'
import { rankRowsForBarChart, CHART_BAR_TOP_N, type ChartSortDir } from '../utils/chartSort'

/** 1 バトル単位の散布図メトリクス値を BattleRow から計算する。 */
function getBattleMetric(b: BattleRow, k: BattleMetricKey): number | null {
  switch (k) {
    case 'kill':         return b.kill
    case 'assist':       return b.assist
    case 'contrib_kill': return b.kill + b.assist
    case 'death':        return b.death
    case 'kd':           return b.death === 0 ? null : b.kill / b.death
    case 'contrib_kd':   return b.death === 0 ? null : (b.kill + b.assist) / b.death
    case 'inked':        return b.inked
    case 'special':      return b.special
  }
}

/** メトリクスキーから表示ラベル取得。バトル系・集計系の両方を扱う。 */
function metricLabelOf(k: string): string {
  if (k === 'win_lose')                  return '勝敗'
  if (k in GROUP_BY_LABELS)             return GROUP_BY_LABELS[k as GroupByKey]
  if (k in BATTLE_METRIC_LABELS)         return BATTLE_METRIC_LABELS[k as BattleMetricKey]
  if (k === 'losses' || k in METRIC_LABELS) return scatterAggMetricLabel(k)
  return k
}

/** 値の色マッピング。勝率は divergent、その他は accent 濃淡。 */
function colorOfValue(value: number | null, isRate: boolean, min: number, max: number, metric: MetricKey): string {
  if (value === null) return 'var(--cell-empty)'
  // 勝率(発散)の色はヒートマップ・カレンダーと共通のスケールを使う(#351)
  if (isRate) return rateCellColor(value)
  // 勝数・平均系もヒートマップ・カレンダーと共通の 7 段スケール(#351)
  if (max <= min) return sequentialCellColor(0.5, metric)
  return sequentialCellColor((value - min) / (max - min), metric)
}

/** カテゴリ集計単位(ブキ / ステージ / サブ / スペシャル / ブキカテゴリ)の散布図ポイントを作る。 */
/** ツールチップ 1 行分。 */
type TooltipRow = { label: string; value: string; muted?: boolean }

/**
 * ツールチップの行をメトリクスキーで重複排除する(#388)。
 *
 * X / Y / サイズ / 色 は同じメトリクスを割り当てられるため(例: サイズと色を両方「バトル数」)、
 * そのまま並べると同じ行が 2 度出る。先に積んだ行を優先して残す(= X/Y 側が残る)。
 *
 * 行は関数で受け取る。サイズ・色は未設定(key が undefined)のことがあり、その場合に
 * ラベル・値の組み立てを走らせないため(従来の三項演算子によるガードと同じ扱いを保つ)。
 */
function dedupeRows(entries: { key: string | undefined; row: () => TooltipRow | null }[]): TooltipRow[] {
  const seen = new Set<string>()
  const out: TooltipRow[] = []
  for (const { key, row } of entries) {
    if (!key || seen.has(key)) continue
    seen.add(key)
    const r = row()
    if (r) out.push(r)
  }
  return out
}

/**
 * バトル数・勝数・負数が軸などに割り当てられているとき、個別行の代わりに
 * ヒートマップと同じ `バトル数: N (x 勝 y 敗)` を 1 行で出す(#388 / #562)。
 */
function usesWinCountBlock(keys: (string | undefined)[]): boolean {
  return keys.some(k => k != null && SCATTER_WIN_COUNT_METRICS.has(k))
}

function winCountTooltipRow(d: GroupedStatsRow, muted?: boolean): TooltipRow | null {
  if (d.total <= 0) return null
  return {
    label: '',
    value: `バトル数: ${d.total} (${winLoseBreakdown(d.total, d.wins, d.draws)})`,
    muted,
  }
}

/** 集計散布図のツールチップ 1 行の値。 */
function fmtScatterMetric(value: number | null, key: string): string {
  if (key === 'losses') return formatMetric(value, 'total')
  return formatMetric(value, key as MetricKey)
}

function scatterTooltipEntries(
  d: GroupedStatsRow,
  xKey: string,
  yKey: string,
  sizeKey: string | undefined,
  colorKey: string | undefined,
  x: number | null,
  y: number | null,
  size: number | null,
  colorVal: number | null,
  catVal: string | null,
  isCatColor: boolean,
): { key: string | undefined; row: () => TooltipRow | null }[] {
  const winBlock = usesWinCountBlock([xKey, yKey, sizeKey, colorKey])
  let winCountShown = false

  const axisRow = (
    key: string | undefined,
    value: number | null,
    muted?: boolean,
  ): TooltipRow | null => {
    if (!key) return null
    if (winBlock && SCATTER_WIN_COUNT_METRICS.has(key)) {
      if (winCountShown) return null
      winCountShown = true
      return winCountTooltipRow(d, muted)
    }
    return { label: metricLabelOf(key), value: fmtScatterMetric(value, key), muted }
  }

  return [
    { key: xKey, row: () => axisRow(xKey, x) },
    { key: yKey, row: () => axisRow(yKey, y) },
    { key: sizeKey, row: () => axisRow(sizeKey, size, true) },
    isCatColor
      ? { key: colorKey, row: () => (colorKey ? { label: metricLabelOf(colorKey), value: catVal!, muted: true } : null) }
      : { key: colorKey, row: () => axisRow(colorKey, colorVal, true) },
  ]
}

/** 散布図の描画データ一式。凡例はポイントと同じ min/max・同じ色関数から作るので、
 *  ここでまとめて返す(呼び出し側で作り直すと本体と凡例がズレる)。 */
type ScatterBundle = { points: ScatterPoint[]; sizeLegend: SizeLegend | null; colorLegend: ColorLegend | null }

function buildAggScatterPoints(
  data: GroupedStatsRow[],
  xKey: string, yKey: string, sizeKey?: string, colorKey?: string,
  weaponMeta?: Map<string, WeaponMeta>,
  /** ブキ名 → 画像 data URI。点がブキのときだけ渡す(#626)。
   *  ここで取りに行かないのは、ホバーのたびに invoke を飛ばさないため。 */
  weaponImages?: Map<string, string>,
  subImages?: Map<string, string>,
  spImages?: Map<string, string>,
): ScatterBundle {
  const filtered = data.filter(d => d.total > 0)
  const isCatColor = isScatterCategoryColorKey(colorKey)
  // 色マッピング用 min/max(連続値のみ)
  const colorIsRate = isOfficialRateMetric(colorKey ?? '')
  let cmin = Infinity, cmax = -Infinity
  if (colorKey && !isCatColor) {
    for (const d of filtered) {
      const v = scatterAggMetric(d, colorKey)
      if (v === null) continue
      if (v < cmin) cmin = v
      if (v > cmax) cmax = v
    }
  }
  const categories = isCatColor
    ? filtered.map(d => categoryValueForWeaponName(d.name, colorKey, weaponMeta))
    : []
  const points = filtered.map(d => {
    const x = scatterAggMetric(d, xKey)
    const y = scatterAggMetric(d, yKey)
    const size = sizeKey ? scatterAggMetric(d, sizeKey) : null
    const colorVal = colorKey && !isCatColor ? scatterAggMetric(d, colorKey) : null
    const catVal = isCatColor ? categoryValueForWeaponName(d.name, colorKey, weaponMeta) : null
    const catStyle = isCatColor && catVal ? categoryStyleOf(catVal, categories) : null
    return {
      name:  d.name,
      x,
      y,
      size,
      color: catStyle
        ? catStyle.color
        : colorKey
          ? colorOfValue(colorVal, colorIsRate, cmin, cmax, scatterAggColorMetric(colorKey))
          : 'var(--accent)',
      markerShape: catStyle?.shape,
      iconUrl: weaponImages?.get(d.name) ?? null,
      ...kitIconsForWeapon(d.name, weaponMeta, subImages, spImages),
      tooltipRows: dedupeRows(scatterTooltipEntries(
        d, xKey, yKey, sizeKey, colorKey, x, y, size, colorVal, catVal, isCatColor,
      )),
    }
  })
  return {
    points,
    sizeLegend: sizeKey
      ? buildSizeLegend(metricLabelOf(sizeKey), points.map(p => p.size), v => formatMetric(v, scatterAggColorMetric(sizeKey)))
      : null,
    colorLegend: isCatColor
      ? buildCategoryColorLegend(metricLabelOf(colorKey!), categories)
      : colorKey
        ? buildColorLegend(
            metricLabelOf(colorKey),
            filtered.map(d => scatterAggMetric(d, colorKey)),
            v => formatMetric(v, scatterAggColorMetric(colorKey)),
            v => colorOfValue(v, colorIsRate, cmin, cmax, scatterAggColorMetric(colorKey)),
          )
        : null,
  }
}

/** バトル単位メトリクスの表示整形。整数はそのまま、小数は 2 桁。 */
const fmtBattle = (v: number | null): string =>
  v === null ? '-' : (Number.isInteger(v) ? v.toString() : v.toFixed(2))

/** バトル単位の散布図ポイントを作る。整数軸 (キル/デス等) の重なりを見やすくするため
 *  ±0.15 のジッタを乗せる。表示上の位置だけずらして、ホバーには元の値を表示する。
 *  ジッタ後に 0 未満になる場合は 0 でクランプ (キル等の非負値メトリクス向け)。
 *  groupKey は (元の x, y) で重なり判定し、ツールチップで全件を並べて表示する。 */
function buildBattleScatterPoints(
  data: BattleRow[],
  xKey: string, yKey: string, sizeKey?: string, colorKey?: string,
  weaponMeta?: Map<string, WeaponMeta>,
  /** ブキ名 → 画像 data URI(#626)。1 点 = 1 バトルで必ず自分のブキを持つ。 */
  weaponImages?: Map<string, string>,
  subImages?: Map<string, string>,
  spImages?: Map<string, string>,
): ScatterBundle {
  const jitter = () => (Math.random() - 0.5) * 0.3  // ±0.15
  const applyJitter = (v: number | null): number | null =>
    v === null ? null : Math.max(0, v + jitter())
  const isCatColor = isScatterCategoryColorKey(colorKey)
  const categories = isCatColor
    ? data.map(b => categoryValueForBattle(b, colorKey, weaponMeta))
    : []
  const points = data.map(b => {
    const x = getBattleMetric(b, xKey as BattleMetricKey)
    const y = getBattleMetric(b, yKey as BattleMetricKey)
    const size = sizeKey ? getBattleMetric(b, sizeKey as BattleMetricKey) : null
    const catVal = isCatColor ? categoryValueForBattle(b, colorKey, weaponMeta) : null
    let color = 'var(--accent)'
    let markerShape: ScatterPoint['markerShape']
    if (colorKey === 'win_lose') {
      color = b.result === 'win'  ? 'var(--win)'
            : b.result === 'lose' ? 'var(--lose)'
            : 'var(--draw)'
    } else if (isCatColor && catVal) {
      const style = categoryStyleOf(catVal, categories)
      color = style.color
      markerShape = style.shape
    } else if (colorKey) {
      // バトル単位の連続値メトリクス。min/max は呼び出しごとに簡易計算 (ここでは accent 単色)
      color = 'var(--accent)'
    }
    const name = `${b.played_at.slice(0, 10)} / ${b.weapon}`
    return {
      name,
      // 表示位置にジッタを乗せる (0 未満にはしない)
      x: applyJitter(x),
      y: applyJitter(y),
      size,
      color,
      markerShape,
      iconUrl: weaponImages?.get(b.weapon) ?? null,
      ...kitIconsForWeapon(b.weapon, weaponMeta, subImages, spImages),
      // 重なり判定: 元の (x, y) が同じ点を 1 グループに
      groupKey: `${x ?? 'null'}|${y ?? 'null'}`,
      // 複数件表示時の 1 行: 日付・ブキ・勝敗
      rowText: `${b.played_at.slice(5, 10)} ${b.weapon}${colorKey === 'win_lose' ? '' : ` (${b.result})`}`,
      // ツールチップには元の値 (ジッタ前) を表示。同じメトリクスを複数の役割に
      // 割り当てたときの重複は dedupeRows が落とす(#388)。
      tooltipRows: dedupeRows([
        { key: xKey, row: () => ({ label: metricLabelOf(xKey), value: fmtBattle(x) }) },
        { key: yKey, row: () => ({ label: metricLabelOf(yKey), value: fmtBattle(y) }) },
        { key: sizeKey, row: () => ({ label: metricLabelOf(sizeKey!), value: fmtBattle(size), muted: true }) },
        colorKey === 'win_lose'
          // 勝敗はメトリクスではないので、サイズ等と衝突しない専用キーで持つ
          ? { key: 'win_lose', row: () => ({ label: '勝敗', value: b.result, muted: true }) }
          : isCatColor
            ? { key: colorKey, row: () => ({ label: metricLabelOf(colorKey!), value: catVal!, muted: true }) }
            : { key: colorKey, row: () => ({ label: metricLabelOf(colorKey!), value: fmtBattle(getBattleMetric(b, colorKey as BattleMetricKey)), muted: true }) },
      ]),
    }
  })
  return {
    points,
    sizeLegend: sizeKey
      ? buildSizeLegend(metricLabelOf(sizeKey), points.map(p => p.size), fmtBattle)
      : null,
    colorLegend: colorKey === 'win_lose'
      ? { label: '勝敗', layout: 'chips', items: [
          { label: '勝', color: 'var(--win)' },
          { label: '負', color: 'var(--lose)' },
          { label: '分', color: 'var(--draw)' },
        ] }
      : isCatColor
        ? buildCategoryColorLegend(metricLabelOf(colorKey!), categories)
        : null,
  }
}

/** yComposition ごとの並び替えオプション(#509)。
 *  - stacked_winrate: バトル数 / 勝数 / 負数 / 勝率
 *  - attack_defense:  キル / デス / キルレ / 貢献キル / 貢献キルレ
 *  - single_metric:   バトル数 + 選択中メトリクス */
type BarSortKey = MetricKey | 'losses'
type SortOption = { key: BarSortKey; label: string }
const SORT_OPTIONS_STACKED_WINRATE: SortOption[] = [
  { key: 'total',    label: 'バトル数' },
  { key: 'wins',     label: '勝数' },
  { key: 'losses',   label: '負数' },
  { key: 'win_rate', label: '勝率' },
]
/** キル vs デス(attack_defense)用。 */
const SORT_OPTIONS_ATTACK_DEFENSE: SortOption[] = [
  { key: 'avg_kill',         label: 'キル' },
  { key: 'avg_death',        label: 'デス' },
  { key: 'avg_kd',           label: 'キルレ' },
  { key: 'avg_contrib_kill', label: '貢献キル' },
  { key: 'avg_contrib_kd',   label: '貢献キルレ' },
]

function barSortValue(row: GroupedStatsRow, key: BarSortKey): number | null {
  return scatterAggMetric(row, key)
}

// ---------------------------------------------------------------------------
// #401: チャートの「素の幅」からグリッドのスパン(1 / 2 / 3 トラック)を決める。
// ---------------------------------------------------------------------------
//
// 基準トラックは App.css の .chart-grid(minmax(420px, 1fr))と揃える。チャートの
// 見込み描画幅が 1 トラックに収まれば standard(1)、2 トラックぶんなら wide(2)、
// それ以上は full(3)。棒・線・散布図・単一メトリクスは常に standard。
// ヒートマップ・カレンダーは shape だけでなく列数・週数(データ規模)まで見て決める。
//
// 幅の見積もり式は各チャートコンポーネントの実寸ロジックを転記している：
//   - HeatmapChart:        PAD_LEFT(+yTitle) + 列数 * (CELL_W + GAP)
//   - CalendarHeatmapChart: GRID_LEFT + 列数 * PITCH + CELL
// 元コンポーネントの定数を変えたらここも追従すること。
type ChartSpan = 1 | 2 | 3

// 基準トラック 420px を単位にした閾値。カードの padding(16*2)とスクロールの余白を見て
// 1 トラック内なら 430px 目安、2 トラック内なら 850px 目安で切り替える。
function spanForWidth(w: number): ChartSpan {
  if (w <= 430) return 1
  if (w <= 850) return 2
  return 3
}

/** ヒートマップの見込み幅。data2d の X 軸カテゴリ数(バトル数 > 0)から算出。 */
function heatmapEstimatedWidth(data2d: GroupedStatsRow2D[] | undefined): number {
  const xCols = data2d ? new Set(data2d.filter(r => r.total > 0).map(r => r.key_x)).size : 0
  // HeatmapChart: PAD_LEFT_BASE(110) + yTitle 用 TITLE_PAD(22)、CELL_W(32)+GAP(1)=33、末尾 +8。
  return 132 + xCols * 33 + 8
}

/** カレンダーの見込み幅。data(日別 GroupedStatsRow)の日付レンジから週＋月境界ぶんの列数を推定。 */
function calendarEstimatedWidth(data: GroupedStatsRow[]): number {
  const times = data
    .map(d => Date.parse(`${d.name}T00:00:00Z`))
    .filter(n => !Number.isNaN(n))
  // データが無いときは CalendarHeatmapChart が直近 1 年(約 52 週)を空表示するので full 相当。
  let cols: number
  if (times.length === 0) {
    cols = 64
  } else {
    const min = Math.min(...times)
    const max = Math.max(...times)
    const days = (max - min) / 86_400_000 + 1
    const weeks = Math.ceil(days / 7)
    // #310/#392: 月境界ごとに列が 1~2 本ずれる。おおよそ月数ぶん加算して見積もる。
    const months = Math.max(1, Math.round(days / 30))
    cols = weeks + months
  }
  // CalendarHeatmapChart: GRID_LEFT(22) + 列数 * PITCH(19) + CELL(16) + 末尾 8。
  return 22 + cols * 19 + 16 + 8
}

/** チャート 1 枚のグリッドスパンを決める。 */
function chartSpan(chart: CustomChart, data: GroupedStatsRow[], data2d: GroupedStatsRow2D[] | undefined): ChartSpan {
  if (chart.shape === 'heatmap') return spanForWidth(heatmapEstimatedWidth(data2d))
  if (chart.shape === 'calendar_heatmap') return spanForWidth(calendarEstimatedWidth(data))
  // 棒・線・散布図・単一メトリクスは標準幅(ResponsiveContainer で横 100% に追従する)。
  return 1
}

const SPAN_CLASS: Record<ChartSpan, string> = {
  1: '',
  2: 'chart-card--wide',
  3: 'chart-card--full',
}

/** 棒グラフ用: 指標で全件ソートしてから上位を切る(#509)。 */
function sortAndSlice(
  rows: GroupedStatsRow[],
  sortKey: BarSortKey | null,
  dir: ChartSortDir,
  topN: number = CHART_BAR_TOP_N,
): GroupedStatsRow[] {
  if (!sortKey) return rows.slice(0, topN)
  return rankRowsForBarChart(rows, {
    getSortValue: row => barSortValue(row, sortKey),
    getTotal: row => row.total,
    sortByWinRate: sortKey === 'win_rate',
    dir,
    topN,
  })
}

/**
 * カスタムグラフ 1 枚分のカード。dnd-kit Sortable で並び替え可能、
 * 右上に「ドラッグハンドル / 設定 / 削除」ボタンを並べる。
 *
 * - X 軸ラベルの整形は groupBy に応じて自動：
 *   - stage → stageAbbr(省略 + 30° 斜め)
 *   - mode  → modeLabel
 *   - rule  → ruleLabel
 *   - その他 → そのまま
 * - yComposition に応じて並び替えボタンを常に表示
 *   (stacked_winrate / attack_defense / single_metric の棒グラフ)。
 * - 同じキー再クリックで昇順/降順トグル(#509)。
 */
export function CustomChartCard({
  chart, data, data2d, battleData, onEdit, onDelete, weaponImages, weaponMeta,
  subImages, spImages,
  since = null, until = null, filterSummary = '',
}: {
  chart:    CustomChart
  data:     GroupedStatsRow[]
  /** shape='heatmap' のときだけ使う 2D データ。 */
  data2d?:  GroupedStatsRow2D[]
  /** shape='scatter' で dotUnit='battle' のときの 1 バトル単位データ。 */
  battleData?: BattleRow[]
  onEdit:   () => void
  onDelete: () => void
  /** ブキ名 → 画像 URL の対応。X 軸が `weapon` のときラベルをアイコンに置換する。 */
  weaponImages?: Map<string, string>
  /** ブキ名 → カテゴリ/サブ/スペシャル。散布図のカテゴリ色分け(#480)用。 */
  weaponMeta?: Map<string, WeaponMeta>
  /** サブ／スペシャル画像(#641)。散布図ツールチップのキット行用。 */
  subImages?: Map<string, string>
  spImages?: Map<string, string>
  /** カレンダー用。FilterBar の期間(#461)。 */
  since?:   string | null
  until?:   string | null
  /** 画像保存時に焼き込む絞り込み条件(#500)。 */
  filterSummary?: string
}) {
  const sortable = useSortable({ id: chart.id })
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = sortable

  const style: React.CSSProperties = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity:   isDragging ? 0.5 : 1,
  }

  // 並び替えは棒グラフだけ(#509)。heatmap / calendar / line / scatter には出さない。
  const sortOptions: SortOption[] =
    chart.shape !== 'bar' ? [] :
    chart.yComposition === 'stacked_winrate' ? SORT_OPTIONS_STACKED_WINRATE :
    chart.yComposition === 'attack_defense'  ? SORT_OPTIONS_ATTACK_DEFENSE  :
    chart.yComposition === 'single_metric' && chart.metric
      ? (chart.metric === 'total'
        ? [{ key: 'total' as MetricKey, label: 'バトル数' }]
        : [
            { key: 'total' as MetricKey, label: 'バトル数' },
            { key: chart.metric, label: METRIC_LABELS[chart.metric] ?? chart.metric },
          ])
      : []
  const defaultSortKey = sortOptions[0]?.key ?? null
  const [sortKey, setSortKey] = useState<BarSortKey | null>(defaultSortKey)
  const [sortDir, setSortDir] = useState<ChartSortDir>('desc')

  // 構成が変わったら並び替えキーを既定に戻す(古いキーが選択肢から消えるため)。
  useEffect(() => {
    setSortKey(defaultSortKey)
    setSortDir('desc')
  }, [chart.id, chart.yComposition, chart.metric, defaultSortKey])

  // 軸キーに応じた表示整形(ステージは斜め)
  const nameTransform =
    chart.groupBy === 'stage' ? stageAbbr :
    chart.groupBy === 'mode'  ? modeLabel :
    chart.groupBy === 'rule'  ? ruleLabel :
                                undefined
  const tickAngle = chart.groupBy === 'stage' ? 30 : undefined

  // 指標で全件ソートしてから上位を切る(#509)。
  // 線・カレンダー・散布図・ヒートマップは全データが必要なので slice しない。
  const sliced = (chart.shape === 'line' || chart.shape === 'calendar_heatmap' || chart.shape === 'scatter' || chart.shape === 'heatmap')
    ? data
    : sortAndSlice(data, sortKey, sortDir, chart.topN ?? CHART_BAR_TOP_N)

  function handleSortClick(key: BarSortKey) {
    if (sortKey === key) {
      setSortDir(d => (d === 'desc' ? 'asc' : 'desc'))
    } else {
      setSortKey(key)
      setSortDir('desc')
    }
  }

  // #401: チャート種別・データ規模から決めるグリッドスパン(standard / wide / full)。
  const spanClass = SPAN_CLASS[chartSpan(chart, data, data2d)]

  // 画像保存(#500)。dnd-kit の ref と両立させるため、コールバック ref で両方へ渡す。
  // 毎レンダーで関数が変わると React が ref を付け外しして dnd-kit の登録が揺れるので固定する。
  const cardRef = useRef<HTMLDivElement | null>(null)
  const setRefs = useCallback((el: HTMLDivElement | null) => {
    setNodeRef(el)
    cardRef.current = el
  }, [setNodeRef])
  const title = autoChartTitle(chart)

  return (
    <div className={`chart-card custom-chart-card${spanClass ? ` ${spanClass}` : ''}`} ref={setRefs} style={style}>
      <PanelExportLogo />
      {/* 上段：ドラッグ・設定・削除・画像保存(カスタムグラフ専用)。
          こうすることで下の chart-card-header は固定 4 グラフと同じ「title | 並び替え」レイアウトになる。 */}
      <div className={`custom-chart-toprow ${EXPORT_HIDE_CLASS}`}>
        <button
          className="custom-chart-handle"
          {...attributes}
          {...listeners}
          aria-label="並び替え"
          title="ドラッグで並び替え"
        >⋮⋮</button>
        <PanelExportButton targetRef={cardRef} screen="ダッシュボード" panel={title} />
        <button className="custom-chart-btn" onClick={onEdit}   aria-label="設定" title="設定">⚙</button>
        <button className="custom-chart-btn" onClick={onDelete} aria-label="削除" title="削除">✕</button>
      </div>
      <div className="chart-card-header">
        <h3 className="chart-title">{title}</h3>
        {sortOptions.length > 0 && (
          <div className={`chart-sort-btns ${EXPORT_HIDE_CLASS}`}>
            {sortOptions.map(o => {
              const active = sortKey === o.key
              const dirMark = active ? (sortDir === 'asc' ? ' ↑' : ' ↓') : ''
              return (
                <button
                  key={o.key}
                  type="button"
                  className={`chart-sort-btn${active ? ' active' : ''}`}
                  onClick={() => handleSortClick(o.key)}
                  title={active
                    ? `クリックで${sortDir === 'desc' ? '昇順' : '降順'}に切替`
                    : `${o.label}で並べ替え`}
                  aria-pressed={active}
                  aria-label={`${o.label}${active ? (sortDir === 'asc' ? '(昇順)' : '(降順)') : ''}`}
                >{o.label}{dirMark}</button>
              )
            })}
          </div>
        )}
      </div>
      <PanelExportCaption conditions={filterSummary} />
      {renderChartBody(chart, sliced, data2d, battleData, nameTransform, tickAngle, weaponImages, weaponMeta, subImages, spImages, since, until)}
    </div>
  )
}

/** shape × yComposition の組み合わせでチャートコンポーネントへディスパッチする。
 *  v1.0.0 は shape='bar' / 'line' を実装。scatter / heatmap は今後の PR。
 *  X 軸が `weapon` のときに限り、`weaponImages` を渡してアイコンラベルにする。 */
function renderChartBody(
  chart:         CustomChart,
  data:          GroupedStatsRow[],
  data2d:        GroupedStatsRow2D[] | undefined,
  battleData:    BattleRow[] | undefined,
  nameTransform: ((s: string) => string) | undefined,
  tickAngle:     number | undefined,
  weaponImages:  Map<string, string> | undefined,
  weaponMeta:    Map<string, WeaponMeta> | undefined,
  subImages:     Map<string, string> | undefined,
  spImages:      Map<string, string> | undefined,
  since:         string | null,
  until:         string | null,
): ReactNode {
  // X 軸がブキ系(自分・味方・相手)のときだけ画像を有効化。他の groupBy では undefined。
  // 棒グラフの画像 tick と、散布図のツールチップアイコン(#626)で共有する。
  const isWeaponAxis =
    chart.groupBy === 'weapon' ||
    chart.groupBy === 'ally_weapon' ||
    chart.groupBy === 'enemy_weapon'
  const isWeaponAxisY =
    chart.groupBy2 === 'weapon' ||
    chart.groupBy2 === 'ally_weapon' ||
    chart.groupBy2 === 'enemy_weapon'
  const images = isWeaponAxis ? weaponImages : undefined

  // line: 時系列のみ。複数系列対応(#436)。
  if (chart.shape === 'line') {
    const metrics = chartMetrics(chart)
    if (metrics.length > 0) {
      return <LineChart data={data} metrics={metrics} groupBy={chart.groupBy} />
    }
    return (
      <div className="chart-not-implemented">
        メトリクスを 1 つ以上選んでください。
      </div>
    )
  }

  // calendar_heatmap: 日別のみ。yComposition は single_metric 前提。
  if (chart.shape === 'calendar_heatmap') {
    if (chart.yComposition === 'single_metric' && chart.metric) {
      return <CalendarHeatmapChart data={data} metric={chart.metric} since={since} until={until} />
    }
    return (
      <div className="chart-not-implemented">
        カレンダーヒートマップは「単一メトリクス」を選んでください。
      </div>
    )
  }

  // scatter: ドット単位ごとに別データ。バトル単位 = battleData (BattleRow[])、
  // カテゴリ集計単位 = data (GroupedStatsRow[])。
  if (chart.shape === 'scatter') {
    if (!chart.xMetric || !chart.yMetric) {
      return <div className="chart-not-implemented">散布図には X 軸 / Y 軸 を選んでください。</div>
    }
    const isBattle = chart.dotUnit === 'battle'
    // 点をブキ画像で描くか(#627)。ブキ軸のときだけ。
    // 🔴 画像モードではサイズ・色メトリクスを**渡さない**。画像が塗りを埋めるので色は
    // 読めず、サイズは一定にする約束だから。設定は消さずに無視するので、丸に戻せば復帰する。
    // 凡例も出さない(出すと嘘になる)。
    const imagePx = isScatterImageMode(chart) ? SCATTER_IMAGE_PX[chart.scatterImageSize ?? 'medium'] : undefined
    const sizeKey  = imagePx ? undefined : chart.sizeMetric
    const colorKey = imagePx ? undefined : chart.colorMetric
    // ツールチップのブキ画像(#626)。
    // バトル単位は 1 点 = 1 バトルで必ず自分のブキを持つので、groupBy によらず渡す。
    // 集計単位は点がブキのときだけ(ステージ別の点にブキ画像が付いたら嘘になる)。
    const { points, sizeLegend, colorLegend } = isBattle
      ? buildBattleScatterPoints(battleData ?? [], chart.xMetric, chart.yMetric, sizeKey, colorKey, weaponMeta, weaponImages, subImages, spImages)
      : buildAggScatterPoints(data, chart.xMetric, chart.yMetric, sizeKey, colorKey, weaponMeta, images, images ? subImages : undefined, images ? spImages : undefined)
    return (
      <ScatterChart
        points={points}
        imagePx={imagePx}
        sizeLegend={imagePx ? null : sizeLegend}
        colorLegend={imagePx ? null : colorLegend}
        xLabel={metricLabelOf(chart.xMetric)}
        yLabel={metricLabelOf(chart.yMetric)}
        xIsRate={isOfficialRateMetric(chart.xMetric)}
        yIsRate={isOfficialRateMetric(chart.yMetric)}
        // 勝率 50% / キルレ 1 に破線を引く。環境分析と同じ判定を使う(#548)。
        xRefLine={metricRefLine(chart.xMetric)}
        yRefLine={metricRefLine(chart.yMetric)}
        // 比率メトリクスはログにしても意味がないので、設定が残っていても効かせない (#381)。
        xLogScale={chart.xLogScale && !isOfficialRateMetric(chart.xMetric)}
        yLogScale={chart.yLogScale && !isOfficialRateMetric(chart.yMetric)}
        hasSize={!!sizeKey}
        // 環境分析の散布図と同じ透過度に揃える (#435)
        fillOpacity={0.55}
        // サイズメトリクス未指定時の一定サイズ。バトルは点が多いので小さめ、集計単位は大きめ。
        constSize={isBattle ? 120 : 280}
      />
    )
  }

  // heatmap: 2 軸クロス集計。X 軸 = chart.groupBy / Y 軸 = chart.groupBy2。
  if (chart.shape === 'heatmap') {
    if (!chart.groupBy2) {
      return <div className="chart-not-implemented">Y 軸 (groupBy2) を選んでください。</div>
    }
    if (chart.yComposition !== 'single_metric' || !chart.metric) {
      return <div className="chart-not-implemented">ヒートマップは「単一メトリクス」を選んでください。</div>
    }
    const xT = chart.groupBy  === 'stage' ? stageAbbr : chart.groupBy  === 'mode' ? modeLabel : chart.groupBy  === 'rule' ? ruleLabel : undefined
    const yT = chart.groupBy2 === 'stage' ? stageAbbr : chart.groupBy2 === 'mode' ? modeLabel : chart.groupBy2 === 'rule' ? ruleLabel : undefined
    // 軸タイトル(#145)：数値メトリクス bin 軸はメトリクス名 (bin 幅併記)、カテゴリ軸は GroupBy ラベル
    const xTitle = chart.xNumericMetric
      ? `${BATTLE_NUMERIC_METRIC_LABELS[chart.xNumericMetric]} (bin ${chart.xBinWidth ?? '?'})`
      : GROUP_BY_LABELS[chart.groupBy]
    const yTitle = chart.yNumericMetric
      ? `${BATTLE_NUMERIC_METRIC_LABELS[chart.yNumericMetric]} (bin ${chart.yBinWidth ?? '?'})`
      : chart.groupBy2 ? GROUP_BY_LABELS[chart.groupBy2] : undefined
    const kitTip = (name: string) => weaponAxisTip(name, weaponMeta, weaponImages, subImages, spImages)
    return (
      <HeatmapChart
        data={data2d ?? []}
        metric={chart.metric}
        xLabelTransform={xT}
        yLabelTransform={yT}
        xNumeric={!!chart.xNumericMetric}
        yNumeric={!!chart.yNumericMetric}
        xTitle={xTitle}
        yTitle={yTitle}
        xWeaponTip={!chart.xNumericMetric && isWeaponAxis ? kitTip : undefined}
        yWeaponTip={!chart.yNumericMetric && isWeaponAxisY ? kitTip : undefined}
      />
    )
  }

  if (chart.shape !== 'bar') {
    return (
      <div className="chart-not-implemented">
        この形({chart.shape})はまだ未実装です。<br />
        後続 PR で対応予定です。
      </div>
    )
  }
  if (chart.yComposition === 'single_metric' && chart.metric) {
    return <SimpleBarChart data={data} metric={chart.metric} nameTransform={nameTransform} tickAngle={tickAngle} images={images} />
  }
  if (chart.yComposition === 'stacked_winrate') {
    return <StackedWinrateChart data={data} nameTransform={nameTransform} tickAngle={tickAngle} images={images} />
  }
  if (chart.yComposition === 'attack_defense') {
    return <AttackDefenseChart data={data} nameTransform={nameTransform} tickAngle={tickAngle} images={images} />
  }
  return null
}
