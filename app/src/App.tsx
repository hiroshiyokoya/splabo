import { useState, useEffect } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'
import { Dashboard } from './components/Dashboard'
import { BattleLog } from './components/BattleLog'
import { FilterBar } from './components/FilterBar'
import { WeaponBook } from './components/WeaponBook'
import { StageBook } from './components/StageBook'
import { AiAnalysis } from './components/AiAnalysis'
import { EnvAnalysis } from './components/EnvAnalysis'
import { Settings } from './components/Settings'
import { About } from './components/About'
import { GearSection } from './gear/GearSection'
import { ViewToggle } from './components/ViewToggle'
import type { ViewToggleOption } from './components/ViewToggle'
import type { Tab, BattlesView, AppSettings, ChartSpec, Filters } from './types'
import { DEFAULT_FILTERS } from './types'
import { loadViewPrefs, saveViewPrefs } from './utils/viewPrefs'
import { initAppSettings } from './utils/appSettings'
import { useNotify, parseFetchError } from './utils/notify'
import {
  SETTINGS_KEY,
  LAST_FETCHED_KEY,
  LAST_WEAPONS_FETCH_KEY as LAST_WEAPONS_FETCH_K,
  lsGet,
  mirrorToStore,
  importFromStoreIfNewer,
} from './utils/settingsStore'
import './App.css'

initAppSettings()

const DEFAULT_SETTINGS: AppSettings = {
  ai: { provider: 'openai', apiKey: '', model: '' },
  autoFetchEnabled: false,
  autoFetchIntervalMin: 1440, // 24h
  statink: { apiKey: '', autoUpload: false, screenName: null },
}
/** 武器マスターを再取得するインターバル（ミリ秒）。24 時間。 */
const WEAPONS_FETCH_INTERVAL_MS = 24 * 60 * 60 * 1000

/** 「バトル」タブ内のビュー切替（#296）。 */
const BATTLES_VIEWS: readonly ViewToggleOption<BattlesView>[] = [
  { key: 'dashboard', label: 'ダッシュボード', icon: '📊' },
  { key: 'list',      label: '一覧',           icon: '📋' },
]

function loadSettings(): AppSettings {
  try {
    const raw = lsGet(SETTINGS_KEY)
    if (!raw) return DEFAULT_SETTINGS
    const saved = JSON.parse(raw)
    return {
      ...DEFAULT_SETTINGS,
      ...saved,
      statink: { ...DEFAULT_SETTINGS.statink, ...(saved.statink ?? {}) },
    }
  } catch {
    return DEFAULT_SETTINGS
  }
}

