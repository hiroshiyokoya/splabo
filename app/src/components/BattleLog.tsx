import { useEffect, useState, useCallback } from 'react'
import { invoke } from '@tauri-apps/api/core'
import type { BattleRow, Filters } from '../types'
import { filtersToRange } from '../types'

const PAGE_SIZE = 50

function winRateColor(rate: number): string {
  if (rate >= 0.55) return '#22c55e'
  if (rate >= 0.45) return '#f59e0b'
  return '#ef4444'
}
type OrderBy = 'played_at' | 'kill' | 'death' | 'inked'

// ---------------------------------------------------------------------------
// 型（詳細モーダル用）
// ---------------------------------------------------------------------------

interface Player {
  name?: string
  isMyself?: boolean
  paint?: number
  weapon?: { name?: string; subWeapon?: { name?: string }; specialWeapon?: { name?: string } }
  result?: { kill?: number; death?: number; assist?: number; special?: number }
}
interface OtherTeam { players?: Player[] }
interface Award     { name?: string; rank?: string }

// ---------------------------------------------------------------------------
// メインコンポーネント
// ---------------------------------------------------------------------------

interface Props {
  filters: Filters
}

export function BattleLog({ filters }: Props) {
  const [battles, setBattles]           = useState<BattleRow[]>([])
  const [total, setTotal]               = useState(0)
  const [loading, setLoading]           = useState(true)
  const [weaponImages, setWeaponImages] = useState<Map<string, string>>(new Map())
  const [selected, setSelected]         = useState<BattleRow | null>(null)

  // ページ
  const [offset, setOffset] = useState(0)

  // ソート
  const [orderBy,  setOrderBy]  = useState<OrderBy>('played_at')
  const [orderAsc, setOrderAsc] = useState(false)

  // 集計
  const [stats, setStats] = useState<{ total: number; wins: number; win_rate: number; weapon_count: number } | null>(null)

  // データ取得
  const [refreshKey, setRefreshKey]     = useState(0)
  const [fetching, setFetching]         = useState(false)
  const [fetchResult, setFetchResult]   = useState<string | null>(null)
  const [fetchError, setFetchError]     = useState<string | null>(null)

  async function handleFetch() {
    setFetching(true)
    setFetchResult(null)
    setFetchError(null)
    try {
      const count = await invoke<number>('fetch_battles')
      setFetchResult(`${count}件取得しました`)
      setRefreshKey(k => k + 1)
      invoke('fetch_weapons').catch(console.error)
    } catch (e) {
      setFetchError(String(e))
    } finally {
      setFetching(false)
    }
  }

  // 武器アイコンをロード（テーブル行・モーダル用）
  useEffect(() => {
    invoke<string[]>('db_weapons_used').then(weapons => {
      Promise.all(
        weapons.map(name =>
          invoke<string | null>('read_image', { kind: 'weapon', name })
            .then(url => (url ? ([name, url] as [string, string]) : null))
            .catch(() => null)
        )
      ).then(results => {
        setWeaponImages(new Map(results.filter((r): r is [string, string] => r !== null)))
      })
    })
  }, [])

  // フィルター変化でページをリセット
  useEffect(() => {
    setOffset(0)
  }, [filters])

  useEffect(() => {
    setLoading(true)
    const { since, until } = filtersToRange(filters)
    const filterArgs = {
      since,
      until,
      mode: filters.mode,
      rule: filters.rule,
      resultFilter: filters.result,
      weapon: filters.weapon,
    }
    Promise.all([
      invoke<BattleRow[]>('db_list_battles', { limit: PAGE_SIZE, offset, ...filterArgs, orderBy, orderAsc }),
      invoke<number>('db_battle_count', filterArgs),
      invoke<{ total: number; wins: number; win_rate: number; weapon_count: number }>('db_battle_stats', filterArgs),
    ])
      .then(([rows, count, s]) => { setBattles(rows); setTotal(count); setStats(s) })
      .catch(console.error)
      .finally(() => setLoading(false))
  }, [offset, filters, orderBy, orderAsc, refreshKey])

  function handleSort(col: OrderBy) {
    setOffset(0)
    if (col === orderBy) { setOrderAsc(v => !v) }
    else { setOrderBy(col); setOrderAsc(false) }
  }

  return (
    <div className="battle-log">
      <div className="log-header">
        <h2>バトルログ</h2>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginLeft: 'auto' }}>
          {fetchResult && <span style={{ color: 'var(--win)', fontSize: 13 }}>{fetchResult}</span>}
          {fetchError  && <span style={{ color: 'var(--lose)', fontSize: 13 }}>{fetchError}</span>}
          <button className="btn-primary" onClick={handleFetch} disabled={fetching}>
            {fetching ? '取得中...' : 'バトルデータを取得'}
          </button>
        </div>
      </div>

      {stats && (
        <div className="stat-cards" style={{ marginBottom: 12 }}>
          <LogStatCard label="総試合数"   value={stats.total.toLocaleString()} />
          <LogStatCard label="全体勝率"   value={stats.total > 0 ? `${(stats.win_rate * 100).toFixed(1)}%` : '—'}
            valueColor={stats.total > 0 ? winRateColor(stats.win_rate) : undefined} />
          <LogStatCard label="勝利数"     value={stats.wins.toLocaleString()} />
          <LogStatCard label="使用武器数" value={stats.weapon_count.toString()} />
        </div>
      )}

      {loading ? (
        <div className="loading">読み込み中...</div>
      ) : battles.length === 0 ? (
        <div className="empty">該当するバトルデータがありません。</div>
      ) : (
        <>
          <table className="battle-table">
            <thead>
              <tr>
                <SortTh col="played_at" label="日時"   orderBy={orderBy} orderAsc={orderAsc} onSort={handleSort} />
                <th>モード</th>
                <th>ルール</th>
                <th>ステージ</th>
                <th>武器</th>
                <th>結果</th>
                <SortTh col="kill"      label="K/D/A"  orderBy={orderBy} orderAsc={orderAsc} onSort={handleSort} />
                <SortTh col="inked"     label="塗り"   orderBy={orderBy} orderAsc={orderAsc} onSort={handleSort} />
              </tr>
            </thead>
            <tbody>
              {battles.map(b => (
                <tr key={b.id} className={`result-${b.result.toLowerCase()} clickable-row`} onClick={() => setSelected(b)}>
                  <td>{new Date(b.played_at).toLocaleString('ja-JP', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })}</td>
                  <td>{b.mode}</td>
                  <td>{b.rule}</td>
                  <td>{b.stage}</td>
                  <td>
                    <span className="weapon-cell">
                      {weaponImages.get(b.weapon) && <img src={weaponImages.get(b.weapon)} alt="" className="weapon-icon" />}
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
            <button disabled={offset === 0} onClick={() => setOffset(Math.max(0, offset - PAGE_SIZE))}>前へ</button>
            <span>{offset + 1}–{Math.min(offset + PAGE_SIZE, total)} / {total}</span>
            <button disabled={offset + PAGE_SIZE >= total} onClick={() => setOffset(offset + PAGE_SIZE)}>次へ</button>
          </div>
        </>
      )}

      {selected && (
        <BattleDetailModal battle={selected} weaponImages={weaponImages} onClose={() => setSelected(null)} />
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------
// ソートヘッダー
// ---------------------------------------------------------------------------

function SortTh({ col, label, orderBy, orderAsc, onSort }: {
  col: OrderBy; label: string; orderBy: OrderBy; orderAsc: boolean; onSort: (c: OrderBy) => void
}) {
  const active = orderBy === col
  return (
    <th className={`sortable-th${active ? ' sorted' : ''}`} onClick={() => onSort(col)}>
      {label}<span className="sort-arrow">{active ? (orderAsc ? ' ↑' : ' ↓') : ' ⇅'}</span>
    </th>
  )
}

// ---------------------------------------------------------------------------
// 詳細モーダル
// ---------------------------------------------------------------------------

function BattleDetailModal({ battle, weaponImages, onClose }: {
  battle: BattleRow; weaponImages: Map<string, string>; onClose: () => void
}) {
  const [showRaw, setShowRaw] = useState(false)

  const handleKey = useCallback((e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }, [onClose])
  useEffect(() => {
    window.addEventListener('keydown', handleKey)
    return () => window.removeEventListener('keydown', handleKey)
  }, [handleKey])

  const hasDetail  = battle.my_team !== null
  const myTeam     = (battle.my_team     ? tryParse(battle.my_team)     : null) as Player[]    | null ?? []
  const otherTeams = (battle.other_teams ? tryParse(battle.other_teams) : null) as OtherTeam[] | null ?? []
  const awards     = (battle.awards      ? tryParse(battle.awards)      : null) as Award[]     | null ?? []
  const durationMin = Math.floor(battle.duration / 60)
  const durationSec = battle.duration % 60

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-panel" onClick={e => e.stopPropagation()}>
        <div className="modal-header">
          <div className="modal-title">
            <span className={`result-badge ${battle.result.toLowerCase()}`}>{battle.result}</span>
            {battle.knockout && battle.knockout !== 'NEITHER' && <span className="ko-badge">KO</span>}
            <span>{battle.mode} / {battle.rule}</span>
            <span className="modal-stage">{battle.stage}</span>
          </div>
          <div className="modal-meta">
            {new Date(battle.played_at).toLocaleString('ja-JP')}
            {battle.duration > 0 && <span> · {durationMin}:{String(durationSec).padStart(2, '0')}</span>}
          </div>
          <button className="modal-close" onClick={onClose}>✕</button>
        </div>

        <div className="modal-body">
          {!hasDetail && (
            <div className="detail-notice">詳細データ未取得 — 「詳細データを取得」を実行すると K/D/A・チーム情報が表示されます</div>
          )}

          <section className="modal-section">
            <h3 className="modal-section-title">スタッツ</h3>
            <div className="stats-grid">
              <StatItem label="キル"       value={battle.kill} />
              <StatItem label="デス"       value={battle.death} />
              <StatItem label="アシスト"   value={battle.assist} />
              <StatItem label="スペシャル" value={battle.special} />
              <StatItem label="塗り"       value={battle.inked.toLocaleString()} />
            </div>
            <div className="weapon-detail-row">
              {weaponImages.get(battle.weapon) && <img src={weaponImages.get(battle.weapon)} alt="" className="weapon-icon-lg" />}
              <div className="weapon-detail-names">
                <span className="weapon-main">{battle.weapon}</span>
                {battle.sub_weapon     && <span className="weapon-sub">サブ: {battle.sub_weapon}</span>}
                {battle.special_weapon && <span className="weapon-sp">スペシャル: {battle.special_weapon}</span>}
              </div>
            </div>
            {(battle.rank_before || battle.rank_after || battle.x_power) && (
              <div className="rank-row">
                {battle.rank_before && <span>ランク: {battle.rank_before}</span>}
                {battle.rank_after  && <span> → {battle.rank_after}</span>}
                {battle.x_power    && <span> · Xパワー: {battle.x_power}</span>}
              </div>
            )}
          </section>

          {hasDetail && (myTeam.length > 0 || otherTeams.length > 0) && (
            <section className="modal-section">
              <h3 className="modal-section-title">チーム</h3>
              <div className="teams-grid">
                {myTeam.length > 0 && <TeamTable title="自チーム" players={myTeam} weaponImages={weaponImages} highlight />}
                {otherTeams.map((team, i) => (
                  <TeamTable key={i} title={`相手チーム${otherTeams.length > 1 ? i + 1 : ''}`} players={team.players ?? []} weaponImages={weaponImages} />
                ))}
              </div>
            </section>
          )}

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

          <section className="modal-section">
            <button className="raw-toggle" onClick={() => setShowRaw(v => !v)}>
              {showRaw ? '▲' : '▶'} raw JSON
            </button>
            {showRaw && <pre className="raw-json">{JSON.stringify(tryParse(battle.raw_json), null, 2)}</pre>}
          </section>
        </div>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// 共通サブコンポーネント
// ---------------------------------------------------------------------------

function StatItem({ label, value }: { label: string; value: number | string }) {
  return (
    <div className="stat-item">
      <div className="stat-item-label">{label}</div>
      <div className="stat-item-value">{value}</div>
    </div>
  )
}

function TeamTable({ title, players, weaponImages, highlight }: {
  title: string; players: Player[]; weaponImages: Map<string, string>; highlight?: boolean
}) {
  return (
    <div className={`team-table-wrap${highlight ? ' my-team' : ''}`}>
      <div className="team-label">{title}</div>
      <table className="team-table">
        <thead>
          <tr><th>武器</th><th>K</th><th>D</th><th>A</th><th>Sp</th><th>塗り</th></tr>
        </thead>
        <tbody>
          {players.map((p, i) => {
            const wName = p.weapon?.name ?? ''
            return (
              <tr key={i} className={p.isMyself ? 'myself-row' : ''}>
                <td>
                  <span className="weapon-cell">
                    {weaponImages.get(wName) && <img src={weaponImages.get(wName)} alt="" className="weapon-icon" />}
                    {wName}
                  </span>
                </td>
                <td>{p.result?.kill    ?? '—'}</td>
                <td>{p.result?.death   ?? '—'}</td>
                <td>{p.result?.assist  ?? '—'}</td>
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

function LogStatCard({ label, value, valueColor }: { label: string; value: string; valueColor?: string }) {
  return (
    <div className="stat-card">
      <div className="stat-label">{label}</div>
      <div className="stat-value" style={valueColor ? { color: valueColor } : undefined}>{value}</div>
    </div>
  )
}

function tryParse(s: string): unknown {
  try { return JSON.parse(s) } catch { return null }
}
