import { Component, type ErrorInfo, type ReactNode } from 'react'
import i18n from '../i18n'

interface Props {
  children: ReactNode
  /** リセット時に呼ばれる。ナビゲーションなど */
  onReset?: () => void
}

interface State {
  error: Error | null
  errorInfo: ErrorInfo | null
}

/**
 * アプリ全体のクラッシュをキャッチするエラーバウンダリ。
 *
 * - 子コンポーネントで投げられた例外を捕捉し、フォールバック UI を表示する。
 * - `componentDidCatch` でログを `console.error` に残す（Tauri 側のログには流れない点に注意）。
 * - 「再読み込み」ボタンで状態を初期化し、エラー直前の画面に戻ろうとする。
 *   ナビゲーション状態は失われるが、ハードリロードまではしない。
 */
export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null, errorInfo: null }

  static getDerivedStateFromError(error: Error): Partial<State> {
    return { error }
  }

  componentDidCatch(error: Error, errorInfo: ErrorInfo): void {
    this.setState({ errorInfo })
    console.error('[ErrorBoundary] uncaught error:', error)
    console.error('[ErrorBoundary] component stack:', errorInfo.componentStack)
  }

  handleReset = (): void => {
    this.setState({ error: null, errorInfo: null })
    this.props.onReset?.()
  }

  handleHardReload = (): void => {
    window.location.reload()
  }

  render(): ReactNode {
    if (this.state.error) {
      return (
        <div className="error-boundary">
          <div className="error-boundary-card">
            <div className="error-boundary-icon">⚠️</div>
            <h2 className="error-boundary-title">{i18n.t('errorBoundary.title')}</h2>
            <p className="error-boundary-desc">
              {i18n.t('errorBoundary.desc')}
            </p>
            <details className="error-boundary-details">
              <summary>{i18n.t('errorBoundary.details')}</summary>
              <pre className="error-boundary-trace">
                {this.state.error.message}
                {this.state.error.stack && '\n\n' + this.state.error.stack}
              </pre>
            </details>
            <div className="error-boundary-actions">
              <button className="btn-primary" onClick={this.handleReset}>
                {i18n.t('errorBoundary.dismiss')}
              </button>
              <button className="btn-secondary" onClick={this.handleHardReload}>
                {i18n.t('errorBoundary.reload')}
              </button>
            </div>
          </div>
        </div>
      )
    }
    return this.props.children
  }
}
