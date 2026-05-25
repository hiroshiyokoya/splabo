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
  activeIndex, dataLength, leftPad, rightPad, top = 6, children,
}: {
  activeIndex: number | null
  dataLength:  number
  leftPad:     number
  rightPad:    number
  /** ツールチップを置く Y 位置（カード上端からの px）。 */
  top?:        number
  children:    ReactNode
}) {
  if (activeIndex == null || dataLength === 0) return null
  const center = activeIndex + 0.5
  return (
    <div
      className="chart-hover-tooltip"
      style={{
        top,
        left: `calc(${leftPad}px + (100% - ${leftPad + rightPad}px) * ${center} / ${dataLength})`,
      }}
    >
      {children}
    </div>
  )
}
