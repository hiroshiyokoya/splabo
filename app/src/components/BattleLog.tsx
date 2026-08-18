import { useEffect, useMemo, useState, useCallback } from 'react'
import { useTranslation } from 'react-i18next'
import { invoke } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'
import { openUrl } from '@tauri-apps/plugin-opener'
import type { BattleRow, BattleStats, Filters, ParentJson, Player, Team, VsHistoryDetail, Award } from '../types'
import {
  filtersToRange, modeLabel, ruleLabel, resultLabel, modeFilterArg, ruleFilterArg,
  fmtKillWithAssist, fmtKillRatioWithContrib,
} from '../types'
import { ABILITY_LABELS, abilityKeyFromUrl, colorToHex, loadAbilityImages } from '../utils/abilities'
import { winRateColor } from '../utils/heatmapColors'
import { battleStageDisplayName, battleWeaponDisplayName } from '../i18n/displayName'

const PAGE_SIZE = 50

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

/** 規定ブラウザで URL を開く(Tauri webview 内に開かない)。 */
function openExternal(url: string) {
  openUrl(url).catch(console.error)
}

function dateLocale(lang: string): string {
  return lang.startsWith('en') ? 'en-US' : 'ja-JP'
}

export function BattleLog({ filters, statinkScreenName }: Props) {
  const { t, i18n } = useTranslation()
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

  // ブキ・アビリティ・ステージ画像をロード
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
      mode: modeFilterArg(filters.mode),
      rule: ruleFilterArg(filters.rule),
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
    <div className="battle-log book--fill">
      {stats && (
        <div className="stat-cards" style={{ marginBottom: 12 }}>
          <LogStatCard label={t('dashboard.totalBattles')}        value={stats.total.toLocaleString()} />
          <LogStatCard label={t('dashboard.winLoseDraw')}
            value={`${stats.wins} / ${stats.total - stats.wins - stats.draws} (${stats.draws})`} />
          <LogStatCard label={t('dashboard.overallWinRate')}          value={stats.total > 0 ? `${(stats.win_rate * 100).toFixed(1)}%` : '-'}
            valueColor={stats.total > 0 ? winRateColor(stats.win_rate) : undefined} />
          {/* カッコ内が何かはラベルで示す(#561)。「Win / Lose (Draw)」と同じ書き方。 */}
          <LogStatCard label={t('dashboard.avgKillAssist')} value={fmtKillWithAssist(stats.avg_kill, stats.avg_assist)} />
          <LogStatCard label={t('dashboard.avgDeath')}           value={stats.avg_death !== null ? stats.avg_death.toFixed(2) : '-'} />
          <LogStatCard label={t('dashboard.kdContrib')}       value={fmtKillRatioWithContrib(stats.avg_kill, stats.avg_assist, stats.avg_death)} />
        </div>
      )}

      {loading ? (
        <div className="loading">{t('common.loading')}</div>
      ) : battles.length === 0 ? (
        <div className="empty">{t('battles.empty')}</div>
      ) : (
        <>
          <div className="book-table-wrap">
            <table className="battle-table">
            <thead>
              <tr>
                <th className="team-color-th"></th>
                <SortTh col="played_at" label={t('battles.datetime')}   orderBy={orderBy} orderAsc={orderAsc} onSort={handleSort} />
                <th>{t('battles.lobby')}</th>
                <th>{t('battles.rule')}</th>
                <th>{t('battles.stage')}</th>
                <th>{t('battles.weapon')}</th>
                <th>{t('battles.result')}</th>
                <SortTh col="kill"       label="K"     orderBy={orderBy} orderAsc={orderAsc} onSort={handleSort} />
                <SortTh col="assist"     label="A"     orderBy={orderBy} orderAsc={orderAsc} onSort={handleSort} />
                <SortTh col="death"      label="D"     orderBy={orderBy} orderAsc={orderAsc} onSort={handleSort} />
                <SortTh col="kill_ratio" label={t('battles.killRatio')} orderBy={orderBy} orderAsc={orderAsc} onSort={handleSort} />
                <SortTh col="special"    label="SP"    orderBy={orderBy} orderAsc={orderAsc} onSort={handleSort} />
                <SortTh col="inked"      label={t('battles.inked')}  orderBy={orderBy} orderAsc={orderAsc} onSort={handleSort} />
                <th className="statink-col-th" title={t('battles.statUploaded')}>stat</th>
              </tr>
            </thead>
            <tbody>
              {battles.map((b, idx) => {
                const isKo  = !!b.knockout && b.knockout !== 'NEITHER'
                return (
                  <tr key={b.id} className={`result-${b.result} clickable-row`} onClick={() => setSelectedIdx(idx)}>
                    <td className={`team-color-cell result-stripe--${b.result.toLowerCase()}`} />
                    <td>{new Date(b.played_at).toLocaleString(dateLocale(i18n.language), { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })}</td>
                    <td>{modeLabel(b.mode)}</td>
                    <td>{ruleLabel(b.rule)}</td>
                    <td>{battleStageDisplayName(b)}</td>
                    <td>
                      <span className="weapon-cell">
                        {weaponImages.get(b.weapon) && <img src={weaponImages.get(b.weapon)} alt="" className="weapon-icon" />}
                        {battleWeaponDisplayName(b)}
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
                          title={t('battles.openStatink')}
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
          </div>

          <div className="pagination">
            <button disabled={offset === 0} onClick={() => setOffset(Math.max(0, offset - PAGE_SIZE))}>{t('battles.prevPage')}</button>
            <span>{offset + 1}–{Math.min(offset + PAGE_SIZE, total)} / {total}</span>
            <button disabled={offset + PAGE_SIZE >= total} onClick={() => setOffset(offset + PAGE_SIZE)}>{t('battles.nextPage')}</button>
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

/**
 * 背景ステージ画像を横方向のどこで切り出すか(0–100 の %)を、バトル ID から決める(#416)。
 *
 * modal は縦長なので `background-size: cover` では縦が全部入り、横が約 4 割切れる。
 * その「横のどこを見せるか」を毎回変えて単調さを避ける。
 *
 * 🔴 `Math.random()` は使わない。レンダリングのたびに値が変わるので、ホバーや状態更新の
 * 再レンダリングで背景がガタつく。ID からのハッシュなら見た目の多様性は同じまま、
 * **再レンダリングで動かず、同じバトルを開き直せば同じ絵**になる。
 */
function stageCropX(id: string): number {
  // djb2。暗号強度は不要で、ID の分布をばらけさせられればよい。
  let h = 5381
  for (let i = 0; i < id.length; i++) h = ((h << 5) + h + id.charCodeAt(i)) | 0
  return (h >>> 0) % 101
}

function BattleDetailModal({ battle, weaponImages, abilityImages, stageImages, statinkScreenName, onClose, onPrev, onNext }: {
  battle: BattleRow
  weaponImages: Map<string, string>
  abilityImages: Map<string, string>
  stageImages: Map<string, string>
  statinkScreenName: string | null
  onClose: () => void
  onPrev?: () => void  // 前のバトル(先頭なら undefined)
  onNext?: () => void  // 次のバトル(末尾なら undefined)
}) {
  const { t, i18n } = useTranslation()
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

  // raw_json から詳細を取得(チームカラー・スコア・トリカラー対応)
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
    ? ({
        ['--stage-bg' as string]: `url("${stageImage}")`,
        ['--stage-pos' as string]: `${stageCropX(battle.id)}% center`,
      } as React.CSSProperties)
    : undefined

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-panel modal-panel--with-stage" style={panelStyle} onClick={e => e.stopPropagation()}>
        <div className="modal-header">
          <span className={`result-badge ${battle.result.toLowerCase()}`}>{resultLabel(battle.result)}</span>
          {isKo && <span className="ko-badge">KO</span>}
          <span className="modal-title-text">{modeLabel(battle.mode)} / {ruleLabel(battle.rule)}</span>
          <span className="modal-stage">{battleStageDisplayName(battle)}</span>
          <span className="modal-meta">
            {new Date(battle.played_at).toLocaleString(dateLocale(i18n.language))}
            {battle.duration > 0 && <> · {durationMin}:{String(durationSec).padStart(2, '0')}</>}
            {battle.statink_uuid && (
              <button
                className="statink-badge"
                title={t('battles.openStatinkId', { id: battle.statink_uuid })}
                onClick={() => openExternal(statinkBattleUrl(battle.statink_uuid!, statinkScreenName))}
              >stat.ink ✓</button>
            )}
          </span>
          <div className="modal-nav">
            <button className="modal-nav-btn" onClick={onPrev} disabled={!onPrev} title={t('battles.prevTitle')}>{t('battles.prev')}</button>
            <button className="modal-nav-btn" onClick={onNext} disabled={!onNext} title={t('battles.nextTitle')}>{t('battles.next')}</button>
          </div>
          <button className="modal-close" onClick={onClose} aria-label={t('common.close')}>✕</button>
        </div>

        <div className="modal-body">
          {!hasDetail && (
            <div className="detail-notice">{t('battles.noDetail')}</div>
          )}

          {hasDetail && (myTeam || otherTeams.length > 0) && (
            <ScoreSummary myTeam={myTeam} otherTeams={otherTeams} rule={battle.rule} />
          )}

          {awards.length > 0 && (
            <section className="modal-section">
              <h3 className="modal-section-title">{t('battles.awards')}</h3>
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
              <h3 className="modal-section-title">{t('battles.scoreboard')}</h3>
              <div className="teams-stack">
                {myTeam && (
                  <TeamPanel
                    team={myTeam}
                    label={t('battles.myTeam')}
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
                    label={otherTeams.length > 1 ? t('battles.enemyTeamN', { n: i + 1 }) : t('battles.enemyTeam')}
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
// スコアサマリ(モーダル上部)
// ---------------------------------------------------------------------------

function ScoreSummary({ myTeam, otherTeams }: {
  myTeam: Team | null
  otherTeams: Team[]
  rule: string
}) {
  const { t } = useTranslation()
  const myColor = colorToHex(myTeam?.color)
  const teams   = [{ team: myTeam, color: myColor }, ...otherTeams.map(team => ({ team, color: colorToHex(team.color) }))]

  // ルール文字列に依存せず、result の値で何を表示するか決める：
  // paintRatio が数値なら 塗り%、なければ score を数値表示。result 自体が null(中断・切断バトル等)なら '-'。
  function renderScore(team: Team | null): string {
    const r = team?.result
    if (r == null) return '-'
    if (typeof r.paintRatio === 'number') return `${(r.paintRatio * 100).toFixed(1)}%`
    if (typeof r.score      === 'number') return String(r.score)
    return '-'
  }

  return (
    <section className="modal-section score-summary">
      <div className="score-summary-row">
        {teams.map((entry, i) => (
          <div key={i} className="score-summary-team" style={{ '--team-color': entry.color ?? '#6066aa' } as React.CSSProperties}>
            <div className="score-summary-label">{i === 0 ? t('battles.meShort') : (teams.length > 2 ? t('battles.enemyShortN', { n: i }) : t('battles.enemyShort'))}</div>
            <div className="score-summary-value">{renderScore(entry.team)}</div>
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
  const { t } = useTranslation()
  return (
    <section className="modal-section my-stats-card">
      <h3 className="modal-section-title">{t('battles.myStats')}</h3>
      <div className="my-stats-grid">
        <div className="my-stats-weapon">
          {weaponImages.get(battle.weapon) && <img src={weaponImages.get(battle.weapon)} alt="" className="weapon-icon-lg" />}
          <div className="my-stats-weapon-names">
            <div className="weapon-main">{battleWeaponDisplayName(battle)}</div>
            {battle.sub_weapon     && <div className="weapon-sub">{t('battles.subPrefix', { name: battle.sub_weapon })}</div>}
            {battle.special_weapon && <div className="weapon-sp">SP: {battle.special_weapon}</div>}
          </div>
        </div>
        <div className="my-stats-numbers">
          <StatItem label={t('battles.kill')}       value={battle.kill} />
          <StatItem label={t('battles.assist')}   value={battle.assist} />
          <StatItem label={t('battles.death')}       value={battle.death} />
          <StatItem label={t('battles.special')} value={battle.special} />
          <StatItem label={t('battles.inked')}       value={battle.inked.toLocaleString()} />
        </div>
      </div>
      <RankChangeRow battle={battle} />
    </section>
  )
}

// ---------------------------------------------------------------------------
// セット結果(バンカラチャレンジ / X マッチ評価戦)
// parent_json が非 null の最新バトルに表示する
// ---------------------------------------------------------------------------

function RankChangeRow({ battle }: { battle: BattleRow }) {
  const { t } = useTranslation()
  if (!battle.parent_json) return null
  const parent = tryParse(battle.parent_json) as ParentJson | null
  if (!parent) return null

  const setWin    = parent.winCount  ?? null
  const setLose   = parent.loseCount ?? null
  const hasSet    = setWin !== null && setLose !== null

  // バンカラチャレンジのウデマエ前後
  // detail(raw_json)から udemae を取り、parent.udemaeAfter があれば「→ <after>」を表示
  const detail = tryParse(battle.raw_json) as { udemae?: string } | null
  const udemaeBefore = detail?.udemae ?? null
  const udemaeAfter  = parent.udemaeAfter ?? null
  const isPromo      = parent.isPromo === true
  const isPromoSuccess = isPromo && parent.isUdemaeUp === true

  // X マッチ評価戦のパワー前後
  const xPowerBefore = battle.x_power ?? null  // BattleRow.x_power は xMatch.lastXPower
  const xPowerAfter  = parent.xPowerAfter ?? null

  const showRank   = udemaeBefore || udemaeAfter || isPromo
  const showXPower = xPowerBefore !== null || xPowerAfter !== null
  if (!showRank && !showXPower && !hasSet) return null

  return (
    <div className="rank-change">
      {showRank && (
        <div className="rank-change-line">
          <span className="rank-change-label">{t('battles.rank')}</span>
          <span className="rank-change-value">
            {udemaeBefore ?? '?'}
            {udemaeAfter && udemaeAfter !== udemaeBefore && (
              <> → <strong>{udemaeAfter}</strong></>
            )}
            {isPromo && (
              <span className={`promo-tag ${isPromoSuccess ? 'promo-success' : 'promo-attempt'}`}>
                {isPromoSuccess ? t('battles.promoSuccess') : t('battles.promo')}
              </span>
            )}
          </span>
        </div>
      )}
      {showXPower && (
        <div className="rank-change-line">
          <span className="rank-change-label">{t('battles.xPower')}</span>
          <span className="rank-change-value">
            {xPowerBefore !== null ? xPowerBefore.toFixed(1) : '?'}
            {xPowerAfter !== null && (
              <> → <strong>{xPowerAfter.toFixed(1)}</strong></>
            )}
          </span>
        </div>
      )}
      {hasSet && (
        <div className="rank-change-line">
          <span className="rank-change-label">{t('battles.set')}</span>
          <span className="rank-change-value">
            <span style={{ color: 'var(--win)' }}>{t('battles.setWin', { n: setWin })}</span>
            {' '}
            <span style={{ color: 'var(--lose)' }}>{t('battles.setLose', { n: setLose })}</span>
          </span>
        </div>
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------
// チームパネル(スコアボード 1 チーム分)
// ---------------------------------------------------------------------------

function TeamPanel({ team, label, highlight, showSignal, weaponImages, abilityImages }: {
  team: Team
  label: string
  highlight?: boolean
  showSignal: boolean
  weaponImages: Map<string, string>
  abilityImages: Map<string, string>
}) {
  const { t } = useTranslation()
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
          {t('battles.teamTotals', { k: totalK, a: totalA, d: totalD, sp: totalSp, p: totalP.toLocaleString() })}
        </span>
      </div>
      <table className="team-table">
        <thead>
          <tr>
            <th></th>
            <th>{t('books.nameplate')}</th>
            <th>{t('books.weapon')}</th>
            <th>{t('books.gear')}</th>
            <th>K</th>
            <th>A</th>
            <th>D</th>
            <th>SP</th>
            <th>{t('battles.inked')}</th>
            {showSignal && <th>{t('books.signal')}</th>}
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
      <td className="num-col">{pureK ?? '-'}</td>
      <td className="num-col">{result?.assist  ?? '-'}</td>
      <td className="num-col">{result?.death   ?? '-'}</td>
      <td className="num-col">{result?.special ?? '-'}</td>
      <td className="num-col">{p.paint?.toLocaleString() ?? '-'}</td>
      {showSignal && <td className="num-col">{result?.noroshiTry ?? '-'}</td>}
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
          {[0, 1, 2].map(idx => {
            const ab = gear?.additionalGearPowers?.[idx]
            // ab が undefined  → スロット未解放(locked)。★0/★1 で配列に要素が無い
            // ab が empty URL  → 解放済みだが未装着(アキ)。abilityKeyFromUrl で 'empty' を解決して画像表示
            // ab が通常アビリティ → 通常表示
            return <GearSlot key={idx} ability={ab} abilityImages={abilityImages} isLocked={!ab} />
          })}
        </div>
      ))}
    </div>
  )
}

function GearSlot({ ability, abilityImages, primary, isLocked }: {
  ability?: { name?: string; image?: { url?: string } }
  abilityImages: Map<string, string>
  primary?: boolean
  isLocked?: boolean
}) {
  const { t } = useTranslation()
  const url    = ability?.image?.url
  const key    = abilityKeyFromUrl(url)
  const imgUrl = key ? abilityImages.get(key) : undefined
  const label  = isLocked ? t('battles.locked') : ((key && ABILITY_LABELS[key]) ?? ability?.name ?? '')
  return (
    <span
      className={`gear-slot${primary ? ' primary' : ''}${isLocked ? ' locked' : ''}`}
      title={label}
    >
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
