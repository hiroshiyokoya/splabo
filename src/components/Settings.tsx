import { useState } from 'react'
import type { AppSettings } from '../types'

interface Props {
  settings: AppSettings
  onSave: (s: AppSettings) => void
}

export function Settings({ settings, onSave }: Props) {
  const [draft, setDraft] = useState<AppSettings>(settings)
  const [saved, setSaved] = useState(false)

  function save() {
    onSave(draft)
    setSaved(true)
    setTimeout(() => setSaved(false), 2000)
  }

  return (
    <div className="settings-panel">
      <h2>設定</h2>

      <section className="settings-section">
        <h3>AI API</h3>
        <label>
          プロバイダー
          <select
            value={draft.ai.provider}
            onChange={(e) => setDraft(d => ({ ...d, ai: { ...d.ai, provider: e.target.value as 'openai' | 'gemini' } }))}
          >
            <option value="openai">OpenAI (ChatGPT)</option>
            <option value="gemini">Google Gemini</option>
          </select>
        </label>
        <label>
          APIキー
          <input
            type="password"
            value={draft.ai.apiKey}
            onChange={(e) => setDraft(d => ({ ...d, ai: { ...d.ai, apiKey: e.target.value } }))}
            placeholder="sk-... または AIzaSy..."
          />
        </label>
        <label>
          モデル
          <input
            type="text"
            value={draft.ai.model}
            onChange={(e) => setDraft(d => ({ ...d, ai: { ...d.ai, model: e.target.value } }))}
            placeholder={draft.ai.provider === 'openai' ? 'gpt-4o-mini' : 'gemini-1.5-flash'}
          />
        </label>
      </section>

      <section className="settings-section">
        <h3>自動取得</h3>
        <label className="checkbox-label">
          <input
            type="checkbox"
            checked={draft.autoFetchEnabled}
            onChange={(e) => setDraft(d => ({ ...d, autoFetchEnabled: e.target.checked }))}
          />
          毎日自動でバトルデータを取得する
        </label>
        <label>
          取得時刻（時）
          <input
            type="number"
            min={0}
            max={23}
            value={draft.autoFetchHour}
            onChange={(e) => setDraft(d => ({ ...d, autoFetchHour: Number(e.target.value) }))}
            disabled={!draft.autoFetchEnabled}
          />
        </label>
      </section>

      <button className="btn-primary" onClick={save}>
        {saved ? '保存しました' : '保存'}
      </button>
    </div>
  )
}
