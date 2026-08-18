import { useState, useEffect } from 'react'
import { useTranslation } from 'react-i18next'
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
import { formatInvokeError } from '../utils/notify'
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
import { saveLocalePref } from '../i18n'
import { loadLocalePref } from '../i18n/persist'
import type { LocalePref } from '../i18n/locale'

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

/**
 * ペアリング QR に載せるペイロード(viewer と共有する契約)。
 * viewer は hosts を順に /ping して到達可能なホストを採用する。
 */
function pairingPayload(info: CompanionInfo): string {
  return JSON.stringify({ v: 1, hosts: info.host_ips, port: info.port, token: info.token })
}

export function Settings({ settings, onSave, loginVersion, focus }: Props) {
  const { t, i18n } = useTranslation()
  const settingsTabs: readonly ViewToggleOption<SettingsTab>[] = [
    { key: 'link',    label: t('settings.tabLink'),    icon: '🔗' },
    { key: 'data',    label: t('settings.tabData'),    icon: '🗄' },
    { key: 'display', label: t('settings.tabDisplay'), icon: '🎨' },
    { key: 'ai',      label: t('settings.tabAi'),      icon: '🤖' },
  ]
  const failPrefix = t('common.error')
  const isFailText = (text: string) =>
    text.startsWith(failPrefix) || text === t('settings.envPickStart')
  const failText = (e: unknown) => t('common.errorWithDetail', { detail: formatInvokeError(e) })
  const numLocale = i18n.language.startsWith('en') ? 'en-US' : 'ja-JP'
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
  const [localePref, setLocalePref] = useState<LocalePref>(loadLocalePref)
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
      setWeaponUpdateResult(t('settings.weaponsFetched', { count: count }))
    } catch (e) {
      setWeaponUpdateResult(failText(e))
    } finally {
      setWeaponUpdating(false)
    }
  }

  async function handleUploadStatink() {
    setUploading(true)
    setUploadResult(null)
    try {
      const count = await invoke<number>('upload_to_statink')
      setUploadResult(count > 0 ? t('settings.uploaded', { count }) : t('settings.uploadedNone'))
    } catch (e) {
      setUploadResult(failText(e))
    } finally {
      setUploading(false)
    }
  }

  async function handleImportStatink() {
    if (!window.confirm(t('settings.importConfirm'))) return
    setImporting(true)
    setImportResult(null)
    try {
      const r = await invoke<{ imported: number; skipped: number; failed: number; total: number }>(
        'import_from_statink'
      )
      const parts = [
        t('settings.importNew', { count: r.imported }),
        t('settings.importSkipped', { count: r.skipped }),
      ]
      if (r.failed > 0) parts.push(t('settings.importFailed', { count: r.failed }))
      setImportResult(t('settings.importDone', { parts: parts.join(' / '), total: r.total }))
    } catch (e) {
      setImportResult(failText(e))
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
    if (!window.confirm(t('settings.gearDeleteConfirm'))) return
    setGearDeleting(true)
    setGearDeleteResult(null)
    try {
      await invoke('delete_gear_data')
      setGearDeleteResult(t('settings.gearDeleted'))
    } catch (e) {
      setGearDeleteResult(failText(e))
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
      setEnvRefetchResult(t('settings.envPickStart'))
      return
    }
    const range = since
      ? t('settings.envRangeSince', { since })
      : t('settings.envRangeAll')
    const zipNote = since ? t('settings.envZipDaily') : t('settings.envZipFull')
    if (!window.confirm(t('settings.envRefetchConfirm', { range, zipNote }))) return
    setEnvRefetching(true)
    setEnvRefetchResult(null)
    setEnvRefetchProgress({ current: 0, total: 1, phase: 'download' })
    try {
      const n = await invoke<number>('import_env_full', { since })
      setEnvRefetchResult(t('settings.envImported', { count: n.toLocaleString(numLocale) }))
    } catch (e) {
      setEnvRefetchResult(failText(e))
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
      setCompanionError(formatInvokeError(e))
    } finally {
      setCompanionBusy(false)
    }
  }

  return (
    <div className="settings-panel">
      <div className="settings-header">
        <h2>{t('settings.title')}</h2>
        <ViewToggle
          options={settingsTabs}
          value={subTab}
          onChange={setSubTab}
          ariaLabel={t('settings.tabsAria')}
        />
      </div>

      {/* ── 連携: Nintendo → stat.ink → モバイル同期 ── */}
      {subTab === 'link' && (
      <section className="settings-section">
        <h3>{t('settings.nintendo')}</h3>
        {loggedIn ? (
          <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
            <span style={{ color: 'var(--win)', fontSize: 13 }}>{t('settings.linked')}</span>
            <button className="btn-danger" onClick={handleLogout} disabled={authLoading}>
              {authLoading ? t('common.processing') : t('settings.unlink')}
            </button>
          </div>
        ) : (
          <div>
            <p style={{ color: 'var(--text-muted)', fontSize: 13, marginBottom: 10 }}>
              {t('settings.loginNeeded')}
            </p>
            <button className="btn-primary" onClick={handleLogin} disabled={authLoading}>
              {authLoading ? t('common.processing') : t('settings.login')}
            </button>
          </div>
        )}
      </section>
      )}

      {subTab === 'link' && (
      <section className="settings-section">
        <h3>{t('settings.statink')}</h3>
        <p style={{ color: 'var(--text-muted)', fontSize: 13, marginBottom: 10 }}>
          <a
            href="https://stat.ink"
            onClick={e => { e.preventDefault(); openUrl('https://stat.ink').catch(console.error) }}
            style={{ color: 'var(--accent)', cursor: 'pointer' }}
          >stat.ink</a>
          {' '}{t('settings.statinkHint')}
        </p>
        <label>
          {t('settings.apiKey')}
          <input
            type="password"
            value={settings.statink.apiKey}
            onChange={(e) => update({ statink: { ...settings.statink, apiKey: e.target.value } })}
            placeholder={t('settings.apiKeyPlaceholder')}
          />
        </label>
        <label className="checkbox-label" style={{ marginTop: 8 }}>
          <input
            type="checkbox"
            checked={settings.statink.autoUpload}
            onChange={(e) => update({ statink: { ...settings.statink, autoUpload: e.target.checked } })}
            disabled={!settings.statink.apiKey || isDevBuild}
          />
          {t('settings.autoUpload')}
        </label>
        {isDevBuild && (
          <p style={{ color: 'var(--text-muted)', fontSize: 13, margin: '6px 0 0' }}>
            {t('settings.devUploadDisabled')}
          </p>
        )}
        <button
          className="btn-primary"
          style={{ marginTop: 10 }}
          onClick={handleUploadStatink}
          disabled={uploading || !settings.statink.apiKey || isDevBuild}
        >
          {uploading ? t('settings.uploading') : t('settings.uploadNow')}
        </button>
        {uploadResult && (
          <div
            style={{
              marginTop: 8,
              fontSize: 13,
              color: isFailText(uploadResult) ? 'var(--accent2)' : 'var(--text-muted)',
            }}
          >
            {uploadResult}
          </div>
        )}
        <p style={{ color: 'var(--text-muted)', fontSize: 13, margin: '16px 0 10px' }}>
          {t('settings.importHint')}
        </p>
        <button
          className="btn-primary"
          onClick={handleImportStatink}
          disabled={importing || !settings.statink.apiKey}
        >
          {importing ? t('settings.importing') : t('settings.importPast')}
        </button>
        {importResult && (
          <div
            style={{
              marginTop: 8,
              fontSize: 13,
              color: isFailText(importResult) ? 'var(--accent2)' : 'var(--text-muted)',
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
        <h3>{t('settings.companion')}</h3>
        <p style={{ color: 'var(--text-muted)', fontSize: 13, marginBottom: 10 }}>
          {t('settings.companionHint')}
        </p>
        <label className="checkbox-label">
          <input
            type="checkbox"
            checked={companionInfo !== null}
            disabled={companionBusy}
            onChange={(e) => handleToggleCompanion(e.target.checked)}
          />
          {t('settings.companionEnable')}
        </label>
        {companionError && (
          <p style={{ color: 'var(--lose)', fontSize: 13, margin: '8px 0 0' }}>
            {t('common.errorWithDetail', { detail: companionError })}
          </p>
        )}
        {companionInfo && (
          <div style={{ marginTop: 14 }}>
            <p style={{ color: 'var(--text-muted)', fontSize: 13, marginBottom: 10 }}>
              {t('settings.companionQr')}
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
              {t('settings.companionEndpoint', {
                hosts: companionInfo.host_ips.length > 0 ? companionInfo.host_ips.join(', ') : t('common.unknownIp'),
                port: companionInfo.port,
              })}
            </p>
            {companionInfo.host_ips.length === 0 && (
              <p style={{ color: 'var(--lose)', fontSize: 12, margin: '4px 0 0' }}>
                {t('settings.companionNoLan')}
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
                {t('settings.companionPublicNet')}
              </div>
            )}
            <p style={{ color: 'var(--text-muted)', fontSize: 12, margin: '8px 0 0', lineHeight: 1.6 }}>
              {t('settings.companionFwHint')}
            </p>
          </div>
        )}
      </section>
      )}

      {/* ── データ: 自動取得 → マスターデータ → ギアデータ削除 ── */}
      {subTab === 'data' && (
      <section className="settings-section">
        <h3>{t('settings.autoFetch')}</h3>
        <label className="checkbox-label">
          <input
            type="checkbox"
            checked={settings.autoFetchEnabled}
            onChange={(e) => update({ autoFetchEnabled: e.target.checked })}
          />
          {t('settings.autoFetchEnable')}
        </label>
        <label>
          {t('settings.interval')}
          <select
            value={settings.autoFetchIntervalMin}
            onChange={(e) => update({ autoFetchIntervalMin: Number(e.target.value) })}
            disabled={!settings.autoFetchEnabled}
          >
            <option value={15}>{t('settings.intervalMin', { count: 15 })}</option>
            <option value={30}>{t('settings.intervalMin', { count: 30 })}</option>
            <option value={60}>{t('settings.intervalHour', { count: 1 })}</option>
            <option value={120}>{t('settings.intervalHour', { count: 2 })}</option>
            <option value={240}>{t('settings.intervalHour', { count: 4 })}</option>
            <option value={360}>{t('settings.intervalHour', { count: 6 })}</option>
            <option value={720}>{t('settings.intervalHour', { count: 12 })}</option>
            <option value={1440}>{t('settings.intervalHour', { count: 24 })}</option>
          </select>
        </label>
      </section>
      )}

      {subTab === 'data' && (
      <section className="settings-section">
        <h3>{t('settings.master')}</h3>
        <div className="settings-help" style={{ marginBottom: 12 }}>
          {t('settings.masterHint')}
        </div>
        <button
          className="btn-primary"
          onClick={handleUpdateWeapons}
          disabled={weaponUpdating || !loggedIn}
        >
          {weaponUpdating ? t('common.fetching') : t('settings.updateWeapons')}
        </button>
        {weaponUpdateResult && (
          <div
            style={{
              marginTop: 8,
              fontSize: 13,
              color: isFailText(weaponUpdateResult) ? 'var(--accent2)' : 'var(--text-muted)',
            }}
          >
            {weaponUpdateResult}
          </div>
        )}
      </section>
      )}

      {subTab === 'data' && (
      <section className="settings-section">
        <h3>{t('settings.envData')}</h3>
        <p style={{ color: 'var(--text-muted)', fontSize: 13, marginBottom: 10 }}>
          {t('settings.envDataHint')}
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
          {envRefetching ? t('settings.envRefetching') : t('settings.envRefetch')}
        </button>
        {envRefetchProgress && envRefetching && (
          <div className="settings-help" style={{ marginTop: 8 }}>
            {envRefetchProgress.phase === 'download' ? t('settings.envPhaseDownload') :
             envRefetchProgress.phase === 'extract' ? t('settings.envPhaseExtract') :
             envRefetchProgress.phase === 'index' ? t('settings.envPhaseIndex') :
             t('settings.envPhaseImport')}
            {' '}
            {envRefetchProgress.total > 0
              ? `${Math.round((envRefetchProgress.current / envRefetchProgress.total) * 100)}%`
              : ''}
            {' '}
            ({envRefetchProgress.current.toLocaleString(numLocale)} / {envRefetchProgress.total.toLocaleString(numLocale)})
          </div>
        )}
        {envRefetchResult && (
          <div
            style={{
              marginTop: 8,
              fontSize: 13,
              color: isFailText(envRefetchResult) ? 'var(--accent2)' : 'var(--text-muted)',
            }}
          >
            {envRefetchResult}
          </div>
        )}
      </section>
      )}

      {subTab === 'data' && (
      <section className="settings-section">
        <h3>{t('settings.gearData')}</h3>
        <p style={{ color: 'var(--text-muted)', fontSize: 13, marginBottom: 10 }}>
          {t('settings.gearDataHint')}
        </p>
        <button
          className="btn-danger"
          onClick={handleDeleteGearData}
          disabled={gearDeleting}
        >
          {gearDeleting ? t('settings.deleting') : t('settings.deleteGear')}
        </button>
        {gearDeleteResult && (
          <div
            style={{
              marginTop: 8,
              fontSize: 13,
              color: isFailText(gearDeleteResult) ? 'var(--accent2)' : 'var(--text-muted)',
            }}
          >
            {gearDeleteResult}
          </div>
        )}
      </section>
      )}

      {/* ── 表示: 言語 → カラーテーマ → ダッシュボード → ギア表示 ── */}
      {subTab === 'display' && (
      <section className="settings-section">
        <h3>{t('settings.language')}</h3>
        <p className="settings-note" style={{ marginTop: 0, marginBottom: 12 }}>
          {t('settings.languageHint')}
        </p>
        <label>
          {t('settings.language')}
          <select
            value={localePref}
            onChange={(e) => {
              const next = e.target.value as LocalePref
              setLocalePref(next)
              saveLocalePref(next)
            }}
          >
            <option value="system">{t('settings.languageSystem')}</option>
            <option value="ja">{t('settings.languageJa')}</option>
            <option value="en">{t('settings.languageEn')}</option>
          </select>
        </label>
      </section>
      )}

      {subTab === 'display' && (
      <section className="settings-section">
        <h3>{t('settings.theme')}</h3>
        <div className="theme-options">
          {THEMES.map(theme => (
            <button
              key={theme.id}
              className={`theme-option${themeId === theme.id ? ' active' : ''}`}
              onClick={() => { saveTheme(theme.id); setThemeId(theme.id) }}
            >
              <span className="theme-dot" style={{ background: theme.dot }} />
              {t(`settings.theme_${theme.id}`)}
            </button>
          ))}
        </div>
      </section>
      )}

      {subTab === 'display' && (
      <section className="settings-section">
        <h3>{t('settings.dashboard')}</h3>
        <p style={{ color: 'var(--text-muted)', fontSize: 13, marginBottom: 10 }}>
          {t('settings.dashboardResetHint')}
        </p>
        <button
          className="btn-danger"
          onClick={() => {
            if (window.confirm(t('settings.dashboardResetConfirm'))) {
              clearCustomCharts()
              // 反映のためリロード。Dashboard 側 state を直接触る経路を作らないシンプル運用。
              window.location.reload()
            }
          }}
        >
          {t('settings.dashboardReset')}
        </button>
      </section>
      )}

      {subTab === 'display' && (
      <section className="settings-section">
        <h3>{t('settings.gearDisplay')}</h3>
        <p className="settings-note" style={{ marginTop: 0, marginBottom: 12 }}>
          {t('settings.gearDisplayHint')}
        </p>
        <label>
          {t('settings.density')}
          <select
            value={gearDensity}
            onChange={(e) => handleChangeDensity(e.target.value as DensityId)}
          >
            {DENSITIES.map(d => (
              <option key={d.id} value={d.id}>{t(`settings.density_${d.id}`)}</option>
            ))}
          </select>
        </label>
        <label>
          {t('settings.comboLimit')}
          <select
            value={gearComboLimit}
            onChange={(e) => handleChangeComboLimit(Number(e.target.value) as ComboLimitValue)}
          >
            {COMBO_LIMITS.map(v => (
              <option key={v} value={v}>{t('settings.itemCount', { count: v })}</option>
            ))}
          </select>
        </label>
        <label>
          {t('settings.nearLimit')}
          <select
            value={gearNearLimit}
            onChange={(e) => handleChangeNearLimit(Number(e.target.value) as NearLimitValue)}
          >
            {NEAR_LIMITS.map(v => (
              <option key={v} value={v}>{t('settings.itemCount', { count: v })}</option>
            ))}
          </select>
        </label>
      </section>
      )}

      {/* ── AI(新設): AI API ── */}
      {subTab === 'ai' && (
      <section className="settings-section">
        <h3>{t('settings.aiApi')}</h3>
        <label>
          {t('settings.provider')}
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
          {t('settings.aiApiKey')}
          <input
            type="password"
            value={settings.ai.apiKey}
            onChange={(e) => update({ ai: { ...settings.ai, apiKey: e.target.value } })}
            placeholder="sk-... / AIzaSy... / sk-ant-... / xai-..."
          />
        </label>
        <label>
          {t('settings.model')}
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
            <option value="__custom__">{t('settings.customModel')}</option>
          </select>
        </label>
        <label>
          {t('settings.customModelId')}
          <input
            type="text"
            value={settings.ai.model}
            onChange={(e) => update({ ai: { ...settings.ai, model: e.target.value } })}
            placeholder={defaultModelFor(settings.ai.provider)}
          />
        </label>
        <p className="settings-note">
          {t('settings.aiPriceNote')}
        </p>
      </section>
      )}
    </div>
  )
}
