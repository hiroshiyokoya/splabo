import { useState, useEffect } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'
import { getVersion } from '@tauri-apps/api/app'
import { isDevVersion } from '../utils/version'
import { openUrl } from '@tauri-apps/plugin-opener'
import { QRCodeSVG } from 'qrcode.react'
import type { AppSettings, SettingsTab } from '../types'
import { ViewToggle, type ViewToggleOption } from './ViewToggle'
import { loadViewPrefs, saveViewPrefs } from '../utils/viewPrefs'
import { THEMES, saveTheme, getThemeId } from '../utils/appSettings'
import { AI_MODELS, PROVIDER_LABELS, modelDisplayLabel, defaultModelFor, type AiProvider } from '../utils/aiModels'
import { clearCustomCharts } from '../utils/customCharts'
import { mirrorToStore } from '../utils/settingsStore'
import {
  ImportSincePicker,
  loadEnvImportPrefs,
  saveEnvImportPrefs,
  resolveImportSince,
  type ImportSinceKind,
} from './EnvImportSince'
import {
  DENSITIES,
  COMBO_LIMITS,
  NEAR_LIMITS,
  applyDensity,
  saveComboLimit,
  saveNearLimit,
  loadDensityId,
  loadComboLimit,
  loadNearLimit,
  type DensityId,
  type ComboLimitValue,
  type NearLimitValue,
} from '../gear/utils/appSettings'

interface Props {
  settings: AppSettings
  onSave: (s: AppSettings) => void
  loginVersion: number
  /** 遷移時に開くサブタブの指定(#428)。認証エラー通知やダッシュボード空状態から
   *  「設定を開く」で飛ばすとき、目的の項目(Nintendo アカウント)がある連携タブを開かせる。
   *  nonce を変えるたびに効くので、永続化した選択より優先される(同じ tab を再指定しても発火)。 */
  focus?: { tab: SettingsTab; nonce: number } | null
}

/** 設定タブ内のサブタブ(#428 / #434)。AI を右端に追加。 */
const SETTINGS_TABS: readonly ViewToggleOption<SettingsTab>[] = [
  { key: 'link',    label: '連携', icon: '🔗' },
  { key: 'data',    label: 'データ', icon: '🗄' },
  { key: 'display', label: '表示', icon: '🎨' },
  { key: 'ai',      label: 'AI',   icon: '🤖' },
]

/** companion_start の戻り値(Rust companion.rs::CompanionInfo に対応)。 */
interface CompanionInfo {
  host_ips: string[]
  port: number
  token: string
}

/** companion_status の戻り値。 */
interface CompanionStatus {
  running: boolean
  port: number | null
}

/** companion_diagnostics の戻り値(Rust companion.rs::CompanionDiagnostics に対応・#363)。 */
interface CompanionDiagnostics {
  /** 実行 OS("windows" のときだけ network_category を判定)。 */
  os: string
  /** "public" | "private" | "domain" | "unknown" | "unsupported"。 */
  network_category: string
  /** LAN 側 IPv4 が 1 つでも見えているか。 */
  has_lan_ip: boolean
}

/** ファイアウォール / プロファイルのトラブルシュート手順(README の該当節)。 */
const FIREWALL_HELP_URL =
  'https://github.com/hiroshiyokoya/splabo/blob/develop/README.md#モバイル同期がつながらないとき'

/**
 * ペアリング QR に載せるペイロード(viewer と共有する契約)。
 * viewer は hosts を順に /ping して到達可能なホストを採用する。
 */
function pairingPayload(info: CompanionInfo): string {
  return JSON.stringify({ v: 1, hosts: info.host_ips, port: info.port, token: info.token })
}

