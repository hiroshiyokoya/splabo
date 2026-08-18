// タブ内のビューを切り替えるセグメンテッドコントロール（#296）。
// 「バトル」タブ（ダッシュボード / 一覧）とブキ・ステージタブ（パネル / 一覧・#297）で共用する。

import { useTranslation } from 'react-i18next'
import type { TFunction } from 'i18next'
import type { BookView } from '../types'

export interface ViewToggleOption<T extends string> {
  key: T
  label: string
  icon?: string
}

/** ブキ・ステージ共通のビュー切替（#297）。 */
export function getBookViews(t: TFunction): readonly ViewToggleOption<BookView>[] {
  return [
    { key: 'panel', label: t('books.panel'), icon: '🖼' },
    { key: 'list',  label: t('books.list'),   icon: '📋' },
  ]
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
  ariaLabel,
}: Props<T>) {
  const { t } = useTranslation()
  const groupLabel = ariaLabel ?? t('books.viewAria')
  return (
    <div className="view-toggle" role="group" aria-label={groupLabel}>
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
