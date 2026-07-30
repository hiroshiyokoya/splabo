/**
 * AI 分析（#566）。
 *
 * **AI には SQL を書かせ、アプリが手元で実行する。** AI に渡すのはビュー定義と
 * ドメイン知識（`ai_analysis_prompt`）と質問文だけで、データは 1 行も送らない。
 *
 * 以前はデータを渡して AI に数値を計算させ、その結果をグラフにしていた。
 * **AI が幻覚した数値がそのままグラフになる**ので方式を変えた。数値は SQLite が出す。
 *
 * この版はまず「生成された SQL と結果の表」を出すところまで（#566 の第 1 段）。
 * 結果を既存のグラフ部品で描く導線と、画面ごとの入力欄は次の段で入れる。
 */
import { useRef, useState } from 'react'
import { invoke } from '@tauri-apps/api/core'
import type { AppSettings } from '../types'
import { defaultModelFor } from '../utils/aiModels'

/** AI に返させる形。SQL と、それが何を出すかの短い説明。 */
interface SqlPlan {
  sql: string
  explanation?: string
}

/** `ai_run_sql` の戻り。 */
interface AnalysisResult {
  columns: string[]
  rows: (string | number | null)[][]
  /** 行数上限で切られたか。切ったまま「全部」と見せないための印。 */
  truncated: boolean
}

/** 画面に出す行数。バックエンドは 5000 行で切るが、DOM に全部出すと重い。 */
const DISPLAY_ROWS = 200

/** 何を聞けるか分からないと使われないので例を置く。 */
const EXAMPLES = [
  '勝率と最も相関の高いバトル指標は？',
  'ウデマエ帯ごとの武器使用率を上位10件',
  'ステージ別の勝率を、20戦以上に絞ってランキングで',
]

export function AiAnalysis({ settings }: { settings: AppSettings }) {
  const [prompt, setPrompt] = useState('')
  const [phase, setPhase] = useState<null | 'ai' | 'sql'>(null)
  const [error, setError] = useState<string | null>(null)
  const [plan, setPlan] = useState<SqlPlan | null>(null)
  const [sqlError, setSqlError] = useState<string | null>(null)
  const [result, setResult] = useState<AnalysisResult | null>(null)

  // ビュー定義とドメイン知識はビルド時に固定なので、一度取ったら使い回す。
  const schemaRef = useRef<string | null>(null)

  async function schemaPrompt(): Promise<string> {
    if (schemaRef.current === null) {
      schemaRef.current = await invoke<string>('ai_analysis_prompt')
    }
    return schemaRef.current
  }

  /**
   * 質問から SQL を作って実行する。
   * `fixHint` があるとき（実行が失敗した後の「AI に直させる」）は、その内容を添えて書き直させる。
   */
  async function analyze(fixHint?: { sql: string; error: string }) {
    if (!prompt.trim()) return
    if (!settings.ai.apiKey) {
      setError('設定でAPIキーを入力してください')
      return
    }
    setError(null)
    setSqlError(null)
    setResult(null)

    // 🔴 判定に state（phase / plan）を使わない。この関数の中では更新前の値が見えるので、
    // 初回に SQL 実行だけ失敗したケースを取り違える（「AI に直させる」が出なくなる）。
    let issued: SqlPlan | null = null
    try {
      setPhase('ai')
      issued = await askForSql(settings, prompt, await schemaPrompt(), fixHint)
      setPlan(issued)

      setPhase('sql')
      const next = await invoke<AnalysisResult>('ai_run_sql', { sql: issued.sql })
      setResult(next)
      // 0 件はエラーにならないが、たいてい SQL の作りが間違っている
      // （1 行 1 件のビューに HAVING COUNT(*) >= 5 を付けた等）。直させる導線を出す。
      if (next.rows.length === 0) {
        setSqlError('結果が 0 件でした。絞り込みが厳しすぎるか、集計の粒度が合っていない可能性があります。')
      }
    } catch (e) {
      // SQL を受け取った後の失敗 = 実行時エラー。「AI に直させる」で回復できる。
      if (issued) setSqlError(String(e))
      else setError(String(e))
    } finally {
      setPhase(null)
    }
  }

  const busy = phase !== null

  return (
    <div className="ai-panel">
      <h2>AI分析</h2>
      <p className="ai-hint">
        聞きたいことを日本語で入力してください。AI が SQL を書き、<strong>この PC の中だけで実行</strong>します。
        <br />
        AI に送られるのは<strong>質問文とデータの構造の説明だけ</strong>で、バトルデータそのものは送りません。
      </p>

      <div className="ai-examples">
        {EXAMPLES.map(ex => (
          <button key={ex} className="ai-example" onClick={() => setPrompt(ex)} disabled={busy}>
            {ex}
          </button>
        ))}
      </div>

      <div className="ai-input-row">
        <textarea
          className="ai-textarea"
          value={prompt}
          onChange={e => setPrompt(e.target.value)}
          placeholder="聞きたいことを入力..."
          rows={3}
          onKeyDown={e => {
            if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) analyze()
          }}
        />
        <button className="btn-primary" onClick={() => analyze()} disabled={busy}>
          {phase === 'ai' ? 'AI に問い合わせ中...' : phase === 'sql' ? '集計中...' : '分析'}
        </button>
      </div>

      {error && <div className="error-box">{error}</div>}

      {plan?.explanation && <p className="ai-explanation">{plan.explanation}</p>}

      {plan && (
        <details className="ai-sql">
          <summary>実行した SQL</summary>
          <pre>{plan.sql}</pre>
        </details>
      )}

      {sqlError && (
        <div className="error-box">
          <div>{sqlError}</div>
          <button
            className="btn-secondary ai-fix-btn"
            disabled={busy}
            onClick={() => plan && analyze({ sql: plan.sql, error: sqlError })}
          >
            AI に直させる
          </button>
        </div>
      )}

      {result && result.rows.length > 0 && <ResultTable result={result} />}
    </div>
  )
}

