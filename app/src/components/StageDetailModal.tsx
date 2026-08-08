import { useCallback, useEffect, useState } from 'react'
import { invoke } from '@tauri-apps/api/core'
import type { GroupedStatsRow } from '../types'
import { RULE_LABELS, ruleLabel, avgKillRatio } from '../types'

// Dashboard / WeaponBook / StageBook.winRateColor と同期。
function winRateColor(rate: number): string {
  if (rate >= 0.55) return '#34d399'
  if (rate >= 0.45) return '#fb923c'
  return '#f472b6'
}

/** コンパクト戦績「12戦 7勝5敗」。引き分けは 0 でないときだけ「2分」を付ける(#449)。
 *  WeaponBook.fmtRecord / WeaponDetailModal.fmtRecord と同期。 */
function fmtRecord(total: number, wins: number, draws: number): string {
  const losses = total - wins - draws
  return `${total}戦 ${wins}勝${losses}敗${draws > 0 ? `${draws}分` : ''}`
}

/** ブキ TOP セクションの下限バトル数(勝率 TOP のブレを避ける)。 */
const WEAPON_MIN_BATTLES = 5
/** ブキ TOP セクションで表示する件数。 */
const WEAPON_TOP_N = 5

/**
 * ステージ図鑑カードをクリックして開く詳細モーダル (#226)。
 *
 * - ルール別統計は `db_grouped_stats(group_by='rule', stage=<key>)` で取得。
 *   WHERE 句は `m.key` で絞られる(db.rs の filter_where 参照)ので row.key をそのまま渡せる。
 * - ブキ TOP は `db_grouped_stats(group_by='weapon', stage=<key>)` で取得し、
 *   FE 側で「勝利数 TOP」「勝率 TOP(≥ WEAPON_MIN_BATTLES)」の 2 リストに絞る。
 * - Rust 側の追加コマンドは不要。既存の `db_grouped_stats` の `stage` フィルタを利用。
 */
export function StageDetailModal({
  row, image, onClose,
}: {
  row:     GroupedStatsRow
  image:   string | null
  onClose: () => void
}) {
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
    Promise.all([
      invoke<GroupedStatsRow[]>('db_grouped_stats', { groupBy: 'rule',   stage: row.key }),
      invoke<GroupedStatsRow[]>('db_grouped_stats', { groupBy: 'weapon', stage: row.key }),
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
  }, [row.key])

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
          <span className="modal-meta">{row.total} 戦</span>
          <button className="modal-close" onClick={onClose}>✕</button>
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

          {/* ルール別統計 */}
          <section className="modal-section">
            <h3 className="modal-section-title">ルール別統計</h3>
            {loading && <div className="loading">読み込み中...</div>}
            {!loading && error && <div className="empty">読み込み失敗: {error}</div>}
            {!loading && !error && (
              <div className="stage-modal-rule-table-wrap">
                <table className="stage-modal-rule-table">
                  <thead>
                    <tr>
                      <th>ルール</th>
                      <th className="num">バトル</th>
                      <th className="num">勝率</th>
                      <th className="num">平均K</th>
                      <th className="num">平均A</th>
                      <th className="num">平均D</th>
                      <th className="num">キルレ</th>
                      <th className="num">KO率</th>
                    </tr>
                  </thead>
                  <tbody>
                    {ruleOrder.map(rk => {
                      const r = ruleMap.get(rk)
                      const total = r?.total ?? 0
                      const dec   = r ? r.total - r.draws : 0
                      const wr    = r && dec > 0 ? r.wins / dec : null
                      const koR   = r && r.total > 0 ? r.knockout_win / r.total : null
                      return (
                        <tr key={rk} className={total === 0 ? 'stage-modal-rule-empty' : undefined}>
                          <td>{ruleLabel(rk)}</td>
                          <td className="num">{total}</td>
                          <td
                            className="num"
                            style={{ color: wr !== null ? winRateColor(wr) : undefined }}
                          >
                            {wr !== null ? `${(wr * 100).toFixed(1)}%` : '-'}
                          </td>
                          <td className="num">{r?.avg_kill   !== null && r?.avg_kill   !== undefined ? r.avg_kill.toFixed(2)   : '-'}</td>
                          <td className="num">{r?.avg_assist !== null && r?.avg_assist !== undefined ? r.avg_assist.toFixed(2) : '-'}</td>
                          <td className="num">{r?.avg_death  !== null && r?.avg_death  !== undefined ? r.avg_death.toFixed(2)  : '-'}</td>
                          <td className="num">{r ? avgKillRatio(r.avg_kill, r.avg_death) : '-'}</td>
                          <td className="num">{koR !== null ? `${(koR * 100).toFixed(1)}%` : '-'}</td>
                        </tr>
                      )
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </section>

          {/* ブキ TOP：勝利数 / 勝率 */}
          <section className="modal-section">
            <h3 className="modal-section-title">このステージでのブキ TOP</h3>
            {loading && <div className="loading">読み込み中...</div>}
            {!loading && !error && (weaponRows ?? []).length === 0 && (
              <div className="empty">このステージでのブキ記録がありません。</div>
            )}
            {!loading && !error && (weaponRows ?? []).length > 0 && (
              <div className="stage-modal-weapon-cols">
                <div className="stage-modal-weapon-col">
                  <div className="stage-modal-weapon-col-title">勝利数 TOP {WEAPON_TOP_N}</div>
                  {topByWins.length === 0
                    ? <div className="empty">勝利記録なし</div>
                    : (
                      <div className="stage-modal-weapon-list">
                        {topByWins.map(w => (
                          <WeaponRow key={w.key} row={w} icon={weaponIcons.get(w.key) ?? null} primary={`${w.wins} 勝`} />
                        ))}
                      </div>
                    )
                  }
                </div>
                <div className="stage-modal-weapon-col">
                  <div className="stage-modal-weapon-col-title">
                    勝率 TOP {WEAPON_TOP_N}
                    <span className="stage-modal-weapon-col-note"> ({WEAPON_MIN_BATTLES} 戦以上)</span>
                  </div>
                  {topByWinRate.length === 0
                    ? <div className="empty">{WEAPON_MIN_BATTLES} 戦以上のブキなし</div>
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
  return (
    <div className="stage-modal-weapon-row">
      <div className="stage-modal-weapon-icon-wrap">
        {icon
          ? <img src={icon} alt={row.name} className="stage-modal-weapon-icon" />
          : <div className="stage-modal-weapon-icon stage-modal-weapon-icon--placeholder" />
        }
      </div>
      <span className="stage-modal-weapon-name" title={row.name}>{row.name}</span>
      <span className="stage-modal-weapon-count">{fmtRecord(row.total, row.wins, row.draws)}</span>
      <span
        className="stage-modal-weapon-primary"
        style={primaryColor ? { color: primaryColor } : undefined}
      >{primary}</span>
    </div>
  )
}
