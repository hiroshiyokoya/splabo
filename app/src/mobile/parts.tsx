import { useCallback, useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { periodToSince, modeFilterArg, ruleFilterArg } from '../types'
import type { Period } from '../types'
import { LOBBY_OPTIONS, RULE_OPTIONS } from '../utils/filterSummary'

/** バトル・ブキ・ステージで共有する期間（#801） */
export const PERIODS: Period[] = ['7d', '30d', 'current_season', 'all']

/**
 * バトル・ブキ・ステージで共有する絞り込み（#801）。殻が持ち、画面を移っても同じまま。
 * ロビー・ルールは複数選べる（空 = すべて・選んだものの OR）。値はデスクトップの FilterBar と同じキー。
 */
export interface MobileFilter {
  period: Period
  mode: string[]
  rule: string[]
}

export const DEFAULT_FILTER: MobileFilter = { period: '7d', mode: [], rule: [] }

/**
 * 選んだ絞り込みをスマホのブラウザに覚えておく（次に開いたときも同じ条件で始める）。
 * 端末ごとの好みなので PC には送らない。読めない・壊れているときは既定に戻す。
 */
const FILTER_STORAGE_KEY = 'splabo:mobileFilter'

export function loadMobileFilter(): MobileFilter {
  try {
    const raw = localStorage.getItem(FILTER_STORAGE_KEY)
    if (!raw) return DEFAULT_FILTER
    const v = JSON.parse(raw) as Partial<MobileFilter>
    const strings = (a: unknown) => (Array.isArray(a) ? a.filter((x): x is string => typeof x === 'string') : [])
    return {
      period: PERIODS.includes(v.period as Period) ? (v.period as Period) : DEFAULT_FILTER.period,
      mode: strings(v.mode),
      rule: strings(v.rule),
    }
  } catch {
    return DEFAULT_FILTER
  }
}

export function saveMobileFilter(f: MobileFilter): void {
  try {
    localStorage.setItem(FILTER_STORAGE_KEY, JSON.stringify(f))
  } catch {
    // プライベートブラウズなどで保存できなくても、その場の絞り込みは効く
  }
}

/** コマンドに渡す絞り込みの引数（デスクトップと同じ変換。ルールの turf_war → nawabari など） */
export function filterArgs(f: MobileFilter): { since: string | null; until: null; mode: string | null; rule: string | null } {
  return {
    since: periodToSince(f.period),
    until: null,
    mode: modeFilterArg(f.mode),
    rule: ruleFilterArg(f.rule),
  }
}

/**
 * 畳める複数選択（ロビー・ルール・ブキ種）。押すとチェックの一覧が開き、外側を押すと閉じる。
 * 何も選んでいなければ「すべて」。標準の `<select multiple>` はブラウザで見た目がばらつくので使わない。
 */
export function MultiFilter({ values, allLabel, options, onChange, ariaLabel }: {
  values: string[]
  allLabel: string
  options: { key: string; label: string }[]
  onChange: (v: string[]) => void
  ariaLabel: string
}) {
  const { t } = useTranslation()
  const [open, setOpen] = useState(false)
  const rootRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    const onDown = (e: PointerEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('pointerdown', onDown)
    return () => document.removeEventListener('pointerdown', onDown)
  }, [open])

  const labelOf = (key: string) => options.find(o => o.key === key)?.label ?? key
  const summary = values.length === 0
    ? allLabel
    : values.length === 1
      ? labelOf(values[0])
      : t('mobile.multiSelected', { first: labelOf(values[0]), count: values.length - 1 })
  const toggle = (key: string) =>
    onChange(values.includes(key) ? values.filter(v => v !== key) : [...values, key])

  return (
    <div className="m-multi" ref={rootRef}>
      <button
        type="button"
        className={`m-sort m-multi__button${values.length > 0 ? ' m-sort--active' : ''}`}
        onClick={() => setOpen(o => !o)}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={ariaLabel}
      >
        <span className="m-multi__summary">{summary}</span>
        <span className="m-multi__caret" aria-hidden>▾</span>
      </button>
      {open && (
        <div className="m-multi__panel" role="listbox" aria-multiselectable="true" aria-label={ariaLabel}>
          <button
            type="button"
            className={`m-multi__option${values.length === 0 ? ' m-multi__option--on' : ''}`}
            onClick={() => onChange([])}
          >
            <span className="m-multi__check" aria-hidden>{values.length === 0 ? '✓' : ''}</span>
            {allLabel}
          </button>
          {options.map(o => {
            const on = values.includes(o.key)
            return (
              <button
                key={o.key}
                type="button"
                role="option"
                aria-selected={on}
                className={`m-multi__option${on ? ' m-multi__option--on' : ''}`}
                onClick={() => toggle(o.key)}
              >
                <span className="m-multi__check" aria-hidden>{on ? '✓' : ''}</span>
                {o.label}
              </button>
            )
          })}
        </div>
      )}
    </div>
  )
}