function ResultTable({ result }: { result: AnalysisResult }) {
  const shown = result.rows.slice(0, DISPLAY_ROWS)
  return (
    <>
      <div className="ai-result-meta">
        {result.rows.length.toLocaleString()} 行
        {result.truncated && '（上限で打ち切り）'}
        {result.rows.length > DISPLAY_ROWS && ` / 先頭 ${DISPLAY_ROWS} 行を表示`}
      </div>
      <div className="ai-result-wrap">
        <table className="ai-result-table">
          <thead>
            <tr>{result.columns.map(c => <th key={c}>{c}</th>)}</tr>
          </thead>
          <tbody>
            {shown.map((row, i) => (
              <tr key={i}>
                {row.map((v, j) => (
                  <td key={j} className={typeof v === 'number' ? 'num' : undefined}>
                    {v === null ? '-' : typeof v === 'number' ? formatNumber(v) : v}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  )
}

/** 整数はそのまま、小数は 3 桁まで。相関係数のような小さい値が 0 に見えないように。 */
function formatNumber(v: number): string {
  if (Number.isInteger(v)) return v.toLocaleString()
  return v.toFixed(3)
}

// ---------------------------------------------------------------------------
// AI 呼び出し
// ---------------------------------------------------------------------------

function buildSystemPrompt(schema: string): string {
  return `あなたは splabo（Splatoon 3 の戦績分析アプリ）の分析アシスタントです。
ユーザーの質問に答えるための SQLite の SELECT を 1 つ書いてください。

${schema}

## 使える統計関数

このアプリが SQLite に足したものです。

- corr(x, y) — ピアソン相関
- variance(x) / stddev(x) — 標本分散 / 標本標準偏差
- regr_slope(y, x) / regr_intercept(y, x) — 回帰の傾き / 切片

いずれも引数に NULL がある行は母数から外れます。件数不足や分散 0 では NULL を返します。

## 制約

- **読み取り専用です。** SELECT 以外は実行できません（ATTACH / PRAGMA / 書き込みは拒否されます）
- **上に挙げたビューだけを使ってください。** 他のテーブルは参照しないでください
- 結果は行数に上限があります。ランキングなら ORDER BY と LIMIT を付けてください
- 列名は結果表の見出しになります。**日本語の別名**を付けてください

## よくある間違い

- **各ビューの「1 行が何か」を必ず確認してください。** \`ai_battles\` の \`battle_id\` は一意なので、
  \`GROUP BY battle_id\` はグループが 1 行ずつになるだけで意味がありません
- **足切りはグループごとの件数に対して行ってください。** グループが 1 行しかない集計に
  \`HAVING COUNT(*) >= 5\` を付けると、全部消えて 0 件になります
- **相関を聞かれたら平均を並べず \`corr()\` を使ってください。** 平均を見比べても相関は分かりません
- 集計しない列を SELECT に混ぜないでください

## 書き方の例

質問「勝率と最も相関の高いバトル指標は？」

{"sql": "SELECT '平均キル' AS 指標, corr(won, kill) AS 相関係数, COUNT(won) AS 件数 FROM ai_battles UNION ALL SELECT '平均デス', corr(won, death), COUNT(won) FROM ai_battles UNION ALL SELECT '平均アシスト', corr(won, assist), COUNT(won) FROM ai_battles UNION ALL SELECT '平均塗り', corr(won, inked), COUNT(won) FROM ai_battles ORDER BY ABS(相関係数) DESC", "explanation": "各指標と勝敗の相関係数を並べ、絶対値の大きい順にしました。負の値は「多いほど負けやすい」を意味します。"}

質問「ステージ別の勝率を 20 戦以上で」

{"sql": "SELECT stage AS ステージ, ROUND(AVG(won) * 100, 1) AS 勝率, COUNT(won) AS 件数 FROM ai_battles GROUP BY stage HAVING COUNT(won) >= 20 ORDER BY 勝率 DESC", "explanation": "ステージごとの勝率を、20 戦以上あるステージに絞って高い順に並べました。"}

質問「ウデマエ帯ごとの武器使用率を上位10件」

{"sql": "SELECT poster_rank AS ウデマエ, weapon AS ブキ, COUNT(*) AS 出現数, ROUND(COUNT(*) * 100.0 / SUM(COUNT(*)) OVER (PARTITION BY poster_rank), 2) AS 使用率 FROM ai_env_slots WHERE poster_rank IS NOT NULL GROUP BY poster_rank, weapon ORDER BY 使用率 DESC LIMIT 10", "explanation": "ウデマエ帯ごとのブキ出現数と、その帯の中での使用率を出しました。母数は投稿者を除く 7 人です。"}

## 返し方

JSON だけを返してください。前後に説明を付けないでください。

{"sql": "SELECT ...", "explanation": "この SQL が何を出すかの 1〜2 文の説明"}`
}

async function askForSql(
  settings: AppSettings,
  question: string,
  schema: string,
  fixHint?: { sql: string; error: string },
): Promise<SqlPlan> {
  const system = buildSystemPrompt(schema)
  let user = `質問: ${question}`
  if (fixHint) {
    // 失敗した SQL と理由を添えて書き直させる。何が悪かったか分からないと同じ物を返す。
    // 0 件だった場合もここに来る（エラーではないが、たいてい作りが間違っている）。
    user += `

前回この SQL は期待どおりの結果になりませんでした。原因を踏まえて書き直してください。

前回の SQL:
${fixHint.sql}

問題:
${fixHint.error}

特に次を確認してください。
- 各ビューの「1 行が何か」に対して GROUP BY の単位が正しいか
- HAVING の足切りが、1 行しかないグループに当たっていないか
- 相関を求められているなら corr() を使っているか`
  }

  const provider = settings.ai.provider
  const model = settings.ai.model || defaultModelFor(provider)
  const text = await (() => {
    switch (provider) {
      case 'openai':    return callOpenAi(settings.ai.apiKey, model, system, user)
      case 'gemini':    return callGemini(settings.ai.apiKey, model, system, user)
      case 'anthropic': return callAnthropic(settings.ai.apiKey, model, system, user)
      case 'grok':      return callGrok(settings.ai.apiKey, model, system, user)
    }
  })()

  return parsePlan(text)
}

/** JSON だけを返すよう頼んでいるが、コードフェンスで包んでくることがあるので剥がす。 */
function parsePlan(text: string): SqlPlan {
  const stripped = text
    .trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/, '')
    .trim()
  let parsed: unknown
  try {
    parsed = JSON.parse(stripped)
  } catch {
    throw new Error(`AI の返答を JSON として読めませんでした:\n${text.slice(0, 500)}`)
  }
  const obj = parsed as { sql?: unknown; explanation?: unknown }
  if (typeof obj.sql !== 'string' || !obj.sql.trim()) {
    throw new Error(`AI の返答に sql が入っていません:\n${text.slice(0, 500)}`)
  }
  return {
    sql: obj.sql.trim(),
    explanation: typeof obj.explanation === 'string' ? obj.explanation : undefined,
  }
}

async function callOpenAi(apiKey: string, model: string, system: string, user: string): Promise<string> {
  const res = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
    body: JSON.stringify({
      model,
      response_format: { type: 'json_object' },
      messages: [{ role: 'system', content: system }, { role: 'user', content: user }],
    }),
  })
  if (!res.ok) throw new Error(`OpenAI API error: ${res.status} ${await safeBodyText(res)}`)
  const json = await res.json()
  return json.choices[0].message.content
}

async function callGemini(apiKey: string, model: string, system: string, user: string): Promise<string> {
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
  return json.candidates[0].content.parts[0].text
}

async function callAnthropic(apiKey: string, model: string, system: string, user: string): Promise<string> {
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type':      'application/json',
      'x-api-key':         apiKey,
      'anthropic-version': '2023-06-01',
      // ブラウザ環境(Tauri webview)から呼ぶため、CORS 制限を回避
      'anthropic-dangerous-direct-browser-access': 'true',
    },
    body: JSON.stringify({ model, max_tokens: 4096, system, messages: [{ role: 'user', content: user }] }),
  })
  if (!res.ok) throw new Error(`Anthropic API error: ${res.status} ${await safeBodyText(res)}`)
  const json = await res.json()
  // Anthropic の message.content は [{ type: 'text', text: '...' }, ...] 形式
  return (json.content ?? [])
    .filter((c: { type: string }) => c.type === 'text')
    .map((c: { text: string }) => c.text)
    .join('')
}

async function callGrok(apiKey: string, model: string, system: string, user: string): Promise<string> {
  // Grok (xAI) は OpenAI 互換 API
  const res = await fetch('https://api.x.ai/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
    body: JSON.stringify({
      model,
      response_format: { type: 'json_object' },
      messages: [{ role: 'system', content: system }, { role: 'user', content: user }],
    }),
  })
  if (!res.ok) throw new Error(`Grok API error: ${res.status} ${await safeBodyText(res)}`)
  const json = await res.json()
  return json.choices[0].message.content
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
