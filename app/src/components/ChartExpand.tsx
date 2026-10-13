import { useTranslation } from 'react-i18next'

/**
 * スマホ Web 版（#800）でグラフを「大きく見る」ための指定。デスクトップでは渡さない。
 *
 * - `expanded`: いま画面いっぱいに広げているか（カードに `chart-card--expanded` を付ける）
 * - `onExpand` / `onCollapse`: 広げる・閉じる（履歴の扱いは Dashboard が持つ）
 */
export interface ChartExpandProps {
  expanded?: boolean
  onExpand?: () => void
  onCollapse?: () => void
}

/** 「大きく見る」/「閉じる」ボタン。`onExpand` が無ければ何も出さない */
export function ChartExpandButton({ expanded, onExpand, onCollapse }: ChartExpandProps) {
  const { t } = useTranslation()
  if (!onExpand) return null
  return expanded ? (
    <button type="button" className="chart-expand-btn" onClick={onCollapse} aria-label={t('common.close')}>✕</button>
  ) : (
    <button type="button" className="chart-expand-btn" onClick={onExpand} aria-label={t('chart.expand')} title={t('chart.expand')}>⤢</button>
  )
}
