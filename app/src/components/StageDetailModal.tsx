import { useCallback, useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { TFunction } from 'i18next'
import { invoke } from '@tauri-apps/api/core'
import type { GroupedStatsRow, Filters, StageRecord } from '../types'
import { RULE_LABELS, ruleLabel, filtersToBookDetailArgs, fmtKillRatioWithContrib, fmtOfficialWinRate, METRIC_LABELS } from '../types'
import { winRateColor } from '../utils/heatmapColors'

/** コンパクト戦績「12戦 7勝5敗」。引き分けは 0 でないときだけ「2分」を付ける(#449)。
 *  WeaponBook.fmtRecord / WeaponDetailModal.fmtRecord と同期。 */
function fmtRecord(t: TFunction, total: number, wins: number, draws: number): string {
  const losses = total - wins - draws
  return draws > 0
    ? t('books.recordDraw', { total, wins, losses, draws })
    : t('books.record', { total, wins, losses })
}

function fmtAvg(n: number | null | undefined): string {
  if (n === null || n === undefined) return '-'
  return n.toFixed(2)
}

/** ブキ TOP セクションの下限バトル数(勝率 TOP のブレを避ける)。 */
const WEAPON_MIN_BATTLES = 5
/** ブキ TOP セクションで表示する件数。 */
const WEAPON_TOP_N = 5

/**
 * ステージカードをクリックして開く詳細モーダル (#226)。
 *
 * - ルール別統計は `db_grouped_stats(group_by='rule', stage=<key>)` で取得。
 *   WHERE 句は `m.key` で絞られる(db.rs の filter_where 参照)ので row.key をそのまま渡せる。
 *   FilterBar と同じ期間・モード・ルール・結果を載せ、対象ステージだけ上書きする。
 * - ブキ TOP は `db_grouped_stats(group_by='weapon', stage=<key>)` で取得し、
 *   FE 側で「勝利数 TOP」「勝率 TOP(≥ WEAPON_MIN_BATTLES)」の 2 リストに絞る。
 * - Rust 側の追加コマンドは不要。既存の `db_grouped_stats` の `stage` フィルタを利用。
 */
export function StageDetailModal({
  row, image, official, filters, onClose,
}: {
  row:      GroupedStatsRow
  image:    string | null
  official: StageRecord | null
  filters:  Filters
  onClose:  () => void
}) {
  const { t } = useTranslation()
  const [ruleRows,   setRuleRows]   = useState<GroupedStatsRow[] | null>(null)
  const [weaponRows, setWeaponRows] = useState<GroupedStatsRow[] | null>(null)
  const [weaponIcons, setWeaponIcons] = useState<Map<string, string>>(new Map())
  const [loading,    setLoading]    = useState(true)
  const [error,      setError]      = useState<string | null>(null)

  // ESC で閉じる
  const handleKey = useCallback((e: KeyboardEvent) => {
    if (e.key === 'Escape') onClose()
  }, [onClose])
  useEffect(() => {
    window.addEventListener('keydown', handleKey)
    return () => window.removeEventListener('keydown', handleKey)
  }, [handleKey])

  // ルール別 / ブキ別を並列で取得。stage フィルタは row.key(m.key)。
  useEffect(() => {
    setLoading(true)
    setError(null)
    const filterArgs = filtersToBookDetailArgs(filters, { stage: row.key })
    Promise.all([
      invoke<GroupedStatsRow[]>('db_grouped_stats', { groupBy: 'rule',   ...filterArgs }),
      invoke<GroupedStatsRow[]>('db_grouped_stats', { groupBy: 'weapon', ...filterArgs }),
    ])
      .then(([rules, weapons]) => {
        setRuleRows(rules)
        setWeaponRows(weapons)

        // ブキアイコン。key はブキスラッグ(stat.ink キー)で read_image と一致する。
        // TOP に出そうな候補(勝利数 or 勝率)だけ先に集めて重複排除。
        const wins = [...weapons].sort((a, b) => b.wins - a.wins).slice(0, WEAPON_TOP_N)
        const rate = weapons
          .filter(w => w.total >= WEAPON_MIN_BATTLES)
          .sort((a, b) => b.win_rate - a.win_rate)
          .slice(0, WEAPON_TOP_N)
        const uniq = new Map<string, string>()
        for (const w of [...wins, ...rate]) uniq.set(w.key, w.name)

        Promise.all(
          [...uniq.entries()].map(([key, name]) =>
            invoke<string | null>('read_image', { kind: 'weapon', name: key })
              .then(url => (url ? ([key, url] as [string, string]) : null))
              .catch(() => null)
              // key が name_ja だった場合のフォールバック(read_image がスラッグ想定)。
              .then(res => res ?? (name && name !== key
                ? invoke<string | null>('read_image', { kind: 'weapon', name })
                    .then(url => (url ? ([key, url] as [string, string]) : null))
                    .catch(() => null)
                : null))
          )
        ).then(results => {
          setWeaponIcons(new Map(results.filter((x): x is [string, string] => x !== null)))
        })
      })
      .catch(err => setError(typeof err === 'string' ? err : String(err)))
      .finally(() => setLoading(false))
  }, [row.key, filters])

  // ルール別は 5 ルール固定順で表示。データが無いルールは 0 で埋める。
  const ruleOrder = Object.keys(RULE_LABELS)
  const ruleMap   = new Map((ruleRows ?? []).map(r => [r.key, r]))

  // ブキ TOP：勝利数と勝率。
  const topByWins = (weaponRows ?? [])
    .filter(w => w.wins > 0)
    .sort((a, b) => b.wins - a.wins)
    .slice(0, WEAPON_TOP_N)

  const topByWinRate = (weaponRows ?? [])
    .filter(w => w.total >= WEAPON_MIN_BATTLES)
    .sort((a, b) => b.win_rate - a.win_rate)
    .slice(0, WEAPON_TOP_N)

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-panel stage-detail-modal" onClick={e => e.stopPropagation()}>
        <div className="modal-header">
          <span className="modal-title-text">{row.name}</span>
          <span className="modal-meta">{t('common.battlesCount', { count: row.total })}</span>
          <button className="modal-close" onClick={onClose} aria-label={t('common.close')}>✕</button>
        </div>

        <div className="modal-body">
          {/* ヘッダー：ステージ画像(大) */}
          <section className="modal-section stage-modal-hero">
            <div className="stage-modal-hero-image">
              {image
                ? <img src={image} alt={row.name} />
                : <div className="stage-modal-hero-placeholder" />}
            </div>
          </section>

          {official && (
            <section className="modal-section">
              <h3 className="modal-section-title">{t('books.official')}</h3>
              <div className="weapon-modal-stats-grid weapon-modal-stats-grid--official">
                <StatPanel label={t('labels.rule.turf_war')} value={fmtOfficialWinRate(official.win_rate_tw)} color={rateColor(official.win_rate_tw)} />
                <StatPanel label={t('labels.rule.area')} value={fmtOfficialWinRate(official.win_rate_ar)} color={rateColor(official.win_rate_ar)} />
                <StatPanel label={t('labels.rule.yagura')} value={fmtOfficialWinRate(official.win_rate_lf)} color={rateColor(official.win_rate_lf)} />
                <StatPanel label={t('labels.rule.hoko')} value={fmtOfficialWinRate(official.win_rate_gl)} color={rateColor(official.win_rate_gl)} />
                <StatPanel label={t('labels.rule.asari')} value={fmtOfficialWinRate(official.win_rate_cl)} color={rateColor(official.win_rate_cl)} />
              </div>
            </section>
          )}

          {/* ルール別統計 */}
          <section className="modal-section">
            <h3 className="modal-section-title">{t('books.ruleStats')}</h3>
            {loading && <div className="loading">{t('common.loading')}</div>}
            {!loading && error && <div className="empty">{t('books.loadFail', { error })}</div>}
            {!loading && !error && (
              <div className="stage-modal-rule-list">
                <div className="stage-modal-rule-row stage-modal-rule-head">
                  <span>{t('battles.rule')}</span>
                  <span />
                  <span className="num">{t('books.recordCol')}</span>
                  <span className="num">{METRIC_LABELS.win_rate}</span>
                  <span className="num">{t('books.avgK')}</span>
                  <span className="num">{t('books.avgA')}</span>
                  <span className="num">{t('books.avgD')}</span>
                  <span className="num">{t('books.kdContrib')}</span>
                </div>
                {ruleOrder.map(rk => {
                  const r = ruleMap.get(rk)
                  const total = r?.total ?? 0
                  const wins  = r?.wins ?? 0
                  const draws = r?.draws ?? 0
                  const dec   = total - draws
                  const wr    = r && dec > 0 ? r.wins / dec : null
                  const widthPct = wr !== null ? Math.max(2, wr * 100) : 0
                  return (
                    <div
                      key={rk}
                      className={`stage-modal-rule-row${total === 0 ? ' stage-modal-rule-row--empty' : ''}`}
                    >
                      <span className="weapon-modal-stage-name">{ruleLabel(rk)}</span>
                      <div className="weapon-modal-rule-bar">
                        {wr !== null && (
                          <div
                            className="weapon-modal-rule-bar-fill"
                            style={{ width: `${widthPct}%`, background: winRateColor(wr) }}
                          />
                        )}
                      </div>
                      <span className="num stage-modal-rule-record">{fmtRecord(t, total, wins, draws)}</span>
                      <span
                        className="num stage-modal-rule-rate"
                        style={{ color: wr !== null ? winRateColor(wr) : undefined }}
                      >{wr !== null ? `${(wr * 100).toFixed(1)}%` : '-'}</span>
                      <span className="num">{total > 0 ? fmtAvg(r?.avg_kill) : '-'}</span>
                      <span className="num">{total > 0 ? fmtAvg(r?.avg_assist) : '-'}</span>
                      <span className="num">{total > 0 ? fmtAvg(r?.avg_death) : '-'}</span>
                      <span className="num">{total > 0 && r ? fmtKillRatioWithContrib(r.avg_kill, r.avg_assist, r.avg_death) : '-'}</span>
                    </div>
                  )
                })}
              </div>
            )}
          </section>

          {/* ブキ TOP：勝利数 / 勝率 */}
          <section className="modal-section">
            <h3 className="modal-section-title">{t('books.weaponTop')}</h3>
            {loading && <div className="loading">{t('common.loading')}</div>}
            {!loading && !error && (weaponRows ?? []).length === 0 && (
              <div className="empty">{t('books.noStageWeapons')}</div>
            )}
            {!loading && !error && (weaponRows ?? []).length > 0 && (
              <div className="stage-modal-weapon-cols">
                <div className="stage-modal-weapon-col">
                  <div className="stage-modal-weapon-col-title">{t('books.winsTop', { n: WEAPON_TOP_N })}</div>
                  {topByWins.length === 0
                    ? <div className="empty">{t('books.noWins')}</div>
                    : (
                      <div className="stage-modal-weapon-list">
                        {topByWins.map(w => (
                          <WeaponRow key={w.key} row={w} icon={weaponIcons.get(w.key) ?? null} primary={t('common.winsCount', { count: w.wins })} />
                        ))}
                      </div>
                    )
                  }
                </div>
                <div className="stage-modal-weapon-col">
                  <div className="stage-modal-weapon-col-title">
                    {t('books.winRateTop', { n: WEAPON_TOP_N })}
                    <span className="stage-modal-weapon-col-note">{t('books.minBattlesNote', { n: WEAPON_MIN_BATTLES })}</span>
                  </div>
                  {topByWinRate.length === 0
                    ? <div className="empty">{t('books.noMinWeapons', { n: WEAPON_MIN_BATTLES })}</div>
                    : (
                      <div className="stage-modal-weapon-list">
                        {topByWinRate.map(w => (
                          <WeaponRow
                            key={w.key}
                            row={w}
                            icon={weaponIcons.get(w.key) ?? null}
                            primary={`${(w.win_rate * 100).toFixed(1)}%`}
                            primaryColor={winRateColor(w.win_rate)}
                          />
                        ))}
                      </div>
                    )
                  }
                </div>
              </div>
            )}
          </section>
        </div>
      </div>
    </div>
  )
}

