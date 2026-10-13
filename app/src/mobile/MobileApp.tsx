import { useCallback, useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { call, BackendUnauthorizedError, BackendUnreachableError, MOBILE_REFRESH_EVENT } from '../utils/backend'
import { GearSection } from '../gear/GearSection'
import { BattleScreen } from './BattleScreen'
import { WeaponScreen } from './WeaponScreen'
import { StageScreen } from './StageScreen'
import { DEFAULT_FILTER } from './parts'
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

const SECTION_LABEL: Record<Section, string> = {
  battle: 'mobile.navBattle',
  weapon: 'mobile.navWeapon',
  stage: 'mobile.navStage',
  gear: 'mobile.navGear',
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
  const [section, setSection] = useState<Section>('battle')
  // バトル・ブキ・ステージで共有する絞り込み（期間・ロビー・ルール・#801）。画面を移っても同じまま
  const [filter, setFilter] = useState<MobileFilter>(DEFAULT_FILTER)
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
      <header className="m-header">
        <img src="/splabo-favicon-32.png" alt="SpLabo" width={24} height={24} />
        {connection !== 'ok' && <span className="m-header__title">SpLabo</span>}
        {connection === 'ok' && (
          <>
            {/* 4 つのナビを 390px に収めるため、つながったら「SpLabo」の文字は出さない（#801） */}
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
            <button
              type="button"
              className="m-update-btn"
              onClick={handleUpdate}
              disabled={updating}
              aria-label={t('mobile.update')}
              title={t('mobile.update')}
            >
              <span className={updating ? 'm-spin' : undefined} aria-hidden>↻</span>
            </button>
          </>
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
