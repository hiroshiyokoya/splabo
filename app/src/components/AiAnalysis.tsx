/**
 * AI 分析（#566）。
 *
 * **AI には SQL を書かせ、アプリが手元で実行する。** 以前はデータを渡して AI に数値を
 * 計算させ、その結果をグラフにしていた。**AI が幻覚した数値がそのままグラフになる**ので
 * 方式を変えた。数値は SQLite が出す。
 *
 * 2 段構成:
 *
 * | 段 | 決めること | 保証 |
 * |---|---|---|
 * | AI①（`askForSql`） | 何を集計するか（SQL・縦長で返す） | SQLite が計算する |
 * | AI②（`askForPresentation`） | 表かグラフか・行・列・セル・軸 | **形は Rust の `ai_present` が作る** |
 *
 * AI① に渡すのはビュー定義・ドメイン知識・件数と期間の範囲（`ai_analysis_prompt`）と質問文で、
 * **バトルの中身は送らない**。AI② には**集計結果の先頭 `AI2_SAMPLE_ROWS` 行**を送る（#541）。
 */
import { useEffect, useState } from 'react'
import { invoke } from '@tauri-apps/api/core'
import type { AppSettings, ShapedChart } from '../types'
import { AiResultChart } from './charts/AiResultChart'
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

/**
 * AI②（見せ方を決める段）が返す指定。**数値は含まない。**
 *
 * 中身の定義と説明は Rust の `ai_present` が持つ（`ai_presentation_prompt`）。
 * ここは受け渡しのための型だけ。
 */
interface PresentationSpec {
  shape: 'table' | 'pivot'
  title?: string
  columns?: { field: string; label?: string }[]
  row_key?: string
  row_label?: string
  column_key?: string
  column_order?: string[]
  column_suffix?: string
  cell_template?: string
}

/** `ai_apply_presentation` が表を返したとき。形はここで確定している。 */
interface ShapedTable {
  title?: string
  columns: string[]
  rows: (string | number | null)[][]
  /** 出せなかったもの・切ったものの説明。黙って捨てないための欄。 */
  warnings: string[]
}

/** `ai_apply_presentation` の戻り。表かグラフのどちらか（#587）。 */
type Presentation =
  | ({ form: 'table' } & ShapedTable)
  | ({ form: 'chart' } & ShapedChart)

/** 画面に出す行数。バックエンドは 5000 行で切るが、DOM に全部出すと重い。 */
const DISPLAY_ROWS = 200

/**
 * SQL を作らせる試行の上限（初回 + 自動の書き直し 2 回）。
 *
 * 列名の取り違えのような**エラーメッセージを読めば直せる失敗**が実際に多い。
 * 毎回ユーザーに「AI に直させる」を押させるのは手間なので自動で回す。
 * ただし 1 回ごとに API を呼ぶ（ユーザーの課金）ので上限を切り、回数を画面に出す。
 */
const MAX_ATTEMPTS = 3

/** 0 件だったときの説明。エラーではないが、たいてい SQL の作りが間違っている。 */
const EMPTY_PROBLEM =
  '結果が 0 件でした。絞り込みが厳しすぎるか、集計の粒度が合っていない可能性があります。'

/**
 * AI② に見せる行数の上限。
 *
 * 見せ方を決めるだけなので全行は要らない。**送る量とコストを抑えるため**に頭だけ渡す。
 * 列名と、どんな値が入るか（順位が 1〜5 か等）が分かれば足りる。
 */
const AI2_SAMPLE_ROWS = 20

/** AI② を試す回数（初回 + 書き直し 1 回）。形の指定は失敗しても表は出せるので浅くする。 */
const MAX_PRESENT_ATTEMPTS = 2

/** 何を聞けるか分からないと使われないので例を置く。 */
const EXAMPLES = [
  '勝率と最も相関の高いバトル指標は？',
  'ルールごとに勝率と相関が高い指標の上位5つ。ルール×相関係数の表で、セルには指標と相関係数を並べて',
  'ウデマエ帯ごとのブキ使用率を上位10件',
  'Xパワーを 500 ごとに区切って、パワー帯ごとの勝率上位 5 ブキを、行 = 帯・列 = 順位で',
]

