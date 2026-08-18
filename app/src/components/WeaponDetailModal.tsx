import { useCallback, useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { TFunction } from 'i18next'
import { invoke } from '@tauri-apps/api/core'
import type { Filters, GroupedStatsRow, WeaponRecord } from '../types'
import { weaponRecordDisplayName, groupedStatsDisplayName, weaponCategoryDisplayName, subWeaponDisplayName, specialWeaponDisplayName } from '../i18n/displayName'
import { RULE_LABELS, filtersToBookDetailArgs, fmtKillRatioWithContrib, fmtOfficialDate, ruleLabel, METRIC_LABELS } from '../types'
import { winRateColor } from '../utils/heatmapColors'

/** 「勝率の良いステージ」の下限バトル数(少数サンプルによる勝率のブレを避ける)。
 *  StageDetailModal の「勝率 TOP ブキ」と同じ流儀・同じ値に揃えている。 */
const STAGE_MIN_BATTLES = 5
/** 「勝率の良いステージ」で表示する件数。 */
const STAGE_TOP_N = 5

function fmtNum(n: number | null | undefined, digits = 2): string {
  if (n === null || n === undefined) return '-'
  return n.toFixed(digits)
}

function fmtPower(n: number | null | undefined): string {
  if (n == null) return '-'
  return Math.round(n).toLocaleString()
}

/** コンパクト戦績「12戦 7勝5敗」。引き分けは 0 でないときだけ「2分」を付ける(#449)。
 *  StageDetailModal.fmtRecord と同期。 */
function fmtRecord(t: TFunction, total: number, wins: number, draws: number): string {
  const losses = total - wins - draws
  return draws > 0
    ? t('books.recordDraw', { total, wins, losses, draws })
    : t('books.record', { total, wins, losses })
}

/**
 * ブキカードをクリックして開く詳細モーダル。
 *
 * - バトル統計(バトル数 / W/L/D / 勝率 / 平均キル・デス・塗り / キルレ)は DB 集計。
 *   親 (WeaponBook) が FilterBar 済みの statsByWeapon から該当行を `stats` prop として渡す。
 *   WeaponRecord.total は全期間なので使わない。
 * - ステージ Top 5 とルール別勝率は `db_grouped_stats(group_by, weapon=ブキスラッグ)` を 2 回呼んで取得。
 *   FilterBar と同じ期間・モード・ルール・結果を載せ、対象ブキだけ上書きする。
 *   ブキスラッグは `weapons.name`(旧テーブル)= `weapon.key`(新テーブル)= stat.ink キー。
 *   FE 側で持っている `WeaponRecord.name` をそのまま `weapon` フィルタとして渡せる。
 * - 直近 30 バトルの線グラフは仕様により非実装(#149)。
 * - WeaponQuery 由来の公式アプリの数字（熟練度・通算勝利・通算塗・最終使用・チャレパワー）は取得できていれば表示する(#674)。
 */
export function WeaponDetailModal({
  weapon, image, subImage, spImage, stats, filters, onClose,
}: {
  weapon:   WeaponRecord
  image:    string | null
  subImage: string | null
  spImage:  string | null
  stats:    GroupedStatsRow | null
  filters:  Filters
  onClose:  () => void
}) {
  const { t } = useTranslation()
  const [stageRows, setStageRows] = useState<GroupedStatsRow[] | null>(null)
  const [ruleRows,  setRuleRows]  = useState<GroupedStatsRow[] | null>(null)
  const [loading,   setLoading]   = useState(true)
  const [error,     setError]     = useState<string | null>(null)

  // ESC で閉じる
  const handleKey = useCallback((e: KeyboardEvent) => {
    if (e.key === 'Escape') onClose()
  }, [onClose])
  useEffect(() => {
    window.addEventListener('keydown', handleKey)
    return () => window.removeEventListener('keydown', handleKey)
  }, [handleKey])

  // ステージ別 / ルール別の集計を並列で取得。weapon フィルタはブキスラッグ単独でパイプ区切り不要。
  useEffect(() => {
    setLoading(true)
    setError(null)
    const filterArgs = filtersToBookDetailArgs(filters, { weapon: weapon.name })
    Promise.all([
      invoke<GroupedStatsRow[]>('db_grouped_stats', { groupBy: 'stage', ...filterArgs }),
      invoke<GroupedStatsRow[]>('db_grouped_stats', { groupBy: 'rule',  ...filterArgs }),
    ])
      .then(([stages, rules]) => {
        setStageRows(stages)
        setRuleRows(rules)
      })
      .catch(err => setError(typeof err === 'string' ? err : String(err)))
      .finally(() => setLoading(false))
  }, [weapon.name, filters])

  const total          = stats?.total ?? 0
  const wins           = stats?.wins ?? 0
  const draws          = stats?.draws ?? 0
  const losses         = total - wins - draws
  const decisive       = total - draws
  const overallWinRate = decisive > 0 ? wins / decisive : null

  // ステージ Top 5(バトル数降順、既に db 側でソート済み)
  const topStages = (stageRows ?? []).slice(0, 5)

  // 勝率の良いステージ Top 5(#302)。取得済みの stageRows を使い回すので追加クエリは不要。
  // 少数サンプルで勝率が跳ねるのを避けるため STAGE_MIN_BATTLES 戦以上に絞る。
  // 勝率を算出できない(引き分けのみ等で decisive=0)ステージは除外し、
  // 同率のときはバトル数の多い方を上位にする。
  const bestStages = (stageRows ?? [])
    .filter(r => r.total >= STAGE_MIN_BATTLES)
    .map(r => {
      const dec = r.total - r.draws
      return { row: r, winRate: dec > 0 ? r.wins / dec : null }
    })
    .filter((x): x is { row: GroupedStatsRow; winRate: number } => x.winRate !== null)
    .sort((a, b) => (b.winRate - a.winRate) || (b.row.total - a.row.total))
    .slice(0, STAGE_TOP_N)
  // ルール別は 5 ルール固定順で表示(データが無いルールは試合数 0 として並べる)
  const ruleOrder = Object.keys(RULE_LABELS)
  const ruleMap = new Map((ruleRows ?? []).map(r => [r.key, r]))

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-panel weapon-detail-modal" onClick={e => e.stopPropagation()}>
        <div className="modal-header">
          <span className="modal-title-text">{weaponRecordDisplayName(weapon)}</span>
          {weapon.category && <span className="modal-meta">{weaponCategoryDisplayName(weapon.category)}</span>}
          <button className="modal-close" onClick={onClose} aria-label={t('common.close')}>✕</button>
        </div>

        <div className="modal-body">
          {/* ヘッダー：ブキ画像(大)+ サブ/SP */}
          <section className="modal-section weapon-modal-hero">
            <div className="weapon-modal-hero-icon">
              {image
                ? <img src={image} alt={weaponRecordDisplayName(weapon)} />
                : <div className="weapon-modal-hero-placeholder" />}
            </div>
            <div className="weapon-modal-hero-meta">
              {weapon.sub_weapon && (
                <div className="weapon-modal-hero-row">
                  {subImage && <img src={subImage} alt={subWeaponDisplayName(weapon.sub_weapon)} className="weapon-sub-sp-icon" />}
                  <span>{t('battles.subPrefix', { name: subWeaponDisplayName(weapon.sub_weapon) })}</span>
                </div>
              )}
              {weapon.special_weapon && (
                <div className="weapon-modal-hero-row">
                  {spImage && <img src={spImage} alt={specialWeaponDisplayName(weapon.special_weapon)} className="weapon-sub-sp-icon weapon-sub-sp-icon--sp" />}
                  <span>SP: {specialWeaponDisplayName(weapon.special_weapon)}</span>
                </div>
              )}
            </div>
          </section>

          {(weapon.weapon_level != null || weapon.win_count_total != null || weapon.paint_point_total != null
            || weapon.last_used_at != null || weapon.weapon_power != null || weapon.weapon_power_max != null) && (
            <section className="modal-section">
              <h3 className="modal-section-title">{t('books.official')}</h3>
              <div className="weapon-modal-stats-grid weapon-modal-stats-grid--official">
                <StatPanel label={METRIC_LABELS.official_weapon_level} value={weapon.weapon_level != null ? String(weapon.weapon_level) : '-'} />
                <StatPanel label={METRIC_LABELS.official_win_count} value={weapon.win_count_total != null ? weapon.win_count_total.toLocaleString() : '-'} />
                <StatPanel label={METRIC_LABELS.official_paint} value={weapon.paint_point_total != null ? weapon.paint_point_total.toLocaleString() : '-'} />
                <StatPanel label={t('books.powerNow')} value={fmtPower(weapon.weapon_power)} />
                <StatPanel label={t('books.powerMax')} value={fmtPower(weapon.weapon_power_max)} />
                <StatPanel label={METRIC_LABELS.official_last_used_at} value={fmtOfficialDate(weapon.last_used_at)} />
              </div>
            </section>
          )}

          <section className="modal-section">
            <h3 className="modal-section-title">{t('books.fetchedBattles')}</h3>
            <div className="weapon-modal-stats-grid">
              <StatPanel label={METRIC_LABELS.total}  value={total.toLocaleString()} />
              <StatPanel label={t('books.winsLossesDraws')} value={`${wins} / ${losses} (${draws})`} />
              <StatPanel
                label={METRIC_LABELS.win_rate}
                value={overallWinRate !== null ? `${(overallWinRate * 100).toFixed(1)}%` : '-'}
                color={overallWinRate !== null ? winRateColor(overallWinRate) : undefined}
              />
              <StatPanel label={t('books.avgInked')} value={fmtNum(stats?.avg_inked, 0)} />
              <StatPanel label={t('books.avgKill')} value={fmtNum(stats?.avg_kill, 2)} />
              <StatPanel label={t('books.avgAssist')} value={fmtNum(stats?.avg_assist, 2)} />
              <StatPanel label={t('books.avgDeath')} value={fmtNum(stats?.avg_death, 2)} />
              <StatPanel label={t('books.kdContrib')} value={fmtKillRatioWithContrib(stats?.avg_kill, stats?.avg_assist, stats?.avg_death)} />
            </div>
          </section>

          {/* ルール別勝率 */}
          <section className="modal-section">
            <h3 className="modal-section-title">{t('books.ruleWinRates')}</h3>
            {loading && <div className="loading">{t('common.loading')}</div>}
            {!loading && !error && (
              <div className="weapon-modal-stage-list">
                {ruleOrder.map(rk => {
                  const row = ruleMap.get(rk)
                  const total = row?.total ?? 0
                  const wins  = row?.wins ?? 0
                  const draws = row?.draws ?? 0
                  const dec = total - draws
                  const wr  = row && dec > 0 ? row.wins / dec : null
                  return (
                    <RecordRow
                      key={rk}
                      name={ruleLabel(rk)}
                      total={total}
                      wins={wins}
                      draws={draws}
                      winRate={wr}
                      showBar
                    />
                  )
                })}
              </div>
            )}
          </section>

          {/* ステージ Top 5 */}
          <section className="modal-section">
            <h3 className="modal-section-title">{t('books.topStages')}</h3>
            {loading && <div className="loading">{t('common.loading')}</div>}
            {!loading && error && <div className="empty">{t('books.loadFail', { error })}</div>}
            {!loading && !error && topStages.length === 0 && <div className="empty">{t('books.noWeaponBattles')}</div>}
            {!loading && !error && topStages.length > 0 && (
              <div className="weapon-modal-stage-list">
                {topStages.map(r => {
                  const dec = r.total - r.draws
                  const wr  = dec > 0 ? r.wins / dec : null
                  return (
                    <RecordRow
                      key={r.key}
                      name={groupedStatsDisplayName(r)}
                      total={r.total}
                      wins={r.wins}
                      draws={r.draws}
                      winRate={wr}
                    />
                  )
                })}
              </div>
            )}
          </section>

          {/* 勝率の良いステージ Top 5(#302)。stageRows を勝率降順で並べ替えたもの。 */}
          <section className="modal-section">
            <h3 className="modal-section-title">
              {t('books.bestStages', { n: STAGE_TOP_N })}
              <span className="weapon-modal-section-note">{t('books.minBattlesNote', { n: STAGE_MIN_BATTLES })}</span>
            </h3>
            {loading && <div className="loading">{t('common.loading')}</div>}
            {!loading && error && <div className="empty">{t('books.loadFail', { error })}</div>}
            {!loading && !error && bestStages.length === 0 && <div className="empty">{t('books.noMinStages', { n: STAGE_MIN_BATTLES })}</div>}
            {!loading && !error && bestStages.length > 0 && (
              <div className="weapon-modal-stage-list">
                {bestStages.map(({ row: r, winRate: wr }) => (
                  <RecordRow
                    key={r.key}
                    name={groupedStatsDisplayName(r)}
                    total={r.total}
                    wins={r.wins}
                    draws={r.draws}
                    winRate={wr}
                  />
                ))}
              </div>
            )}
          </section>
        </div>
      </div>
    </div>
  )
}

