import { useCallback, useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { call, BackendUnauthorizedError, BackendUnreachableError } from '../utils/backend'
import type { SessionResult } from './session'

/** PC との接続状態 */
export type Connection = 'checking' | 'ok' | 'unauthorized' | 'unreachable'

/** backend の例外を接続状態に読み替える（コマンド自体のエラーは接続できているとみなす） */
export function connectionOf(e: unknown): Connection {
  if (e instanceof BackendUnauthorizedError) return 'unauthorized'
  if (e instanceof BackendUnreachableError) return 'unreachable'
  return 'ok'
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

/** スマホ Web 版の殻。#788 では接続の確認だけ（画面は #789 以降で足す） */
export function MobileApp({ session }: { session: SessionResult }) {
  const { t } = useTranslation()
  const [connection, setConnection] = useState<Connection>(
    session === 'rejected' ? 'unauthorized' : session === 'unreachable' ? 'unreachable' : 'checking',
  )
  const [battleCount, setBattleCount] = useState<number | null>(null)

  const check = useCallback(async () => {
    setConnection('checking')
    try {
      setBattleCount(await call<number>('db_battle_count'))
      setConnection('ok')
    } catch (e) {
      setConnection(connectionOf(e))
    }
  }, [])

  useEffect(() => {
    if (session !== 'rejected') void check()
  }, [session, check])

  return (
    <div className="m-app">
      <header className="m-header">
        <img src="/splabo-favicon-32.png" alt="" width={24} height={24} />
        <span className="m-header__title">SpLabo</span>
      </header>
      <main className="m-main">
        {connection === 'checking' && <p className="m-status">{t('mobile.connecting')}</p>}
        {(connection === 'unauthorized' || connection === 'unreachable') && (
          <ConnectionProblem connection={connection} onRetry={check} />
        )}
        {connection === 'ok' && (
          <p className="m-status">{t('mobile.connected', { count: battleCount ?? 0 })}</p>
        )}
      </main>
    </div>
  )
}
