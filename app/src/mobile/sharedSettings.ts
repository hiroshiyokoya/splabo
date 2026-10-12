import { call } from '../utils/backend'

/**
 * PC の表示設定（スタック型の順・コーデ候補の件数など）をスマホにも反映する（#789）。
 *
 * デスクトップの画面部品はこれらを localStorage から読む（`loadStackableSkillOrder` など）。
 * スマホのブラウザの localStorage は PC とは別物なので、PC の値（`get_shared_settings`）を
 * スマホの localStorage に書き写しておく。PC に無いキーは触らない（スマホは既定の表示のまま）。
 * 取れなくても画面は既定の設定で動くので、失敗は無視する。
 */
export async function applyPcSettings(): Promise<void> {
  try {
    const settings = await call<Record<string, string>>('get_shared_settings')
    for (const [key, value] of Object.entries(settings)) {
      localStorage.setItem(key, value)
    }
  } catch {
    // PC に届かない・古い PC 側など。既定の表示で続ける
  }
}
