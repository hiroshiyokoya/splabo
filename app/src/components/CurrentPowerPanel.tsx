import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { listen } from '@tauri-apps/api/event'
import { call } from '../utils/backend'
import type { CurrentPower } from '../types'
import { ruleLabel } from '../types'

const DAY_MS = 24 * 60 * 60 * 1000

function dateLocale(lang: string): string {
  return lang.startsWith('en') ? 'en-US' : 'ja-JP'
}

/**
 * バトルタブの上のパネル（#913）。ルールごとの今の X パワー 4 枚と、今のウデマエ。
 * ダッシュボードと一覧のどちらでも出す。絞り込みには従わない。
 * どれも分からない（X マッチもバンカラもしていない）ときは出さない。
 * 値の時点はカードに重ねると出る。1 日以上前の値には「n 日前」を添える。
 */
export function CurrentPowerPanel() {
  const { t, i18n } = useTranslation()
  const [power, setPower] = useState<CurrentPower | null>(null)
  const [refreshKey, setRefreshKey] = useState(0)

  // 取得が終わったら読み直す
  useEffect(() => {
    const unlistenPromise = listen('fetch_complete', () => setRefreshKey(k => k + 1))
    return () => { unlistenPromise.then(fn => fn()) }
  }, [])

  useEffect(() => {
    call<CurrentPower>('db_current_power').then(setPower).catch(console.error)
  }, [refreshKey])

  if (!power) return null
  if (power.x_powers.every(x => x.x_power === null) && power.udemae === null) return null

  const asOf = (at: string | null) =>
    at ? t('battles.asOf', {
      time: new Date(at).toLocaleString(dateLocale(i18n.language), { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }),
    }) : undefined
  const ago = (at: string | null) => {
    if (!at) return undefined
    const days = Math.floor((Date.now() - new Date(at).getTime()) / DAY_MS)
    return days >= 1 ? t('battles.daysAgo', { n: days }) : undefined
  }

  return (
    <section className="current-power">
    <div className="current-power-title">{t('battles.currentPowerTitle')}</div>
    <div className="stat-cards stat-cards--current">
      {power.x_powers.map(x => (
        <PowerCard
          key={x.rule}
          label={`${ruleLabel(x.rule)} XP`}
          value={x.x_power !== null ? x.x_power.toFixed(1) : t('battles.notMeasured')}
          small={x.x_power === null}
          title={asOf(x.at)}
          sub={x.x_power !== null ? ago(x.at) : undefined}
        />
      ))}
      <PowerCard
        label={t('battles.currentUdemae')}
        value={power.udemae ?? '-'}
        title={asOf(power.udemae_at)}
        sub={ago(power.udemae_at)}
      />
    </div>
    </section>
  )
}

function PowerCard({ label, value, small, title, sub }: {
  label: string; value: string; small?: boolean
  /** カードに重ねたときに出す説明 */
  title?: string
  /** 値の下に小さく添える一言 */
  sub?: string
}) {
  return (
    <div className="stat-card" title={title}>
      <div className="stat-label">{label}</div>
      <div className={`stat-value${small ? ' stat-value--small' : ''}`}>{value}</div>
      {sub && <div className="stat-sub">{sub}</div>}
    </div>
  )
}
