import { useEffect, useRef, useState, useCallback } from 'react'
import { invoke } from '@tauri-apps/api/core'
import type { BattleRow } from '../types'

const PAGE_SIZE = 50
const MODES   = ['REGULAR', 'BANKARA', 'XMATCH']
const RULES   = ['ナワバリ', 'ガチエリア', 'ガチヤグラ', 'ガチホコ', 'ガチアサリ']
const RESULTS = ['WIN', 'LOSE', 'DRAW']
type OrderBy  = 'played_at' | 'kill' | 'death' | 'inked'

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

export function BattleLog() {
  const [battles, setBattles]           = useState<BattleRow[]>([])
  const [total, setTotal]               = useState(0)
  const [loading, setLoading]           = useState(true)
  const [weaponImages, setWeaponImages] = useState<Map<string, string>>(new Map())
  const [weaponList, setWeaponList]     = useState<string[]>([])
  const [selected, setSelected]         = useState<BattleRow | null>(null)

  // ページ
  const [offset, setOffset] = useState(0)

  // フィルター
  const [filterMode,   setFilterMode]   = useState<string | null>(null)
  const [filterRule,   setFilterRule]   = useState<string | null>(null)
  const [filterResult, setFilterResult] = useState<string | null>(null)
  const [filterWeapon, setFilterWeapon] = useState<string | null>(null)
  const [pickerOpen,   setPickerOpen]   = useState(false)

  // ソート
  const [orderBy,  setOrderBy]  = useState<OrderBy>('played_at')
  const [orderAsc, setOrderAsc] = useState(false)

  // 武器一覧を初回ロード（アイコン付き）
  useEffect(() => {
    invoke<string[]>('db_weapons_used').then(weapons => {
      setWeaponList(weapons)
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

  // フィルター・ソート・ページ変化でバトル再取得
  useEffect(() => {
    setLoading(true)
    Promise.all([
      invoke<BattleRow[]>('db_list_battles', {
        limit: PAGE_SIZE, offset,
        mode: filterMode, rule: filterRule,
        result_filter: filterResult, weapon: filterWeapon,
        order_by: orderBy, order_asc: orderAsc,
      }),
      invoke<number>('db_battle_count', {
        mode: filterMode, rule: filterRule,
        result_filter: filterResult, weapon: filterWeapon,
      }),
    ])
      .then(([rows, count]) => { setBattles(rows); setTotal(count) })
      .catch(console.error)
      .finally(() => setLoading(false))
  }, [offset, filterMode, filterRule, filterResult, filterWeapon, orderBy, orderAsc])

  function toggle<T>(val: T, cur: T | null, set: (v: T | null) => void) {
    setOffset(0)
    set(cur === val ? null : val)
  }

  function handleSort(col: OrderBy) {
    setOffset(0)
    if (col === orderBy) { setOrderAsc(v => !v) }
    else { setOrderBy(col); setOrderAsc(false) }
  }

  return (
    <div className="battle-log">
      <div className="log-header">
        <h2>バトルログ</h2>
        <span className="total-count">計 {total} 試合</span>
      </div>

      {/* フィルターバー */}
      <div className="filter-bar">
        <div className="filter-row">
          <FilterGroup label="モード">
            {MODES.map(m => (
              <button key={m}
                className={`filter-btn${filterMode === m ? ' active' : ''}`}
                onClick={() => toggle(m, filterMode, setFilterMode)}
              >{m}</button>
            ))}
          </FilterGroup>
          <FilterGroup label="ルール">
            {RULES.map(r => (
              <button key={r}
                className={`filter-btn${filterRule === r ? ' active' : ''}`}
                onClick={() => toggle(r, filterRule, setFilterRule)}
              >{r}</button>
            ))}
          </FilterGroup>
        </div>
        <div className="filter-row">
          <FilterGroup label="結果">
            {RESULTS.map(r => (
              <button key={r}
                className={`filter-btn result-btn-${r.toLowerCase()}${filterResult === r ? ' active' : ''}`}
                onClick={() => toggle(r, filterResult, setFilterResult)}
              >{r}</button>
            ))}
          </FilterGroup>
          <FilterGroup label="武器">
            <WeaponPicker
              weaponList={weaponList}
              weaponImages={weaponImages}
              selected={filterWeapon}
              open={pickerOpen}
              onToggleOpen={() => setPickerOpen(v => !v)}
              onClose={() => setPickerOpen(false)}
              onSelect={w => { toggle(w, filterWeapon, setFilterWeapon); setPickerOpen(false) }}
            />
          </FilterGroup>
        </div>
      </div>

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
// フィルターグループ
// ---------------------------------------------------------------------------

function FilterGroup({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="filter-group">
      <span className="filter-group-label">{label}</span>
      {children}
    </div>
  )
}

// ---------------------------------------------------------------------------
// 武器ピッカー
// ---------------------------------------------------------------------------

function WeaponPicker({
  weaponList, weaponImages, selected, open, onToggleOpen, onClose, onSelect,
}: {
  weaponList: string[]
  weaponImages: Map<string, string>
  selected: string | null
  open: boolean
  onToggleOpen: () => void
  onClose: () => void
  onSelect: (w: string) => void
}) {
  const wrapRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    function handler(e: MouseEvent) {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) onClose()
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [open, onClose])

  return (
    <div className="weapon-picker-wrap" ref={wrapRef}>
      <button className={`filter-btn weapon-trigger${selected ? ' active' : ''}`} onClick={onToggleOpen}>
        {selected ? (
          <span className="weapon-cell">
            {weaponImages.get(selected) && <img src={weaponImages.get(selected)} alt="" className="weapon-icon" />}
            {selected}
          </span>
        ) : '全武器 ▼'}
      </button>
      {open && (
        <div className="weapon-picker-dropdown">
          {weaponList.map(w => (
            <button key={w} className={`weapon-picker-item${selected === w ? ' active' : ''}`} onClick={() => onSelect(w)}>
              {weaponImages.get(w) && <img src={weaponImages.get(w)} alt="" className="weapon-icon" />}
              {w}
            </button>
          ))}
        </div>
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

function tryParse(s: string): unknown {
  try { return JSON.parse(s) } catch { return null }
}
