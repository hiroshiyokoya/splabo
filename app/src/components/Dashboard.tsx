import { useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { invoke } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'
import {
  BarChart, Bar,
  XAxis, YAxis, CartesianGrid, ResponsiveContainer, Cell, ReferenceLine,
} from 'recharts'
import { HoverTooltip } from './charts/HoverTooltip'
import {
  DndContext, closestCenter, KeyboardSensor, PointerSensor, useSensor, useSensors,
  type DragEndEvent,
} from '@dnd-kit/core'
import {
  SortableContext, sortableKeyboardCoordinates, rectSortingStrategy, arrayMove,
} from '@dnd-kit/sortable'
import type { Summary, SummaryEntry, Filters, BattleStats, BattleRow, GroupedStatsRow, GroupedStatsRow2D, CustomChart, GroupByKey, WeaponRecord } from '../types'
import { BATTLE_NUMERIC_DEFAULT_BIN } from '../types'
import {
  filtersToRange, modeLabel, ruleLabel, modeFilterArg, ruleFilterArg,
  fmtKillWithAssist, fmtKillRatioWithContrib,
} from '../types'
import { stageSummaryTickLabel, summaryEntryDisplayName } from '../i18n/displayName'
import { CustomChartCard } from './CustomChartCard'
import { ChartConfigModal } from './ChartConfigModal'
import { loadCustomCharts, saveCustomCharts, generateChartId } from '../utils/customCharts'
import type { WeaponMeta } from '../utils/scatterCategoryColors'
import { loadSubSpImageMaps, loadStageImageMap } from '../utils/weaponKitImages'
import { PanelExportButton, PanelExportCaption, PanelExportLogo } from './PanelExport'
import { EXPORT_HIDE_CLASS } from '../utils/panelExport'
import { describeFilters, buildExportCaption, useStageNames } from '../utils/filterSummary'
import { rankRowsForBarChart } from '../utils/chartSort'
import { WIN_RATE_HI, WIN_RATE_LO, WIN_RATE_MID, winRateColor } from '../utils/heatmapColors'

const COLOR_WIN  = '#22c55e'
const COLOR_LOSE = '#ef4444'
const COLOR_DRAW = '#9ca3af'

function winRateLevel(rate: number): 'hi' | 'mid' | 'lo' {
  if (rate >= 0.55) return 'hi'
  if (rate >= 0.45) return 'mid'
  return 'lo'
}

// 積み上げバーで「最上段のセグメントだけ上端を角丸」にする shape。
// Recharts の radius={[r,r,0,0]} を全 stack に付けると各セグメントが
// 個別に丸まって境目に変な凹みが出るため、shape で制御する。
// 並び(下→上): wins → losses → draws。
function stackTopRoundedShape(props: any) {
  const { x, y, width, height, fill, fillOpacity, payload, dataKey } = props
  if (height <= 0) return null
  const isTop =
    (dataKey === 'draws'  && payload.draws  > 0) ||
    (dataKey === 'losses' && payload.draws === 0 && payload.losses > 0) ||
    (dataKey === 'wins'   && payload.draws === 0 && payload.losses === 0 && payload.wins > 0)
  const r = isTop ? Math.min(4, height / 2, width / 2) : 0
  if (r === 0) {
    return <rect x={x} y={y} width={width} height={height} fill={fill} fillOpacity={fillOpacity} />
  }
  const d =
    `M ${x},${y + r} Q ${x},${y} ${x + r},${y} ` +
    `L ${x + width - r},${y} Q ${x + width},${y} ${x + width},${y + r} ` +
    `L ${x + width},${y + height} L ${x},${y + height} Z`
  return <path d={d} fill={fill} fillOpacity={fillOpacity} />
}

type SortBy = 'total' | 'wins' | 'win_rate'

interface Props {
  filters: Filters
  /** サイドバーの「最新データを取得」と同じ処理を空状態のボタンからも呼べるようにする。 */
  onFetchRequest?: () => void
  /** 「設定タブを開く」ためのコールバック(ログイン誘導用)。 */
  onOpenSettings?: () => void
  /** 取得中はボタンを disable + 表示文言を変えるためのフラグ。 */
  fetching?: boolean
}

export function Dashboard({ filters, onFetchRequest, onOpenSettings, fetching }: Props) {
  const { t, i18n } = useTranslation()
  const [summary, setSummary] = useState<Summary | null>(null)
  const [stats, setStats]     = useState<BattleStats | null>(null)
  // #86 PR B: ユーザーが追加したカスタムグラフ。localStorage に永続化。
  const [customCharts, setCustomCharts] = useState<CustomChart[]>(() => loadCustomCharts())
  // 各 groupBy のデータをキャッシュ(同じキーを複数カードで参照するので 1 回で済ませる)。
  const [groupedStatsCache, setGroupedStatsCache] = useState<Partial<Record<GroupByKey, GroupedStatsRow[]>>>({})
  // ヒートマップ用の 2D キャッシュ。キーは `${groupBy}|${groupBy2}|${topN}`。
  const [grouped2dCache, setGrouped2dCache] = useState<Record<string, GroupedStatsRow2D[]>>({})
  // バトル単位散布図のキャッシュ (フィルター変更時のみ再取得)
  const [battleData, setBattleData] = useState<BattleRow[]>([])
  // モーダル状態：null=閉じる、{ chart: null }=新規、{ chart: 既存 }=編集
  const [modalState, setModalState] = useState<{ chart: CustomChart | null } | null>(null)
  const [loading, setLoading] = useState(true)
  const [refreshKey, setRefreshKey] = useState(0)
  const [weaponImages, setWeaponImages] = useState<Map<string, string>>(new Map())
  const [weaponMeta, setWeaponMeta] = useState<Map<string, WeaponMeta>>(new Map())
  const [weaponEnByName, setWeaponEnByName] = useState<Map<string, string | null>>(new Map())
  const [stageImages, setStageImages] = useState<Map<string, string>>(new Map())
  const [subImages, setSubImages] = useState<Map<string, string>>(new Map())
  const [spImages, setSpImages] = useState<Map<string, string>>(new Map())
  const [weaponSort, setWeaponSort] = useState<SortBy>('total')
  const [stageSort, setStageSort] = useState<SortBy>('total')
  const [ruleSort, setRuleSort] = useState<SortBy>('total')
  const [modeSort, setModeSort] = useState<SortBy>('total')

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  )

  // 画像保存に焼き込む条件(#500)。FilterBar は画面上部にあり画像には写らない。
  // キャプション本体は末尾に該当バトル数が付くので、集計が出そろってから組む(下の filterSummary)。
  const stageNames      = useStageNames()
  const filterConditions = useMemo(
    () => describeFilters(filters, stageNames, weaponEnByName),
    [filters, stageNames, weaponEnByName],
  )

  useEffect(() => {
    const { since, until } = filtersToRange(filters)
    setLoading(true)
    const filterArgs = {
      since,
      until,
      mode: modeFilterArg(filters.mode),
      rule: ruleFilterArg(filters.rule),
      resultFilter: filters.result,
      weapon: filters.weapon.length > 0 ? filters.weapon.join('|') : null,
      stage: filters.stage.length > 0 ? filters.stage.join('|') : null,
    }
    // カスタムグラフが必要としている group_by を unique にまとめて 1 回ずつ取得。
    // 1D: heatmap 以外。 2D: heatmap のみ。 BattleRow: scatter で dotUnit='battle' のみ。
    const neededGroups = Array.from(new Set(customCharts.filter(c => c.shape !== 'heatmap').map(c => c.groupBy)))
    // 2D 用：軸タイプ・bin 幅・topN まで含めた完全なキーで集約。
    // 数値軸 (#134) のときは `numeric:metric` を BE に送り、bin_width も併送。
    function axisKey(c: CustomChart, side: 'x' | 'y'): { gb: string; bin: number | null } {
      if (side === 'x') {
        return c.xNumericMetric
          ? { gb: `numeric:${c.xNumericMetric}`, bin: c.xBinWidth ?? BATTLE_NUMERIC_DEFAULT_BIN[c.xNumericMetric] }
          : { gb: c.groupBy,  bin: null }
      } else {
        return c.yNumericMetric
          ? { gb: `numeric:${c.yNumericMetric}`, bin: c.yBinWidth ?? BATTLE_NUMERIC_DEFAULT_BIN[c.yNumericMetric] }
          : { gb: c.groupBy2 ?? 'stage', bin: null }
      }
    }
    const heatmapSpecs = customCharts.filter(c =>
      c.shape === 'heatmap' && (c.groupBy2 || c.xNumericMetric || c.yNumericMetric)
    ).map(c => {
      const xa = axisKey(c, 'x')
      const ya = axisKey(c, 'y')
      const tn = c.topN ?? 20
      return { c, xa, ya, tn, key: `${xa.gb}|${xa.bin ?? ''}|${ya.gb}|${ya.bin ?? ''}|${tn}` }
    })
    const needed2dKeys = Array.from(new Map(heatmapSpecs.map(s => [s.key, s])).values())
    const needsBattleData = customCharts.some(c => c.shape === 'scatter' && c.dotUnit === 'battle')

    Promise.all([
      invoke<Summary>('db_summary', filterArgs),
      invoke<BattleStats>('db_battle_stats', filterArgs),
      ...neededGroups.map(g => invoke<GroupedStatsRow[]>('db_grouped_stats', { ...filterArgs, groupBy: g }).then(rows => [g, rows] as const)),
      ...needed2dKeys.map(s => invoke<GroupedStatsRow2D[]>('db_grouped_stats_2d', {
        ...filterArgs,
        groupByX:   s.xa.gb,
        groupByY:   s.ya.gb,
        topN:       s.tn,
        xBinWidth:  s.xa.bin,
        yBinWidth:  s.ya.bin,
      }).then(rows => [s.key, rows] as const)),
      needsBattleData
        ? invoke<BattleRow[]>('db_list_battles', { ...filterArgs, limit: 10000, offset: 0, orderBy: 'played_at', orderAsc: false })
        : Promise.resolve([] as BattleRow[]),
    ])
      .then((results) => {
        const [s, st, ...rest] = results as [Summary, BattleStats, ...unknown[]]
        const gpairs = rest.slice(0, neededGroups.length) as (readonly [GroupByKey, GroupedStatsRow[]])[]
        const pairs2d = rest.slice(neededGroups.length, neededGroups.length + needed2dKeys.length) as (readonly [string, GroupedStatsRow2D[]])[]
        const battleRows = rest[neededGroups.length + needed2dKeys.length] as BattleRow[]
        setSummary(s)
        setStats(st)
        const cache: Partial<Record<GroupByKey, GroupedStatsRow[]>> = {}
        for (const [g, rows] of gpairs) cache[g] = rows
        setGroupedStatsCache(cache)
        const cache2d: Record<string, GroupedStatsRow2D[]> = {}
        for (const [k, rows] of pairs2d) cache2d[k] = rows
        setGrouped2dCache(cache2d)
        setBattleData(battleRows)
      })
      .catch(console.error)
      .finally(() => setLoading(false))
  }, [refreshKey, filters, customCharts])

  // fetch_complete イベントでデータを自動リフレッシュ
  useEffect(() => {
    const unlistenPromise = listen('fetch_complete', () => setRefreshKey(k => k + 1))
    return () => { unlistenPromise.then(fn => fn()) }
  }, [])

  // Load weapon images once
  useEffect(() => {
    invoke<WeaponRecord[]>('db_list_weapons').then(list => {
      setWeaponMeta(new Map(list.map(w => [w.name, {
        category: w.category,
        sub_weapon: w.sub_weapon,
        special_weapon: w.special_weapon,
      }])))
      setWeaponEnByName(new Map(list.map(w => [w.name, w.name_en ?? null])))
      loadSubSpImageMaps(list).then(({ subImages: sub, spImages: sp }) => {
        setSubImages(sub)
        setSpImages(sp)
      }).catch(console.error)
    }).catch(console.error)
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
    }).catch(() => {})
  }, [])

  // ステージ画像を一度だけ事前ロード(#742)。カスタムヒートマップのステージ軸チップ用。
  useEffect(() => {
    invoke<{ name: string }[]>('db_stages_used').then(list => {
      loadStageImageMap(list.map(s => s.name)).then(setStageImages).catch(console.error)
    }).catch(() => {})
  }, [])

  // ブキ軸のチャートに出てくる名前で、まだ画像を持っていないものを足す(#626)。
  //
  // 上の事前ロードは `db_weapons_used` = **自分が使ったブキだけ**なので、
  // 味方・相手ブキ軸の名前はほとんど埋まらない。画像そのものは取得時に
  // 全プレイヤー分キャッシュ済みなので、名前さえ渡せば読める。
  //
  // 取りに行った名前は `weaponIconTried` に積み、見つからなかったものを毎回引き直さない
  // (stat.ink 由来でローカルマスターに無いブキは永久に見つからない)。
  const weaponIconTried = useRef<Set<string>>(new Set())
  useEffect(() => {
    const names = new Set<string>()
    for (const c of customCharts) {
      if (c.groupBy === 'weapon' || c.groupBy === 'ally_weapon' || c.groupBy === 'enemy_weapon') {
        for (const row of groupedStatsCache[c.groupBy] ?? []) names.add(row.name)
      }
      if (c.shape !== 'heatmap' || !(c.groupBy2 || c.xNumericMetric || c.yNumericMetric)) continue
      const xa = c.xNumericMetric
        ? { gb: `numeric:${c.xNumericMetric}`, bin: c.xBinWidth ?? BATTLE_NUMERIC_DEFAULT_BIN[c.xNumericMetric] }
        : { gb: c.groupBy, bin: null as number | null }
      const ya = c.yNumericMetric
        ? { gb: `numeric:${c.yNumericMetric}`, bin: c.yBinWidth ?? BATTLE_NUMERIC_DEFAULT_BIN[c.yNumericMetric] }
        : { gb: c.groupBy2 ?? 'stage', bin: null as number | null }
      const key = `${xa.gb}|${xa.bin ?? ''}|${ya.gb}|${ya.bin ?? ''}|${c.topN ?? 20}`
      const rows = grouped2dCache[key] ?? []
      const xW = !c.xNumericMetric && (c.groupBy === 'weapon' || c.groupBy === 'ally_weapon' || c.groupBy === 'enemy_weapon')
      const yW = !c.yNumericMetric && (c.groupBy2 === 'weapon' || c.groupBy2 === 'ally_weapon' || c.groupBy2 === 'enemy_weapon')
      if (xW) for (const r of rows) names.add(r.name_x)
      if (yW) for (const r of rows) names.add(r.name_y)
    }
    const targets = [...names].filter(n => !weaponImages.has(n) && !weaponIconTried.current.has(n))
    if (targets.length === 0) return
    targets.forEach(n => weaponIconTried.current.add(n))   // 解決前に積む(再レンダーで二重に invoke しない)
    Promise.all(targets.map(name =>
      invoke<string | null>('read_image', { kind: 'weapon', name })
        .then(url => (url ? ([name, url] as [string, string]) : null))
        .catch(() => null)
    )).then(results => {
      const hits = results.filter((r): r is [string, string] => r !== null)
      if (hits.length === 0) return
      setWeaponImages(prev => {
        const next = new Map(prev)
        for (const [k, u] of hits) next.set(k, u)
        return next
      })
    })
  }, [customCharts, groupedStatsCache, grouped2dCache, weaponImages])

  const totalBattles = summary?.by_mode.reduce((s, e) => s + e.total, 0) ?? 0
  const totalWins    = summary?.by_mode.reduce((s, e) => s + e.wins,  0) ?? 0
  const totalDraws   = summary?.by_mode.reduce((s, e) => s + e.draws, 0) ?? 0
  const totalLosses  = totalBattles - totalWins - totalDraws
  const decisiveBattles = totalBattles - totalDraws
  const overallWinRate  = decisiveBattles > 0 ? totalWins / decisiveBattles : null
  // 保存画像のキャプション(#553)。集計未取得のうちは「該当 0 バトル」を出さない。
  const filterSummary = buildExportCaption(filterConditions, summary ? totalBattles : null)
  // カレンダーの表示範囲に渡す(#461)
  const { since: filterSince, until: filterUntil } = filtersToRange(filters)

  function sorted(data: SummaryEntry[], by: SortBy): SummaryEntry[] {
    return [...data].sort((a, b) => b[by] - a[by])
  }

  /** 固定のブキ別: 指標で全件ソートしてから上位 14(#509)。逆順なし。 */
  function rankedWeapons(data: SummaryEntry[], by: SortBy): SummaryEntry[] {
    return rankRowsForBarChart(data, {
      getSortValue: row => row[by],
      getTotal: row => row.total,
      sortByWinRate: by === 'win_rate',
      dir: 'desc',
    })
  }

  // ---- カスタムグラフ操作 ----
  function persist(charts: CustomChart[]) {
    setCustomCharts(charts)
    saveCustomCharts(charts)
  }
  function handleAdd() {
    setModalState({ chart: null })
  }
  function handleEdit(id: string) {
    const c = customCharts.find(x => x.id === id)
    if (c) setModalState({ chart: c })
  }
  function handleDelete(id: string) {
    persist(customCharts.filter(c => c.id !== id))
  }
  function handleSaveFromModal(saved: CustomChart) {
    if (saved.id) {
      // 編集モード：同じ ID で置換
      persist(customCharts.map(c => c.id === saved.id ? saved : c))
    } else {
      // 新規モード：ID を生成して末尾に追加
      persist([...customCharts, { ...saved, id: generateChartId() }])
    }
    setModalState(null)
  }
  function handleDragEnd(event: DragEndEvent) {
    const { active, over } = event
    if (!over || active.id === over.id) return
    const oldIdx = customCharts.findIndex(c => c.id === active.id)
    const newIdx = customCharts.findIndex(c => c.id === over.id)
    if (oldIdx < 0 || newIdx < 0) return
    persist(arrayMove(customCharts, oldIdx, newIdx))
  }

  const weaponLabelByKey = useMemo(() => {
    if (!summary) return new Map<string, string>()
    return new Map(summary.by_weapon.map(e => [e.name, summaryEntryDisplayName(e)]))
  }, [summary, i18n.language])

  const stageNameTransform = useMemo(() => {
    if (!summary) return (n: string) => n
    const m = new Map(summary.by_stage.map(e => [e.name, stageSummaryTickLabel(e)]))
    return (n: string) => m.get(n) ?? n
  }, [summary, i18n.language])

  return (
    <div className="dashboard">
      {loading ? (
        <div className="loading">{t('common.loading')}</div>
      ) : !summary || totalBattles === 0 ? (
        <DashboardEmptyState
          onFetchRequest={onFetchRequest}
          onOpenSettings={onOpenSettings}
          fetching={fetching}
        />
      ) : (
        <>
          <div className="stat-cards">
            <StatCard label={t('dashboard.totalBattles')} value={totalBattles.toLocaleString()} />
            <StatCard label={t('dashboard.winLoseDraw')} value={`${totalWins} / ${totalLosses} (${totalDraws})`} />
            <StatCard
              label={t('dashboard.overallWinRate')}
              value={overallWinRate !== null ? `${(overallWinRate * 100).toFixed(1)}%` : '-'}
              valueColor={overallWinRate !== null ? winRateColor(overallWinRate) : undefined}
            />
            {/* カッコ内が何かはラベルで示す(#561)。「Win / Lose (Draw)」と同じ書き方。 */}
            <StatCard label={t('dashboard.avgKillAssist')} value={fmtKillWithAssist(stats?.avg_kill, stats?.avg_assist)} />
            <StatCard label={t('dashboard.avgDeath')} value={stats?.avg_death != null ? stats.avg_death.toFixed(2) : '-'} />
            <StatCard label={t('dashboard.kdContrib')} value={fmtKillRatioWithContrib(stats?.avg_kill, stats?.avg_assist, stats?.avg_death)} />
          </div>

          <div className="chart-grid">
            <ChartCard title={t('dashboard.byWeapon')} sortBy={weaponSort} onSortChange={setWeaponSort} filterSummary={filterSummary}>
              <WinRateChart data={rankedWeapons(summary.by_weapon, weaponSort)} height={260} images={weaponImages} hoverImageSize={64} labelLookup={weaponLabelByKey} />
            </ChartCard>

            <ChartCard title={t('dashboard.byStage')} sortBy={stageSort} onSortChange={setStageSort} filterSummary={filterSummary}>
              {/* ステージは現状 25 種程度で全件表示が望ましい(ブキのような大量マスターと違い slice 不要)。 */}
              <WinRateChart data={sorted(summary.by_stage, stageSort)} height={260} images={new Map()} nameTransform={stageNameTransform} tickAngle={30} />
            </ChartCard>

            <ChartCard title={t('dashboard.byRule')} sortBy={ruleSort} onSortChange={setRuleSort} filterSummary={filterSummary}>
              <WinRateChart data={sorted(summary.by_rule, ruleSort)} height={220} images={new Map()} nameTransform={ruleLabel} />
            </ChartCard>

            <ChartCard title={t('dashboard.byLobby')} sortBy={modeSort} onSortChange={setModeSort} filterSummary={filterSummary}>
              <WinRateChart data={sorted(summary.by_mode, modeSort)} height={220} images={new Map()} nameTransform={modeLabel} />
            </ChartCard>

            {/* #86 PR B: カスタムグラフ。ドラッグで並び替え可能、⚙で編集・✕で削除 */}
            <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleDragEnd}>
              <SortableContext items={customCharts.map(c => c.id)} strategy={rectSortingStrategy}>
                {customCharts.map(c => {
                  // 2D キャッシュキーは fetch 時と同じ規則で再構築。
                  let data2d: GroupedStatsRow2D[] | undefined
                  if (c.shape === 'heatmap' && (c.groupBy2 || c.xNumericMetric || c.yNumericMetric)) {
                    const xa = c.xNumericMetric
                      ? { gb: `numeric:${c.xNumericMetric}`, bin: c.xBinWidth ?? BATTLE_NUMERIC_DEFAULT_BIN[c.xNumericMetric] }
                      : { gb: c.groupBy, bin: null as number | null }
                    const ya = c.yNumericMetric
                      ? { gb: `numeric:${c.yNumericMetric}`, bin: c.yBinWidth ?? BATTLE_NUMERIC_DEFAULT_BIN[c.yNumericMetric] }
                      : { gb: c.groupBy2 ?? 'stage', bin: null as number | null }
                    const key = `${xa.gb}|${xa.bin ?? ''}|${ya.gb}|${ya.bin ?? ''}|${c.topN ?? 20}`
                    data2d = grouped2dCache[key] ?? []
                  }
                  return (
                    <CustomChartCard
                      key={c.id}
                      chart={c}
                      data={groupedStatsCache[c.groupBy] ?? []}
                      data2d={data2d}
                      battleData={c.shape === 'scatter' && c.dotUnit === 'battle' ? battleData : undefined}
                      onEdit={() => handleEdit(c.id)}
                      onDelete={() => handleDelete(c.id)}
                      weaponImages={weaponImages}
                      weaponMeta={weaponMeta}
                      subImages={subImages}
                      spImages={spImages}
                      stageImages={stageImages}
                      since={filterSince}
                      until={filterUntil}
                      filterSummary={filterSummary}
                    />
                  )
                })}
              </SortableContext>
            </DndContext>

          </div>

          <div className="dashboard-add-row">
            <button className="btn-secondary dashboard-add-btn" onClick={handleAdd}>
              {t('dashboard.addChart')}
            </button>
          </div>
        </>
      )}

      {modalState && (
        <ChartConfigModal
          initial={modalState.chart}
          onSave={handleSaveFromModal}
          onClose={() => setModalState(null)}
        />
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------
// 空状態(DB にバトルが 1 件も無いとき)
// ---------------------------------------------------------------------------

function DashboardEmptyState({ onFetchRequest, onOpenSettings, fetching }: {
  onFetchRequest?: () => void
  onOpenSettings?: () => void
  fetching?: boolean
}) {
  const { t } = useTranslation()
  return (
    <div className="dashboard-empty">
      <div className="dashboard-empty-icon" aria-hidden="true">📊</div>
      <h3 className="dashboard-empty-title">{t('dashboard.emptyTitle')}</h3>
      <p className="dashboard-empty-desc">{t('dashboard.emptyDesc')}</p>
      <ol className="dashboard-empty-steps">
        <li>{t('dashboard.emptyStep1', { settings: t('nav.settings') })}</li>
        <li>{t('dashboard.emptyStep2', { fetch: t('nav.fetch') })}</li>
      </ol>
      <div className="dashboard-empty-actions">
        {onFetchRequest && (
          <button className="btn-primary" onClick={onFetchRequest} disabled={fetching}>
            {fetching ? t('nav.fetching') : t('nav.fetch')}
          </button>
        )}
        {onOpenSettings && (
          <button className="btn-secondary" onClick={onOpenSettings}>
            {t('common.openSettings')}
          </button>
        )}
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Custom XAxis tick - controlled by parent's activeIndex
// ---------------------------------------------------------------------------

function ImageTick(props: {
  x?: number; y?: number; payload?: { value: string }; index?: number
  images: Map<string, string>
  activeIndex: number | null
  onHoverIndex: (i: number | null) => void
  hoverSize: number
  nameTransform?: (name: string) => string
  tickAngle?: number
}) {
  const { x = 0, y = 0, payload, index, images, activeIndex, onHoverIndex, hoverSize, nameTransform, tickAngle } = props
  if (!payload) return null
  const isActive  = activeIndex === null || activeIndex === index
  const isHovered = activeIndex === index
  const url = images.get(payload.value)
  if (url) {
    const size   = isHovered ? hoverSize : 32
    const offset = -(size / 2)
    const yOff   = 36 - size  // bottom of image stays fixed at y+36
    return (
      <g
        transform={`translate(${x},${y})`}
        style={{ cursor: 'pointer', opacity: isActive ? 1 : 0.35 }}
        onMouseEnter={() => onHoverIndex(index ?? null)}
        onMouseLeave={() => onHoverIndex(null)}
      >
        <image
          href={url}
          x={offset} y={yOff}
          width={size} height={size}
          style={{ transition: 'all 0.15s' }}
        />
      </g>
    )
  }
  const raw = payload.value
  const label = nameTransform ? nameTransform(raw) : (raw.length > 6 ? raw.slice(0, 6) + '…' : raw)
  const textProps = {
    fill: 'var(--text)' as const,
    fontSize: 10,
    opacity: isActive ? 1 : 0.4,
    fontWeight: isHovered ? 700 : 400,
    onMouseEnter: () => onHoverIndex(index ?? null),
    onMouseLeave: () => onHoverIndex(null),
    style: { cursor: 'default' as const },
  }
  if (tickAngle) {
    return (
      <g transform={`translate(${x}, ${y + 4})`}>
        <text {...textProps} transform={`rotate(${tickAngle})`} textAnchor="start">
          {label}
        </text>
      </g>
    )
  }
  return (
    <text {...textProps} x={x} y={y + 10} textAnchor="middle">
      {label}
    </text>
  )
}

// ---------------------------------------------------------------------------
// WinRateChart - activeIndex shared between tick icons and bars
// ---------------------------------------------------------------------------

function WinRateChart({ data, height, images, hoverImageSize = 64, nameTransform, tickAngle, labelLookup }: {
  data: SummaryEntry[]
  height: number
  images: Map<string, string>
  hoverImageSize?: number
  nameTransform?: (name: string) => string
  tickAngle?: number
  /** Slug/key → localized display label (weapon chart tooltip). */
  labelLookup?: Map<string, string>
}) {
  const { t } = useTranslation()
  const [activeIndex, setActiveIndex] = useState<number | null>(null)
  const hasImages = data.some(d => images.has(d.name))
  const tickHeight = hasImages ? 40 : tickAngle ? 36 : 16
  const tickStyle = { fontSize: 10, fill: 'var(--text)' }

  const chartData = data.map(d => ({ ...d, losses: d.total - d.wins - d.draws }))

  function cellOpacity(i: number) {
    return activeIndex === null || activeIndex === i ? 1 : 0.35
  }

  // バーごとに上→下のグラデーション。上端で 95%、下端で 50% の不透明度。
  // SVG gradient ID はチャート間で衝突しないよう React useId を使うのが安全だが、
  // 1 ページに複数置いてもブラウザ的には問題ない(同一定義のため)。
  const gradients: { id: string; color: string }[] = [
    { id: 'grad-win',      color: COLOR_WIN  },
    { id: 'grad-lose',     color: COLOR_LOSE },
    { id: 'grad-draw',     color: COLOR_DRAW },
    { id: 'grad-rate-hi',  color: WIN_RATE_HI  },
    { id: 'grad-rate-mid', color: WIN_RATE_MID },
    { id: 'grad-rate-lo',  color: WIN_RATE_LO  },
  ]

  // HoverTooltip 位置計算用：左 YAxis 36 + 右 YAxis 36(+ マージン 8)
  const leftPad  = 36
  const rightPad = 36 + 8

  return (
    <div className="chart-hover-area" style={{ position: 'relative' }}>
    <ResponsiveContainer width="100%" height={height}>
      <BarChart
        data={chartData}
        margin={{ top: 4, right: 8, left: 0, bottom: hasImages ? 8 : 4 }}
        onMouseLeave={() => setActiveIndex(null)}
      >
        <defs>
          {gradients.map(g => (
            <linearGradient key={g.id} id={g.id} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%"   stopColor={g.color} stopOpacity="0.95" />
              <stop offset="100%" stopColor={g.color} stopOpacity="0.5"  />
            </linearGradient>
          ))}
        </defs>
        <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" vertical={false} />
        <XAxis
          dataKey="name"
          tick={(props: any) => (
            <ImageTick
              {...props}
              images={images}
              activeIndex={activeIndex}
              onHoverIndex={setActiveIndex}
              hoverSize={hoverImageSize}
              nameTransform={nameTransform}
              tickAngle={tickAngle}
            />
          )}
          interval={0}
          height={tickHeight}
        />
        <YAxis yAxisId="left" tick={tickStyle} width={36} />
        <YAxis
          yAxisId="right"
          orientation="right"
          tickFormatter={(v) => `${(v * 100).toFixed(0)}%`}
          domain={[0, 1]}
          tick={tickStyle}
          width={36}
        />
        <ReferenceLine yAxisId="right" y={0.5} stroke="#4b5563" strokeDasharray="4 4" />
        <Bar yAxisId="left" dataKey="wins" stackId="s" maxBarSize={32} activeBar={false}
          shape={stackTopRoundedShape}
          onMouseEnter={(_: any, index: number) => setActiveIndex(index)}
        >
          {chartData.map((_, i) => <Cell key={i} fill="url(#grad-win)" fillOpacity={cellOpacity(i)} />)}
        </Bar>
        <Bar yAxisId="left" dataKey="losses" stackId="s" maxBarSize={32} activeBar={false}
          shape={stackTopRoundedShape}
          onMouseEnter={(_: any, index: number) => setActiveIndex(index)}
        >
          {chartData.map((_, i) => <Cell key={i} fill="url(#grad-lose)" fillOpacity={cellOpacity(i)} />)}
        </Bar>
        <Bar yAxisId="left" dataKey="draws" stackId="s" maxBarSize={32} activeBar={false}
          shape={stackTopRoundedShape}
          onMouseEnter={(_: any, index: number) => setActiveIndex(index)}
        >
          {chartData.map((_, i) => <Cell key={i} fill="url(#grad-draw)" fillOpacity={cellOpacity(i)} />)}
        </Bar>
        <Bar yAxisId="right" dataKey="win_rate" name="win_rate" maxBarSize={32} activeBar={false}
          radius={[4, 4, 0, 0]}
          onMouseEnter={(_: any, index: number) => setActiveIndex(index)}
        >
          {chartData.map((entry, i) => (
            <Cell key={i} fill={`url(#grad-rate-${winRateLevel(entry.win_rate)})`} fillOpacity={cellOpacity(i)} />
          ))}
        </Bar>
      </BarChart>
    </ResponsiveContainer>
    <HoverTooltip activeIndex={activeIndex} dataLength={chartData.length} leftPad={leftPad} rightPad={rightPad}>
      {activeIndex != null && (() => {
        const entry = chartData[activeIndex]
        const displayLabel = nameTransform
          ? nameTransform(entry.name)
          : (labelLookup?.get(entry.name) ?? entry.name)
        return (
          <>
            <div className="hover-tt-title">{displayLabel}</div>
            <div className="hover-tt-row">{t('dashboard.ttTotal', { n: entry.total })}</div>
            <div className="hover-tt-row" style={{ color: COLOR_WIN }}>{t('dashboard.ttWins', { n: entry.wins })}</div>
            <div className="hover-tt-row" style={{ color: COLOR_LOSE }}>{t('dashboard.ttLosses', { n: entry.total - entry.wins - entry.draws })}</div>
            {entry.draws > 0 && <div className="hover-tt-row" style={{ color: COLOR_DRAW }}>{t('dashboard.ttDraws', { n: entry.draws })}</div>}
            <div className="hover-tt-row">{t('dashboard.ttWinRate', { pct: (entry.win_rate * 100).toFixed(1) })}</div>
          </>
        )
      })()}
    </HoverTooltip>
    </div>
  )
}

// ---------------------------------------------------------------------------
// ChartCard with optional sort buttons
// ---------------------------------------------------------------------------

function StatCard({ label, value, valueColor, small }: { label: string; value: string; valueColor?: string; small?: boolean }) {
  return (
    <div className="stat-card">
      <div className="stat-label">{label}</div>
      <div className={`stat-value${small ? ' stat-value--small' : ''}`} style={valueColor ? { color: valueColor } : undefined}>{value}</div>
    </div>
  )
}

function ChartCard({
  title, children, sortBy, onSortChange, filterSummary,
}: {
  title: string
  children: React.ReactNode
  sortBy?: SortBy
  onSortChange?: (s: SortBy) => void
  /** 画像保存時に焼き込む絞り込み条件(#500)。 */
  filterSummary: string
}) {
  const { t } = useTranslation()
  const cardRef = useRef<HTMLDivElement>(null)
  return (
    <div className="chart-card" ref={cardRef}>
      <PanelExportLogo />
      <div className="chart-card-header">
        <h3 className="chart-title">{title}</h3>
        <div className="chart-card-actions">
          {onSortChange && (
            <div className={`chart-sort-btns ${EXPORT_HIDE_CLASS}`}>
              <button
                className={`chart-sort-btn${sortBy === 'total' ? ' active' : ''}`}
                onClick={() => onSortChange('total')}
              >{t('metrics.total')}</button>
              <button
                className={`chart-sort-btn${sortBy === 'wins' ? ' active' : ''}`}
                onClick={() => onSortChange('wins')}
              >{t('metrics.wins')}</button>
              <button
                className={`chart-sort-btn${sortBy === 'win_rate' ? ' active' : ''}`}
                onClick={() => onSortChange('win_rate')}
              >{t('metrics.win_rate')}</button>
            </div>
          )}
          <PanelExportButton targetRef={cardRef} screen={t('chart.screenDashboard')} panel={title} />
        </div>
      </div>
      <PanelExportCaption conditions={filterSummary} />
      {children}
    </div>
  )
}

// ---------------------------------------------------------------------------
// AI chart renderer
// ---------------------------------------------------------------------------

