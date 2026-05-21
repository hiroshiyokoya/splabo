import { useEffect, useMemo, useState, useCallback } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'
import { openUrl } from '@tauri-apps/plugin-opener'
import type { BattleRow, BattleStats, Filters, Player, Team, VsHistoryDetail, Award } from '../types'
import { filtersToRange, modeLabel, ruleLabel, resultLabel, avgKillRatio } from '../types'
import { ABILITY_LABELS, abilityKeyFromUrl, colorToHex, loadAbilityImages } from '../utils/abilities'

const PAGE_SIZE = 50

// Dashboard.winRateColor と同期。緑/赤は勝/負と衝突するため emerald/orange/pink。
function winRateColor(rate: number): string {
  if (rate >= 0.55) return '#34d399'
  if (rate >= 0.45) return '#fb923c'
  return '#f472b6'
}

/** キルレ表示。D=0 のときは ∞、それ以外は K/D を小数 2 桁で。 */
function killRatio(kill: number, death: number): string {
  if (death === 0) return '∞'
  return (kill / death).toFixed(2)
}

type OrderBy = 'played_at' | 'kill' | 'assist' | 'death' | 'special' | 'inked' | 'kill_ratio'

// ---------------------------------------------------------------------------
// メインコンポーネント
// ---------------------------------------------------------------------------

interface Props {
  filters: Filters
  statinkScreenName: string | null
}

/** stat.ink バトル詳細 URL を構築。screen_name があれば公開ページ、無ければ API JSON にフォールバック。 */
function statinkBattleUrl(uuid: string, screenName: string | null): string {
  return screenName
    ? `https://stat.ink/@${screenName}/spl3/${uuid}`
    : `https://stat.ink/api/v3/battle/${uuid}`
}

/** 規定ブラウザで URL を開く（Tauri webview 内に開かない）。 */
function openExternal(url: string) {
  openUrl(url).catch(console.error)
}

