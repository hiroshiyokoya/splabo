import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from 'react'

export type NotifyKind = 'error' | 'info' | 'success' | 'warning'

export interface Notice {
  id: number
  kind: NotifyKind
  title: string
  /** 本文。省略可。 */
  message?: string
  /** ms 単位。0 で永続（手動で閉じるまで残る）。デフォルト 6000ms。 */
  durationMs: number
  /** クリックで実行されるアクション（例: 「設定を開く」「再試行」）。 */
  action?: {
    label: string
    onClick: () => void
  }
}

interface NotifyContextValue {
  notices: Notice[]
  notify: (n: Omit<Notice, 'id' | 'durationMs'> & { durationMs?: number }) => number
  dismiss: (id: number) => void
  dismissAll: () => void
}

const NotifyContext = createContext<NotifyContextValue | null>(null)

let nextId = 1

/**
 * アプリ全体で使うグローバル通知（トースト）プロバイダ。
 *
 * `main.tsx` で `<App />` をラップしておくと、子のどこからでも `useNotify()` で呼べる。
 * 通知は配列で持ち、`durationMs` 経過後に自動で消える。`durationMs: 0` で永続。
 */
export function NotifyProvider({ children }: { children: ReactNode }) {
  const [notices, setNotices] = useState<Notice[]>([])

  const dismiss = useCallback((id: number) => {
    setNotices(curr => curr.filter(n => n.id !== id))
  }, [])

  const dismissAll = useCallback(() => setNotices([]), [])

  const notify: NotifyContextValue['notify'] = useCallback((n) => {
    const id         = nextId++
    const durationMs = n.durationMs ?? 6000
    setNotices(curr => [...curr, { ...n, id, durationMs }])
    if (durationMs > 0) {
      window.setTimeout(() => dismiss(id), durationMs)
    }
    return id
  }, [dismiss])

  const value = useMemo<NotifyContextValue>(
    () => ({ notices, notify, dismiss, dismissAll }),
    [notices, notify, dismiss, dismissAll],
  )

  return <NotifyContext.Provider value={value}>{children}</NotifyContext.Provider>
}

/** 通知を発行するための hook。Provider 外で呼ぶとエラー。 */
export function useNotify(): NotifyContextValue {
  const ctx = useContext(NotifyContext)
  if (!ctx) throw new Error('useNotify must be called within <NotifyProvider>')
  return ctx
}

// ---------------------------------------------------------------------------
// エラーパース：Rust から返ってくる String エラーから意味のある分類を取り出す
// ---------------------------------------------------------------------------

export type FetchErrorKind =
  | 'not_logged_in'
  /** 外部サービス（znca-api 等）の一時障害。再ログインしても直らない（#399）。 */
  | 'upstream_unavailable'
  | 'network'
  | 'auth_expired'
  | 'unknown'

export interface FetchError {
  kind:      FetchErrorKind
  title:     string
  message:   string
  /** ユーザー向けに「次にどうすればよいか」のサジェスト。 */
  hint?:     string
}

/** バックエンドが付ける機械可読プリフィクス（`app/src-tauri/src/nxapi.rs` の `FailureKind::code`）。 */
const ERROR_CODE_PREFIX = /^(NOT_LOGGED_IN|UPSTREAM_UNAVAILABLE|AUTH_EXPIRED|NETWORK|FETCH_IN_PROGRESS)\s*:\s*/

/**
 * Rust 側のエラー文字列をフロント向けに分類する。
 *
 * 分類は**バックエンドが付けたプリフィクス**で行う。以前は `bullet token|f-token|znca` の
 * 文字列マッチで「認証期限切れ」に倒していたが、znca-api が 500 を返しただけの一時障害でも
 * 再ログインを促してしまい、ユーザーは直らない操作を繰り返すことになっていた（#399）。
 * 「取得に失敗した」という事実ではなく「なぜ失敗したか」で文言を出し分ける。
 *
 * プリフィクスが無い（＝分類できなかった）ものは、憶測で認証エラーにせず素直に扱う。
 */
export function parseFetchError(raw: unknown): FetchError {
  const text = typeof raw === 'string' ? raw : raw instanceof Error ? raw.message : String(raw)
  const code = ERROR_CODE_PREFIX.exec(text)?.[1]
  /** 表示用。機械可読プリフィクスはユーザーに見せない。 */
  const detail = text.replace(ERROR_CODE_PREFIX, '')

  if (code === 'NOT_LOGGED_IN' || text.startsWith('NOT_LOGGED_IN')) {
    return {
      kind:    'not_logged_in',
      title:   'Nintendo アカウントでログインしてください',
      message: '設定画面の「Nintendo アカウントでログイン」からログインすると、最新データを取得できます。',
      hint:    'settings',
    }
  }

  // 外部サービス（znca-api 等）の一時障害。**再ログインを促さない** — トークンは生きている。
  if (code === 'UPSTREAM_UNAVAILABLE') {
    return {
      kind:    'upstream_unavailable',
      title:   '外部サービスが一時的に不調です',
      message: detail + '\n\n認証に使う外部サービスが一時的に応答していません。しばらく待ってから再試行してください（ログインし直す必要はありません）。',
      hint:    'retry',
    }
  }

  // 認証情報の失効（401 / 403 / invalid_grant）。ここだけが再ログイン案内。
  if (code === 'AUTH_EXPIRED') {
    return {
      kind:    'auth_expired',
      title:   '認証の有効期限が切れました',
      message: detail + '\n\n設定から Nintendo アカウントでログインし直してください。',
      hint:    'retry_or_login',
    }
  }

  if (code === 'NETWORK') {
    return {
      kind:    'network',
      title:   'ネットワークエラー',
      message: detail + '\n\nインターネット接続を確認のうえ、もう一度お試しください。',
      hint:    'retry',
    }
  }

  // 分類プリフィクスが付かない経路（Rust 内部の reqwest エラー等）はメッセージから判断する。
  if (/timed?\s*out|connection|dns|reqwest|tls|certificate|sendrequest|HTTP\s*client/i.test(detail)) {
    return {
      kind:    'network',
      title:   'ネットワークエラー',
      message: detail + '\n\nインターネット接続を確認のうえ、もう一度お試しください。',
      hint:    'retry',
    }
  }

  return {
    kind:    'unknown',
    title:   '予期しないエラーが発生しました',
    message: detail,
  }
}