function WeaponRow({ row, icon, primary, primaryColor }: {
  row:          GroupedStatsRow
  icon:         string | null
  primary:      string
  primaryColor?: string
}) {
  const { t } = useTranslation()
  return (
    <div className="stage-modal-weapon-row">
      <div className="stage-modal-weapon-icon-wrap">
        {icon
          ? <img src={icon} alt={row.name} className="stage-modal-weapon-icon" />
          : <div className="stage-modal-weapon-icon stage-modal-weapon-icon--placeholder" />
        }
      </div>
      <span className="stage-modal-weapon-name" title={row.name}>{row.name}</span>
      <span className="stage-modal-weapon-count">{fmtRecord(t, row.total, row.wins, row.draws)}</span>
      <span
        className="stage-modal-weapon-primary"
        style={primaryColor ? { color: primaryColor } : undefined}
      >{primary}</span>
    </div>
  )
}

function rateColor(n: number | null | undefined): string | undefined {
  if (n == null) return undefined
  return winRateColor(n)
}

function StatPanel({ label, value, color }: { label: string; value: string; color?: string }) {
  return (
    <div className="weapon-modal-stat-panel">
      <div className="weapon-modal-stat-label">{label}</div>
      <div className="weapon-modal-stat-value" style={color ? { color } : undefined}>{value}</div>
    </div>
  )
}
