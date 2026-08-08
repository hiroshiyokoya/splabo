import { useCallback, useEffect, useState } from 'react'
import { invoke } from '@tauri-apps/api/core'
import type { GroupedStatsRow, WeaponRecord } from '../types'
import { RULE_LABELS, ruleLabel } from '../types'

// Dashboard.winRateColor / WeaponBook.winRateColor と同期。
function winRateColor(rate: number): string {
  if (rate >= 0.55) return '#34d399'
  if (rate >= 0.45) return '#fb923c'
  return '#f472b6'
}

/** 「勝率の良いステージ」の下限バトル数(少数サンプルによる勝率のブレを避ける)。
 *  StageDetailModal の「勝率 TOP ブキ」と同じ流儀・同じ値に揃えている。 */
const STAGE_MIN_BATTLES = 5
/** 「勝率の良いステージ」で表示する件数。 */
const STAGE_TOP_N = 5

function fmtNum(n: number | null | undefined, digits = 2): string {
  if (n === null || n === undefined) return '-'
  return n.toFixed(digits)
}

function fmtRatio(num: number | null | undefined, den: number | null | undefined): string {
  if (num === null || num === undefined || den === null || den === undefined || den === 0) return '-'
  return (num / den).toFixed(2)
}

/** コンパクト戦績「12戦 7勝5敗」。引き分けは 0 でないときだけ「2分」を付ける(#449)。
 *  WeaponBook.fmtRecord / StageDetailModal.fmtRecord と同期。 */
function fmtRecord(total: number, wins: number, draws: number): string {
  const losses = total - wins - draws
  return `${total}戦 ${wins}勝${losses}敗${draws > 0 ? `${draws}分` : ''}`
}

/**
 * ブキ図鑑カードをクリックして開く詳細モーダル。
 *
 * - バトル統計(バトル数 / W/L/D / 勝率 / 平均キル・デス・塗り / キルレ)は DB 集計。
 *   親 (WeaponBook) が statsByWeapon から該当行を `stats` prop として渡す。
 * - ステージ Top 5 とルール別勝率は `db_grouped_stats(group_by, weapon=ブキスラッグ)` を 2 回呼んで取得。
 *   ブキスラッグは `weapons.name`(旧テーブル)= `weapon.key`(新テーブル)= stat.ink キー。
 *   FE 側で持っている `WeaponRecord.name` をそのまま `weapon` フィルタとして渡せる。
 * - 直近 30 バトルの線グラフは仕様により非実装(#149)。
 * - WeaponRecordQuery 由来の公式アプリ統計(熟練度・通算勝利数・総塗)は #162 廃止中のため
 *   今 PR では表示しない(混乱回避)。
 */
