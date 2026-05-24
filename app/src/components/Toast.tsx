import { useNotify, type Notice } from '../utils/notify'

/**
 * 画面右下に重ねて表示するトーストコンポーネント。
 *
 * 通知は `NotifyProvider` が状態を持ち、ここはレンダリング専用。
 * 通常のトーストと違い、`action` が指定された通知はクリッカブルなボタンを描画する
 * （「設定を開く」「再試行」など、ユーザーが次にすべき動作を一発で起こせる）。
 */
export function Toaster() {
  const { notices, dismiss } = useNotify()

  if (notices.length === 0) return null

  return (
    <div className="toaster" role="region" aria-live="polite" aria-label="通知">
      {notices.map(n => (
        <ToastItem key={n.id} notice={n} onDismiss={() => dismiss(n.id)} />
      ))}
    </div>
  )
}

function ToastItem({ notice, onDismiss }: { notice: Notice; onDismiss: () => void }) {
  const { kind, title, message, action } = notice
  const icon =
    kind === 'error'   ? '⚠️' :
    kind === 'warning' ? '⚠️' :
    kind === 'success' ? '✓'  :
                         'ℹ️'

  return (
    <div className={`toast toast--${kind}`} role={kind === 'error' ? 'alert' : 'status'}>
      <div className="toast-icon" aria-hidden="true">{icon}</div>
      <div className="toast-body">
        <div className="toast-title">{title}</div>
        {message && <div className="toast-message">{message}</div>}
        {action && (
          <button className="toast-action" onClick={() => { action.onClick(); onDismiss() }}>
            {action.label}
          </button>
        )}
      </div>
      <button className="toast-close" onClick={onDismiss} aria-label="閉じる">✕</button>
    </div>
  )
}