export function AiAnalysis({ settings }: { settings: AppSettings }) {
  const [prompt, setPrompt] = useState('')
  const [phase, setPhase] = useState<null | { kind: 'ai' | 'sql' | 'present'; attempt: number }>(null)
  const [error, setError] = useState<string | null>(null)
  const [plan, setPlan] = useState<SqlPlan | null>(null)
  const [sqlError, setSqlError] = useState<string | null>(null)
  const [result, setResult] = useState<AnalysisResult | null>(null)
  /** 何回 AI に書かせたか。自動で書き直した事実を隠さないために出す。 */
  const [attempts, setAttempts] = useState(0)
  /** AI② が決めた見せ方（表かグラフ）。決まらなければ null で、SQL の結果をそのまま出す。 */
  const [shaped, setShaped] = useState<Presentation | null>(null)
  /** 見せ方を決められなかった理由。表は出るので、エラーではなく注記として出す。 */
  const [shapeNote, setShapeNote] = useState<string | null>(null)
  /**
   * 集計を始めてからの経過秒数。
   *
   * 環境データは 3900 万行あり、全シーズンの集計は 30 秒以上かかる。
   * 何も動かないと固まったように見えるので、進んでいることを見せる。
   */
  const [elapsed, setElapsed] = useState(0)

  useEffect(() => {
    if (phase?.kind !== 'sql') {
      setElapsed(0)
      return
    }
    const started = Date.now()
    const id = setInterval(() => setElapsed(Math.floor((Date.now() - started) / 1000)), 1000)
    return () => clearInterval(id)
  }, [phase?.kind, phase?.attempt])

  // 分析ごとに取り直す。**データの規模（件数と期間）が入る**ので、
  // 取り込みの前後で内容が変わる。件数の集計は 50ms 程度なので毎回引いて問題ない。
  async function schemaPrompt(): Promise<string> {
    return await invoke<string>('ai_analysis_prompt')
  }

  /**
   * 質問から SQL を作って実行する。**失敗したら自動で書き直させる**（上限 `MAX_ATTEMPTS`）。
   *
   * 実行エラーは AI にエラー文を渡せばだいたい直る（列名の取り違え、ビューの選び間違い等）。
   * `fixHint` は、上限まで使い切ったあとユーザーが手動で押した「AI に直させる」から来る。
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
    setAttempts(0)
    setShaped(null)
    setShapeNote(null)

    // 🔴 判定に state を使わない。この関数の中では更新前の値が見えるので取り違える。
    let hint = fixHint
    // 0 件は「本当に該当なし」のこともある。書き直しは 1 回だけ試して、
    // それでも 0 件ならそれが答えだと受け取る（無駄に API を叩かない）。
    let emptyRetried = false

    // 1 回の分析中は同じスキーマで十分（リトライごとに DB を引き直す必要はない）。
    const schema = await schemaPrompt()

    try {
      for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
        setPhase({ kind: 'ai', attempt })
        let issued: SqlPlan
        try {
          issued = await askForSql(settings, prompt, schema, hint)
        } catch (e) {
          // AI 呼び出し自体の失敗（キー・通信・JSON 不正）は書き直しても直らない。
          setError(String(e))
          return
        }
        setPlan(issued)
        setAttempts(attempt)

        setPhase({ kind: 'sql', attempt })
        let problem: string
        try {
          const next = await invoke<AnalysisResult>('ai_run_sql', { sql: issued.sql })
          if (next.rows.length > 0) {
            setResult(next)
            // 集計は済んだので、失敗しても表は出せる。ここから先で throw しない。
            await decidePresentation(next)
            return
          }
          setResult(next)
          if (emptyRetried) {
            setSqlError(EMPTY_PROBLEM)
            return
          }
          emptyRetried = true
          problem = EMPTY_PROBLEM
        } catch (e) {
          problem = String(e)
        }

        // 上限に達したら、ここから先はユーザーの判断（手動の「AI に直させる」）に委ねる。
        if (attempt === MAX_ATTEMPTS) {
          setSqlError(problem)
          return
        }
        setResult(null)
        hint = { sql: issued.sql, error: problem }
      }
    } finally {
      setPhase(null)
    }
  }

  /**
   * AI② に見せ方を決めさせ、アプリ側で表の形を作る（#566 第 1 段 B）。
   *
   * **数値には触らせない。** AI② が返すのは「どの列を行に置くか」だけで、
   * 組み替えとセルの連結は Rust の `ai_apply_presentation` が行う。
   * だから「セルに勝率を入れ忘れる」ような崩れ方が起きない。
   *
   * ここは**失敗しても致命的ではない**。形が決まらなければ SQL の結果をそのまま出す。
   * 集計は既に終わっているので、見せ方のために結果を捨てるのは損。
   */
  async function decidePresentation(data: AnalysisResult) {
    let hint: string | undefined
    for (let attempt = 1; attempt <= MAX_PRESENT_ATTEMPTS; attempt++) {
      setPhase({ kind: 'present', attempt })
      try {
        const spec = await askForPresentation(settings, prompt, data, hint)
        setShaped(await invoke<Presentation>('ai_apply_presentation', { result: data, spec }))
        return
      } catch (e) {
        // 列の取り違えなら、エラーに実際の列名が入っているので渡せば直る。
        hint = String(e)
        if (attempt === MAX_PRESENT_ATTEMPTS) {
          setShapeNote(`見せ方を決められなかったので、集計結果をそのまま表示しています。（${hint}）`)
        }
      }
    }
  }

  const busy = phase !== null

  return (
    <div className="ai-panel">
      <h2>AI分析</h2>
      <p className="ai-hint">
        聞きたいことを日本語で入力してください。AI が SQL を書き、<strong>この PC の中だけで実行</strong>します。
        <br />
        SQL を書かせるときに送るのは<strong>質問文・データの構造の説明・件数と期間の範囲だけ</strong>で、
        バトルの内容は送りません。
        <br />
        そのあと<strong>表やグラフの見せ方を決めるために、集計結果の先頭 {AI2_SAMPLE_ROWS} 行を送ります</strong>
        （ステージ名・ブキ名・勝率などの集計値。個々のバトルや他プレイヤーの名前は含みません）。
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
          {phase === null
            ? '分析'
            : (phase.kind === 'ai'
                ? 'AI に問い合わせ中'
                : phase.kind === 'sql'
                  ? `集計中${elapsed >= 3 ? `（${elapsed} 秒）` : ''}`
                  : '見せ方を決めています') +
              // 2 回目以降は書き直していることが分かるように出す。
              (phase.attempt > 1 ? `（書き直し ${phase.attempt - 1} 回目）` : '') +
              '...'}
        </button>
      </div>

      {error && <div className="error-box">{error}</div>}

      {plan?.explanation && <p className="ai-explanation">{plan.explanation}</p>}

      {plan && (
        <details className="ai-sql">
          <summary>
            実行した SQL
            {attempts > 1 && `（AI が ${attempts - 1} 回書き直しました）`}
          </summary>
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

      {shapeNote && <p className="ai-shape-note">{shapeNote}</p>}

      {shaped?.warnings.map(w => (
        <p key={w} className="ai-shape-note">{w}</p>
      ))}

      {shaped?.title && <h3 className="ai-result-title">{shaped.title}</h3>}

      {/* AI② が決めたのが表かグラフか。決められなければ集計結果をそのまま出す。 */}
      {shaped?.form === 'chart' ? (
        <AiResultChart chart={shaped} />
      ) : shaped ? (
        <ResultTable
          columns={shaped.columns}
          rows={shaped.rows}
          truncated={result?.truncated ?? false}
        />
      ) : (
        result &&
        result.rows.length > 0 && (
          <ResultTable
            columns={result.columns}
            rows={result.rows}
            truncated={result.truncated}
          />
        )
      )}

      {/* 形を変えたときは、元の集計結果も確認できるようにしておく（数値の根拠）。
          グラフのときは特に、点になった値を数字で確かめられる必要がある。 */}
      {shaped && result && (
        <details className="ai-sql">
          <summary>集計結果（{result.rows.length.toLocaleString()} 行）</summary>
          <ResultTable columns={result.columns} rows={result.rows} truncated={result.truncated} />
        </details>
      )}
    </div>
  )
}

function ResultTable({
  columns,
  rows,
  truncated,
}: {
  columns: string[]
  rows: (string | number | null)[][]
  truncated: boolean
}) {
  const shown = rows.slice(0, DISPLAY_ROWS)
  return (
    <>
      <div className="ai-result-meta">
        {rows.length.toLocaleString()} 行
        {truncated && '（上限で打ち切り）'}
        {rows.length > DISPLAY_ROWS && ` / 先頭 ${DISPLAY_ROWS} 行を表示`}
      </div>
      <div className="ai-result-wrap">
        <table className="ai-result-table">
          <thead>
            {/* ピボットすると同じ見出しが並ぶことがあるので添字も鍵に含める。 */}
            <tr>{columns.map((c, i) => <th key={`${c}-${i}`}>{c}</th>)}</tr>
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
  // 🔴 スキーマ・使える関数・よくある間違い・書き方の例は **すべて schema に含まれる**
  // （Rust の `analysis_prompt()` が組む）。ここに書き足さないこと。
  // 実例の SQL は「実際に実行できるか」を Rust 側のテストで検証している。
  // 壊れた例を渡すと AI はそれを忠実に真似するので、テストできる場所に置いてある。
  // 「縦長で返す」だけは、返答フォーマットの直前で再強調する（Rust 側にも同趣旨あり）。
  return `あなたは splabo（Splatoon 3 の戦績分析アプリ）の分析アシスタントです。
ユーザーの質問に答えるための SQLite の SELECT を 1 つ書いてください。

${schema}

---

## 守ること

- **読み取り専用です。** SELECT 以外は実行できません（ATTACH / PRAGMA / 書き込みは拒否されます）
- **上に挙げたビューだけを使ってください。** 他のテーブルは参照しないでください
- 結果は行数に上限があります。ランキングなら ORDER BY と LIMIT を付けてください
- 列名は結果表の見出しになります。**日本語の別名**を付けてください
- **表の形はあなたの仕事ではありません。縦長（1 行 = 1 つの組み合わせ）で返してください。**
  「行は〇〇、列は〇〇」と形を指定されていても、**組み替えは後段のアプリが行います**。
  値を \`||\` で連結せず、それぞれ別の列で返してください（連結すると後段が数値を扱えません）
- 「よくある間違い」と「書き方の例」に必ず目を通してください

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
- 相関を求められているなら corr() を使っているか
- 群ごとの上位 N なら ROW_NUMBER() OVER (PARTITION BY ...) で順位を振り、**順位も列に出しているか**
- 縦長になっているか（列方向への展開や \`||\` での連結をしていないか）
- 数値の帯は文字列ではなく数値で作り、ORDER BY もその数値で並べているか`
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

/**
 * AI②（見せ方を決める段）に問い合わせる。
 *
 * 🔴 **ここだけは集計結果が外部に出る。** 送るのは列名と先頭 `AI2_SAMPLE_ROWS` 行で、
 * 生のバトルではないが、ステージ名・ブキ名・勝率といった中身がそのまま含まれる。
 * README とこの画面の説明はこの事実に合わせてある（#541）。
 *
 * 全行を送らないのは、見せ方を決めるのに要らないから（コストと送信量を抑える）。
 */
async function askForPresentation(
  settings: AppSettings,
  question: string,
  data: AnalysisResult,
  fixHint?: string,
): Promise<PresentationSpec> {
  const system = await invoke<string>('ai_presentation_prompt')
  const sample = data.rows.slice(0, AI2_SAMPLE_ROWS)
  let user = `質問: ${question}

集計結果の列: ${data.columns.join(', ')}
全 ${data.rows.length} 行のうち先頭 ${sample.length} 行:
${JSON.stringify(sample)}`
  if (fixHint) {
    user += `

前回の指定は使えませんでした。原因を踏まえて直してください。

${fixHint}`
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

  return parseSpec(text)
}

/** AI② の返答を `PresentationSpec` として読む。形が違えばここで弾く。 */
function parseSpec(text: string): PresentationSpec {
  const parsed = parseJson(text)
  const obj = parsed as { shape?: unknown }
  if (obj.shape !== 'table' && obj.shape !== 'pivot') {
    throw new Error(`shape は "table" か "pivot" にしてください（返答: ${String(obj.shape)}）`)
  }
  return parsed as PresentationSpec
}

/** JSON だけを返すよう頼んでいるが、コードフェンスで包んでくることがあるので剥がす。 */
function parseJson(text: string): unknown {
  const stripped = text
    .trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/, '')
    .trim()
  try {
    return JSON.parse(stripped)
  } catch {
    throw new Error(`AI の返答を JSON として読めませんでした:\n${text.slice(0, 500)}`)
  }
}

function parsePlan(text: string): SqlPlan {
  const parsed = parseJson(text)
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
