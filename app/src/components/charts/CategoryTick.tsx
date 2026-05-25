import type { CSSProperties } from 'react'

/**
 * Recharts XAxis 用のカスタム tick レンダラ。
 *
 * - `images.has(value)` のときは武器アイコン等の画像を描く
 *   - デフォルト 32px、ホバー時（activeIndex===index）は hoverSize（既定 64px）に拡大
 *   - 画像底辺の y は固定（y+36）。サイズ変化で「上に伸びる」アニメーションになるよう offset を計算
 * - 無いときはテキストラベル（`tickAngle` 指定で 30° などの斜め配置に対応）
 *
 * activeIndex/onHoverIndex を渡すと、tick のホバーが親 BarChart の activeIndex と
 * 双方向に同期する（tick をホバー → bar も立ち上がる、bar をホバー → tick も拡大）。
 *
 * 使い方:
 *   const [activeIndex, setActiveIndex] = useState<number | null>(null)
 *   <XAxis tick={categoryTick({ images, activeIndex, onHoverIndex: setActiveIndex })} />
 */
export function categoryTick(opts: {
  images?:        Map<string, string>
  tickAngle?:     number
  nameTransform?: (s: string) => string
  activeIndex?:   number | null
  onHoverIndex?:  (i: number | null) => void
  /** ホバー時の画像サイズ（既定 64px）。固定 4 グラフの WinRateChart と揃えている。 */
  hoverSize?:     number
  /** 非ホバー時の画像サイズ（既定 32px）。 */
  baseSize?:      number
}) {
  const {
    images, tickAngle, nameTransform,
    activeIndex, onHoverIndex,
    hoverSize = 64, baseSize = 32,
  } = opts
  return (props: any) => {
    const { x = 0, y = 0, payload, index } = props
    if (!payload) return null
    const raw = String(payload.value ?? '')
    const url = images?.get(raw)

    const idx       = typeof index === 'number' ? index : null
    const isActive  = activeIndex == null || activeIndex === idx   // 不透明 / 半透明判定
    const isHovered = activeIndex === idx                          // 拡大判定

    if (url) {
      const size   = isHovered ? hoverSize : baseSize
      const offset = -(size / 2)
      // 画像の底辺 (= tick の y + 36) を固定して、サイズが大きくなったぶん上に伸びる
      const yOff   = 36 - size
      return (
        <g
          transform={`translate(${x},${y})`}
          style={{ cursor: 'pointer', opacity: isActive ? 1 : 0.35 }}
          onMouseEnter={() => onHoverIndex?.(idx)}
          onMouseLeave={() => onHoverIndex?.(null)}
        >
          <image
            href={url}
            x={offset}
            y={yOff}
            width={size}
            height={size}
            style={{ transition: 'all 0.15s' }}
          />
        </g>
      )
    }

    const label = nameTransform ? nameTransform(raw) : raw
    const textStyle: CSSProperties = {
      fill: 'var(--text)',
      fontSize: 10,
      opacity: isActive ? 1 : 0.4,
      fontWeight: isHovered ? 700 : 400,
    }
    const handlers = {
      onMouseEnter: () => onHoverIndex?.(idx),
      onMouseLeave: () => onHoverIndex?.(null),
      style: { cursor: 'default' as const },
    }
    if (tickAngle) {
      return (
        <g transform={`translate(${x}, ${y + 4})`}>
          <text {...handlers} style={textStyle} transform={`rotate(${tickAngle})`} textAnchor="start">
            {label}
          </text>
        </g>
      )
    }
    return (
      <text {...handlers} x={x} y={y + 12} textAnchor="middle" style={textStyle}>
        {label}
      </text>
    )
  }
}