export function BattleLog({ filters, statinkScreenName }: Props) {
  const [battles, setBattles]                 = useState<BattleRow[]>([])
  const [total, setTotal]                     = useState(0)
  const [loading, setLoading]                 = useState(true)
  const [weaponImages, setWeaponImages]       = useState<Map<string, string>>(new Map())
  const [abilityImages, setAbilityImages]     = useState<Map<string, string>>(new Map())
  const [stageImages, setStageImages]         = useState<Map<string, string>>(new Map())
  const [selectedIdx, setSelectedIdx]         = useState<number | null>(null)

  // ページ
  const [offset, setOffset] = useState(0)

  // ソート
  const [orderBy,  setOrderBy]  = useState<OrderBy>('played_at')
  const [orderAsc, setOrderAsc] = useState(false)

  // 集計
  const [stats, setStats] = useState<BattleStats | null>(null)

  // データ取得
  const [refreshKey, setRefreshKey] = useState(0)

  // fetch_complete イベントでデータを自動リフレッシュ
  useEffect(() => {
    const unlistenPromise = listen('fetch_complete', () => setRefreshKey(k => k + 1))
    return () => { unlistenPromise.then(fn => fn()) }
  }, [])

  // 武器・アビリティ・ステージ画像をロード
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
    loadAbilityImages().then(setAbilityImages)
    invoke<{ id: string; name: string }[]>('db_stages_used').then(stages => {
      Promise.all(
        stages.map(s =>
          invoke<string | null>('read_image', { kind: 'stage', name: s.name })
            .then(url => (url ? ([s.name, url] as [string, string]) : null))
            .catch(() => null)
        )
      ).then(results => {
        setStageImages(new Map(results.filter((r): r is [string, string] => r !== null)))
      })
    })
  }, [refreshKey])

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
      weapon: filters.weapon.length > 0 ? filters.weapon.join('|') : null,
      stage: filters.stage.length > 0 ? filters.stage.join('|') : null,
    }
    Promise.all([
      invoke<BattleRow[]>('db_list_battles', { limit: PAGE_SIZE, offset, ...filterArgs, orderBy, orderAsc }),
      invoke<number>('db_battle_count', filterArgs),
      invoke<BattleStats>('db_battle_stats', filterArgs),
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
      </div>

      {stats && (
        <div className="stat-cards" style={{ marginBottom: 12 }}>
          <LogStatCard label="総バトル数"        value={stats.total.toLocaleString()} />
          <LogStatCard label="Win / Lose (Draw)"
            value={`${stats.wins} / ${stats.total - stats.wins - stats.draws} (${stats.draws})`} />
          <LogStatCard label="全体勝率"          value={stats.total > 0 ? `${(stats.win_rate * 100).toFixed(1)}%` : '—'}
            valueColor={stats.total > 0 ? winRateColor(stats.win_rate) : undefined} />
          <LogStatCard label="平均キル"          value={stats.avg_kill  !== null ? stats.avg_kill.toFixed(2)  : '—'} />
          <LogStatCard label="平均デス"          value={stats.avg_death !== null ? stats.avg_death.toFixed(2) : '—'} />
          <LogStatCard label="キルレシオ"        value={avgKillRatio(stats.avg_kill, stats.avg_death)} />
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
                <th className="team-color-th"></th>
                <SortTh col="played_at" label="日時"   orderBy={orderBy} orderAsc={orderAsc} onSort={handleSort} />
                <th>モード</th>
                <th>ルール</th>
                <th>ステージ</th>
                <th>武器</th>
                <th>結果</th>
                <SortTh col="kill"       label="K"     orderBy={orderBy} orderAsc={orderAsc} onSort={handleSort} />
                <SortTh col="assist"     label="A"     orderBy={orderBy} orderAsc={orderAsc} onSort={handleSort} />
                <SortTh col="death"      label="D"     orderBy={orderBy} orderAsc={orderAsc} onSort={handleSort} />
                <SortTh col="kill_ratio" label="キルレ" orderBy={orderBy} orderAsc={orderAsc} onSort={handleSort} />
                <SortTh col="special"    label="SP"    orderBy={orderBy} orderAsc={orderAsc} onSort={handleSort} />
                <SortTh col="inked"      label="塗り"  orderBy={orderBy} orderAsc={orderAsc} onSort={handleSort} />
                <th className="statink-col-th" title="stat.ink アップロード済み">stat</th>
              </tr>
            </thead>
            <tbody>
              {battles.map((b, idx) => {
                const isKo  = !!b.knockout && b.knockout !== 'NEITHER'
                return (
                  <tr key={b.id} className={`result-${b.result} clickable-row`} onClick={() => setSelectedIdx(idx)}>
                    <td className={`team-color-cell result-stripe--${b.result.toLowerCase()}`} />
                    <td>{new Date(b.played_at).toLocaleString('ja-JP', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })}</td>
                    <td>{modeLabel(b.mode)}</td>
                    <td>{ruleLabel(b.rule)}</td>
                    <td>{b.stage_name ?? b.stage}</td>
                    <td>
                      <span className="weapon-cell">
                        {weaponImages.get(b.weapon) && <img src={weaponImages.get(b.weapon)} alt="" className="weapon-icon" />}
                        {b.weapon}
                      </span>
                    </td>
                    <td className={`result-cell ${b.result.toLowerCase()}`}>
                      {resultLabel(b.result)}
                      {isKo && <span className="ko-badge-inline">KO</span>}
                    </td>
                    <td>{b.kill}</td>
                    <td>{b.assist}</td>
                    <td>{b.death}</td>
                    <td>{killRatio(b.kill, b.death)}</td>
                    <td>{b.special}</td>
                    <td>{b.inked.toLocaleString()}</td>
                    <td className="statink-col-cell">
                      {b.statink_uuid && (
                        <button
                          className="statink-mark"
                          title="stat.ink で開く"
                          onClick={e => {
                            e.stopPropagation()
                            openExternal(statinkBattleUrl(b.statink_uuid!, statinkScreenName))
                          }}
                        >✓</button>
                      )}
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>

          <div className="pagination">
            <button disabled={offset === 0} onClick={() => setOffset(Math.max(0, offset - PAGE_SIZE))}>前へ</button>
            <span>{offset + 1}–{Math.min(offset + PAGE_SIZE, total)} / {total}</span>
            <button disabled={offset + PAGE_SIZE >= total} onClick={() => setOffset(offset + PAGE_SIZE)}>次へ</button>
          </div>
        </>
      )}

      {selectedIdx !== null && battles[selectedIdx] && (
        <BattleDetailModal
          battle={battles[selectedIdx]}
          weaponImages={weaponImages}
          abilityImages={abilityImages}
          stageImages={stageImages}
          statinkScreenName={statinkScreenName}
          onClose={() => setSelectedIdx(null)}
          onPrev={selectedIdx > 0 ? () => setSelectedIdx(i => (i !== null ? i - 1 : null)) : undefined}
          onNext={selectedIdx < battles.length - 1 ? () => setSelectedIdx(i => (i !== null ? i + 1 : null)) : undefined}
        />
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

function BattleDetailModal({ battle, weaponImages, abilityImages, stageImages, statinkScreenName, onClose, onPrev, onNext }: {
  battle: BattleRow
  weaponImages: Map<string, string>
  abilityImages: Map<string, string>
  stageImages: Map<string, string>
  statinkScreenName: string | null
  onClose: () => void
  onPrev?: () => void  // 前のバトル（先頭なら undefined）
  onNext?: () => void  // 次のバトル（末尾なら undefined）
}) {
  const [showRaw, setShowRaw] = useState(false)

  // ESC で閉じる、←/→ で前後移動
  const handleKey = useCallback((e: KeyboardEvent) => {
    if (e.key === 'Escape') onClose()
    else if (e.key === 'ArrowLeft'  && onPrev) onPrev()
    else if (e.key === 'ArrowRight' && onNext) onNext()
  }, [onClose, onPrev, onNext])
  useEffect(() => {
    window.addEventListener('keydown', handleKey)
    return () => window.removeEventListener('keydown', handleKey)
  }, [handleKey])

  // raw_json から詳細を取得（チームカラー・スコア・トリカラー対応）
  const detail = useMemo(() => tryParse(battle.raw_json) as VsHistoryDetail | null, [battle.raw_json])
  const myTeam     = detail?.myTeam ?? null
  const otherTeams = detail?.otherTeams ?? []
  const awards: Award[] = detail?.awards ?? []
  const isTricolor = otherTeams.length >= 2

  const hasDetail   = battle.my_team !== null
  const isKo        = !!battle.knockout && battle.knockout !== 'NEITHER'
  const durationMin = Math.floor(battle.duration / 60)
  const durationSec = battle.duration % 60

  const stageImage = stageImages.get(battle.stage_name ?? battle.stage)
  const panelStyle = stageImage
    ? ({ ['--stage-bg' as string]: `url("${stageImage}")` } as React.CSSProperties)
    : undefined

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-panel modal-panel--with-stage" style={panelStyle} onClick={e => e.stopPropagation()}>
        <div className="modal-header">
          <div className="modal-title">
            <span className={`result-badge ${battle.result.toLowerCase()}`}>{resultLabel(battle.result)}</span>
            {isKo && <span className="ko-badge">KO</span>}
            <span>{modeLabel(battle.mode)} / {ruleLabel(battle.rule)}</span>
            <span className="modal-stage">{battle.stage_name ?? battle.stage}</span>
          </div>
          <div className="modal-meta">
            {new Date(battle.played_at).toLocaleString('ja-JP')}
            {battle.duration > 0 && <span> · {durationMin}:{String(durationSec).padStart(2, '0')}</span>}
            {battle.statink_uuid && (
              <button
                className="statink-badge"
                title={`stat.ink で開く (ID: ${battle.statink_uuid})`}
                onClick={() => openExternal(statinkBattleUrl(battle.statink_uuid!, statinkScreenName))}
              >stat.ink ✓</button>
            )}
          </div>
          <div className="modal-nav">
            <button className="modal-nav-btn" onClick={onPrev} disabled={!onPrev} title="前のバトル (←)">‹ 前</button>
            <button className="modal-nav-btn" onClick={onNext} disabled={!onNext} title="次のバトル (→)">次 ›</button>
          </div>
          <button className="modal-close" onClick={onClose}>✕</button>
        </div>

        <div className="modal-body">
          {!hasDetail && (
            <div className="detail-notice">詳細データ未取得 — 「バトルデータを取得」を実行すると詳細が表示されます</div>
          )}

          {hasDetail && (myTeam || otherTeams.length > 0) && (
            <ScoreSummary myTeam={myTeam} otherTeams={otherTeams} rule={battle.rule} />
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

          <MyStatsCard battle={battle} weaponImages={weaponImages} />

          {hasDetail && (myTeam || otherTeams.length > 0) && (
            <section className="modal-section">
              <h3 className="modal-section-title">スコアボード</h3>
              <div className="teams-stack">
                {myTeam && (
                  <TeamPanel
                    team={myTeam}
                    label="自チーム"
                    highlight
                    showSignal={isTricolor}
                    weaponImages={weaponImages}
                    abilityImages={abilityImages}
                  />
                )}
                {otherTeams.map((team, i) => (
                  <TeamPanel
                    key={i}
                    team={team}
                    label={otherTeams.length > 1 ? `相手チーム${i + 1}` : '相手チーム'}
                    showSignal={isTricolor}
                    weaponImages={weaponImages}
                    abilityImages={abilityImages}
                  />
                ))}
              </div>
            </section>
          )}

          <section className="modal-section">
            <button className="raw-toggle" onClick={() => setShowRaw(v => !v)}>
              {showRaw ? '▲' : '▶'} raw JSON
            </button>
            {showRaw && <pre className="raw-json">{JSON.stringify(detail ?? tryParse(battle.raw_json), null, 2)}</pre>}
          </section>
        </div>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// スコアサマリ（モーダル上部）
// ---------------------------------------------------------------------------

function ScoreSummary({ myTeam, otherTeams }: {
  myTeam: Team | null
  otherTeams: Team[]
  rule: string
}) {
  const myColor = colorToHex(myTeam?.color)
  const teams   = [{ team: myTeam, color: myColor }, ...otherTeams.map(t => ({ team: t, color: colorToHex(t.color) }))]

  // ルール文字列に依存せず、result の値で何を表示するか決める：
  // paintRatio が数値なら 塗り%、なければ score を数値表示。result 自体が null（中断・切断バトル等）なら '—'。
  function renderScore(team: Team | null): string {
    const r = team?.result
    if (r == null) return '—'
    if (typeof r.paintRatio === 'number') return `${(r.paintRatio * 100).toFixed(1)}%`
    if (typeof r.score      === 'number') return String(r.score)
    return '—'
  }

  return (
    <section className="modal-section score-summary">
      <div className="score-summary-row">
        {teams.map((t, i) => (
          <div key={i} className="score-summary-team" style={{ '--team-color': t.color ?? '#6066aa' } as React.CSSProperties}>
            <div className="score-summary-label">{i === 0 ? '自' : (teams.length > 2 ? `相手${i}` : '相手')}</div>
            <div className="score-summary-value">{renderScore(t.team)}</div>
          </div>
        ))}
      </div>
    </section>
  )
}

// ---------------------------------------------------------------------------
// 自分の戦績カード
// ---------------------------------------------------------------------------

function MyStatsCard({ battle, weaponImages }: {
  battle: BattleRow
  weaponImages: Map<string, string>
}) {
  return (
    <section className="modal-section my-stats-card">
      <h3 className="modal-section-title">自分の戦績</h3>
      <div className="my-stats-grid">
        <div className="my-stats-weapon">
          {weaponImages.get(battle.weapon) && <img src={weaponImages.get(battle.weapon)} alt="" className="weapon-icon-lg" />}
          <div className="my-stats-weapon-names">
            <div className="weapon-main">{battle.weapon}</div>
            {battle.sub_weapon     && <div className="weapon-sub">サブ: {battle.sub_weapon}</div>}
            {battle.special_weapon && <div className="weapon-sp">SP: {battle.special_weapon}</div>}
          </div>
        </div>
        <div className="my-stats-numbers">
          <StatItem label="キル"       value={battle.kill} />
          <StatItem label="アシスト"   value={battle.assist} />
          <StatItem label="デス"       value={battle.death} />
          <StatItem label="スペシャル" value={battle.special} />
          <StatItem label="塗り"       value={battle.inked.toLocaleString()} />
        </div>
      </div>
      {(battle.rank_before || battle.rank_after || battle.x_power) && (
        <div className="rank-row">
          {battle.rank_before && <span>ランク: {battle.rank_before}</span>}
          {battle.rank_after  && <span> → {battle.rank_after}</span>}
          {battle.x_power     && <span> · Xパワー: {battle.x_power}</span>}
        </div>
      )}
    </section>
  )
}

// ---------------------------------------------------------------------------
// チームパネル（スコアボード 1 チーム分）
// ---------------------------------------------------------------------------

function TeamPanel({ team, label, highlight, showSignal, weaponImages, abilityImages }: {
  team: Team
  label: string
  highlight?: boolean
  showSignal: boolean
  weaponImages: Map<string, string>
  abilityImages: Map<string, string>
}) {
  const color   = colorToHex(team.color)
  const players = team.players ?? []
  // Nintendo の result.kill は kill+assist なので、純粋K に補正して合計を計算する。
  const totalA  = players.reduce((s, p) => s + (p.result?.assist ?? 0), 0)
  const totalK  = players.reduce((s, p) => s + ((p.result?.kill ?? 0) - (p.result?.assist ?? 0)), 0)
  const totalD  = players.reduce((s, p) => s + (p.result?.death  ?? 0), 0)
  const totalSp = players.reduce((s, p) => s + (p.result?.special?? 0), 0)
  const totalP  = players.reduce((s, p) => s + (p.paint ?? 0), 0)
  const score   = team.result?.score
  const paint   = team.result?.paintRatio

  return (
    <div className={`team-panel${highlight ? ' my-team' : ''}`} style={{ '--team-color': color ?? '#6066aa' } as React.CSSProperties}>
      <div className="team-panel-header">
        <span className="team-panel-label" style={color ? { color } : undefined}>{label}</span>
        {typeof score === 'number' && <span className="team-panel-score">{score}</span>}
        {typeof paint === 'number' && <span className="team-panel-score">{(paint * 100).toFixed(1)}%</span>}
        <span className="team-panel-totals">
          {totalK}K / {totalA}A / {totalD}D / SP {totalSp} / 塗り {totalP.toLocaleString()}p
        </span>
      </div>
      <table className="team-table">
        <thead>
          <tr>
            <th></th>
            <th>ネームプレート</th>
            <th>武器</th>
            <th>ギア</th>
            <th>K</th>
            <th>A</th>
            <th>D</th>
            <th>SP</th>
            <th>塗り</th>
            {showSignal && <th>信号</th>}
          </tr>
        </thead>
        <tbody>
          {players.map((p, i) => (
            <PlayerRow
              key={i}
              p={p}
              showSignal={showSignal}
              weaponImages={weaponImages}
              abilityImages={abilityImages}
            />
          ))}
        </tbody>
      </table>
    </div>
  )
}

// ---------------------------------------------------------------------------
// プレイヤー行
// ---------------------------------------------------------------------------

function PlayerRow({ p, showSignal, weaponImages, abilityImages }: {
  p: Player
  showSignal: boolean
  weaponImages: Map<string, string>
  abilityImages: Map<string, string>
}) {
  const wName  = p.weapon?.name ?? ''
  const crown  = crownType(p)
  const result = p.result

  // Nintendo の result.kill は kill+assist なので、純粋K に補正して表示を統一する。
  const assist  = result?.assist ?? 0
  const pureK   = result ? (result.kill ?? 0) - assist : null

  return (
    <tr className={p.isMyself ? 'myself-row' : ''}>
      <td className="crown-cell">{crown && <span className={`crown-badge crown-${crown}`}>{crown === 'x' ? '👑' : crown}</span>}</td>
      <td className="splashtag-cell">
        <div className="splashtag-title">{p.byname ?? ''}</div>
        <div className="splashtag-name">
          <span>{p.name ?? ''}</span>
          {p.nameId && <span className="splashtag-id"> #{p.nameId}</span>}
        </div>
      </td>
      <td className="weapon-col">
        <span className="weapon-cell">
          {weaponImages.get(wName) && <img src={weaponImages.get(wName)} alt="" className="weapon-icon" />}
          <span>{wName}</span>
        </span>
      </td>
      <td className="gear-col">
        <GearGrid p={p} abilityImages={abilityImages} />
      </td>
      <td className="num-col">{pureK ?? '—'}</td>
      <td className="num-col">{result?.assist  ?? '—'}</td>
      <td className="num-col">{result?.death   ?? '—'}</td>
      <td className="num-col">{result?.special ?? '—'}</td>
      <td className="num-col">{p.paint?.toLocaleString() ?? '—'}</td>
      {showSignal && <td className="num-col">{result?.noroshiTry ?? '—'}</td>}
    </tr>
  )
}

function crownType(p: Player): 'x' | '100x' | '333x' | null {
  if (p.festDragonCert === 'DRAGON')        return '100x'
  if (p.festDragonCert === 'DOUBLE_DRAGON') return '333x'
  if (p.crown)                              return 'x'
  return null
}

// ---------------------------------------------------------------------------
// ギア 3×4 グリッド
// ---------------------------------------------------------------------------

function GearGrid({ p, abilityImages }: { p: Player; abilityImages: Map<string, string> }) {
  const gears = [
    { gear: p.headGear     },
    { gear: p.clothingGear },
    { gear: p.shoesGear    },
  ]
  return (
    <div className="gear-grid">
      {gears.map(({ gear }, i) => (
        <div key={i} className="gear-row">
          <GearSlot ability={gear?.primaryGearPower} abilityImages={abilityImages} primary />
          {[0, 1, 2].map(idx => (
            <GearSlot key={idx} ability={gear?.additionalGearPowers?.[idx]} abilityImages={abilityImages} />
          ))}
        </div>
      ))}
    </div>
  )
}

function GearSlot({ ability, abilityImages, primary }: {
  ability?: { name?: string; image?: { url?: string } }
  abilityImages: Map<string, string>
  primary?: boolean
}) {
  const url = ability?.image?.url
  const key = abilityKeyFromUrl(url)
  const imgUrl = key ? abilityImages.get(key) : undefined
  const label  = (key && ABILITY_LABELS[key]) ?? ability?.name ?? ''
  return (
    <span className={`gear-slot${primary ? ' primary' : ''}`} title={label}>
      {imgUrl
        ? <img src={imgUrl} alt={label} />
        : <span className="gear-slot-fallback">·</span>}
    </span>
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

function LogStatCard({ label, value, valueColor, small }: { label: string; value: string; valueColor?: string; small?: boolean }) {
  return (
    <div className="stat-card">
      <div className="stat-label">{label}</div>
      <div className={`stat-value${small ? ' stat-value--small' : ''}`} style={valueColor ? { color: valueColor } : undefined}>{value}</div>
    </div>
  )
}

function tryParse(s: string): unknown {
  try { return JSON.parse(s) } catch { return null }
}
