import { useCallback, useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { Period } from '../types'

/** バトル・ブキ・ステージで共有する期間（#801） */
export const PERIODS: Period[] = ['7d', '30d', 'current_season', 'all']

export function pct(rate: number | null | undefined): string {
  return rate == null ? '—' : `${Math.round(rate * 100)}%`
}

/** 勝率の分子・分母に使う「何戦・何勝・引き分け」 */
export interface RecordLike {
  total: number
  wins: number
  draws: number
  win_rate: number | null
}

/** 勝率と、その内訳（何戦・何勝何敗）。引き分けは勝ちにも負けにも数えない */
export function RecordCell({ g }: { g: RecordLike }) {
  const { t } = useTranslation()
  const losses = g.total - g.wins - g.draws
  return (
    <span className="m-record">
      <span className="m-record__rate">{pct(g.win_rate)}</span>
      <span className="m-record__detail">{t('mobile.record', { total: g.total, wins: g.wins, losses })}</span>
    </span>
  )
}

/** 期間の切り替え（殻が持つ値を各画面で出す） */
export function PeriodBar({ period, onChange }: { period: Period; onChange: (p: Period) => void }) {
  const { t } = useTranslation()
  return (
    <div className="m-periods" role="tablist">
      {PERIODS.map(p => (
        <button
          key={p}
          type="button"
          className={`m-period${period === p ? ' m-period--active' : ''}`}
          onClick={() => onChange(p)}
        >
          {t(`mobile.period.${p}`)}
        </button>
      ))}
    </div>
  )
}

/**
 * 一覧 → 詳細の切り替えを、ブラウザの履歴にも積む（#801）。
 * Android の戻るボタンや iPhone の戻るスワイプで詳細を閉じられるようにする。
 *
 * - `open(v)`: 詳細を開いて履歴を 1 つ積む
 * - `close()`: 画面の「戻る」ボタン。積んだ履歴を戻す（popstate で閉じる）
 */
export function useDetail<T>(): { selected: T | null; open: (v: T) => void; close: () => void } {
  const [selected, setSelected] = useState<T | null>(null)
  const pushed = useRef(false)

  useEffect(() => {
    const onPop = () => {
      pushed.current = false
      setSelected(null)
    }
    window.addEventListener('popstate', onPop)
    return () => window.removeEventListener('popstate', onPop)
  }, [])

  // 詳細を開いたまま画面を離れたら、積んだ履歴を残さない
  useEffect(() => () => {
    if (pushed.current) history.back()
  }, [])

  const open = useCallback((v: T) => {
    setSelected(v)
    if (!pushed.current) {
      history.pushState({ mobileDetail: true }, '')
      pushed.current = true
    }
    window.scrollTo(0, 0)
  }, [])

  const close = useCallback(() => {
    if (pushed.current) history.back()
    else setSelected(null)
  }, [])

  return { selected, open, close }
}

/** 詳細画面の上の「戻る」と見出し */
export function DetailHeader({ title, onBack, children }: { title: string; onBack: () => void; children?: React.ReactNode }) {
  const { t } = useTranslation()
  return (
    <div className="m-detail-head">
      <button type="button" className="m-back" onClick={onBack} aria-label={t('mobile.back')}>‹</button>
      {children}
      <span className="m-detail-head__title">{title}</span>
    </div>
  )
}

/** 小さな数値パネル（詳細のサマリ・公式の記録） */
export function StatTile({ label, value }: { label: string; value: string }) {
  return (
    <div className="m-tile">
      <span className="m-tile__value">{value}</span>
      <span className="m-tile__label">{label}</span>
    </div>
  )
}

/** 並び替え（3 つに絞る・#801） */
export type BookSort = 'total' | 'win_rate' | 'name'

export function SortSelect({ value, onChange }: { value: BookSort; onChange: (v: BookSort) => void }) {
  const { t } = useTranslation()
  return (
    <select className="m-sort" value={value} onChange={e => onChange(e.target.value as BookSort)} aria-label={t('mobile.sort')}>
      <option value="total">{t('mobile.sortTotal')}</option>
      <option value="win_rate">{t('mobile.sortWinRate')}</option>
      <option value="name">{t('mobile.sortName')}</option>
    </select>
  )
}

/** 一覧の並び替え。名前は表示名で比べる */
export function sortBook<T extends RecordLike>(rows: T[], sort: BookSort, nameOf: (r: T) => string, locale: string): T[] {
  return [...rows].sort((a, b) => {
    if (sort === 'name') return nameOf(a).localeCompare(nameOf(b), locale)
    if (sort === 'win_rate') return (b.win_rate ?? -1) - (a.win_rate ?? -1) || b.total - a.total
    return b.total - a.total || (b.win_rate ?? -1) - (a.win_rate ?? -1)
  })
}
