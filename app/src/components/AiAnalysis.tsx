import { useState } from 'react'
import { invoke } from '@tauri-apps/api/core'
import type { Summary, ChartSpec, AppSettings } from '../types'
import { defaultModelFor } from '../utils/aiModels'

interface Props {
  settings: AppSettings
  onChartReady: (spec: ChartSpec) => void
}

export function AiAnalysis({ settings, onChartReady }: Props) {
  const [prompt, setPrompt] = useState('')
  const [response, setResponse] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function analyze() {
    if (!prompt.trim()) return
    if (!settings.ai.apiKey) {
      setError('設定でAPIキーを入力してください')
      return
    }

    setLoading(true)
    setError(null)

    try {
      const summary = await invoke<Summary>('db_summary', { since: null })
      const chartSpec = await callAiApi(settings, prompt, summary)
      setResponse(JSON.stringify(chartSpec, null, 2))
      onChartReady(chartSpec)
    } catch (e) {
      setError(String(e))
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="ai-panel">
      <h2>AI分析</h2>
      <p className="ai-hint">
        どんなグラフを見たいか日本語で入力してください。<br />
        例:「武器別の勝率とバトル数の相関を散布図で見せて」
      </p>

      <div className="ai-input-row">
        <textarea
          className="ai-textarea"
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          placeholder="分析したい内容を入力..."
          rows={3}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) analyze()
          }}
        />
        <button className="btn-primary" onClick={analyze} disabled={loading}>
          {loading ? '分析中...' : '分析'}
        </button>
      </div>

      {error && <div className="error-box">{error}</div>}

      {response && (
        <details className="ai-raw">
          <summary>AIの返答（raw）</summary>
          <pre>{response}</pre>
        </details>
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------
// AI API 呼び出し
// ---------------------------------------------------------------------------

async function callAiApi(settings: AppSettings, prompt: string, summary: Summary): Promise<ChartSpec> {
  const systemPrompt = `あなたはSplatoon 3のバトルデータを可視化するアシスタントです。
ユーザーの要求に応じて、Rechartsで描画できるグラフの仕様をJSONで返してください。

返すJSONの形式:
{
  "chartType": "bar" | "line" | "scatter" | "pie",
  "title": "グラフのタイトル",
  "data": [ { <xKey>: ..., <yKey>: ... }, ... ],
  "xKey": "X軸のキー名",
  "yKey": "Y軸のキー名"
}

dataはサマリーデータから計算してください。JSONのみ返し、説明文は不要です。`

  const userMessage = `バトルデータのサマリー:\n${JSON.stringify(summary, null, 2)}\n\n要求: ${prompt}`

  const provider = settings.ai.provider
  const model    = settings.ai.model || defaultModelFor(provider)
  switch (provider) {
    case 'openai':    return callOpenAi(settings.ai.apiKey, model, systemPrompt, userMessage)
    case 'gemini':    return callGemini(settings.ai.apiKey, model, systemPrompt, userMessage)
    case 'anthropic': return callAnthropic(settings.ai.apiKey, model, systemPrompt, userMessage)
    case 'grok':      return callGrok(settings.ai.apiKey, model, systemPrompt, userMessage)
  }
}

async function callOpenAi(apiKey: string, model: string, system: string, user: string): Promise<ChartSpec> {
  const res = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model,
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: user },
      ],
    }),
  })
  if (!res.ok) throw new Error(`OpenAI API error: ${res.status} ${await safeBodyText(res)}`)
  const json = await res.json()
  return JSON.parse(json.choices[0].message.content) as ChartSpec
}

async function callGemini(apiKey: string, model: string, system: string, user: string): Promise<ChartSpec> {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      system_instruction: { parts: [{ text: system }] },
      contents: [{ parts: [{ text: user }] }],
      generationConfig: { response_mime_type: 'application/json' },
    }),
  })
  if (!res.ok) throw new Error(`Gemini API error: ${res.status} ${await safeBodyText(res)}`)
  const json = await res.json()
  return JSON.parse(json.candidates[0].content.parts[0].text) as ChartSpec
}

async function callAnthropic(apiKey: string, model: string, system: string, user: string): Promise<ChartSpec> {
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type':      'application/json',
      'x-api-key':         apiKey,
      'anthropic-version': '2023-06-01',
      // ブラウザ環境（Tauri webview）から呼ぶため、CORS 制限を回避
      'anthropic-dangerous-direct-browser-access': 'true',
    },
    body: JSON.stringify({
      model,
      max_tokens: 4096,
      system,
      messages: [{ role: 'user', content: user }],
    }),
  })
  if (!res.ok) throw new Error(`Anthropic API error: ${res.status} ${await safeBodyText(res)}`)
  const json = await res.json()
  // Anthropic の message.content は [{ type: 'text', text: '...' }, ...] 形式
  const text = (json.content ?? [])
    .filter((c: { type: string }) => c.type === 'text')
    .map((c: { text: string }) => c.text)
    .join('')
  return JSON.parse(text) as ChartSpec
}

async function callGrok(apiKey: string, model: string, system: string, user: string): Promise<ChartSpec> {
  // Grok (xAI) は OpenAI 互換 API
  const res = await fetch('https://api.x.ai/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type':  'application/json',
      'Authorization': `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model,
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: system },
        { role: 'user',   content: user   },
      ],
    }),
  })
  if (!res.ok) throw new Error(`Grok API error: ${res.status} ${await safeBodyText(res)}`)
  const json = await res.json()
  return JSON.parse(json.choices[0].message.content) as ChartSpec
}

/** エラーレスポンス本文を安全に取り出す。失敗時は空文字。長すぎる場合は切る。 */
async function safeBodyText(res: Response): Promise<string> {
  try {
    const text = await res.text()
    return text.length > 500 ? text.slice(0, 500) + '…' : text
  } catch {
    return ''
  }
}
