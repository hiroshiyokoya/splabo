import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { call, MOBILE_REFRESH_EVENT } from '../utils/backend'
import { loadWeaponImageMap, loadStageImageMap } from '../utils/weaponKitImages'
import { modeLabel, ruleLabel, resultLabel } from '../types'
import type { Filters } from '../types'
import { Dashboard } from '../components/Dashboard'
import { FilterBar, RecordCell, pct, filterArgs } from './parts'
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
  /** ステージ別。`name` はステージの日本語名（画像もこれで引く） */
  by_stage: GroupStat[]
}

/** ステージの欄の件数と、「勝率の良いステージ」に入れる最低バトル数（ブキの詳細と同じ） */
const STAGE_TOP_N = 5
const STAGE_MIN_BATTLES = 5

const PAGE = 30

function fmtTime(iso: string, locale: string): string {
  return new Date(iso).toLocaleString(locale, { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })
}

/**
 * スマホのバトル画面（#791・設計 #784 §2）。期間で絞ったサマリと、直近のバトルの一覧。
 * データはデスクトップと同じコマンド（db_battle_stats / db_summary / db_list_battles）。
 */
export function BattleScreen({ filter, onFilterChange }: { filter: MobileFilter; onFilterChange: (f: MobileFilter) => void }) {
  const { t, i18n } = useTranslation()
  const en = i18n.language.startsWith('en')
  const locale = en ? 'en-US' : 'ja-JP'
  const [view, setView] = useState<'dashboard' | 'list'>('dashboard')
  const [stats, setStats] = useState<BattleStats | null>(null)
  const [summary, setSummary] = useState<Summary | null>(null)
  const [battles, setBattles] = useState<BattleRow[]>([])
  const [hasMore, setHasMore] = useState(false)
  const [weaponImages, setWeaponImages] = useState<Map<string, string>>(new Map())
  const [stageImages, setStageImages] = useState<Map<string, string>>(new Map())
  const [error, setError] = useState<string | null>(null)
  const [reloadKey, setReloadKey] = useState(0)

  // バトル数の多いステージ・勝率の良いステージ（5 戦以上）
  const topStages = useMemo(
    () => [...(summary?.by_stage ?? [])].sort((a, b) => b.total - a.total).slice(0, STAGE_TOP_N),
    [summary],
  )
  const bestStages = useMemo(
    () => (summary?.by_stage ?? [])
      .filter(g => g.total >= STAGE_MIN_BATTLES)
      .sort((a, b) => (b.win_rate ?? 0) - (a.win_rate ?? 0) || b.total - a.total)
      .slice(0, STAGE_TOP_N),
    [summary],
  )

  // ステージの欄に出すものだけ画像を読む。画像が無いステージを何度も読みに行かないよう、頼んだ名前を覚えておく
  const requestedStageImages = useRef(new Set<string>())
  useEffect(() => {
    const names = [...topStages, ...bestStages].map(g => g.name).filter(n => !requestedStageImages.current.has(n))
    if (names.length === 0) return
    names.forEach(n => requestedStageImages.current.add(n))
    void loadStageImageMap(names).then(m => setStageImages(prev => new Map([...prev, ...m])))
  }, [topStages, bestStages])

  const stageLine = (g: GroupStat) => (
    <div key={g.name} className="m-bar-row">
      <span className="m-bar-row__label m-bar-row__label--stage">
        {stageImages.get(g.name) ? <img src={stageImages.get(g.name)} alt="" /> : <span className="m-stage-blank" />}
        <span>{(en ? g.name_en : g.name_ja) ?? g.name}</span>
      </span>
      <RecordCell g={g} />
    </div>
  )

  const addWeaponImages = useCallback(async (rows: { weapon?: string | null; name?: string }[]) => {
    const names = rows.map(r => r.weapon ?? r.name ?? '').filter(Boolean)
    const loaded = await loadWeaponImageMap(names)
    setWeaponImages(prev => new Map([...prev, ...loaded]))
  }, [])

  // 絞り込みを変えたとき・読み直しのとき
  useEffect(() => {
    let cancelled = false
    const args = filterArgs(filter)
    Promise.all([
      call<BattleStats>('db_battle_stats', args),
      call<Summary>('db_summary', args),
      call<BattleRow[]>('db_list_battles', { ...args, limit: PAGE, offset: 0 }),
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

      {view === 'dashboard' && <>
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
              <RecordCell g={g} />
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
              <RecordCell g={g} />
            </div>
          ))}
        </section>
      )}

      {topStages.length > 0 && (
        <section className="m-card">
          <h2 className="m-card__title">{t('mobile.topStages', { n: STAGE_TOP_N })}</h2>
          {topStages.map(g => stageLine(g))}
        </section>
      )}

      {summary && summary.by_stage.length > 0 && (
        <section className="m-card">
          <h2 className="m-card__title">
            {t('mobile.bestStages', { n: STAGE_TOP_N })}
            <span className="m-card__note">{t('mobile.minBattles', { n: STAGE_MIN_BATTLES })}</span>
          </h2>
          {bestStages.length === 0 && <p className="m-empty">{t('mobile.noMinBattles', { n: STAGE_MIN_BATTLES })}</p>}
          {bestStages.map(g => stageLine(g))}
        </section>
      )}

      {/* デスクトップのダッシュボードのグラフ（固定の 4 つとカスタムグラフ）。見るだけ。
          数字のカードはスマホの上のサマリと同じ中身なので出さない */}
      <div className="m-dashboard">
        <Dashboard filters={dashboardFilters} readOnly hideStats />
      </div>
      </>}

      {view === 'list' && (
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
      )}
    </div>
  )
}
