import { invoke } from '@tauri-apps/api/core'
import { isTauri } from '../gear/utils/tauri'

/**
 * バックエンド（Rust のコマンド）を呼ぶ窓口（#785・設計 #784 §3）。
 *
 * - Tauri の中（デスクトップ）: `invoke` をそのまま使う
 * - ブラウザ（スマホ Web 版）: コンパニオンサーバーの `POST /api/cmd/<cmd>` を呼ぶ。
 *   本文は invoke と同じ camelCase の引数 JSON。認証は Cookie（`POST /api/session` で受け取る）
 *
 * フロントのコードは `invoke` を直接使わず、必ずここを通す。
 */
export async function call<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  if (isTauri()) return invoke<T>(cmd, args)
  return callHttp<T>(cmd, args)
}

/** PC（コンパニオンサーバー）に届かない。PC が止まっている・別のネットワーク・ファイアウォール */
export class BackendUnreachableError extends Error {
  /** fetch が投げた元のエラー */
  readonly detail: unknown

  constructor(detail?: unknown) {
    super('backend unreachable')
    this.name = 'BackendUnreachableError'
    this.detail = detail
  }
}

/** 認証が通らない（Cookie が無い・トークンを再発行した）。QR を読み直してもらう */
export class BackendUnauthorizedError extends Error {
  constructor() {
    super('backend unauthorized')
    this.name = 'BackendUnauthorizedError'
  }
}

async function callHttp<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  let res: Response
  try {
    res = await fetch(`/api/cmd/${encodeURIComponent(cmd)}`, {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(args ?? {}),
    })
  } catch (e) {
    throw new BackendUnreachableError(e)
  }
  if (res.status === 401) throw new BackendUnauthorizedError()
  if (!res.ok) {
    // invoke と同じく、コマンドのエラーは文字列で投げる（呼び出し側の formatInvokeError をそのまま使える）
    throw (await res.text().catch(() => '')) || `HTTP ${res.status}`
  }
  return (await res.json()) as T
}
