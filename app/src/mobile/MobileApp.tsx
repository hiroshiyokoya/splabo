import { useCallback, useEffect, useId, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { call, BackendUnauthorizedError, BackendUnreachableError, MOBILE_REFRESH_EVENT } from '../utils/backend'
import { GearSection } from '../gear/GearSection'
import { BattleScreen } from './BattleScreen'
import { WeaponScreen } from './WeaponScreen'
import { StageScreen } from './StageScreen'
import { loadMobileFilter, saveMobileFilter } from './parts'
import type { MobileFilter } from './parts'
import { requestPcUpdate } from './pcUpdate'
import { applyPcSettings } from './sharedSettings'
import type { SessionResult } from './session'

/** PC との接続状態 */
export type Connection = 'checking' | 'ok' | 'unauthorized' | 'unreachable'

/** backend の例外を接続状態に読み替える（コマンド自体のエラーは接続できているとみなす） */
export function connectionOf(e: unknown): Connection {
  if (e instanceof BackendUnauthorizedError) return 'unauthorized'
  if (e instanceof BackendUnreachableError) return 'unreachable'
  return 'ok'
}

/** ページを裏に回してからこれ以上たって前面に戻ったら、データを読み直す */
const REFRESH_AFTER_HIDDEN_MS = 30 * 1000

/** 更新結果の表示を消すまで */
const UPDATE_NOTE_MS = 4000

type Section = 'battle' | 'weapon' | 'stage' | 'gear'

const SECTIONS: Section[] = ['battle', 'weapon', 'stage', 'gear']

/** 開いていたタブを覚えておくキー（再読み込みしても同じタブで始める・#809） */
const SECTION_STORAGE_KEY = 'splabo:mobileSection'

function loadSection(): Section {
  try {
    const v = localStorage.getItem(SECTION_STORAGE_KEY)
    return SECTIONS.includes(v as Section) ? (v as Section) : 'battle'
  } catch {
    return 'battle'
  }
}

function saveSection(s: Section): void {
  try {
    localStorage.setItem(SECTION_STORAGE_KEY, s)
  } catch {
    // 保存できなくても、その場の切り替えは効く
  }
}

const SECTION_LABEL: Record<Section, string> = {
  battle: 'mobile.navBattle',
  weapon: 'mobile.navWeapon',
  stage: 'mobile.navStage',
  gear: 'mobile.navGear',
}

/**
 * ブラウザのバーを消して全画面にするボタン（Fullscreen API）。
 * http の PC アドレスでは Android の「ホーム画面に追加」でもバーが残るため、ページ側から全画面にする。
 * 対応していないブラウザ（iPhone の Safari など）では出さない
 */
function FullscreenButton() {
  const { t } = useTranslation()
  const [full, setFull] = useState(() => document.fullscreenElement != null)

  useEffect(() => {
    const onChange = () => setFull(document.fullscreenElement != null)
    document.addEventListener('fullscreenchange', onChange)
    return () => document.removeEventListener('fullscreenchange', onChange)
  }, [])

  if (!document.fullscreenEnabled) return null

  const toggle = () => {
    if (document.fullscreenElement) void document.exitFullscreen().catch(() => {})
    else void document.documentElement.requestFullscreen({ navigationUI: 'hide' }).catch(() => {})
  }
  const label = t(full ? 'mobile.exitFullscreen' : 'mobile.fullscreen')
  return (
    <button type="button" className="m-round-btn" onClick={toggle} aria-label={label} title={label}>
      <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
        {full
          ? <path d="M9 4v5H4M15 4v5h5M9 20v-5H4M15 20v-5h5" />
          : <path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5" />}
      </svg>
    </button>
  )
}

/**
 * 更新ボタンのアイコン（#821）。太い丸矢印を、ロゴと同じ緑 → 黄 → 橙のグラデーションで塗る。
 * 外部の画像は使わず、ここで描く（ライセンスの心配がなく、PC から余計なファイルを配らなくてよい）。
 */
function RefreshIcon() {
  const id = useId()
  return (
    <svg viewBox="0 0 24 24" width="24" height="24" aria-hidden>
      <defs>
        <linearGradient id={id} x1="3" y1="21" x2="21" y2="3" gradientUnits="userSpaceOnUse">
          <stop offset="0" stopColor="#22e83a" />
          <stop offset="0.55" stopColor="#e8f028" />
          <stop offset="1" stopColor="#f58a1c" />
        </linearGradient>
      </defs>
      {/* 3 時から少し下（20°）を始まりに、時計回りに 295° 回る円弧。終わり（右上）に矢じりを付ける。
          3 時から始めると、太い線の端の丸みが矢じりと重なる */}
      <path d="M19.52 14.74A8 8 0 1 1 17.66 6.34" fill="none" stroke={`url(#${id})`} strokeWidth="4.6" strokeLinecap="round" />
      <path d="M21.2 2.8v7.1h-7.1z" fill={`url(#${id})`} stroke={`url(#${id})`} strokeWidth="1.6" strokeLinejoin="round" />
    </svg>
  )
}

/** つながらないときの案内（#788・設計 #784 §8） */
export function ConnectionProblem({ connection, onRetry }: { connection: Connection; onRetry: () => void }) {
  const { t } = useTranslation()
  if (connection === 'unauthorized') {
    return (
      <div className="m-problem">
        <p className="m-problem__title">{t('mobile.unauthorizedTitle')}</p>
        <p>{t('mobile.unauthorizedBody')}</p>
      </div>
    )
  }
  return (
    <div className="m-problem">
      <p className="m-problem__title">{t('mobile.unreachableTitle')}</p>
      <ul>
        <li>{t('mobile.unreachableCheckOn')}</li>
        <li>{t('mobile.unreachableCheckWifi')}</li>
        <li>{t('mobile.unreachableCheckPrivate')}</li>
      </ul>
      <button type="button" className="btn-secondary" onClick={onRetry}>{t('mobile.retry')}</button>
    </div>
  )
}

/**
 * スマホ Web 版の殻（#789・設計 #784 §2・§8）。
 *
 * - ヘッダー: 画面の切り替えと「更新」（PC に任天堂から取り直させる）
 * - 中身はデスクトップの画面部品をそのまま使う（ギアは GearSection。コーデシート・保存コーデも込み）
 * - ページを前面に戻したら読み直す（PC 側の自動取得の結果を拾う）
 */
export function MobileApp({ session }: { session: SessionResult }) {
  const { t } = useTranslation()
  const [connection, setConnection] = useState<Connection>(
    session === 'rejected' ? 'unauthorized' : session === 'unreachable' ? 'unreachable' : 'checking',
  )
  const [section, setSection] = useState<Section>(loadSection)
  useEffect(() => { saveSection(section) }, [section])
  // バトル・ブキ・ステージで共有する絞り込み（期間・ロビー・ルール・#801）。画面を移っても同じまま
  const [filter, setFilter] = useState<MobileFilter>(loadMobileFilter)
  // 選んだ絞り込みはスマホに覚えておき、次に開いたときもその条件で始める
  useEffect(() => { saveMobileFilter(filter) }, [filter])
  const [updating, setUpdating] = useState(false)
  const [updateNote, setUpdateNote] = useState<{ ok: boolean; text: string } | null>(null)
  const hiddenAt = useRef<number | null>(null)

  const check = useCallback(async () => {
    setConnection('checking')
    try {
      await call<number>('db_battle_count')
      setConnection('ok')
    } catch (e) {
      setConnection(connectionOf(e))
    }
  }, [])

  useEffect(() => {
    if (session !== 'rejected') void check()
  }, [session, check])

  // PC 側で設定（スタック型の順など）を変えていたら、それも拾ってから各画面に読み直させる
  const refresh = useCallback(async () => {
    await applyPcSettings()
    window.dispatchEvent(new Event(MOBILE_REFRESH_EVENT))
  }, [])

  // 前面に戻ったら読み直す（つながっていなかったら接続から確かめ直す）
  useEffect(() => {
    const onVisibility = () => {
      if (document.visibilityState === 'hidden') {
        hiddenAt.current = Date.now()
        return
      }
      const since = hiddenAt.current
      hiddenAt.current = null
      if (since === null || Date.now() - since < REFRESH_AFTER_HIDDEN_MS) return
      if (connection === 'ok') void refresh()
      else void check()
    }
    document.addEventListener('visibilitychange', onVisibility)
    return () => document.removeEventListener('visibilitychange', onVisibility)
  }, [connection, refresh, check])

  const handleUpdate = async () => {
    if (updating) return
    setUpdating(true)
    setUpdateNote(null)
    const outcome = await requestPcUpdate()
    setUpdating(false)
    if (outcome.ok) {
      void refresh()
      setUpdateNote({ ok: true, text: t('mobile.updateDone') })
    } else {
      setUpdateNote({ ok: false, text: t('mobile.updateFailed', { detail: outcome.message }) })
    }
    setTimeout(() => setUpdateNote(null), UPDATE_NOTE_MS)
  }

  return (
    <div className="m-app">
      {/* 1 段目にロゴと丸ボタン（全画面・更新）、2 段目にタブ（#815） */}
      <header className="m-header">
        <div className="m-header__top">
          <img className="m-header__logo" src="/splabo-logo.png" alt="SpLabo" />
          {connection === 'ok' && (
            <>
              <FullscreenButton />
              <button
                type="button"
                className="m-round-btn"
                onClick={handleUpdate}
                disabled={updating}
                aria-label={t('mobile.update')}
                title={t('mobile.update')}
              >
                <span className={`m-refresh-icon${updating ? ' m-spin' : ''}`}><RefreshIcon /></span>
              </button>
            </>
          )}
        </div>
        {connection === 'ok' && (
          <nav className="m-nav">
            {SECTIONS.map(s => (
              <button
                key={s}
                type="button"
                className={`m-nav__item${section === s ? ' m-nav__item--active' : ''}`}
                onClick={() => setSection(s)}
              >
                {t(SECTION_LABEL[s])}
              </button>
            ))}
          </nav>
        )}
      </header>
      {updating && <p className="m-note">{t('mobile.updating')}</p>}
      {updateNote && (
        <p className={`m-note${updateNote.ok ? '' : ' m-note--error'}`} role="status">{updateNote.text}</p>
      )}
      <main className="m-main">
        {connection === 'checking' && <p className="m-status">{t('mobile.connecting')}</p>}
        {(connection === 'unauthorized' || connection === 'unreachable') && (
          <ConnectionProblem connection={connection} onRetry={check} />
        )}
        {connection === 'ok' && section === 'battle' && <BattleScreen filter={filter} onFilterChange={setFilter} />}
        {connection === 'ok' && section === 'weapon' && <WeaponScreen filter={filter} onFilterChange={setFilter} />}
        {connection === 'ok' && section === 'stage' && <StageScreen filter={filter} onFilterChange={setFilter} />}
        {connection === 'ok' && section === 'gear' && <GearSection />}
      </main>
    </div>
  )
}