export function WeaponDetailModal({
  weapon, image, subImage, spImage, stats, onClose,
}: {
  weapon:   WeaponRecord
  image:    string | null
  subImage: string | null
  spImage:  string | null
  stats:    GroupedStatsRow | null
  onClose:  () => void
}) {
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
    Promise.all([
      invoke<GroupedStatsRow[]>('db_grouped_stats', { groupBy: 'stage', weapon: weapon.name }),
      invoke<GroupedStatsRow[]>('db_grouped_stats', { groupBy: 'rule',  weapon: weapon.name }),
    ])
      .then(([stages, rules]) => {
        setStageRows(stages)
        setRuleRows(rules)
      })
      .catch(err => setError(typeof err === 'string' ? err : String(err)))
      .finally(() => setLoading(false))
  }, [weapon.name])

  const decisive       = weapon.total - weapon.draws
  const overallWinRate = decisive > 0 ? weapon.wins / decisive : null
  const losses         = weapon.total - weapon.wins - weapon.draws

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
          <span className="modal-title-text">{weapon.name}</span>
          {weapon.category && <span className="modal-meta">{weapon.category}</span>}
          <button className="modal-close" onClick={onClose}>✕</button>
        </div>

        <div className="modal-body">
          {/* ヘッダー：ブキ画像(大)+ サブ/SP */}
          <section className="modal-section weapon-modal-hero">
            <div className="weapon-modal-hero-icon">
              {image
                ? <img src={image} alt={weapon.name} />
                : <div className="weapon-modal-hero-placeholder" />}
            </div>
            <div className="weapon-modal-hero-meta">
              {weapon.sub_weapon && (
                <div className="weapon-modal-hero-row">
                  {subImage && <img src={subImage} alt={weapon.sub_weapon} className="weapon-sub-sp-icon" />}
                  <span>サブ: {weapon.sub_weapon}</span>
                </div>
              )}
              {weapon.special_weapon && (
                <div className="weapon-modal-hero-row">
                  {spImage && <img src={spImage} alt={weapon.special_weapon} className="weapon-sub-sp-icon weapon-sub-sp-icon--sp" />}
                  <span>SP: {weapon.special_weapon}</span>
                </div>
              )}
            </div>
          </section>

          {/* バトル統計：8 パネル(4×2 グリッド)。
              上段はバトル数・勝敗・勝率・平均塗り、
              下段は K/A/D 系(平均キル・平均アシスト・平均デス・キルレ)で揃える(#449 / #465)。 */}
          <section className="modal-section">
            <h3 className="modal-section-title">バトル統計</h3>
            <div className="weapon-modal-stats-grid">
              <StatPanel label="バトル数"  value={weapon.total.toLocaleString()} />
              <StatPanel label="Win / Lose (Draw)" value={`${weapon.wins} / ${losses} (${weapon.draws})`} />
              <StatPanel
                label="勝率"
                value={overallWinRate !== null ? `${(overallWinRate * 100).toFixed(1)}%` : '-'}
                color={overallWinRate !== null ? winRateColor(overallWinRate) : undefined}
              />
              <StatPanel label="平均塗り" value={fmtNum(stats?.avg_inked, 0)} />
              <StatPanel label="平均キル" value={fmtNum(stats?.avg_kill, 2)} />
              <StatPanel label="平均アシスト" value={fmtNum(stats?.avg_assist, 2)} />
              <StatPanel label="平均デス" value={fmtNum(stats?.avg_death, 2)} />
              <StatPanel label="キルレ" value={fmtRatio(stats?.avg_kill, stats?.avg_death)} />
            </div>
          </section>

          {/* ルール別勝率(横棒) */}
          <section className="modal-section">
            <h3 className="modal-section-title">ルール別勝率</h3>
            {loading && <div className="loading">読み込み中...</div>}
            {!loading && !error && (
              <div className="weapon-modal-rule-list">
                {ruleOrder.map(rk => {
                  const row = ruleMap.get(rk)
                  const dec = row ? row.total - row.draws : 0
                  const wr  = row && dec > 0 ? row.wins / dec : null
                  const widthPct = wr !== null ? Math.max(2, wr * 100) : 0
                  return (
                    <div key={rk} className="weapon-modal-rule-row">
                      <span className="weapon-modal-rule-name">{ruleLabel(rk)}</span>
                      <div className="weapon-modal-rule-bar">
                        {wr !== null && (
                          <div
                            className="weapon-modal-rule-bar-fill"
                            style={{ width: `${widthPct}%`, background: winRateColor(wr) }}
                          />
                        )}
                      </div>
                      <span className="weapon-modal-rule-value">
                        {wr !== null ? `${(wr * 100).toFixed(1)}%` : '-'}
                        <span className="weapon-modal-rule-count"> ({row?.total ?? 0})</span>
                      </span>
                    </div>
                  )
                })}
              </div>
            )}
          </section>

          {/* ステージ Top 5 */}
          <section className="modal-section">
            <h3 className="modal-section-title">よく戦うステージ Top 5</h3>
            {loading && <div className="loading">読み込み中...</div>}
            {!loading && error && <div className="empty">読み込み失敗: {error}</div>}
            {!loading && !error && topStages.length === 0 && <div className="empty">このブキのバトル記録がありません。</div>}
            {!loading && !error && topStages.length > 0 && (
              <div className="weapon-modal-stage-list">
                {topStages.map(r => {
                  const dec = r.total - r.draws
                  const wr  = dec > 0 ? r.wins / dec : null
                  return (
                    <div key={r.key} className="weapon-modal-stage-row">
                      <span className="weapon-modal-stage-name" title={r.name}>{r.name}</span>
                      <span className="weapon-modal-stage-count">{fmtRecord(r.total, r.wins, r.draws)}</span>
                      <span
                        className="weapon-modal-stage-rate"
                        style={{ color: wr !== null ? winRateColor(wr) : 'var(--text-muted)' }}
                      >{wr !== null ? `${(wr * 100).toFixed(1)}%` : '-'}</span>
                    </div>
                  )
                })}
              </div>
            )}
          </section>

          {/* 勝率の良いステージ Top 5(#302)。stageRows を勝率降順で並べ替えたもの。 */}
          <section className="modal-section">
            <h3 className="modal-section-title">
              勝率の良いステージ Top {STAGE_TOP_N}
              <span className="weapon-modal-section-note"> ({STAGE_MIN_BATTLES} 戦以上)</span>
            </h3>
            {loading && <div className="loading">読み込み中...</div>}
            {!loading && error && <div className="empty">読み込み失敗: {error}</div>}
            {!loading && !error && bestStages.length === 0 && <div className="empty">{STAGE_MIN_BATTLES} 戦以上のステージなし</div>}
            {!loading && !error && bestStages.length > 0 && (
              <div className="weapon-modal-stage-list">
                {bestStages.map(({ row: r, winRate: wr }) => (
                  <div key={r.key} className="weapon-modal-stage-row">
                    <span className="weapon-modal-stage-name" title={r.name}>{r.name}</span>
                    <span className="weapon-modal-stage-count">{fmtRecord(r.total, r.wins, r.draws)}</span>
                    <span
                      className="weapon-modal-stage-rate"
                      style={{ color: winRateColor(wr) }}
                    >{`${(wr * 100).toFixed(1)}%`}</span>
                  </div>
                ))}
              </div>
            )}
          </section>
        </div>
      </div>
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
