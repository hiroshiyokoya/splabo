/** Tauri ネイティブ環境で動いているかどうかを判定する */
export const isTauri = (): boolean => '__TAURI_INTERNALS__' in window

/**
 * 外部 URL をシステムブラウザで開く。
 * Tauri 環境では plugin-opener を使用。ブラウザ開発時は window.open() にフォールバック。
 */
export async function openExternal(url: string): Promise<void> {
  if (isTauri()) {
    try {
      const { openUrl } = await import('@tauri-apps/plugin-opener')
      await openUrl(url)
      return
    } catch {
      // フォールバック
    }
  }
  window.open(url, '_blank', 'noreferrer')
}