/** 畳めるプルダウン（1 つだけ選ぶもの。今は並び替え） */
export function FilterSelect({ value, allLabel, options, onChange, ariaLabel }: {
  value: string | null
  allLabel?: string
  options: { key: string; label: string }[]
  onChange: (v: string | null) => void
  ariaLabel: string
}) {
  return (
    <select
      // 「すべて」以外で絞っているときだけ目立たせる（並び替えは絞り込みではないので対象外）
      className={`m-sort${value && allLabel !== undefined ? ' m-sort--active' : ''}`}
      value={value ?? ''}
      onChange={e => onChange(e.target.value || null)}
      aria-label={ariaLabel}
    >
      {allLabel !== undefined && <option value="">{allLabel}</option>}
      {options.map(o => <option key={o.key} value={o.key}>{o.label}</option>)}
    </select>
  )
}

/**
 * 絞り込みの帯: 期間のボタンと、ロビー・ルールのプルダウン。
 * `children` に画面ごとのプルダウン（ブキ種・並び替え）を足せる。
 */
export function FilterBar({ filter, onChange, children }: {
  filter: MobileFilter
  onChange: (f: MobileFilter) => void
  children?: React.ReactNode
}) {
  const { t } = useTranslation()
  return (
    <div className="m-filter">
      <PeriodBar period={filter.period} onChange={period => onChange({ ...filter, period })} />
      <div className="m-filter__selects">
        <MultiFilter
          values={filter.mode}
          allLabel={t('filter.allLobbies')}
          options={LOBBY_OPTIONS.map(o => ({ key: o.key, label: t(`filter.lobby_${o.key}`) }))}
          onChange={mode => onChange({ ...filter, mode })}
          ariaLabel={t('filter.lobby')}
        />
        <MultiFilter
          values={filter.rule}
          allLabel={t('filter.allRules')}
          options={RULE_OPTIONS.map(o => ({ key: o.key, label: t(`filter.rule_${o.key}`) }))}
          onChange={rule => onChange({ ...filter, rule })}
          ariaLabel={t('filter.rule')}
        />
        {children}
      </div>
    </div>
  )
}

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
export function StatTile({ label, value, valueColor }: { label: string; value: string; valueColor?: string }) {
  return (
    <div className="m-tile">
      <span className="m-tile__value" style={valueColor ? { color: valueColor } : undefined}>{value}</span>
      <span className="m-tile__label">{label}</span>
    </div>
  )
}

/** 並び替え（3 つに絞る・#801） */
export type BookSort = 'total' | 'win_rate' | 'name'

export function SortSelect({ value, onChange }: { value: BookSort; onChange: (v: BookSort) => void }) {
  const { t } = useTranslation()
  return (
    <FilterSelect
      value={value}
      options={[
        { key: 'total', label: t('mobile.sortTotal') },
        { key: 'win_rate', label: t('mobile.sortWinRate') },
        { key: 'name', label: t('mobile.sortName') },
      ]}
      onChange={v => onChange((v ?? 'total') as BookSort)}
      ariaLabel={t('mobile.sort')}
    />
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
