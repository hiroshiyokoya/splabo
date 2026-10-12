import { useCallback, useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { call, MOBILE_REFRESH_EVENT } from '../utils/backend'
import { loadWeaponImageMap } from '../utils/weaponKitImages'
import { modeLabel, ruleLabel, resultLabel, periodToSince, type Period } from '../types'

/** db_list_battles の 1 行（スマホで使う分だけ） */
interface BattleRow {
  id: string
  played_at: string
  mode: string
  rule: string | null
  result: string
  knockout: string | null
  kill: number | null
  assist: number | null
  death: number | null
  special: number | null
  weapon: string | null
  weapon_name_ja: string | null
  weapon_name_en: string | null
  stage_name: string | null
  stage_name_en: string | null
}

/** db_battle_stats の戻り値 */
interface BattleStats {
  total: number
  wins: number
  draws: number
  win_rate: number | null
  avg_kill: number | null
  avg_death: number | null
  avg_assist: number | null
}

/** db_summary の各グループ */
interface GroupStat {
  name: string
  name_ja?: string | null
  name_en?: string | null
  total: number
  wins: number
  draws: number
  win_rate: number | null
}

interface Summary {
  by_rule: GroupStat[]
  by_weapon: GroupStat[]
}

const PAGE = 30
const PERIODS: Period[] = ['7d', '30d', 'current_season', 'all']

function pct(rate: number | null | undefined): string {
  return rate == null ? '—' : `${Math.round(rate * 100)}%`
}

function fmtTime(iso: string, locale: string): string {
  return new Date(iso).toLocaleString(locale, { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })
}

/**
 * スマホのバトル画面（#791・設計 #784 §2）。期間で絞ったサマリと、直近のバトルの一覧。
 * データはデスクトップと同じコマンド（db_battle_stats / db_summary / db_list_battles）。
 */
export function BattleScreen() {
  const { t, i18n } = useTranslation()
  const en = i18n.language.startsWith('en')
  const locale = en ? 'en-US' : 'ja-JP'
  const [period, setPeriod] = useState<Period>('7d')
  const [stats, setStats] = useState<BattleStats | null>(null)
  const [summary, setSummary] = useState<Summary | null>(null)
  const [battles, setBattles] = useState<BattleRow[]>([])
  const [hasMore, setHasMore] = useState(false)
  const [weaponImages, setWeaponImages] = useState<Map<string, string>>(new Map())
  const [error, setError] = useState<string | null>(null)
  const [reloadKey, setReloadKey] = useState(0)

  const addWeaponImages = useCallback(async (rows: { weapon?: string | null; name?: string }[]) => {
    const names = rows.map(r => r.weapon ?? r.name ?? '').filter(Boolean)
    const loaded = await loadWeaponImageMap(names)
    setWeaponImages(prev => new Map([...prev, ...loaded]))
  }, [])

  // 期間を変えたとき・読み直しのとき
  useEffect(() => {
    let cancelled = false
    const since = periodToSince(period)
    const filter = { since, until: null }
    Promise.all([
      call<BattleStats>('db_battle_stats', filter),
      call<Summary>('db_summary', filter),
      call<BattleRow[]>('db_list_battles', { ...filter, limit: PAGE, offset: 0 }),
    ])
      .then(([st, sm, rows]) => {
        if (cancelled) return
        setStats(st)
        setSummary(sm)
        setBattles(rows)
        setHasMore(rows.length === PAGE)
        setError(null)
        void addWeaponImages([...rows, ...sm.by_weapon.slice(0, 5)])
      })
      .catch(e => { if (!cancelled) setError(String(e)) })
    return () => { cancelled = true }
  }, [period, reloadKey, addWeaponImages])

  useEffect(() => {
    const onRefresh = () => setReloadKey(k => k + 1)
    window.addEventListener(MOBILE_REFRESH_EVENT, onRefresh)
    return () => window.removeEventListener(MOBILE_REFRESH_EVENT, onRefresh)
  }, [])

  const loadMore = async () => {
    const rows = await call<BattleRow[]>('db_list_battles', {
      since: periodToSince(period), until: null, limit: PAGE, offset: battles.length,
    })
    setBattles(prev => [...prev, ...rows])
    setHasMore(rows.length === PAGE)
    void addWeaponImages(rows)
  }

  const weaponName = (b: BattleRow) => (en ? b.weapon_name_en : b.weapon_name_ja) ?? b.weapon ?? ''
  const stageName = (b: BattleRow) => (en ? b.stage_name_en : b.stage_name) ?? b.stage_name ?? ''

  return (
    <div className="m-battle">
      <div className="m-periods" role="tablist">
        {PERIODS.map(p => (
          <button
            key={p}
            type="button"
            className={`m-period${period === p ? ' m-period--active' : ''}`}
            onClick={() => setPeriod(p)}
          >
            {t(`mobile.period.${p}`)}
          </button>
        ))}
      </div>

      {error && <p className="m-note m-note--error">{error}</p>}

      {stats && (
        <section className="m-card m-stats">
          <div className="m-stats__main">
            <span className="m-stats__rate">{pct(stats.win_rate)}</span>
            <span className="m-stats__label">{t('mobile.winRate')}</span>
          </div>
          <div className="m-stats__sub">
            <span>{t('mobile.battlesCount', { count: stats.total })}</span>
            <span>{t('mobile.winsLosses', { wins: stats.wins, losses: stats.total - stats.wins - stats.draws })}</span>
            <span>
              {t('mobile.avgKda', {
                k: (stats.avg_kill ?? 0).toFixed(1),
                a: (stats.avg_assist ?? 0).toFixed(1),
                d: (stats.avg_death ?? 0).toFixed(1),
              })}
            </span>
          </div>
        </section>
      )}

      {summary && summary.by_rule.length > 0 && (
        <section className="m-card">
          <h2 className="m-card__title">{t('mobile.byRule')}</h2>
          {summary.by_rule.map(g => (
            <div key={g.name} className="m-bar-row">
              <span className="m-bar-row__label">{ruleLabel(g.name)}</span>
              <span className="m-bar">
                <span className="m-bar__fill" style={{ width: `${Math.round((g.win_rate ?? 0) * 100)}%` }} />
              </span>
              <span className="m-bar-row__value">{pct(g.win_rate)}</span>
              <span className="m-bar-row__count">{g.total}</span>
            </div>
          ))}
        </section>
      )}

      {summary && summary.by_weapon.length > 0 && (
        <section className="m-card">
          <h2 className="m-card__title">{t('mobile.topWeapons')}</h2>
          {summary.by_weapon.slice(0, 5).map(g => (
            <div key={g.name} className="m-bar-row">
              <span className="m-bar-row__label m-bar-row__label--weapon">
                {weaponImages.get(g.name) && <img src={weaponImages.get(g.name)} alt="" />}
                <span>{(en ? g.name_en : g.name_ja) ?? g.name}</span>
              </span>
              <span className="m-bar-row__value">{pct(g.win_rate)}</span>
              <span className="m-bar-row__count">{g.total}</span>
            </div>
          ))}
        </section>
      )}

      <section className="m-card m-battles">
        <h2 className="m-card__title">{t('mobile.recentBattles')}</h2>
        {battles.length === 0 && stats && <p className="m-empty">{t('mobile.noBattles')}</p>}
        {battles.map(b => {
          const r = b.result.toLowerCase()
          const img = b.weapon ? weaponImages.get(b.weapon) : undefined
          return (
            <div key={b.id} className={`m-battle-row m-battle-row--${r}`}>
              <span className="m-battle-row__weapon">
                {img ? <img src={img} alt={weaponName(b)} /> : null}
              </span>
              <span className="m-battle-row__body">
                <span className="m-battle-row__line1">
                  {b.rule ? ruleLabel(b.rule) : modeLabel(b.mode)} · {stageName(b)}
                </span>
                <span className="m-battle-row__line2">
                  {modeLabel(b.mode)} · {fmtTime(b.played_at, locale)}
                </span>
              </span>
              <span className="m-battle-row__kda">
                {b.kill ?? 0}<small>({b.assist ?? 0})</small>/{b.death ?? 0}
              </span>
              <span className={`m-result m-result--${r}`}>{resultLabel(b.result)}</span>
            </div>
          )
        })}
        {hasMore && (
          <button type="button" className="btn-secondary m-more" onClick={loadMore}>{t('mobile.more')}</button>
        )}
      </section>
    </div>
  )
}
