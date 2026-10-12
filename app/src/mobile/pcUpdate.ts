/**
 * スマホから PC に「任天堂から取り直して」と頼む（#789・設計 #784 §8）。
 *
 * コンパニオンの ②更新命令（`POST /update` → `GET /update_status` をポーリング）をそのまま使う。
 * viewer と同じ経路で、認証はスマホ Web 版の Cookie で通る（#788）。
 */

/** `GET /update_status` の形（companion.rs `UpdateStatus` のうち使う分） */
interface UpdateStatus {
  state: 'idle' | 'running' | 'done' | 'failed'
  error_message?: string | null
}

export type UpdateOutcome = { ok: true } | { ok: false; message: string }

const POLL_MS = 2000
/** 取り直しは数十秒。PC 側が固まったときに永遠に待たないよう上限を置く */
const TIMEOUT_MS = 5 * 60 * 1000

async function getStatus(): Promise<UpdateStatus> {
  const res = await fetch('/update_status', { credentials: 'same-origin' })
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  return (await res.json()) as UpdateStatus
}

export async function requestPcUpdate(): Promise<UpdateOutcome> {
  try {
    const res = await fetch('/update', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ target: 'both' }),
    })
    // 409 = 実行中・未ログイン・PC 側の取得と重なった。本文に理由がある。
    if (!res.ok && res.status !== 409) return { ok: false, message: `HTTP ${res.status}` }
    if (res.status === 409) {
      const body = (await res.json().catch(() => null)) as UpdateStatus | null
      // 既に走っているなら、その完了を待てばよい
      if (body?.state !== 'running') return { ok: false, message: body?.error_message ?? 'HTTP 409' }
    }

    const deadline = Date.now() + TIMEOUT_MS
    while (Date.now() < deadline) {
      await new Promise(r => setTimeout(r, POLL_MS))
      const st = await getStatus()
      if (st.state === 'done') return { ok: true }
      if (st.state === 'failed') return { ok: false, message: st.error_message ?? '' }
    }
    return { ok: false, message: 'timeout' }
  } catch (e) {
    return { ok: false, message: e instanceof Error ? e.message : String(e) }
  }
}
