import type { CSSProperties } from 'react'

/**
 * Recharts XAxis 用のカスタム tick レンダラ。
 *
 * - `images.has(value)` のときは武器アイコン等の画像を描く（32px 正方形）
 * - 無いときはテキストラベル（`tickAngle` 指定で 30° などの斜め配置に対応）
 *
 * 使い方: `<XAxis tick={categoryTick({ images, tickAngle, nameTransform })} />`
 */
export function categoryTick(opts: {
  images?:        Map<string, string>
  tickAngle?:     number
  nameTransform?: (s: string) => string
}) {
  const { images, tickAngle, nameTransform } = opts
  // eslint-disable-next-line react/display-name
  return (props: any) => {
    const { x = 0, y = 0, payload } = props
    if (!payload) return null
    const raw = String(payload.value ?? '')
    const url = images?.get(raw)

    if (url) {
      const size = 32
      return (
        <g transform={`translate(${x},${y})`}>
          <image
            href={url}
            x={-size / 2}
            y={4}
            width={size}
            height={size}
          />
        </g>
      )
    }

    const label = nameTransform ? nameTransform(raw) : raw
    const textStyle: CSSProperties = { fill: 'var(--text)', fontSize: 10 }
    if (tickAngle) {
      return (
        <g transform={`translate(${x}, ${y + 4})`}>
          <text style={textStyle} transform={`rotate(${tickAngle})`} textAnchor="start">
            {label}
          </text>
        </g>
      )
    }
    return (
      <text x={x} y={y + 12} textAnchor="middle" style={textStyle}>
        {label}
      </text>
    )
  }
}
