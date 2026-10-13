/**
 * QR の URL（`/m/#t=<トークン>`）からトークンを取り出して Cookie に交換する（#788・設計 #784 §5）。
 *
 * トークンは `#` 以降にあるのでサーバーには送られない。ここで `POST /api/session` に渡し、
 * `HttpOnly` の Cookie を受け取る。終わったら URL から `#t=` を消す（ホーム画面に追加したときに
 * トークン入りの URL が残らないように）。
 *
 * - `'exchanged'`: 交換できた
 * - `'none'`: URL にトークンが無い（2 回目以降。Cookie が既にある前提で進める）
 * - `'rejected'`: トークンが違う（再発行された・古い QR）
 * - `'unreachable'`: PC に届かない
 */
export type SessionResult = 'exchanged' | 'none' | 'rejected' | 'unreachable'

export function tokenFromHash(hash: string): string | null {
  const m = hash.match(/(?:^#|&)t=([0-9a-f]+)/)
  return m ? m[1] : null
}

export async function establishSession(): Promise<SessionResult> {
  const token = tokenFromHash(window.location.hash)
  if (!token) return 'none'
  history.replaceState(null, '', window.location.pathname + window.location.search)
  try {
    const res = await fetch('/api/session', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token }),
    })
    return res.ok ? 'exchanged' : 'rejected'
  } catch {
    return 'unreachable'
  }
}