export default function App() {
  const [tab, setTab] = useState<Tab>('battles')
  // 「バトル」タブ内のビュー。前回選択を localStorage から復元する（#296）。
  const [battlesView, setBattlesViewState] = useState<BattlesView>(() => loadViewPrefs().battles)
  const [settings, setSettings] = useState<AppSettings>(loadSettings)
  const [aiChart, setAiChart] = useState<ChartSpec | null>(null)
  const [loginVersion, setLoginVersion] = useState(0)
  const [filters, setFilters] = useState<Filters>(DEFAULT_FILTERS)
  const [showAbout, setShowAbout] = useState(false)
  const [lastFetchedAt, setLastFetchedAt] = useState<string | null>(
    () => lsGet(LAST_FETCHED_KEY)
  )
  const { notify } = useNotify()

  // 起動時: store（settings.json）が localStorage より新しければ取り込む（識別子変更後の復元経路 #241）。
  // 取り込んだら設定 state・派生 state を localStorage の最新値で更新する。
  useEffect(() => {
    let cancelled = false
    importFromStoreIfNewer().then(imported => {
      if (imported && !cancelled) {
        setSettings(loadSettings())
        setLastFetchedAt(lsGet(LAST_FETCHED_KEY))
        // テーマは module ロード時に initAppSettings() で既定適用済みなので、
        // 取り込み後の localStorage 値で再適用する。
        initAppSettings()
      }
    })
    return () => { cancelled = true }
  }, [])

  // 起動直後・設定変更時・store 取り込み後に、自動取得と stat.ink 設定を
  // バックエンドへ同期する（#322）。以前は設定タブ（Settings）を開いたときにしか
  // 同期されず、開かずに閉じると「自動取得 ON でもトレイに残らず終了」「スケジューラーが
  // 動かない」状態になっていた。settings は本コンポーネントが持つので、mount 時
  // （loadSettings の値）と import 後（setSettings）で必ず同期される。
  useEffect(() => {
    invoke('set_scheduler_config', {
      enabled: settings.autoFetchEnabled,
      intervalMin: settings.autoFetchIntervalMin,
    }).catch(console.error)
    invoke('set_statink_config', {
      autoUpload: settings.statink.autoUpload,
      apiKey: settings.statink.apiKey,
    }).catch(console.error)
  }, [
    settings.autoFetchEnabled,
    settings.autoFetchIntervalMin,
    settings.statink.autoUpload,
    settings.statink.apiKey,
  ])

  /** フェッチ失敗を共通の流儀でトーストに変換する。
   *  ・未ログイン → 設定タブへ誘導するボタン付き
   *  ・期限切れ・ネットワーク → 再試行ボタン付き
   *  ・それ以外 → エラー詳細を出して再試行ボタン付き */
  function reportFetchError(err: unknown, retry?: () => void) {
    const fe = parseFetchError(err)
    const action =
      fe.hint === 'settings' ? { label: '設定を開く', onClick: () => setTab('settings') } :
      retry                  ? { label: '再試行',     onClick: retry } :
      undefined
    // 未ログイン・外部サービスの一時障害は「アプリが壊れた」ではないので warning 止まり（#399）。
    const soft = fe.kind === 'not_logged_in' || fe.kind === 'upstream_unavailable'
    notify({ kind: soft ? 'warning' : 'error', title: fe.title, message: fe.message, action, durationMs: 0 })
  }

  // 認証完了後にデータ取得を実行
  useEffect(() => {
    if (loginVersion > 0) {
      invoke('fetch_battles_full').catch(err => reportFetchError(err, () => invoke('fetch_battles_full').catch(e => reportFetchError(e))))
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loginVersion])

  // バトル取得中フラグ。サイドバーの「最新データを取得」ボタン、Dashboard 空状態ボタン等が参照する。
  // 手動ボタン経由は handleFetchFull が直接 set。
  // 起動時取得・スケジューラ取得は Rust 側の fetch_start/fetch_finish イベントで設定される。
  const [fetching, setFetching] = useState(false)

  useEffect(() => {
    const unlistenPromise = listen('fetch_complete', () => {
      const now = new Date().toLocaleString('ja-JP', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })
      setLastFetchedAt(now)
      localStorage.setItem(LAST_FETCHED_KEY, now)
      void mirrorToStore()
    })
    return () => { unlistenPromise.then(fn => fn()) }
  }, [])

  // 起動時取得・スケジューラ取得でも「取得中…」を出すため、Rust 側の fetch_start/fetch_finish を listen し、
  // さらに mount 時点で進行中なら即座に取得中表示にする（起動時取得は React マウント前に始まり得る race 対策）。
  useEffect(() => {
    let disposed  = false
    // 実イベントを一度でも受け取ったら、あとから解決する is_fetching スナップショットで
    // 上書きしない（古い値でのクロバー防止）。
    let sawEvent  = false
    const startP  = listen('fetch_start',  () => { sawEvent = true; setFetching(true) })
    const finishP = listen('fetch_finish', () => { sawEvent = true; setFetching(false) })
    // listener 登録が完了してから is_fetching を読む。こうすると「登録の隙間に
    // fetch_finish を取りこぼして『取得中』が残る」race を塞げる（#402 任意4）:
    // 登録前に emit された finish は、登録後のこの再確認が false を読んで解除する。
    Promise.all([startP, finishP]).then(() => {
      invoke<boolean>('is_fetching')
        .then(v => { if (!disposed && !sawEvent) setFetching(v) })
        .catch(() => {})
    })
    return () => {
      disposed = true
      startP.then(fn => fn())
      finishP.then(fn => fn())
    }
  }, [])

  // stat.ink 自動アップロードの失敗をユーザーに見せる（#402 必須2）。
  // 以前は warn ログに畳んで握りつぶしていたため「なぜか送られない」だけが残っていた。
  // 未送信バトルは DB に残り次回自動で再送されるので、データは失われない旨も伝える。
  useEffect(() => {
    const unlistenPromise = listen<string>('statink_upload_failed', (event) => {
      const fe     = parseFetchError(event.payload)
      const isAuth = fe.kind === 'auth_expired'
      notify({
        kind:    'warning',
        title:   isAuth ? 'stat.ink の API キーを確認してください' : 'stat.ink へ送信できませんでした',
        message: isAuth
          ? 'stat.ink の API キーが無効なため送信できませんでした。設定を確認してください。未送信分は次回自動で送られます（データは失われません）。'
          : 'stat.ink が不調のため送信できませんでした。未送信分は次回自動で送られます（データは失われません）。',
        durationMs: 8000,
      })
    })
    return () => { unlistenPromise.then(fn => fn()) }
  }, [notify])

  // stat.ink の screen_name を初回アップロード時に自動取得して設定に保存
  useEffect(() => {
    const unlistenPromise = listen<string>('statink_screen_name_detected', (event) => {
      const name = event.payload
      setSettings(prev => {
        if (prev.statink.screenName === name) return prev
        const next = { ...prev, statink: { ...prev.statink, screenName: name } }
        localStorage.setItem(SETTINGS_KEY, JSON.stringify(next))
        void mirrorToStore()
        return next
      })
    })
    return () => { unlistenPromise.then(fn => fn()) }
  }, [])

  // 起動時、screen_name が未取得 & API キーありなら既存アップロード済みバトルから逆引き
  useEffect(() => {
    if (settings.statink.screenName) return
    if (!settings.statink.apiKey) return
    invoke<string | null>('detect_statink_screen_name', { apiKey: settings.statink.apiKey }).then(name => {
      if (!name) return
      setSettings(prev => {
        if (prev.statink.screenName === name) return prev
        const next = { ...prev, statink: { ...prev.statink, screenName: name } }
        localStorage.setItem(SETTINGS_KEY, JSON.stringify(next))
        void mirrorToStore()
        return next
      })
    }).catch(console.error)
  }, [settings.statink.apiKey])

  // 起動時に武器マスターの自動チェック。前回取得から 24h 経過していれば裏で再取得。
  // 失敗してもサイレント（UI ブロックしない）。
  useEffect(() => {
    const last = Number(localStorage.getItem(LAST_WEAPONS_FETCH_K) ?? 0)
    if (Date.now() - last < WEAPONS_FETCH_INTERVAL_MS) return
    invoke<number>('fetch_weapons')
      .then(count => {
        localStorage.setItem(LAST_WEAPONS_FETCH_K, String(Date.now()))
        console.log(`[startup] 武器マスター ${count} 件取得`)
      })
      .catch(err => console.warn('[startup] 武器マスター取得失敗:', err))
  }, [loginVersion])

  useEffect(() => {
    const unlistenPromise = listen<string>('deep-link-received', async (event) => {
      const url = event.payload
      if (url.startsWith('npf71b963c1b7b6d119://')) {
        try {
          await invoke('handle_auth_redirect', { url })
          setLoginVersion(v => v + 1)
        } catch (e) {
          console.error('認証リダイレクト処理失敗:', e)
        }
      }
    })
    return () => { unlistenPromise.then(fn => fn()) }
  }, [])

  // 移行が発火した初回起動時、旧バージョン（v0.7 以前の chartoon / geartoon）の
  // アンインストールを案内する。別 identifier のため single-instance では共存を防げず、
  // 旧版と同時起動してしまうのを案内で解消する（#279）。
  useEffect(() => {
    const unlistenPromise = listen('migration_completed', () => {
      notify({
        kind: 'info',
        title: 'データを引き継ぎました',
        message: '旧バージョン（chartoon / geartoon）のデータを splabo に移行しました。旧アプリが残っている場合はアンインストールをおすすめします（旧版と同時に起動してしまうのを防げます）。',
        durationMs: 0,
      })
    })
    return () => { unlistenPromise.then(fn => fn()) }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  function saveSettings(s: AppSettings) {
    setSettings(s)
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(s))
    // store（settings.json）へミラー。識別子変更で localStorage が失われても復元できるように（#241）。
    void mirrorToStore()
  }

  /** ビュー切替。選択を localStorage に保存して次回起動時にも復元する（#296）。 */
  function setBattlesView(next: BattlesView) {
    setBattlesViewState(next)
    saveViewPrefs({ ...loadViewPrefs(), battles: next })
  }

  function handleAiChart(spec: ChartSpec) {
    setAiChart(spec)
    // 生成したグラフはダッシュボードに出るので、「バトル」タブのダッシュボードへ送る。
    setTab('battles')
    setBattlesView('dashboard')
  }

  // サイドバーから呼ばれる「バトルデータ更新」処理
  async function handleFetchFull() {
    if (fetching) return
    setFetching(true)
    try {
      await invoke('fetch_battles_full')
      // 統合: サイドバーの取得で戦績に続けてギアも取得する。
      // ギアの失敗は戦績取得と独立に通知し、戦績取得の成功は保つ。
      try {
        await invoke('fetch_gear_full')
      } catch (gearErr) {
        console.error('gear fetch failed:', gearErr)
        notify({ kind: 'warning', title: 'ギアの取得に失敗しました', message: '戦績は取得できました。ギアは時間をおいて「最新データを取得」からもう一度取得してください。', durationMs: 6000 })
      }
    } catch (e) {
      reportFetchError(e, handleFetchFull)
    } finally {
      setFetching(false)
    }
  }

  return (
    <div className="app">
      <nav className="sidebar">
        <button className="logo" onClick={() => setShowAbout(true)} aria-label="splabo について">
          <img src="/splabo-logo.png" alt="splabo" />
        </button>
        {/* 並び順: 戦績 → 武器図鑑 → ステージ図鑑 → ギアコーデ → 環境分析 → AI分析 → 設定
            命名は「対象＋役割」で統一（戦績 / 〜図鑑 / 〜コーデ / 〜分析）。 */}
        <NavItem id="battles"   icon="⚔️" label="戦績" legacyName="Chartoon" active={tab} onClick={setTab} />
        <NavItem id="weapons"   icon="🔫" label="武器図鑑"       active={tab} onClick={setTab} />
        <NavItem id="stages"    icon="🗺️" label="ステージ図鑑"   active={tab} onClick={setTab} />
        <NavItem id="gear"      icon="👕" label="ギアコーデ"     active={tab} onClick={setTab} />
        <NavItem id="env"       icon="🌍" label="環境分析"       active={tab} onClick={setTab} />
        <NavItem id="ai"        icon="🧙" label="AI分析"         active={tab} onClick={setTab} />
        <NavItem id="settings"  icon="⚙️" label="設定"           active={tab} onClick={setTab} />
        <button
          className="btn-primary sidebar-fetch-btn"
          onClick={handleFetchFull}
          disabled={fetching}
          title="SplatNet3 から最新のバトル結果・ギアデータを取得"
        >
          {fetching ? '取得中...' : '最新データを取得'}
        </button>
        <div className="sidebar-last-fetched">
          {lastFetchedAt ? `データ最終更新日時: ${lastFetchedAt}` : '未取得'}
        </div>
      </nav>

      <main className="content">
        {tab === 'battles' && (
          <>
            {/* 図鑑タブ（FilterBar → 図鑑ヘッダ内の ViewToggle）と並びを揃えるため、
                切替は絞り込みの下に置く。 */}
            <FilterBar filters={filters} onChange={setFilters} />
            <ViewToggle
              options={BATTLES_VIEWS}
              value={battlesView}
              onChange={setBattlesView}
              ariaLabel="戦績の表示切替"
            />
            {battlesView === 'dashboard' ? (
              <Dashboard
                filters={filters}
                aiChart={aiChart}
                onFetchRequest={handleFetchFull}
                onOpenSettings={() => setTab('settings')}
                fetching={fetching}
              />
            ) : (
              <BattleLog filters={filters} statinkScreenName={settings.statink.screenName} />
            )}
          </>
        )}
        {/* 図鑑タブ（#298）: 期間・モード・ルール・結果を集計に反映する。
            武器/ステージ絞り込みは自己言及的なので hideTargetFilters で隠す。 */}
        {(tab === 'weapons' || tab === 'stages') && (
          <FilterBar filters={filters} onChange={setFilters} hideTargetFilters />
        )}
        {tab === 'weapons'   && <WeaponBook filters={filters} />}
        {tab === 'stages'    && <StageBook  filters={filters} />}
        {tab === 'env'       && <EnvAnalysis />}
        {tab === 'gear'      && <GearSection />}
        {tab === 'ai' && <AiAnalysis settings={settings} onChartReady={handleAiChart} />}
        {tab === 'settings' && <Settings settings={settings} onSave={saveSettings} loginVersion={loginVersion} />}
      </main>

      {showAbout && <About onClose={() => setShowAbout(false)} />}
    </div>
  )
}

function NavItem({ id, icon, label, legacyName, active, onClick }: { id: Tab; icon: string; label: string; legacyName?: string; active: Tab; onClick: (t: Tab) => void }) {
  return (
    <button className={`nav-item ${active === id ? 'active' : ''}`} onClick={() => onClick(id)}>
      <span className="nav-item-icon" aria-hidden="true">{icon}</span>
      <span className="nav-item-label">
        {label}
        {/* 旧アプリ名。ギアタブはヘッダーに Geartoon が残っているが、戦績タブは絞り込み窓を
            図鑑と揃えている都合でタブ内に置き場所が無いので、メニューにだけ添える。
            aria からは外す（読み上げでは「戦績」だけで十分）。 */}
        {legacyName && <span className="nav-item-legacy" aria-hidden="true">({legacyName})</span>}
      </span>
    </button>
  )
}
