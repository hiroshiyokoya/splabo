import type { ReactNode } from 'react'

/**
 * activeIndex 連動のツールチップオーバーレイ。
 *
 * Recharts の `<Tooltip>` はプロット領域内へのマウスホバーにしか反応しないため、
 * X 軸アイコン（ティック領域）のホバーではツールチップが出ない。
 * このコンポーネントは `activeIndex` に応じて自前で絶対配置のツールチップを描き、
 * 「アイコンホバー → 上にツールチップ」「バーホバー → 上にツールチップ」の両方を実現する。
 *
 * 親要素を `position: relative` にしておくこと（`.chart-hover-area` を使う想定）。
 *
 * X 位置はチャートカード幅に対するパーセンテージ計算：
 *   left = leftPad + (containerWidth - leftPad - rightPad) * (idx + 0.5) / dataLength
 * `leftPad`・`rightPad` には YAxis や右マージン分の px を渡す。
 */
export function HoverTooltip({
  activeIndex, dataLength, leftPad, rightPad, top = 6, children, ratio,
}: {
  activeIndex: number | null
  dataLength:  number
  leftPad:     number
  rightPad:    number
  /** ツールチップを置く Y 位置（カード上端からの px）。 */
  top?:        number
  children:    ReactNode
  /**
   * プロット領域幅に対する 0–1 の位置比率を直接指定する（#436）。
   *
   * 実時間軸（timestamp の number 軸）では、点の pixel 位置は index に比例しない
   * （month バケットは可変長・欠測バケットの null 埋め有無で間隔が変わる）ため、
   * index/dataLength の比率計算では位置がズレる。呼び出し側が実際の x 位置比率を
   * 計算して渡せば、それを直接使う。未指定時は従来どおり等間隔インデックス前提の計算。
   */
  ratio?:      number
}) {
  if (activeIndex == null || dataLength === 0) return null
  const frac = ratio ?? (activeIndex + 0.5) / dataLength
  return (
    <div
      className="chart-hover-tooltip"
      style={{
        top,
        left: `calc(${leftPad}px + (100% - ${leftPad + rightPad}px) * ${frac})`,
      }}
    >
      {children}
    </div>
  )
}
