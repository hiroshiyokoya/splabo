import { useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { call, MOBILE_REFRESH_EVENT } from '../utils/backend'
import { loadStageImageMap, loadWeaponImageMap } from '../utils/weaponKitImages'
import { ruleLabel, fmtOfficialWinRate } from '../types'
import type { GroupedStatsRow, StageRecord } from '../types'
import { groupedStatsDisplayName } from '../i18n/displayName'
import { RecordCell, FilterBar, useDetail, DetailHeader, StatTile, SortSelect, sortBook, pct, filterArgs } from './parts'
import type { BookSort, MobileFilter } from './parts'

/** 「勝率の良いブキ」に入れる最低バトル数と件数（デスクトップの StageDetailModal と同じ） */
const WEAPON_MIN_BATTLES = 5
const WEAPON_TOP_N = 5

/** 公式の通算勝率（ルール → StageRecord の列） */
const OFFICIAL_RULES: { rule: string; pick: (r: StageRecord) => number | null }[] = [
  { rule: 'turf_war', pick: r => r.win_rate_tw },
  { rule: 'area', pick: r => r.win_rate_ar },
  { rule: 'yagura', pick: r => r.win_rate_lf },
  { rule: 'hoko', pick: r => r.win_rate_gl },
  { rule: 'asari', pick: r => r.win_rate_cl },
]

function fmtNum(n: number | null | undefined): string {
  return n == null ? '-' : Math.round(n).toLocaleString()
}

/**
 * スマホのステージ画面（#801）。デスクトップの「ステージ」タブの簡略版。
 * 一覧（期間内に遊んだステージ・3 つの並び替え）→ タップで詳細。
 */
export function StageScreen({ filter, onFilterChange }: { filter: MobileFilter; onFilterChange: (f: MobileFilter) => void }) {
  const { t, i18n } = useTranslation()
  const locale = i18n.language.startsWith('en') ? 'en' : 'ja'
  const [stats, setStats] = useState<GroupedStatsRow[] | null>(null)
  const [official, setOfficial] = useState<Map<string, StageRecord>>(new Map())
  const [images, setImages] = useState<Map<string, string>>(new Map())
  const [sort, setSort] = useState<BookSort>('total')
  const [error, setError] = useState<string | null>(null)
  const [reloadKey, setReloadKey] = useState(0)
  const detail = useDetail<string>()

  // 公式の通算勝率（全期間）。デスクトップと同じく stage_id はステージの日本語名
  useEffect(() => {
    call<StageRecord[]>('db_list_stage_records')
      .then(list => setOfficial(new Map(list.map(r => [r.stage_id, r]))))
      .catch(() => setOfficial(new Map()))
  }, [reloadKey])

  useEffect(() => {
    let cancelled = false
    call<GroupedStatsRow[]>('db_grouped_stats', { groupBy: 'stage', ...filterArgs(filter) })
      .then(rows => {
        if (cancelled) return
        setStats(rows)
        setError(null)
        // ステージ画像は日本語名で引く（デスクトップの StageBook と同じ）
        void loadStageImageMap(rows.map(r => r.name)).then(m => {
          if (!cancelled) setImages(prev => new Map([...prev, ...m]))
        })
      })
      .catch(e => { if (!cancelled) setError(String(e)) })
    return () => { cancelled = true }
  }, [filter, reloadKey])

  useEffect(() => {
    const onRefresh = () => setReloadKey(k => k + 1)
    window.addEventListener(MOBILE_REFRESH_EVENT, onRefresh)
    return () => window.removeEventListener(MOBILE_REFRESH_EVENT, onRefresh)
  }, [])

  const shown = useMemo(
    () => sortBook((stats ?? []).filter(s => s.total > 0), sort, groupedStatsDisplayName, locale),
    [stats, sort, locale],
  )

  const selectedRow = detail.selected ? shown.find(r => r.key === detail.selected) : undefined
  if (detail.selected) {
    return (
      <div className="m-book">
        <FilterBar filter={filter} onChange={onFilterChange} />
        {selectedRow
          ? (
            <StageDetail
              row={selectedRow}
              image={images.get(selectedRow.name)}
              official={official.get(selectedRow.name) ?? null}
              filter={filter}
              onBack={detail.close}
            />
          )
          : <DetailHeader title={detail.selected} onBack={detail.close} />}
        {!selectedRow && stats && <p className="m-empty">{t('mobile.noBattlesInPeriod')}</p>}
      </div>
    )
  }

  return (
    <div className="m-book">
      <FilterBar filter={filter} onChange={onFilterChange}>
        <SortSelect value={sort} onChange={setSort} />
      </FilterBar>
      {error && <p className="m-note m-note--error">{error}</p>}
      <section className="m-card">
        {stats && shown.length === 0 && <p className="m-empty">{t('mobile.noBattlesInPeriod')}</p>}
        {shown.map(r => (
          <button key={r.key} type="button" className="m-bar-row m-book-row" onClick={() => detail.open(r.key)}>
            <span className="m-bar-row__label m-bar-row__label--stage">
              {images.get(r.name) ? <img src={images.get(r.name)} alt="" /> : <span className="m-stage-blank" />}
              <span>{groupedStatsDisplayName(r)}</span>
            </span>
            <RecordCell g={r} />
          </button>
        ))}
      </section>
    </div>
  )
}

/** ステージの詳細（デスクトップの StageDetailModal の簡略版） */
function StageDetail({ row, image, official, filter, onBack }: {
  row: GroupedStatsRow
  image?: string
  official: StageRecord | null
  filter: MobileFilter
  onBack: () => void
}) {
  const { t } = useTranslation()
  const [rules, setRules] = useState<GroupedStatsRow[]>([])
  const [weapons, setWeapons] = useState<GroupedStatsRow[]>([])
  const [weaponImages, setWeaponImages] = useState<Map<string, string>>(new Map())

  // 絞り込みを変えたら詳細を開いたまま読み直す
  useEffect(() => {
    let cancelled = false
    const args = { ...filterArgs(filter), stage: row.key }
    Promise.all([
      call<GroupedStatsRow[]>('db_grouped_stats', { groupBy: 'rule', ...args }),
      call<GroupedStatsRow[]>('db_grouped_stats', { groupBy: 'weapon', ...args }),
    ])
      .then(([r, w]) => {
        if (cancelled) return
        setRules(r)
        setWeapons(w)
        void loadWeaponImageMap(w.map(x => x.key)).then(m => { if (!cancelled) setWeaponImages(m) })
      })
      .catch(() => {})
    return () => { cancelled = true }
  }, [row.key, filter])

  const mostUsed = [...weapons].sort((a, b) => b.total - a.total).slice(0, WEAPON_TOP_N)
  const best = weapons
    .filter(w => w.total >= WEAPON_MIN_BATTLES)
    .sort((a, b) => b.win_rate - a.win_rate || b.total - a.total)
    .slice(0, WEAPON_TOP_N)

  const weaponLine = (w: GroupedStatsRow) => (
    <div key={w.key} className="m-bar-row">
      <span className="m-bar-row__label m-bar-row__label--weapon">
        {weaponImages.get(w.key) ? <img src={weaponImages.get(w.key)} alt="" /> : <span className="m-icon-blank" />}
        <span>{groupedStatsDisplayName(w)}</span>
      </span>
      <RecordCell g={w} />
    </div>
  )

  return (
    <>
      <DetailHeader title={groupedStatsDisplayName(row)} onBack={onBack} />
      {image && <img className="m-stage-hero" src={image} alt="" />}

      <section className="m-card">
        <div className="m-tiles">
          <StatTile label={t('mobile.winRate')} value={pct(row.win_rate)} />
          <StatTile label={t('mobile.battles')} value={t('mobile.record', { total: row.total, wins: row.wins, losses: row.total - row.wins - row.draws })} />
          <StatTile label={t('mobile.avgKadShort')} value={`${(row.avg_kill ?? 0).toFixed(1)}(${(row.avg_assist ?? 0).toFixed(1)}) / ${(row.avg_death ?? 0).toFixed(1)}`} />
          <StatTile label={t('books.avgInked')} value={fmtNum(row.avg_inked)} />
        </div>
      </section>

      {official && (
        <section className="m-card">
          <h2 className="m-card__title">{t('books.official')}<span className="m-card__note">{t('mobile.allTime')}</span></h2>
          <div className="m-tiles">
            {OFFICIAL_RULES.map(o => (
              <StatTile key={o.rule} label={ruleLabel(o.rule)} value={fmtOfficialWinRate(o.pick(official))} />
            ))}
          </div>
        </section>
      )}

      {rules.length > 0 && (
        <section className="m-card">
          <h2 className="m-card__title">{t('mobile.byRule')}</h2>
          {rules.map(g => (
            <div key={g.key} className="m-bar-row">
              <span className="m-bar-row__label">{ruleLabel(g.key)}</span>
              <span className="m-bar"><span className="m-bar__fill" style={{ width: `${Math.round(g.win_rate * 100)}%` }} /></span>
              <RecordCell g={g} />
            </div>
          ))}
        </section>
      )}

      <section className="m-card">
        <h2 className="m-card__title">{t('mobile.mostUsedWeapons', { n: WEAPON_TOP_N })}</h2>
        {mostUsed.map(weaponLine)}
      </section>

      <section className="m-card">
        <h2 className="m-card__title">
          {t('mobile.bestWeapons', { n: WEAPON_TOP_N })}
          <span className="m-card__note">{t('mobile.minBattles', { n: WEAPON_MIN_BATTLES })}</span>
        </h2>
        {best.length === 0 && <p className="m-empty">{t('mobile.noMinBattles', { n: WEAPON_MIN_BATTLES })}</p>}
        {best.map(weaponLine)}
      </section>
    </>
  )
}
