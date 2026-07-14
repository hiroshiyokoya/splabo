// タブ内のビューを切り替えるセグメンテッドコントロール（#296）。
// 「バトル」タブ（ダッシュボード / 一覧）と図鑑タブ（パネル / 一覧・#297）で共用する。

export interface ViewToggleOption<T extends string> {
  key: T
  label: string
  icon?: string
}

interface Props<T extends string> {
  options: readonly ViewToggleOption<T>[]
  value: T
  onChange: (next: T) => void
  /** スクリーンリーダー向けのグループ名。既定は「ビュー切替」。 */
  ariaLabel?: string
}

export function ViewToggle<T extends string>({
  options,
  value,
  onChange,
  ariaLabel = 'ビュー切替',
}: Props<T>) {
  return (
    <div className="view-toggle" role="group" aria-label={ariaLabel}>
      {options.map(opt => {
        const active = opt.key === value
        return (
          <button
            key={opt.key}
            type="button"
            className={`view-toggle__btn${active ? ' view-toggle__btn--active' : ''}`}
            aria-pressed={active}
            onClick={() => onChange(opt.key)}
          >
            {opt.icon && (
              <span className="view-toggle__icon" aria-hidden="true">{opt.icon}</span>
            )}
            {opt.label}
          </button>
        )
      })}
    </div>
  )
}