function RecordRow({
  name, total, wins, draws, winRate, showBar,
}: {
  name: string
  total: number
  wins: number
  draws: number
  winRate: number | null
  showBar?: boolean
}) {
  const { t } = useTranslation()
  const widthPct = winRate !== null ? Math.max(2, winRate * 100) : 0
  return (
    <div className={`weapon-modal-stage-row${showBar ? ' weapon-modal-stage-row--with-bar' : ''}`}>
      <span className="weapon-modal-stage-name" title={name}>{name}</span>
      {showBar && (
        <div className="weapon-modal-rule-bar">
          {winRate !== null && (
            <div
              className="weapon-modal-rule-bar-fill"
              style={{ width: `${widthPct}%`, background: winRateColor(winRate) }}
            />
          )}
        </div>
      )}
      <span className="weapon-modal-stage-count">{fmtRecord(t, total, wins, draws)}</span>
      <span
        className="weapon-modal-stage-rate"
        style={{ color: winRate !== null ? winRateColor(winRate) : 'var(--text-muted)' }}
      >{winRate !== null ? `${(winRate * 100).toFixed(1)}%` : '-'}</span>
    </div>
  )
}

function StatPanel({ label, value, color }: { label: string; value: string; color?: string }) {
  return (
    <div className="weapon-modal-stat-panel">
      <div className="weapon-modal-stat-label">{label}</div>
      <div className="weapon-modal-stat-value" style={color ? { color } : undefined}>{value}</div>
    </div>
  )
}
