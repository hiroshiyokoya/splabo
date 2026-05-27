import { useCallback, useEffect, useState } from 'react'
import { invoke } from '@tauri-apps/api/core'
import type { GroupedStatsRow, WeaponRecord } from '../types'
import { RULE_LABELS, ruleLabel, stageAbbr } from '../types'

// Dashboard.winRateColor / WeaponBook.winRateColor と同期。
function winRateColor(rate: number): string {
  if (rate >= 0.55) return '#34d399'
  if (rate >= 0.45) return '#fb923c'
  return '#f472b6'
}

// 大きい数値を「1.23万」「12.3万」「1.2百万」短縮表示にする。
function shortNum(n: number | null | undefined): string {
  if (n === null || n === undefined) return '—'
  if (n >= 100_000_000) return `${(n / 100_000_000).toFixed(2)}億`
  if (n >= 10_000)      return `${(n / 10_000).toFixed(n >= 100_000 ? 1 : 2)}万`
  return n.toLocaleString()
}

/**
 * 武器図鑑カードをクリックして開く詳細モーダル。
 *
 * - 公式統計（熟練度 / 勝利数 / 総塗）は WeaponRecord（#49 で拡張済み）から表示。
 * - ステージ Top 5 とルール別勝率は `db_grouped_stats(group_by, weapon=武器スラッグ)` を 2 回呼んで取得。
 *   武器スラッグは `weapons.name`（旧テーブル）= `weapon.key`（新テーブル）= stat.ink キー。
 *   FE 側で持っている `WeaponRecord.name` をそのまま `weapon` フィルタとして渡せる。
 * - 直近 30 バトルの線グラフは仕様により非実装（#149）。
 * - 現/最高ブキチャレパワー・ビッグラン熟練度は WeaponRecordQuery に含まれないため
 *   現状は DB が空。混乱を避けるため今 PR では表示しない（#149 の事前共有差分）。
 */
export function WeaponDetailModal({
  weapon, image, subImage, spImage, onClose,
}: {
  weapon:   WeaponRecord
  image:    string | null
  subImage: string | null
  spImage:  string | null
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

  // ステージ別 / ルール別の集計を並列で取得。weapon フィルタは武器スラッグ単独でパイプ区切り不要。
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

  const decisive = weapon.total - weapon.draws
  const overallWinRate = decisive > 0 ? weapon.wins / decisive : null

  // ステージ Top 5（バトル数降順、既に db 側でソート済み）
  const topStages = (stageRows ?? []).slice(0, 5)
  // ルール別は 5 ルール固定順で表示（データが無いルールは試合数 0 として並べる）
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
          {/* ヘッダー：武器画像（大）+ サブ/SP */}
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
              <div className="weapon-modal-hero-row weapon-modal-hero-overall">
                <span>{weapon.total} 試合</span>
                {overallWinRate !== null && (
                  <span style={{ color: winRateColor(overallWinRate), fontWeight: 600 }}>
                    勝率 {(overallWinRate * 100).toFixed(1)}%
                  </span>
                )}
              </div>
            </div>
          </section>

          {/* 公式統計：熟練度・勝利数・総塗（#149 の事前共有により現/最高パワーは未表示） */}
          <section className="modal-section">
            <h3 className="modal-section-title">公式アプリ統計</h3>
            <div className="weapon-modal-official-grid">
              <OfficialStat label="熟練度"       value={weapon.weapon_level !== null ? `Lv. ${weapon.weapon_level}` : '—'} />
              <OfficialStat label="勝利数"       value={weapon.win_count_total !== null ? weapon.win_count_total.toLocaleString() : '—'} />
              <OfficialStat label="総塗りポイント" value={shortNum(weapon.paint_point_total)} />
            </div>
          </section>

          {/* ルール別勝率（横棒） */}
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
                        {wr !== null ? `${(wr * 100).toFixed(1)}%` : '—'}
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
            {!loading && !error && topStages.length === 0 && <div className="empty">この武器のバトル記録がありません。</div>}
            {!loading && !error && topStages.length > 0 && (
              <div className="weapon-modal-stage-list">
                {topStages.map(r => {
                  const dec = r.total - r.draws
                  const wr  = dec > 0 ? r.wins / dec : null
                  return (
                    <div key={r.key} className="weapon-modal-stage-row">
                      <span className="weapon-modal-stage-name" title={r.name}>{stageAbbr(r.name)}</span>
                      <span className="weapon-modal-stage-count">{r.total} 戦</span>
                      <span
                        className="weapon-modal-stage-rate"
                        style={{ color: wr !== null ? winRateColor(wr) : 'var(--text-muted)' }}
                      >{wr !== null ? `${(wr * 100).toFixed(1)}%` : '—'}</span>
                    </div>
                  )
                })}
              </div>
            )}
          </section>
        </div>
      </div>
    </div>
  )
}

function OfficialStat({ label, value }: { label: string; value: string }) {
  return (
    <div className="weapon-modal-official-item">
      <div className="weapon-modal-official-label">{label}</div>
      <div className="weapon-modal-official-value">{value}</div>
    </div>
  )
}
