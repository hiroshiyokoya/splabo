/** Tauri ネイティブ環境で動いているかどうかを判定する */
export const isTauri = (): boolean => '__TAURI_INTERNALS__' in window
