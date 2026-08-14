/**
 * マトリクス型ヒートマップ(#187)。
 *
 * env_matrix_stats の結果({ row_key, col_key, value, n }[])を
 * 行カテゴリ × 列カテゴリのグリッドとして描画する。Recharts に専用型が無いため
 * CSS グリッド + カラースケールで自前実装する。集計後データは数十×数十セルで軽量。
 */
import { useMemo, useState, type MouseEvent } from 'react'
import type { EnvMatrixCell } from '../../types'
import { AXIS_LABEL_MIN_INTENSITY } from '../../utils/heatmapColors'
import { WeaponKitTipBody, weaponKitTipStyle, type WeaponKitTipData } from './WeaponKitTip'

export interface HeatmapProps {
  cells:      EnvMatrixCell[]
  /** セル値の表示フォーマット。 */
  valueLabel: (v: number) => string
  /** 'diverging' は mid を境に赤(低)/青(高)。'sequential' は薄→濃の単色。 */
  scale:      'sequential' | 'diverging'
  /** diverging の中心値(勝率なら 0.5、キルレなら 1.0)。 */
  mid?:       number
  /** sequential の色相(既定 210=青)。デスのような「高いほど悪い」指標は 8=赤 を渡す。 */
  sequentialHue?: number
  rowAxis:    string
  colAxis:    string
  /** キー → 表示ラベル。未指定はキーそのまま。 */
  rowLabel?:  (key: string) => string
  colLabel?:  (key: string) => string
  /** 列見出しを斜め表示にする(ステージ名など長いラベル向け)。 */
  diagonalCols?: boolean
  /** 行キーの優先並び順。指定キーはこの順、未指定キーはサンプル数降順で後ろに続く。 */
  rowOrder?:  string[]
  /** 列キーの優先並び順。 */
  colOrder?:  string[]
  /** 列見出しクリックによる行ソート対象列。null / 未指定は既定並び(#479)。 */
  sortColKey?: string | null
  /** sortColKey 指定時の昇順 / 降順(初回クリックは desc)。 */
  sortDir?:    'asc' | 'desc'
  /** 列見出しクリック時。親が sortColKey / sortDir を更新する。 */
  onColHeaderClick?: (colKey: string) => void
  /** 行ごとの射影値(そのキーの**全バトル**から算出した値。BE の marginals・#405 / #411)。
   *  与えると行見出しの文字色をセルと同じ色スケールで色付けする。null / 未指定は既定色。 */
  rowValue?:  Map<string, number | null>
  /** 列ごとの射影値。#405 / #411 */
  colValue?:  Map<string, number | null>
  /** 軸見出しの射影値を「その軸の最大値を 1」とする軸内の相対スケールで色付けする(#411)。
   *  カウント系(バトル数)の射影は合計なので、必ずセルの最大値以上になり、
   *  セルの min/max で正規化すると全見出しが最濃で潰れる。合計にはこちらを使う。 */
  axisRelative?: boolean
  /** ブキ軸ラベルのホバーチップ(#643)。返すとブラウザ title の代わりに出す。 */
  rowTip?: (key: string) => WeaponKitTipData | undefined
  colTip?: (key: string) => WeaponKitTipData | undefined
}

/** 集計マップを並べ替える。order 指定時はその順(未指定キーはサンプル数降順で後続)、
 *  未指定時はサンプル数降順。 */
function orderKeys(agg: Map<string, number>, order?: string[]): string[] {
  const entries = [...agg.entries()]
  if (order && order.length) {
    const rank = (k: string) => { const i = order.indexOf(k); return i === -1 ? Number.MAX_SAFE_INTEGER : i }
    return entries.sort((a, b) => (rank(a[0]) - rank(b[0])) || (b[1] - a[1])).map(e => e[0])
  }
  return entries.sort((a, b) => b[1] - a[1]).map(e => e[0])
}

const CELL_KEY_SEP = '\0'

/** 指定列のセル値で行を並べ替える。値なし / null セルは末尾(#479)。 */
function sortRowsByColumn(
  rowKeys: string[],
  colKey: string,
  dir: 'asc' | 'desc',
  cellMap: Map<string, EnvMatrixCell>,
): string[] {
  const withValue: { key: string; value: number }[] = []
  const withoutValue: string[] = []
  for (const rk of rowKeys) {
    const cell = cellMap.get(`${rk}${CELL_KEY_SEP}${colKey}`)
    if (!cell || cell.value === null) withoutValue.push(rk)
    else withValue.push({ key: rk, value: cell.value })
  }
  withValue.sort((a, b) => (dir === 'desc' ? b.value - a.value : a.value - b.value))
  return [...withValue.map(w => w.key), ...withoutValue]
}

