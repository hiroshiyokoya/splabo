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

export type FetchErrorKind = 'not_logged_in' | 'network' | 'auth_expired' | 'unknown'

export interface FetchError {
  kind:      FetchErrorKind
  title:     string
  message:   string
  /** ユーザー向けに「次にどうすればよいか」のサジェスト。 */
  hint?:     string
}

/**
 * Rust 側のエラー文字列をフロント向けに分類する。
 *
 * - `NOT_LOGGED_IN:` プリフィクスはバックエンドが付与する「ログイン未済」の明示マーカー。
 * - bullet token 系のエラーは認証期限切れの可能性が高いので、再ログインへ誘導する。
 * - reqwest 系のメッセージはネットワークエラーとして扱い、リトライを促す。
 */
export function parseFetchError(raw: unknown): FetchError {
  const text = typeof raw === 'string' ? raw : raw instanceof Error ? raw.message : String(raw)

  if (text.startsWith('NOT_LOGGED_IN')) {
    return {
      kind:    'not_logged_in',
      title:   'Nintendo アカウントでログインしてください',
      message: '設定画面の「Nintendo アカウントでログイン」からログインすると、バトルデータを取得できます。',
      hint:    'settings',
    }
  }

  // bullet token / f-token 系は認証フロー失敗（期限切れ or Nintendo 側）
  if (/bullet\s*token|f[-_ ]?token|znca/i.test(text)) {
    return {
      kind:    'auth_expired',
      title:   '認証トークンの取得に失敗しました',
      message: text + '\n\nしばらく待ってから再試行するか、設定からログインし直してください。',
      hint:    'retry_or_login',
    }
  }

  // reqwest / tcp / dns / timeout 系はネットワーク
  if (/timed?\s*out|connection|dns|reqwest|tls|certificate|sendrequest|HTTP\s*client/i.test(text)) {
    return {
      kind:    'network',
      title:   'ネットワークエラー',
      message: text + '\n\nインターネット接続を確認のうえ、もう一度お試しください。',
      hint:    'retry',
    }
  }

  return {
    kind:    'unknown',
    title:   '予期しないエラーが発生しました',
    message: text,
  }
}