export function Settings({ settings, onSave, loginVersion, focus }: Props) {
  // サブタブ(#428)。前回選択を復元し、focus 指定(遷移時の着地)が来たら上書きする。
  const [subTab, setSubTab] = useState<SettingsTab>(() => loadViewPrefs().settings)
  // 選択が変わったら永続化。他のタブ内ビュー(バトル/ブキ/ステージ)と同じ shellViews に相乗り。
  useEffect(() => { saveViewPrefs({ settings: subTab }) }, [subTab])
  // 遷移元の着地指定。nonce が変わるたびに効く(同じ tab を再指定しても発火する)ので、
  // 復元した選択より優先される。
  useEffect(() => { if (focus) setSubTab(focus.tab) }, [focus])

  const [loggedIn, setLoggedIn] = useState(false)
  const [authLoading, setAuthLoading] = useState(false)
  const [themeId, setThemeId] = useState(getThemeId)
  const [uploading, setUploading] = useState(false)
  const [uploadResult, setUploadResult] = useState<string | null>(null)
  const [importing, setImporting] = useState(false)
  const [importResult, setImportResult] = useState<string | null>(null)
  const [weaponUpdating, setWeaponUpdating] = useState(false)
  const [weaponUpdateResult, setWeaponUpdateResult] = useState<string | null>(null)
  // 開発ビルド(0.0.0-dev)では stat.ink アップロードを無効化する(#320)。
  // 実ガードは Rust の upload_pending_battles 側。ここは UI 表示のためだけ。
  const [isDevBuild, setIsDevBuild] = useState(false)

  useEffect(() => {
    // 🔴 判定は getVersion() の生の値に対して行う。表示用の displayVersion() は
    // 開発ビルドで `0.0.0-dev (a1b2c3d)` になるため、比較に使うと常に false になる(#569)。
    getVersion().then(v => setIsDevBuild(isDevVersion(v))).catch(() => {})
  }, [])
  // ── ギア設定 ──────────────────────────────────────────────
  const [gearDensity, setGearDensity] = useState<DensityId>(loadDensityId)
  const [gearComboLimit, setGearComboLimit] = useState<ComboLimitValue>(loadComboLimit)
  const [gearNearLimit, setGearNearLimit] = useState<NearLimitValue>(loadNearLimit)
  const [gearDeleting, setGearDeleting] = useState(false)
  const [gearDeleteResult, setGearDeleteResult] = useState<string | null>(null)
  const [envImportPrefs, setEnvImportPrefs] = useState(loadEnvImportPrefs)
  const [envRefetching, setEnvRefetching] = useState(false)
  const [envRefetchResult, setEnvRefetchResult] = useState<string | null>(null)
  const [envRefetchProgress, setEnvRefetchProgress] = useState<{ current: number; total: number; phase: string } | null>(null)
  useEffect(() => {
    const unlisten = listen<{ current: number; total: number; phase: string }>(
      'env_import_progress',
      (e) => setEnvRefetchProgress(e.payload),
    )
    return () => { unlisten.then(fn => fn()) }
  }, [])

  // ── モバイル同期(コンパニオン)──────────────────────────────
  // Rust 側 CompanionState が真実。UI は companion_status / _start / _stop を叩くだけ。
  const [companionInfo, setCompanionInfo] = useState<CompanionInfo | null>(null)
  const [companionBusy, setCompanionBusy] = useState(false)
  const [companionError, setCompanionError] = useState<string | null>(null)
  // 接続トラブルの自己診断(#363)。有効化中のみ取得する。
  const [companionDiag, setCompanionDiag] = useState<CompanionDiagnostics | null>(null)

  useEffect(() => {
    if (companionInfo) {
      invoke<CompanionDiagnostics>('companion_diagnostics')
        .then(setCompanionDiag)
        .catch(() => setCompanionDiag(null))
    } else {
      setCompanionDiag(null)
    }
  }, [companionInfo])

  useEffect(() => {
    invoke<boolean>('check_auth_status').then(setLoggedIn).catch(() => setLoggedIn(false))
  }, [loginVersion])

  // 起動時にサーバー稼働中なら QR を復元表示する(start は冪等＝稼働中は現行情報を返す)。
  useEffect(() => {
    invoke<CompanionStatus>('companion_status')
      .then(st => {
        if (st.running) {
          return invoke<CompanionInfo>('companion_start').then(setCompanionInfo)
        }
      })
      .catch(() => {})
  }, [])

  // 起動時のスケジューラー / stat.ink 設定同期は App.tsx が担う(#322)。
  // 設定タブを開かなくても同期されるよう起動時 useEffect を App 側へ移設した。
  // ここでは下の update() 内で、ユーザー操作による変更を即時同期するに留める。

  function update(patch: Partial<AppSettings>) {
    const next = { ...settings, ...patch }
    onSave(next)
    // スケジューラー関連の変更は即 Rust 側へ同期
    if ('autoFetchEnabled' in patch || 'autoFetchIntervalMin' in patch) {
      invoke('set_scheduler_config', {
        enabled: next.autoFetchEnabled,
        intervalMin: next.autoFetchIntervalMin,
      }).catch(console.error)
    }
    // stat.ink 設定の変更も即 Rust 側へ同期
    if ('statink' in patch) {
      invoke('set_statink_config', {
        autoUpload: next.statink.autoUpload,
        apiKey: next.statink.apiKey,
      }).catch(console.error)
    }
  }

  async function handleLogin() {
    setAuthLoading(true)
    try {
      await invoke('start_login')
    } catch (e) {
      console.error('ログイン開始失敗:', e)
    } finally {
      setAuthLoading(false)
    }
  }

  async function handleLogout() {
    setAuthLoading(true)
    try {
      await invoke('logout')
      setLoggedIn(false)
    } catch (e) {
      console.error('ログアウト失敗:', e)
    } finally {
      setAuthLoading(false)
    }
  }

  async function handleUpdateWeapons() {
    setWeaponUpdating(true)
    setWeaponUpdateResult(null)
    try {
      const count = await invoke<number>('fetch_weapons')
      setWeaponUpdateResult(`ブキマスター ${count} 件取得しました`)
    } catch (e) {
      setWeaponUpdateResult(`エラー: ${String(e)}`)
    } finally {
      setWeaponUpdating(false)
    }
  }

async function handleUploadStatink() {
    setUploading(true)
    setUploadResult(null)
    try {
      const count = await invoke<number>('upload_to_statink')
      setUploadResult(count > 0 ? `${count}件アップロードしました` : '新規アップロードなし')
    } catch (e) {
      setUploadResult(`エラー: ${String(e)}`)
    } finally {
      setUploading(false)
    }
  }

  async function handleImportStatink() {
    if (!window.confirm(
      'stat.ink に保存された自分の過去バトルをすべて取得して取り込みます。\n' +
      '件数によっては数分かかることがあります。実行しますか？'
    )) return
    setImporting(true)
    setImportResult(null)
    try {
      const r = await invoke<{ imported: number; skipped: number; failed: number; total: number }>(
        'import_from_statink'
      )
      const parts = [`新規 ${r.imported} 件`, `スキップ ${r.skipped} 件`]
      if (r.failed > 0) parts.push(`失敗 ${r.failed} 件`)
      setImportResult(`取り込み完了: ${parts.join(' / ')}(取得 ${r.total} 件)`)
    } catch (e) {
      setImportResult(`エラー: ${String(e)}`)
    } finally {
      setImporting(false)
    }
  }

  // ── ギア設定ハンドラ ──────────────────────────────────────
  // gear 側の appSettings は localStorage を更新するが store ミラーは張らないため、
  // 変更のたびに mirrorToStore() を呼んで settings.json(#241 store ミラー)へ反映する。
  // applyDensity は `.gear-root` 未マウント時(＝設定タブ表示中)は localStorage 更新のみで、
  // 次回ギアタブ表示の initAppSettings() で反映される(即時プレビュー不可・仕様)。
  function handleChangeDensity(id: DensityId) {
    setGearDensity(id)
    applyDensity(id)
    void mirrorToStore()
  }

  function handleChangeComboLimit(v: ComboLimitValue) {
    setGearComboLimit(v)
    saveComboLimit(v)
    void mirrorToStore()
  }

  function handleChangeNearLimit(v: NearLimitValue) {
    setGearNearLimit(v)
    saveNearLimit(v)
    void mirrorToStore()
  }

  async function handleDeleteGearData() {
    if (!window.confirm(
      '取得済みのギアデータ(ギア一覧・画像キャッシュ)をすべて削除します。\n' +
      '削除後はギアタブが空になり、再度サイドバーの「最新データを取得」から取得が必要です。実行しますか？'
    )) return
    setGearDeleting(true)
    setGearDeleteResult(null)
    try {
      await invoke('delete_gear_data')
      setGearDeleteResult('ギアデータを削除しました。ギアタブは再読み込み後に空になります。')
    } catch (e) {
      setGearDeleteResult(`エラー: ${String(e)}`)
    } finally {
      setGearDeleting(false)
    }
  }

  function patchEnvImport(kind: ImportSinceKind, custom: string) {
    const next = { kind, custom }
    setEnvImportPrefs(next)
    saveEnvImportPrefs(next)
  }

  async function handleEnvRefetch() {
    if (envRefetching) return
    const since = resolveImportSince(envImportPrefs.kind, envImportPrefs.custom)
    if (envImportPrefs.kind === 'custom' && !since) {
      setEnvRefetchResult('開始日を選んでください')
      return
    }
    const range = since ? `${since} 以降` : '全期間'
    const zipNote = since
      ? '日次 CSV で取得します（ZIP は使いません）。'
      : '全期間 ZIP（約 980 MiB・10〜15 分）を取り込みます。'
    if (!window.confirm(
      `環境データを削除して、${range} を取り込み直します。${zipNote}\n\n実行しますか？`
    )) return
    setEnvRefetching(true)
    setEnvRefetchResult(null)
    setEnvRefetchProgress({ current: 0, total: 1, phase: 'download' })
    try {
      const n = await invoke<number>('import_env_full', { since })
      setEnvRefetchResult(`${n.toLocaleString()} 行を取り込みました。環境分析タブで確認できます。`)
    } catch (e) {
      setEnvRefetchResult(`エラー: ${String(e)}`)
    } finally {
      setEnvRefetching(false)
      setEnvRefetchProgress(null)
    }
  }

  // ── モバイル同期ハンドラ ──────────────────────────────────
  async function handleToggleCompanion(enabled: boolean) {
    setCompanionBusy(true)
    setCompanionError(null)
    try {
      if (enabled) {
        const info = await invoke<CompanionInfo>('companion_start')
        setCompanionInfo(info)
      } else {
        await invoke('companion_stop')
        setCompanionInfo(null)
      }
    } catch (e) {
      setCompanionError(String(e))
    } finally {
      setCompanionBusy(false)
    }
  }

  return (
    <div className="settings-panel">
      <div className="settings-header">
        <h2>設定</h2>
        <ViewToggle
          options={SETTINGS_TABS}
          value={subTab}
          onChange={setSubTab}
          ariaLabel="設定の分類切替"
        />
      </div>

      {/* ── 連携: Nintendo → stat.ink → モバイル同期 ── */}
      {subTab === 'link' && (
      <section className="settings-section">
        <h3>Nintendo アカウント</h3>
        {loggedIn ? (
          <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
            <span style={{ color: 'var(--win)', fontSize: 13 }}>連携済み</span>
            <button className="btn-danger" onClick={handleLogout} disabled={authLoading}>
              {authLoading ? '処理中...' : '認証解除'}
            </button>
          </div>
        ) : (
          <div>
            <p style={{ color: 'var(--text-muted)', fontSize: 13, marginBottom: 10 }}>
              バトルデータの取得には Nintendo アカウントへのログインが必要です。
            </p>
            <button className="btn-primary" onClick={handleLogin} disabled={authLoading}>
              {authLoading ? '処理中...' : 'Nintendo アカウントでログイン'}
            </button>
          </div>
        )}
      </section>
      )}

      {subTab === 'link' && (
      <section className="settings-section">
        <h3>stat.ink 連携</h3>
        <p style={{ color: 'var(--text-muted)', fontSize: 13, marginBottom: 10 }}>
          <a
            href="https://stat.ink"
            onClick={e => { e.preventDefault(); openUrl('https://stat.ink').catch(console.error) }}
            style={{ color: 'var(--accent)', cursor: 'pointer' }}
          >stat.ink</a>
          {' '}のプロフィールページから API キーを取得してください。
        </p>
        <label>
          API キー
          <input
            type="password"
            value={settings.statink.apiKey}
            onChange={(e) => update({ statink: { ...settings.statink, apiKey: e.target.value } })}
            placeholder="stat.ink の API キーを入力"
          />
        </label>
        <label className="checkbox-label" style={{ marginTop: 8 }}>
          <input
            type="checkbox"
            checked={settings.statink.autoUpload}
            onChange={(e) => update({ statink: { ...settings.statink, autoUpload: e.target.checked } })}
            disabled={!settings.statink.apiKey || isDevBuild}
          />
          バトルデータ取得後に自動でアップロードする
        </label>
        {isDevBuild && (
          <p style={{ color: 'var(--text-muted)', fontSize: 13, margin: '6px 0 0' }}>
            ⚠ 開発ビルド(0.0.0-dev)では、実データの誤送信を防ぐため stat.ink へのアップロードは無効化されています。
          </p>
        )}
        <button
          className="btn-primary"
          style={{ marginTop: 10 }}
          onClick={handleUploadStatink}
          disabled={uploading || !settings.statink.apiKey || isDevBuild}
        >
          {uploading ? 'アップロード中...' : '今すぐアップロード'}
        </button>
        {uploadResult && (
          <div
            style={{
              marginTop: 8,
              fontSize: 13,
              color: uploadResult.startsWith('エラー') ? 'var(--accent2)' : 'var(--text-muted)',
            }}
          >
            {uploadResult}
          </div>
        )}
        <p style={{ color: 'var(--text-muted)', fontSize: 13, margin: '16px 0 10px' }}>
          stat.ink に保存済みの自分の過去バトルをデータベースに取り込みます。
          SplatNet 3 が保持しない古いバトルも集計対象にできます(重複は自動でスキップ)。
        </p>
        <button
          className="btn-primary"
          onClick={handleImportStatink}
          disabled={importing || !settings.statink.apiKey}
        >
          {importing ? '取り込み中...' : 'stat.ink から過去履歴を取得'}
        </button>
        {importResult && (
          <div
            style={{
              marginTop: 8,
              fontSize: 13,
              color: importResult.startsWith('エラー') ? 'var(--accent2)' : 'var(--text-muted)',
            }}
          >
            {importResult}
          </div>
        )}
      </section>
      )}

      {/* モバイル同期 UI は splabo-viewer 公開までリリースビルドでは隠す(#339)。 */}
      {subTab === 'link' && isDevBuild && (
      <section className="settings-section">
        <h3>モバイル同期(コンパニオン)</h3>
        <p style={{ color: 'var(--text-muted)', fontSize: 13, marginBottom: 10 }}>
          同じネットワーク(Wi-Fi ルーターや有線 LAN)上のスマホアプリ「SpLabo viewer」へ、
          取得済みのギア・直近バトルデータを配信します。
          任天堂 API には一切アクセスしません。有効な間だけ配信し、アプリ終了で自動的に止まります。
        </p>
        <label className="checkbox-label">
          <input
            type="checkbox"
            checked={companionInfo !== null}
            disabled={companionBusy}
            onChange={(e) => handleToggleCompanion(e.target.checked)}
          />
          モバイル同期を有効にする
        </label>
        {companionError && (
          <p style={{ color: 'var(--lose)', fontSize: 13, margin: '8px 0 0' }}>
            エラー: {companionError}
          </p>
        )}
        {companionInfo && (
          <div style={{ marginTop: 14 }}>
            <p style={{ color: 'var(--text-muted)', fontSize: 13, marginBottom: 10 }}>
              スマホの「SpLabo viewer」でこの QR コードを読み取ってペアリングしてください。
            </p>
            <div
              style={{
                display: 'inline-block',
                padding: 12,
                background: '#fff',
                borderRadius: 8,
              }}
            >
              <QRCodeSVG value={pairingPayload(companionInfo)} size={192} level="M" />
            </div>
            <p style={{ color: 'var(--text-muted)', fontSize: 12, margin: '10px 0 0' }}>
              接続先: {companionInfo.host_ips.length > 0 ? companionInfo.host_ips.join(', ') : '(IP 不明)'}
              {' : '}{companionInfo.port}
            </p>
            {companionInfo.host_ips.length === 0 && (
              <p style={{ color: 'var(--lose)', fontSize: 12, margin: '4px 0 0' }}>
                ⚠ LAN の IP アドレスが取得できませんでした。ネットワーク接続を確認してください。
              </p>
            )}
            {companionDiag?.network_category === 'public' && (
              <div
                style={{
                  color: 'var(--lose)',
                  fontSize: 12,
                  margin: '8px 0 0',
                  lineHeight: 1.6,
                }}
              >
                ⚠ このネットワークが Windows で「パブリック」に設定されています。
                この状態だと Windows ファイアウォールがスマホからの接続を遮断し、QR を読んでも
                つながりません。<strong>「プライベート ネットワーク」に変更</strong>してください
                (設定 → ネットワークとインターネット → 現在の接続 → ネットワーク プロファイルの種類)。
                初回接続時に許可ダイアログが出たら、<strong>プライベートにチェックして許可</strong>します。
              </div>
            )}
            <p style={{ color: 'var(--text-muted)', fontSize: 12, margin: '8px 0 0', lineHeight: 1.6 }}>
              QR を読んでもつながらない場合、ネットワークが「プライベート」でも
              Windows ファイアウォールの<strong>受信許可がパブリック用にしか無い</strong>ことがあります
              (以前パブリックの状態で許可したまま、あとからプライベートに変更した場合)。
              許可規則はプロファイルごとに効くため引き継がれません。
              <code>wf.msc</code> →「受信の規則」→ <strong>splabo</strong> → プロパティ → 詳細設定タブ →
              プロファイルで<strong>プライベートにチェック</strong>してください。
              <strong>splabo の規則は通常 2 つ(TCP / UDP)あるので、すべて確認</strong>します。
            </p>
            <p style={{ fontSize: 12, margin: '8px 0 0' }}>
              <a
                href={FIREWALL_HELP_URL}
                onClick={e => { e.preventDefault(); openUrl(FIREWALL_HELP_URL).catch(console.error) }}
                style={{ color: 'var(--accent)', cursor: 'pointer' }}
              >
                つながらないときは(ファイアウォール / ネットワークの確認・詳しい手順)
              </a>
            </p>
          </div>
        )}
      </section>
      )}

      {/* ── データ: 自動取得 → マスターデータ → ギアデータ削除 ── */}
      {subTab === 'data' && (
      <section className="settings-section">
        <h3>自動取得(有効時はトレイに常駐)</h3>
        <label className="checkbox-label">
          <input
            type="checkbox"
            checked={settings.autoFetchEnabled}
            onChange={(e) => update({ autoFetchEnabled: e.target.checked })}
          />
          自動でバトル・ギアデータを取得する
        </label>
        <label>
          取得間隔
          <select
            value={settings.autoFetchIntervalMin}
            onChange={(e) => update({ autoFetchIntervalMin: Number(e.target.value) })}
            disabled={!settings.autoFetchEnabled}
          >
            <option value={15}>15分ごと</option>
            <option value={30}>30分ごと</option>
            <option value={60}>1時間ごと</option>
            <option value={120}>2時間ごと</option>
            <option value={240}>4時間ごと</option>
            <option value={360}>6時間ごと</option>
            <option value={720}>12時間ごと</option>
            <option value={1440}>24時間ごと</option>
          </select>
        </label>
      </section>
      )}

      {subTab === 'data' && (
      <section className="settings-section">
        <h3>マスターデータ</h3>
        <div className="settings-help" style={{ marginBottom: 12 }}>
          ブキ・サブ・SP・カテゴリと、公式アプリの熟練度・通算勝利・総塗、全ブキの画像を
          SplatNet 3 から取得します。起動時に 24 時間ごとに自動取得しますが、手動でも実行できます。
        </div>
        <button
          className="btn-primary"
          onClick={handleUpdateWeapons}
          disabled={weaponUpdating || !loggedIn}
        >
          {weaponUpdating ? '取得中...' : 'ブキデータを更新'}
        </button>
        {weaponUpdateResult && (
          <div
            style={{
              marginTop: 8,
              fontSize: 13,
              color: weaponUpdateResult.startsWith('エラー') ? 'var(--accent2)' : 'var(--text-muted)',
            }}
          >
            {weaponUpdateResult}
          </div>
        )}
      </section>
      )}

      {subTab === 'data' && (
      <section className="settings-section">
        <h3>環境分析データ</h3>
        <p style={{ color: 'var(--text-muted)', fontSize: 13, marginBottom: 10 }}>
          stat.ink の公開バトルです。差分更新は環境分析タブ、開始日の変更と入れ直しはこの画面です。
          既定は 2025.1.1〜です（全期間は集計が重く、ZIP 約 980 MiB になります）。
        </p>
        <ImportSincePicker
          kind={envImportPrefs.kind}
          custom={envImportPrefs.custom}
          disabled={envRefetching}
          onKind={k => patchEnvImport(k, envImportPrefs.custom)}
          onCustom={v => patchEnvImport(envImportPrefs.kind, v)}
        />
        <button
          className="btn-primary"
          onClick={handleEnvRefetch}
          disabled={envRefetching}
        >
          {envRefetching ? '再取得中...' : '再取得'}
        </button>
        {envRefetchProgress && envRefetching && (
          <div className="settings-help" style={{ marginTop: 8 }}>
            {envRefetchProgress.phase === 'download' ? 'ダウンロード中' :
             envRefetchProgress.phase === 'extract' ? '解凍中' :
             envRefetchProgress.phase === 'index' ? 'インデックス作成中' :
             'インポート中'}
            {' '}
            {envRefetchProgress.total > 0
              ? `${Math.round((envRefetchProgress.current / envRefetchProgress.total) * 100)}%`
              : ''}
            {' '}
            ({envRefetchProgress.current.toLocaleString()} / {envRefetchProgress.total.toLocaleString()})
          </div>
        )}
        {envRefetchResult && (
          <div
            style={{
              marginTop: 8,
              fontSize: 13,
              color: envRefetchResult.startsWith('エラー') || envRefetchResult.startsWith('開始日') ? 'var(--accent2)' : 'var(--text-muted)',
            }}
          >
            {envRefetchResult}
          </div>
        )}
      </section>
      )}

      {subTab === 'data' && (
      <section className="settings-section">
        <h3>ギアデータ</h3>
        <p style={{ color: 'var(--text-muted)', fontSize: 13, marginBottom: 10 }}>
          取得済みのギアデータ(ギア一覧・画像キャッシュ)をすべて削除します。再度サイドバーの「最新データを取得」から取得できます。
        </p>
        <button
          className="btn-danger"
          onClick={handleDeleteGearData}
          disabled={gearDeleting}
        >
          {gearDeleting ? '削除中...' : 'ギアデータを削除'}
        </button>
        {gearDeleteResult && (
          <div
            style={{
              marginTop: 8,
              fontSize: 13,
              color: gearDeleteResult.startsWith('エラー') ? 'var(--accent2)' : 'var(--text-muted)',
            }}
          >
            {gearDeleteResult}
          </div>
        )}
      </section>
      )}

      {/* ── 表示: カラーテーマ → ダッシュボード → ギア表示 ── */}
      {subTab === 'display' && (
      <section className="settings-section">
        <h3>カラーテーマ</h3>
        <div className="theme-options">
          {THEMES.map(t => (
            <button
              key={t.id}
              className={`theme-option${themeId === t.id ? ' active' : ''}`}
              onClick={() => { saveTheme(t.id); setThemeId(t.id) }}
            >
              <span className="theme-dot" style={{ background: t.dot }} />
              {t.label}
            </button>
          ))}
        </div>
      </section>
      )}

      {subTab === 'display' && (
      <section className="settings-section">
        <h3>ダッシュボード</h3>
        <p style={{ color: 'var(--text-muted)', fontSize: 13, marginBottom: 10 }}>
          追加したカスタムグラフをすべて消してダッシュボードを初期状態(既存の固定 4 グラフのみ)に戻します。
        </p>
        <button
          className="btn-danger"
          onClick={() => {
            if (window.confirm('追加したカスタムグラフをすべて削除します。よろしいですか？')) {
              clearCustomCharts()
              // 反映のためリロード。Dashboard 側 state を直接触る経路を作らないシンプル運用。
              window.location.reload()
            }
          }}
        >
          カスタムグラフをすべて削除(ダッシュボードをリセット)
        </button>
      </section>
      )}

      {subTab === 'display' && (
      <section className="settings-section">
        <h3>ギア</h3>
        <p className="settings-note" style={{ marginTop: 0, marginBottom: 12 }}>
          ギアタブの表示とコーデ検索に関する設定です。表示密度の変更は次回ギアタブを開いたときに反映されます。
        </p>
        <label>
          表示密度
          <select
            value={gearDensity}
            onChange={(e) => handleChangeDensity(e.target.value as DensityId)}
          >
            {DENSITIES.map(d => (
              <option key={d.id} value={d.id}>{d.label}</option>
            ))}
          </select>
        </label>
        <label>
          コーデ候補の表示件数
          <select
            value={gearComboLimit}
            onChange={(e) => handleChangeComboLimit(Number(e.target.value) as ComboLimitValue)}
          >
            {COMBO_LIMITS.map(v => (
              <option key={v} value={v}>{v} 件</option>
            ))}
          </select>
        </label>
        <label>
          近いコーデの表示件数
          <select
            value={gearNearLimit}
            onChange={(e) => handleChangeNearLimit(Number(e.target.value) as NearLimitValue)}
          >
            {NEAR_LIMITS.map(v => (
              <option key={v} value={v}>{v} 件</option>
            ))}
          </select>
        </label>
      </section>
      )}

      {/* ── AI(新設): AI API ── */}
      {subTab === 'ai' && (
      <section className="settings-section">
        <h3>AI API</h3>
        <label>
          プロバイダー
          <select
            value={settings.ai.provider}
            onChange={(e) => {
              const provider = e.target.value as AiProvider
              // プロバイダ切替時、現プロバイダのプリセットに無いモデル名なら新プロバイダの既定モデルにリセット
              const stillValid = AI_MODELS[provider].some(m => m.id === settings.ai.model)
              update({ ai: {
                ...settings.ai,
                provider,
                model: stillValid ? settings.ai.model : defaultModelFor(provider),
              } })
            }}
          >
            {(Object.keys(PROVIDER_LABELS) as AiProvider[]).map(p => (
              <option key={p} value={p}>{PROVIDER_LABELS[p]}</option>
            ))}
          </select>
        </label>
        <label>
          APIキー
          <input
            type="password"
            value={settings.ai.apiKey}
            onChange={(e) => update({ ai: { ...settings.ai, apiKey: e.target.value } })}
            placeholder="sk-... / AIzaSy... / sk-ant-... / xai-..."
          />
        </label>
        <label>
          モデル
          <select
            value={AI_MODELS[settings.ai.provider].some(m => m.id === settings.ai.model)
              ? settings.ai.model : '__custom__'}
            onChange={(e) => {
              const v = e.target.value
              if (v === '__custom__') return    // 「カスタム…」選択時は何もしない(下のテキストフィールドで入力)
              update({ ai: { ...settings.ai, model: v } })
            }}
          >
            {AI_MODELS[settings.ai.provider].map(m => (
              <option key={m.id} value={m.id}>{modelDisplayLabel(m)}</option>
            ))}
            <option value="__custom__">カスタム(下のテキスト欄で指定)…</option>
          </select>
        </label>
        <label>
          カスタムモデル ID
          <input
            type="text"
            value={settings.ai.model}
            onChange={(e) => update({ ai: { ...settings.ai, model: e.target.value } })}
            placeholder={defaultModelFor(settings.ai.provider)}
          />
        </label>
        <p className="settings-note">
          価格・コンテキスト長は 2026 年 5 月時点の情報。最新は各プロバイダの公式料金ページを参照してください。
        </p>
      </section>
      )}
    </div>
  )
}