/** 強度(0=淡い ~ 1=濃い)に応じた背景色と読みやすい文字色。 */
function cellStyle(hue: number, intensity: number): { background: string; color: string } {
  const c = Math.max(0, Math.min(1, intensity))
  const lightness = 92 - c * 52  // 92%(淡)→ 40%(濃)
  return {
    background: `hsl(${hue} 72% ${lightness}%)`,
    color: lightness < 60 ? '#f2f2fb' : '#14142a',
  }
}

/**
 * 軸ラベルの文字色(#405)。セルと同じ hue・強度を使うが、こちらは色付きの「背景」ではなく
 * サーフェス上に置く「文字」なので、淡い色だと読めない。強度に応じて彩度を上げ・明度を下げ、
 * ライト/ダーク双方で読める帯(明度 58%→48%)に収める。強度が小さいうちは既定色のまま
 * (undefined を返す)にして、意味のある差だけを色で示す。
 * 「弱い射影値は色を付けない」閾値はダッシュボードの HeatmapChart と共有する(#409)。 */
function labelColor(hue: number, intensity: number): string | undefined {
  const c = Math.max(0, Math.min(1, intensity))
  if (c < AXIS_LABEL_MIN_INTENSITY) return undefined  // 弱い射影値は既定色(薄すぎる色を避ける)
  const sat = 58 + c * 30                    // 58%(弱)→ 88%(強)
  const light = 58 - c * 10                  // 58%(弱・明るめ)→ 48%(強・濃いめ)
  return `hsl(${hue} ${sat}% ${light}%)`
}

