import { useCallback, useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { call, MOBILE_REFRESH_EVENT } from '../utils/backend'
import { loadWeaponImageMap } from '../utils/weaponKitImages'
import { modeLabel, ruleLabel, resultLabel, fmtKillWithAssist, fmtKillRatioWithContrib } from '../types'
import type { Filters } from '../types'
import { Dashboard } from '../components/Dashboard'
import { FilterBar, StatTile, filterArgs } from './parts'
import { winRateColor } from '../utils/heatmapColors'
import type { MobileFilter } from './parts'

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

const PAGE = 30

function fmtTime(iso: string, locale: string): string {
  return new Date(iso).toLocaleString(locale, { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })
}

/**
 * スマホのバトル画面（#791・#800）。デスクトップのバトルタブと同じく、上に 6 つの数字、
 * その下を「ダッシュボード」（デスクトップのグラフ）と「一覧」（直近のバトル）に分ける。
 */
export function BattleScreen({ filter, onFilterChange }: { filter: MobileFilter; onFilterChange: (f: MobileFilter) => void }) {
  const { t, i18n } = useTranslation()
  const en = i18n.language.startsWith('en')
  const locale = en ? 'en-US' : 'ja-JP'
  const [view, setView] = useState<'dashboard' | 'list'>('dashboard')
  const [stats, setStats] = useState<BattleStats | null>(null)
  const [battles, setBattles] = useState<BattleRow[]>([])
  const [hasMore, setHasMore] = useState(false)
  const [weaponImages, setWeaponImages] = useState<Map<string, string>>(new Map())
  const [error, setError] = useState<string | null>(null)
  const [reloadKey, setReloadKey] = useState(0)

  const addWeaponImages = useCallback(async (rows: BattleRow[]) => {
    const names = rows.map(r => r.weapon ?? '').filter(Boolean)
    const loaded = await loadWeaponImageMap(names)
    setWeaponImages(prev => new Map([...prev, ...loaded]))
  }, [])

  // 絞り込みを変えたとき・読み直しのとき
  useEffect(() => {
    let cancelled = false
    const args = filterArgs(filter)
    Promise.all([
      call<BattleStats>('db_battle_stats', args),
      call<BattleRow[]>('db_list_battles', { ...args, limit: PAGE, offset: 0 }),
    ])
      .then(([st, rows]) => {
        if (cancelled) return
        setStats(st)
        setBattles(rows)
        setHasMore(rows.length === PAGE)
        setError(null)
        void addWeaponImages(rows)
      })
      .catch(e => { if (!cancelled) setError(String(e)) })
    return () => { cancelled = true }
  }, [filter, reloadKey, addWeaponImages])

  useEffect(() => {
    const onRefresh = () => setReloadKey(k => k + 1)
    window.addEventListener(MOBILE_REFRESH_EVENT, onRefresh)
    return () => window.removeEventListener(MOBILE_REFRESH_EVENT, onRefresh)
  }, [])

  const loadMore = async () => {
    const rows = await call<BattleRow[]>('db_list_battles', {
      ...filterArgs(filter), limit: PAGE, offset: battles.length,
    })
    setBattles(prev => [...prev, ...rows])
    setHasMore(rows.length === PAGE)
    void addWeaponImages(rows)
  }

  const weaponName = (b: BattleRow) => (en ? b.weapon_name_en : b.weapon_name_ja) ?? b.weapon ?? ''
  const stageName = (b: BattleRow) => (en ? b.stage_name_en : b.stage_name) ?? b.stage_name ?? ''

  // デスクトップの Dashboard に渡す絞り込み（スマホの期間・ロビー・ルール。ほかは指定なし）
  const dashboardFilters = useMemo<Filters>(() => ({
    period: filter.period,
    mode: filter.mode,
    rule: filter.rule,
    result: null,
    weapon: [],
    stage: [],
    customFrom: null,
    customTo: null,
    seasonName: null,
  }), [filter])

  return (
    <div className="m-battle">
      <FilterBar filter={filter} onChange={onFilterChange} />

      {error && <p className="m-note m-note--error">{error}</p>}

      {/* デスクトップのバトルタブの数字のカード（6 つ）。ダッシュボードでも一覧でも出す */}
      {stats && (
        <section className="m-statcards">
          <StatTile label={t('dashboard.totalBattles')} value={stats.total.toLocaleString()} />
          <StatTile
            label={t('dashboard.winLoseDraw')}
            value={`${stats.wins} / ${stats.total - stats.wins - stats.draws} (${stats.draws})`}
          />
          <StatTile
            label={t('dashboard.overallWinRate')}
            value={stats.win_rate != null ? `${(stats.win_rate * 100).toFixed(1)}%` : '-'}
            valueColor={stats.win_rate != null ? winRateColor(stats.win_rate) : undefined}
          />
          <StatTile label={t('dashboard.avgKillAssist')} value={fmtKillWithAssist(stats.avg_kill, stats.avg_assist)} />
          <StatTile label={t('dashboard.avgDeath')} value={stats.avg_death != null ? stats.avg_death.toFixed(2) : '-'} />
          <StatTile label={t('dashboard.kdContrib')} value={fmtKillRatioWithContrib(stats.avg_kill, stats.avg_assist, stats.avg_death)} />
        </section>
      )}

      {/* デスクトップのバトルタブと同じく「ダッシュボード」「一覧」に分ける（#800） */}
      <div className="m-views" role="tablist">
        {(['dashboard', 'list'] as const).map(v => (
          <button
            key={v}
            type="button"
            role="tab"
            aria-selected={view === v}
            className={`m-view${view === v ? ' m-view--active' : ''}`}
            onClick={() => setView(v)}
          >
            {v === 'dashboard' ? `📊 ${t('mobile.viewDashboard')}` : `📋 ${t('mobile.viewList')}`}
          </button>
        ))}
      </div>

      {view === 'dashboard' && (
        // デスクトップのダッシュボードのグラフ（固定の 4 つとカスタムグラフ）。見るだけ。
        // 数字のカードは上の 6 つと同じ中身なので出さない
        <div className="m-dashboard">
          <Dashboard filters={dashboardFilters} readOnly hideStats />
        </div>
      )}

      {view === 'list' && (
      <section className="m-card m-battles">
        <h2 className="m-card__title">{t('mobile.recentBattles')}</h2>
        {battles.length === 0 && stats && <p className="m-empty">{t('mobile.noBattles')}</p>}
        {battles.map(b => {
          const r = b.result.toLowerCase()
          const img = b.weapon ? weaponImages.get(b.weapon) : undefined
          return (
            <div key={b.id} className={`m-battle-row m-battle-row--${r}`}>
              <span className={`m-result m-result--${r}`}>{resultLabel(b.result)}</span>
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
            </div>
          )
        })}
        {hasMore && (
          <button type="button" className="btn-secondary m-more" onClick={loadMore}>{t('mobile.more')}</button>
        )}
      </section>
      )}
    </div>
  )
}
