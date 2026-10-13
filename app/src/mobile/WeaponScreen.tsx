import { useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { call, MOBILE_REFRESH_EVENT } from '../utils/backend'
import { loadWeaponImageMap, loadSubSpImageMaps } from '../utils/weaponKitImages'
import { ruleLabel, METRIC_LABELS, fmtOfficialDate } from '../types'
import type { GroupedStatsRow, WeaponRecord } from '../types'
import {
  groupedStatsDisplayName, weaponCategoryDisplayName, subWeaponDisplayName, specialWeaponDisplayName,
} from '../i18n/displayName'
import {
  RecordCell, FilterBar, MultiFilter, useDetail, DetailHeader, StatTile, SortSelect, sortBook, pct, filterArgs,
} from './parts'
import type { BookSort, MobileFilter } from './parts'

/** 「勝率の良いステージ」に入れる最低バトル数と件数（デスクトップの WeaponDetailModal と同じ） */
const STAGE_MIN_BATTLES = 5
const STAGE_TOP_N = 5

/** 一覧の 1 行: 期間内の集計 + ブキの情報（ブキ種・サブ・スペシャル・公式の記録） */
interface WeaponRow extends GroupedStatsRow {
  record: WeaponRecord | undefined
}

function fmtNum(n: number | null | undefined): string {
  return n == null ? '-' : Math.round(n).toLocaleString()
}

/**
 * スマホのブキ画面（#801）。デスクトップの「ブキ」タブの簡略版。
 * 一覧（期間内に使ったブキ・ブキ種で絞る・3 つの並び替え）→ タップで詳細。
 */
export function WeaponScreen({ filter, onFilterChange }: { filter: MobileFilter; onFilterChange: (f: MobileFilter) => void }) {
  const { t, i18n } = useTranslation()
  const locale = i18n.language.startsWith('en') ? 'en' : 'ja'
  const [records, setRecords] = useState<WeaponRecord[]>([])
  const [stats, setStats] = useState<GroupedStatsRow[] | null>(null)
  const [images, setImages] = useState<Map<string, string>>(new Map())
  const [selectedCategories, setSelectedCategories] = useState<string[]>([])
  const [sort, setSort] = useState<BookSort>('total')
  const [error, setError] = useState<string | null>(null)
  const [reloadKey, setReloadKey] = useState(0)
  const detail = useDetail<string>()

  // ブキの情報（全期間・公式の記録を含む）
  useEffect(() => {
    call<WeaponRecord[]>('db_list_weapons').then(setRecords).catch(() => setRecords([]))
  }, [reloadKey])

  // 絞り込み（期間・ロビー・ルール）での集計
  useEffect(() => {
    let cancelled = false
    call<GroupedStatsRow[]>('db_grouped_stats', { groupBy: 'weapon', ...filterArgs(filter) })
      .then(rows => {
        if (cancelled) return
        setStats(rows)
        setError(null)
        void loadWeaponImageMap(rows.map(r => r.key)).then(m => {
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

  const rows = useMemo<WeaponRow[]>(() => {
    const byKey = new Map(records.map(r => [r.name, r]))
    return (stats ?? []).filter(s => s.total > 0).map(s => ({ ...s, record: byKey.get(s.key) }))
  }, [stats, records])

  // ブキ種の選択肢は、これまでに使ったことのあるブキから作る（絞り込みで選択肢が消えないように）
  const categoryOptions = useMemo(
    () => [...new Set(records.filter(r => r.total > 0).map(r => r.category).filter(Boolean))].sort(),
    [records],
  )

  const shown = useMemo(
    () => sortBook(
      rows.filter(r => selectedCategories.length === 0 || selectedCategories.includes(r.record?.category ?? '')),
      sort, groupedStatsDisplayName, locale,
    ),
    [rows, selectedCategories, sort, locale],
  )

  const selectedRow = detail.selected ? rows.find(r => r.key === detail.selected) : undefined
  if (detail.selected) {
    return (
      <div className="m-book">
        <FilterBar filter={filter} onChange={onFilterChange} />
        {selectedRow
          ? <WeaponDetail row={selectedRow} image={images.get(selectedRow.key)} filter={filter} onBack={detail.close} />
          : <DetailHeader title={detail.selected} onBack={detail.close} />}
        {!selectedRow && stats && <p className="m-empty">{t('mobile.noBattlesInPeriod')}</p>}
      </div>
    )
  }

  return (
    <div className="m-book">
      <FilterBar filter={filter} onChange={onFilterChange}>
        <MultiFilter
          values={selectedCategories}
          allLabel={t('mobile.allCategories')}
          options={categoryOptions.map(c => ({ key: c, label: weaponCategoryDisplayName(c) }))}
          onChange={setSelectedCategories}
          ariaLabel={t('mobile.category')}
        />
        <SortSelect value={sort} onChange={setSort} />
      </FilterBar>
      {error && <p className="m-note m-note--error">{error}</p>}
      <section className="m-card">
        {stats && shown.length === 0 && <p className="m-empty">{t('mobile.noBattlesInPeriod')}</p>}
        {shown.map(r => (
          <button key={r.key} type="button" className="m-bar-row m-book-row" onClick={() => detail.open(r.key)}>
            <span className="m-bar-row__label m-bar-row__label--weapon">
              {images.get(r.key) ? <img src={images.get(r.key)} alt="" /> : <span className="m-icon-blank" />}
              <span>{groupedStatsDisplayName(r)}</span>
            </span>
            <RecordCell g={r} />
          </button>
        ))}
      </section>
    </div>
  )
}

/** ブキの詳細（デスクトップの WeaponDetailModal の簡略版） */
function WeaponDetail({ row, image, filter, onBack }: { row: WeaponRow; image?: string; filter: MobileFilter; onBack: () => void }) {
  const { t } = useTranslation()
  const [rules, setRules] = useState<GroupedStatsRow[]>([])
  const [stages, setStages] = useState<GroupedStatsRow[]>([])
  const [subSp, setSubSp] = useState<{ sub?: string; sp?: string }>({})
  const rec = row.record

  // 絞り込みを変えたら詳細を開いたまま読み直す
  useEffect(() => {
    let cancelled = false
    const args = { ...filterArgs(filter), weapon: row.key }
    Promise.all([
      call<GroupedStatsRow[]>('db_grouped_stats', { groupBy: 'rule', ...args }),
      call<GroupedStatsRow[]>('db_grouped_stats', { groupBy: 'stage', ...args }),
    ])
      .then(([r, s]) => { if (!cancelled) { setRules(r); setStages(s) } })
      .catch(() => {})
    return () => { cancelled = true }
  }, [row.key, filter])

  useEffect(() => {
    if (!rec) return
    void loadSubSpImageMaps([rec]).then(({ subImages, spImages }) => setSubSp({
      sub: rec.sub_weapon ? subImages.get(rec.sub_weapon) : undefined,
      sp: rec.special_weapon ? spImages.get(rec.special_weapon) : undefined,
    }))
  }, [rec])

  const bestStages = stages
    .filter(s => s.total >= STAGE_MIN_BATTLES)
    .sort((a, b) => b.win_rate - a.win_rate || b.total - a.total)
    .slice(0, STAGE_TOP_N)
  const hasOfficial = rec && (rec.weapon_level != null || rec.win_count_total != null || rec.weapon_power != null)

  return (
    <>
      <DetailHeader title={groupedStatsDisplayName(row)} onBack={onBack}>
        {image && <img className="m-detail-head__icon" src={image} alt="" />}
      </DetailHeader>
      {rec && (rec.sub_weapon || rec.special_weapon) && (
        <div className="m-kit">
          {rec.sub_weapon && (
            <span className="m-kit__item">
              {subSp.sub && <img src={subSp.sub} alt="" />}{subWeaponDisplayName(rec.sub_weapon)}
            </span>
          )}
          {rec.special_weapon && (
            <span className="m-kit__item">
              {subSp.sp && <img src={subSp.sp} alt="" />}{specialWeaponDisplayName(rec.special_weapon)}
            </span>
          )}
        </div>
      )}

      <section className="m-card">
        <div className="m-tiles">
          <StatTile label={t('mobile.winRate')} value={pct(row.win_rate)} />
          <StatTile label={t('mobile.battles')} value={t('mobile.record', { total: row.total, wins: row.wins, losses: row.total - row.wins - row.draws })} />
          <StatTile label={t('mobile.avgKadShort')} value={`${(row.avg_kill ?? 0).toFixed(1)}(${(row.avg_assist ?? 0).toFixed(1)}) / ${(row.avg_death ?? 0).toFixed(1)}`} />
          <StatTile label={t('books.avgInked')} value={fmtNum(row.avg_inked)} />
        </div>
      </section>

      {hasOfficial && rec && (
        <section className="m-card">
          <h2 className="m-card__title">{t('books.official')}<span className="m-card__note">{t('mobile.allTime')}</span></h2>
          <div className="m-tiles">
            <StatTile label={METRIC_LABELS.official_weapon_level} value={rec.weapon_level != null ? String(rec.weapon_level) : '-'} />
            <StatTile label={METRIC_LABELS.official_win_count} value={fmtNum(rec.win_count_total)} />
            <StatTile label={t('books.powerNow')} value={fmtNum(rec.weapon_power)} />
            <StatTile label={t('books.powerMax')} value={fmtNum(rec.weapon_power_max)} />
            <StatTile label={METRIC_LABELS.official_last_used_at} value={fmtOfficialDate(rec.last_used_at)} />
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
        <h2 className="m-card__title">
          {t('mobile.bestStages', { n: STAGE_TOP_N })}
          <span className="m-card__note">{t('mobile.minBattles', { n: STAGE_MIN_BATTLES })}</span>
        </h2>
        {bestStages.length === 0 && <p className="m-empty">{t('mobile.noMinBattles', { n: STAGE_MIN_BATTLES })}</p>}
        {bestStages.map(s => (
          <div key={s.key} className="m-bar-row">
            <span className="m-bar-row__label m-bar-row__label--wide">{groupedStatsDisplayName(s)}</span>
            <RecordCell g={s} />
          </div>
        ))}
      </section>
    </>
  )
}