export function Heatmap({
  cells, valueLabel, scale, mid = 0.5, sequentialHue = 210,
  rowAxis, colAxis, rowLabel, colLabel, diagonalCols = false, rowOrder, colOrder,
  sortColKey = null, sortDir = 'desc', onColHeaderClick,
  rowValue, colValue, axisRelative = false,
  rowTip, colTip,
}: HeatmapProps) {
  const [axisHover, setAxisHover] = useState<{ mx: number; my: number; tip: WeaponKitTipData } | null>(null)

  function axisHoverHandlers(tip: WeaponKitTipData | undefined) {
    if (!tip) return {}
    return {
      onMouseEnter: (e: MouseEvent) => setAxisHover({ mx: e.clientX, my: e.clientY, tip }),
      onMouseMove:  (e: MouseEvent) => setAxisHover(h => h ? { ...h, mx: e.clientX, my: e.clientY } : { mx: e.clientX, my: e.clientY, tip }),
      onMouseLeave: () => setAxisHover(null),
    }
  }
  const { rowKeys, colKeys, cellMap, min, max } = useMemo(() => {
    const rowAgg = new Map<string, number>()
    const colAgg = new Map<string, number>()
    const cellMap = new Map<string, EnvMatrixCell>()
    let min = Infinity
    let max = -Infinity
    for (const c of cells) {
      rowAgg.set(c.row_key, (rowAgg.get(c.row_key) ?? 0) + c.n)
      colAgg.set(c.col_key, (colAgg.get(c.col_key) ?? 0) + c.n)
      cellMap.set(`${c.row_key}${CELL_KEY_SEP}${c.col_key}`, c)
      if (c.value !== null) {
        if (c.value < min) min = c.value
        if (c.value > max) max = c.value
      }
    }
    const defaultRowKeys = orderKeys(rowAgg, rowOrder)
    const rowKeys = sortColKey
      ? sortRowsByColumn(defaultRowKeys, sortColKey, sortDir, cellMap)
      : defaultRowKeys
    const colKeys = orderKeys(colAgg, colOrder)
    if (!isFinite(min)) { min = 0; max = 1 }
    return { rowKeys, colKeys, cellMap, min, max }
  }, [cells, rowOrder, colOrder, sortColKey, sortDir])

  // 値 → (色相, 強度)。セル背景・軸ラベル文字色で共通に使う(色スケールの二重定義をしない・#405)。
  const hueIntensity = (v: number): { hue: number; intensity: number } => {
    if (scale === 'diverging') {
      // mid を境に赤(低)/青(高)。上下それぞれの最大幅で正規化する。
      const span = Math.max(max - mid, mid - min, 1e-6)
      const d = (v - mid) / span
      return { hue: d >= 0 ? 210 : 8, intensity: Math.abs(d) }
    }
    const span = Math.max(max - min, 1e-6)
    return { hue: sequentialHue, intensity: (v - min) / span }
  }

  const styleFor = (v: number): { background: string; color: string } => {
    const { hue, intensity } = hueIntensity(v)
    return cellStyle(hue, intensity)
  }

  /** 軸見出しの文字色。射影値が無い(標本不足・算出不能)キーは既定色(undefined)。 */
  const headColor = (proj?: Map<string, number | null>) => {
    // 合計(カウント系)はセルの min/max と桁が違うので、その軸の最大値を 1 とする。
    const axisMax = axisRelative
      ? Math.max(0, ...[...(proj?.values() ?? [])].filter((v): v is number => v != null))
      : 0
    return (key: string): string | undefined => {
      const v = proj?.get(key)
      if (v == null) return undefined
      if (axisRelative) {
        return axisMax > 0 ? labelColor(sequentialHue, v / axisMax) : undefined
      }
      const { hue, intensity } = hueIntensity(v)
      return labelColor(hue, intensity)
    }
  }
  const rowHeadColor = headColor(rowValue)
  const colHeadColor = headColor(colValue)

  if (cells.length === 0) {
    return <p className="env-no-data">条件に一致するデータがありません(しきい値未満のセルは非表示)</p>
  }

  const rl = rowLabel ?? ((k: string) => k)
  const cl = colLabel ?? ((k: string) => k)

  return (
    <div className="env-heatmap-wrap">
      <table className="env-heatmap">
        <thead>
          <tr>
            <th className="env-heatmap-corner">
              <span className="env-heatmap-rowaxis">{rowAxis}</span>
              <span className="env-heatmap-colaxis">{colAxis}</span>
            </th>
            {colKeys.map(ck => {
              const sorted = sortColKey === ck
              const sortable = !!onColHeaderClick
              const kit = colTip?.(ck)
              const headClass = [
                'env-heatmap-colhead',
                diagonalCols && 'is-diagonal',
                sortable && 'is-sortable',
                sorted && 'is-sorted',
              ].filter(Boolean).join(' ')
              return (
                <th key={ck}
                    className={headClass}
                    style={colHeadColor(ck) ? { color: colHeadColor(ck) } : undefined}
                    title={kit ? undefined : (sortable ? `${cl(ck)} - クリックで行を並べ替え` : ck)}
                    aria-sort={sorted ? (sortDir === 'asc' ? 'ascending' : 'descending') : sortable ? 'none' : undefined}
                    onClick={sortable ? () => onColHeaderClick!(ck) : undefined}
                    {...axisHoverHandlers(kit)}>
                  <span>{cl(ck)}{sorted ? (sortDir === 'asc' ? ' ↑' : ' ↓') : ''}</span>
                </th>
              )
            })}
          </tr>
        </thead>
        <tbody>
          {rowKeys.map(rk => {
            const kit = rowTip?.(rk)
            return (
            <tr key={rk}>
              <th className="env-heatmap-rowhead" title={kit ? undefined : rl(rk)}
                  style={rowHeadColor(rk) ? { color: rowHeadColor(rk) } : undefined}
                  {...axisHoverHandlers(kit)}>{rl(rk)}</th>
              {colKeys.map(ck => {
                const cell = cellMap.get(`${rk}${CELL_KEY_SEP}${ck}`)
                if (!cell || cell.value === null) {
                  return <td key={ck} className="env-heatmap-cell env-heatmap-cell--empty" />
                }
                return (
                  <td
                    key={ck}
                    className="env-heatmap-cell"
                    style={styleFor(cell.value)}
                    title={`${rl(rk)} × ${cl(ck)}\n${valueLabel(cell.value)}(n=${cell.n.toLocaleString()})`}
                  >
                    {valueLabel(cell.value)}
                  </td>
                )
              })}
            </tr>
            )
          })}
        </tbody>
      </table>
      {axisHover && (
        <div className="cal-tooltip" style={weaponKitTipStyle(axisHover.mx, axisHover.my)}>
          <WeaponKitTipBody {...axisHover.tip} />
        </div>
      )}
    </div>
  )
}
