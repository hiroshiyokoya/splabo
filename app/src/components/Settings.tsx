import { useState, useEffect } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { getVersion } from '@tauri-apps/api/app'
import { openUrl } from '@tauri-apps/plugin-opener'
import type { AppSettings } from '../types'
import { THEMES, saveTheme, getThemeId } from '../utils/appSettings'
import { AI_MODELS, PROVIDER_LABELS, modelDisplayLabel, defaultModelFor, type AiProvider } from '../utils/aiModels'
import { clearCustomCharts } from '../utils/customCharts'
import { mirrorToStore } from '../utils/settingsStore'
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
}

export function Settings({ settings, onSave, loginVersion }: Props) {
  const [loggedIn, setLoggedIn] = useState(false)
  const [authLoading, setAuthLoading] = useState(false)
  const [themeId, setThemeId] = useState(getThemeId)
  const [uploading, setUploading] = useState(false)
  const [uploadResult, setUploadResult] = useState<string | null>(null)
  const [importing, setImporting] = useState(false)
  const [importResult, setImportResult] = useState<string | null>(null)
  const [weaponUpdating, setWeaponUpdating] = useState(false)
  const [weaponUpdateResult, setWeaponUpdateResult] = useState<string | null>(null)
  // 開発ビルド（0.0.0-dev）では stat.ink アップロードを無効化する（#320）。
  // 実ガードは Rust の upload_pending_battles 側。ここは UI 表示のためだけ。
  const [isDevBuild, setIsDevBuild] = useState(false)

  useEffect(() => {
    getVersion().then(v => setIsDevBuild(v === '0.0.0-dev')).catch(() => {})
  }, [])
  // ── ギア設定 ──────────────────────────────────────────────
  const [gearDensity, setGearDensity] = useState<DensityId>(loadDensityId)
  const [gearComboLimit, setGearComboLimit] = useState<ComboLimitValue>(loadComboLimit)
  const [gearNearLimit, setGearNearLimit] = useState<NearLimitValue>(loadNearLimit)
  const [gearDeleting, setGearDeleting] = useState(false)
  const [gearDeleteResult, setGearDeleteResult] = useState<string | null>(null)

  useEffect(() => {
    invoke<boolean>('check_auth_status').then(setLoggedIn).catch(() => setLoggedIn(false))
  }, [loginVersion])

  // 起動時のスケジューラー / stat.ink 設定同期は App.tsx が担う（#322）。
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
      setWeaponUpdateResult(`武器マスター ${count} 件取得しました`)
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
      setImportResult(`取り込み完了: ${parts.join(' / ')}（取得 ${r.total} 件）`)
    } catch (e) {
      setImportResult(`エラー: ${String(e)}`)
    } finally {
      setImporting(false)
    }
  }

  // ── ギア設定ハンドラ ──────────────────────────────────────
  // gear 側の appSettings は localStorage を更新するが store ミラーは張らないため、
  // 変更のたびに mirrorToStore() を呼んで settings.json（#241 store ミラー）へ反映する。
  // applyDensity は `.gear-root` 未マウント時（＝設定タブ表示中）は localStorage 更新のみで、
  // 次回ギアタブ表示の initAppSettings() で反映される（即時プレビュー不可・仕様）。
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
      '取得済みのギアデータ（ギア一覧・画像キャッシュ）をすべて削除します。\n' +
      '削除後はギアタブが空になり、再度「データ更新」から取得が必要です。実行しますか？'
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

  return (
    <div className="settings-panel">
      <h2>設定</h2>

      <section className="settings-section">
        <h3>Nintendo アカウント</h3>
        {loggedIn ? (
          <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
            <span style={{ color: 'var(--win)', fontSize: 13 }}>連携済み</span>
            <button className="btn-primary" onClick={handleLogout} disabled={authLoading}>
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

      <section className="settings-section">
        <h3>自動取得（有効時はトレイに常駐）</h3>
        <label className="checkbox-label">
          <input
            type="checkbox"
            checked={settings.autoFetchEnabled}
            onChange={(e) => update({ autoFetchEnabled: e.target.checked })}
          />
          自動でバトルデータを取得する
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
            ⚠ 開発ビルド（0.0.0-dev）では、実データの誤送信を防ぐため stat.ink へのアップロードは無効化されています。
          </p>
        )}
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginTop: 10 }}>
          <button
            className="btn-secondary"
            onClick={handleUploadStatink}
            disabled={uploading || !settings.statink.apiKey || isDevBuild}
          >
            {uploading ? 'アップロード中...' : '今すぐアップロード'}
          </button>
          {uploadResult && (
            <span style={{ fontSize: 13, color: uploadResult.startsWith('エラー') ? 'var(--lose)' : 'var(--win)' }}>
              {uploadResult}
            </span>
          )}
        </div>
        <p style={{ color: 'var(--text-muted)', fontSize: 13, margin: '16px 0 10px' }}>
          stat.ink に保存済みの自分の過去バトルを chartoon に取り込みます。
          SplatNet 3 が保持しない古いバトルも集計対象にできます（重複は自動でスキップ）。
        </p>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          <button
            className="btn-secondary"
            onClick={handleImportStatink}
            disabled={importing || !settings.statink.apiKey}
          >
            {importing ? '取り込み中...' : 'stat.ink から過去履歴を取得'}
          </button>
          {importResult && (
            <span style={{ fontSize: 13, color: importResult.startsWith('エラー') ? 'var(--lose)' : 'var(--win)' }}>
              {importResult}
            </span>
          )}
        </div>
      </section>

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
              if (v === '__custom__') return    // 「カスタム…」選択時は何もしない（下のテキストフィールドで入力）
              update({ ai: { ...settings.ai, model: v } })
            }}
          >
            {AI_MODELS[settings.ai.provider].map(m => (
              <option key={m.id} value={m.id}>{modelDisplayLabel(m)}</option>
            ))}
            <option value="__custom__">カスタム（下のテキスト欄で指定）…</option>
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

      <section className="settings-section">
        <h3>ダッシュボード</h3>
        <p style={{ color: 'var(--text-muted)', fontSize: 13, marginBottom: 10 }}>
          追加したカスタムグラフをすべて消してダッシュボードを初期状態（既存の固定 4 グラフのみ）に戻します。
        </p>
        <button
          className="btn-secondary"
          onClick={() => {
            if (window.confirm('追加したカスタムグラフをすべて削除します。よろしいですか？')) {
              clearCustomCharts()
              // 反映のためリロード。Dashboard 側 state を直接触る経路を作らないシンプル運用。
              window.location.reload()
            }
          }}
        >
          カスタムグラフをすべて削除（ダッシュボードをリセット）
        </button>
      </section>

      <section className="settings-section">
        <h3>マスターデータ</h3>
        <div className="settings-help" style={{ marginBottom: 12 }}>
          武器・サブ・SP・カテゴリ等のマスターデータを SplatNet 3 から取得します。
          起動時に 24 時間ごとに自動取得しますが、手動でも実行できます。
        </div>
        <button
          className="btn-primary"
          onClick={handleUpdateWeapons}
          disabled={weaponUpdating || !loggedIn}
        >
          {weaponUpdating ? '取得中...' : '武器データを更新'}
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
        <p style={{ color: 'var(--text-muted)', fontSize: 13, margin: '16px 0 10px' }}>
          取得済みのギアデータ（ギア一覧・画像キャッシュ）をすべて削除します。ギアタブから再取得できます。
        </p>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          <button
            className="btn-secondary"
            onClick={handleDeleteGearData}
            disabled={gearDeleting}
          >
            {gearDeleting ? '削除中...' : 'ギアデータを削除'}
          </button>
          {gearDeleteResult && (
            <span style={{ fontSize: 13, color: gearDeleteResult.startsWith('エラー') ? 'var(--lose)' : 'var(--win)' }}>
              {gearDeleteResult}
            </span>
          )}
        </div>
      </section>
    </div>
  )
}
