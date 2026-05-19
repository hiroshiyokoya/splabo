import { useEffect, useState, useCallback } from 'react'
import { invoke } from '@tauri-apps/api/core'
import type { BattleRow } from '../types'

const PAGE_SIZE = 50

// ---------------------------------------------------------------------------
// 型
// ---------------------------------------------------------------------------

interface Player {
  name?: string
  isMyself?: boolean
  paint?: number
  weapon?: { name?: string; subWeapon?: { name?: string }; specialWeapon?: { name?: string } }
  result?: { kill?: number; death?: number; assist?: number; special?: number }
}

interface OtherTeam {
  players?: Player[]
}

interface Award {
  name?: string
  rank?: string
}

// ---------------------------------------------------------------------------
// メイン
// ---------------------------------------------------------------------------

export function BattleLog() {
  const [battles, setBattles] = useState<BattleRow[]>([])
  const [offset, setOffset] = useState(0)
  const [total, setTotal] = useState(0)
  const [loading, setLoading] = useState(true)
  const [weaponImages, setWeaponImages] = useState<Map<string, string>>(new Map())
  const [selected, setSelected] = useState<BattleRow | null>(null)

  useEffect(() => {
    setLoading(true)
    Promise.all([
      invoke<BattleRow[]>('db_list_battles', { limit: PAGE_SIZE, offset }),
      invoke<number>('db_battle_count'),
    ])
      .then(([rows, count]) => {
        setBattles(rows)
        setTotal(count)
        const uniqueWeapons = [...new Set(rows.map(b => b.weapon))]
        Promise.all(
          uniqueWeapons.map(name =>
            invoke<string | null>('read_image', { kind: 'weapon', name })
              .then(url => url ? [name, url] as [string, string] : null)
              .catch(() => null)
          )
        ).then(results => {
          setWeaponImages(new Map(results.filter((r): r is [string, string] => r !== null)))
        })
      })
      .catch(console.error)
      .finally(() => setLoading(false))
  }, [offset])

  if (loading) return <div className="loading">読み込み中...</div>

  return (
    <div className="battle-log">
      <div className="log-header">
        <h2>バトルログ</h2>
        <span className="total-count">計 {total} 試合</span>
      </div>

      {battles.length === 0 ? (
        <div className="empty">バトルデータがありません。データを取得してください。</div>
      ) : (
        <>
          <table className="battle-table">
            <thead>
              <tr>
                <th>日時</th>
                <th>モード</th>
                <th>ルール</th>
                <th>ステージ</th>
                <th>武器</th>
                <th>結果</th>
                <th>K/D/A</th>
                <th>塗り</th>
              </tr>
            </thead>
            <tbody>
              {battles.map((b) => (
                <tr
                  key={b.id}
                  className={`result-${b.result.toLowerCase()} clickable-row`}
                  onClick={() => setSelected(b)}
                >
                  <td>{new Date(b.played_at).toLocaleString('ja-JP', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })}</td>
                  <td>{b.mode}</td>
                  <td>{b.rule}</td>
                  <td>{b.stage}</td>
                  <td>
                    <span className="weapon-cell">
                      {weaponImages.get(b.weapon) && (
                        <img src={weaponImages.get(b.weapon)} alt="" className="weapon-icon" />
                      )}
                      {b.weapon}
                    </span>
                  </td>
                  <td className={`result-cell ${b.result.toLowerCase()}`}>{b.result}</td>
                  <td>{b.kill}/{b.death}/{b.assist}</td>
                  <td>{b.inked.toLocaleString()}</td>
                </tr>
              ))}
            </tbody>
          </table>

          <div className="pagination">
            <button disabled={offset === 0} onClick={() => setOffset(Math.max(0, offset - PAGE_SIZE))}>
              前へ
            </button>
            <span>{offset + 1}–{Math.min(offset + PAGE_SIZE, total)} / {total}</span>
            <button disabled={offset + PAGE_SIZE >= total} onClick={() => setOffset(offset + PAGE_SIZE)}>
              次へ
            </button>
          </div>
        </>
      )}

      {selected && (
        <BattleDetailModal
          battle={selected}
          weaponImages={weaponImages}
          onClose={() => setSelected(null)}
        />
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------
// 詳細モーダル
// ---------------------------------------------------------------------------

function BattleDetailModal({
  battle,
  weaponImages,
  onClose,
}: {
  battle: BattleRow
  weaponImages: Map<string, string>
  onClose: () => void
}) {
  const [showRaw, setShowRaw] = useState(false)

  const handleKey = useCallback((e: KeyboardEvent) => {
    if (e.key === 'Escape') onClose()
  }, [onClose])

  useEffect(() => {
    window.addEventListener('keydown', handleKey)
    return () => window.removeEventListener('keydown', handleKey)
  }, [handleKey])

  const hasDetail = battle.my_team !== null

  const myTeam = (battle.my_team ? tryParse(battle.my_team) : null) as Player[] | null ?? []
  const otherTeams = (battle.other_teams ? tryParse(battle.other_teams) : null) as OtherTeam[] | null ?? []
  const awards = (battle.awards ? tryParse(battle.awards) : null) as Award[] | null ?? []

  const durationMin = Math.floor(battle.duration / 60)
  const durationSec = battle.duration % 60

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-panel" onClick={e => e.stopPropagation()}>
        <div className="modal-header">
          <div className="modal-title">
            <span className={`result-badge ${battle.result.toLowerCase()}`}>{battle.result}</span>
            {battle.knockout && battle.knockout !== 'NEITHER' && (
              <span className="ko-badge">KO</span>
            )}
            <span>{battle.mode} / {battle.rule}</span>
            <span className="modal-stage">{battle.stage}</span>
          </div>
          <div className="modal-meta">
            {new Date(battle.played_at).toLocaleString('ja-JP')}
            {battle.duration > 0 && (
              <span> · {durationMin}:{String(durationSec).padStart(2, '0')}</span>
            )}
          </div>
          <button className="modal-close" onClick={onClose}>✕</button>
        </div>

        <div className="modal-body">
          {!hasDetail && (
            <div className="detail-notice">詳細データ未取得 — 「詳細データを取得」を実行すると K/D/A・チーム情報が表示されます</div>
          )}

          {/* 自分のスタッツ */}
          <section className="modal-section">
            <h3 className="modal-section-title">スタッツ</h3>
            <div className="stats-grid">
              <StatItem label="キル"     value={battle.kill} />
              <StatItem label="デス"     value={battle.death} />
              <StatItem label="アシスト" value={battle.assist} />
              <StatItem label="スペシャル" value={battle.special} />
              <StatItem label="塗り"     value={battle.inked.toLocaleString()} />
            </div>

            <div className="weapon-detail-row">
              {weaponImages.get(battle.weapon) && (
                <img src={weaponImages.get(battle.weapon)} alt="" className="weapon-icon-lg" />
              )}
              <div className="weapon-detail-names">
                <span className="weapon-main">{battle.weapon}</span>
                {battle.sub_weapon && <span className="weapon-sub">サブ: {battle.sub_weapon}</span>}
                {battle.special_weapon && <span className="weapon-sp">スペシャル: {battle.special_weapon}</span>}
              </div>
            </div>

            {(battle.rank_before || battle.rank_after || battle.x_power) && (
              <div className="rank-row">
                {battle.rank_before && <span>ランク: {battle.rank_before}</span>}
                {battle.rank_after && <span> → {battle.rank_after}</span>}
                {battle.x_power && <span> · Xパワー: {battle.x_power}</span>}
              </div>
            )}
          </section>

          {/* チーム情報 */}
          {hasDetail && (myTeam.length > 0 || otherTeams.length > 0) && (
            <section className="modal-section">
              <h3 className="modal-section-title">チーム</h3>
              <div className="teams-grid">
                {myTeam.length > 0 && (
                  <TeamTable title="自チーム" players={myTeam} weaponImages={weaponImages} highlight />
                )}
                {otherTeams.map((team, i) => (
                  <TeamTable key={i} title={`相手チーム${otherTeams.length > 1 ? i + 1 : ''}`} players={team.players ?? []} weaponImages={weaponImages} />
                ))}
              </div>
            </section>
          )}

          {/* アワード */}
          {awards.length > 0 && (
            <section className="modal-section">
              <h3 className="modal-section-title">アワード</h3>
              <div className="awards-list">
                {awards.map((a, i) => (
                  <span key={i} className={`award-badge ${(a.rank ?? '').toLowerCase()}`}>{a.name}</span>
                ))}
              </div>
            </section>
          )}

          {/* raw_json */}
          <section className="modal-section">
            <button className="raw-toggle" onClick={() => setShowRaw(v => !v)}>
              {showRaw ? '▲' : '▶'} raw JSON
            </button>
            {showRaw && (
              <pre className="raw-json">{JSON.stringify(tryParse(battle.raw_json), null, 2)}</pre>
            )}
          </section>
        </div>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// サブコンポーネント
// ---------------------------------------------------------------------------

function StatItem({ label, value }: { label: string; value: number | string }) {
  return (
    <div className="stat-item">
      <div className="stat-item-label">{label}</div>
      <div className="stat-item-value">{value}</div>
    </div>
  )
}

function TeamTable({
  title,
  players,
  weaponImages,
  highlight,
}: {
  title: string
  players: Player[]
  weaponImages: Map<string, string>
  highlight?: boolean
}) {
  return (
    <div className={`team-table-wrap${highlight ? ' my-team' : ''}`}>
      <div className="team-label">{title}</div>
      <table className="team-table">
        <thead>
          <tr>
            <th>武器</th>
            <th>K</th>
            <th>D</th>
            <th>A</th>
            <th>Sp</th>
            <th>塗り</th>
          </tr>
        </thead>
        <tbody>
          {players.map((p, i) => {
            const weaponName = p.weapon?.name ?? ''
            return (
              <tr key={i} className={p.isMyself ? 'myself-row' : ''}>
                <td>
                  <span className="weapon-cell">
                    {weaponImages.get(weaponName) && (
                      <img src={weaponImages.get(weaponName)} alt="" className="weapon-icon" />
                    )}
                    {weaponName}
                  </span>
                </td>
                <td>{p.result?.kill ?? '—'}</td>
                <td>{p.result?.death ?? '—'}</td>
                <td>{p.result?.assist ?? '—'}</td>
                <td>{p.result?.special ?? '—'}</td>
                <td>{p.paint?.toLocaleString() ?? '—'}</td>
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}

function tryParse(s: string): unknown {
  try { return JSON.parse(s) } catch { return null }
}
