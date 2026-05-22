/**
 * AI プロバイダ・モデルのプリセット定義。
 *
 * 価格情報は 2026 年 5 月時点の公開料金を参考。
 * 各プロバイダの最新料金は公式ページで要確認：
 * - OpenAI:    https://openai.com/api/pricing/
 * - Gemini:    https://ai.google.dev/pricing
 * - Anthropic: https://www.anthropic.com/pricing
 * - Grok:      https://docs.x.ai/docs/models
 */

export type AiProvider = 'openai' | 'gemini' | 'anthropic' | 'grok'

export interface AiModelInfo {
  /** API リクエストに渡すモデル ID */
  id: string
  /** UI 表示用ラベル */
  label: string
  /** 入力 1M tokens あたりの $ */
  inputPrice: number
  /** 出力 1M tokens あたりの $ */
  outputPrice: number
  /** コンテキスト長（tokens） */
  contextWindow: number
  /** 推奨用途（短文）*/
  useCase: string
}

export const PROVIDER_LABELS: Record<AiProvider, string> = {
  openai:    'OpenAI',
  gemini:    'Google Gemini',
  anthropic: 'Anthropic Claude',
  grok:      'xAI Grok',
}

/** 各プロバイダの主要モデルプリセット。先頭をデフォルトとして使う想定。 */
export const AI_MODELS: Record<AiProvider, AiModelInfo[]> = {
  openai: [
    { id: 'gpt-4o-mini', label: 'GPT-4o mini',
      inputPrice: 0.15,  outputPrice: 0.60, contextWindow: 128_000, useCase: '軽量分析（推奨・低コスト）' },
    { id: 'gpt-4o',      label: 'GPT-4o',
      inputPrice: 2.50,  outputPrice: 10.00, contextWindow: 128_000, useCase: '高精度・汎用' },
    { id: 'o1-mini',     label: 'o1 mini',
      inputPrice: 3.00,  outputPrice: 12.00, contextWindow: 128_000, useCase: '推論強化・複雑な分析' },
  ],
  gemini: [
    { id: 'gemini-2.5-flash',      label: 'Gemini 2.5 Flash',
      inputPrice: 0.075, outputPrice: 0.30, contextWindow: 1_048_576, useCase: '軽量分析（推奨・無料枠あり）' },
    { id: 'gemini-2.5-pro',        label: 'Gemini 2.5 Pro',
      inputPrice: 1.25,  outputPrice: 10.00, contextWindow: 2_097_152, useCase: '高精度・大規模コンテキスト' },
    { id: 'gemini-2.0-flash-lite', label: 'Gemini 2.0 Flash Lite',
      inputPrice: 0.075, outputPrice: 0.30, contextWindow: 1_048_576, useCase: '超軽量・高速' },
  ],
  anthropic: [
    { id: 'claude-haiku-4-5',  label: 'Claude Haiku 4.5',
      inputPrice: 1.00,  outputPrice: 5.00,  contextWindow: 200_000, useCase: '軽量・低コスト（推奨）' },
    { id: 'claude-sonnet-4-5', label: 'Claude Sonnet 4.5',
      inputPrice: 3.00,  outputPrice: 15.00, contextWindow: 200_000, useCase: '高精度・複雑な分析' },
    { id: 'claude-opus-4-1',   label: 'Claude Opus 4.1',
      inputPrice: 15.00, outputPrice: 75.00, contextWindow: 200_000, useCase: '最高精度・コスト高' },
  ],
  grok: [
    { id: 'grok-2-1212',     label: 'Grok 2',
      inputPrice: 2.00,  outputPrice: 10.00, contextWindow: 131_072, useCase: '汎用（推奨）' },
    { id: 'grok-beta',       label: 'Grok Beta',
      inputPrice: 5.00,  outputPrice: 15.00, contextWindow: 131_072, useCase: 'ベータ版' },
  ],
}

export function defaultModelFor(provider: AiProvider): string {
  return AI_MODELS[provider][0]?.id ?? ''
}

/** モデル ID からメタ情報を引く。プリセット外（自由入力）の場合は undefined。 */
export function findModelInfo(provider: AiProvider, modelId: string): AiModelInfo | undefined {
  return AI_MODELS[provider].find(m => m.id === modelId)
}

/** モデル選択ドロップダウン用のラベル表示（価格情報付き）。 */
export function modelDisplayLabel(m: AiModelInfo): string {
  const ctx = m.contextWindow >= 1_000_000
    ? `${(m.contextWindow / 1_000_000).toFixed(1)}M`
    : `${Math.round(m.contextWindow / 1000)}k`
  return `${m.label}  (in $${m.inputPrice}/M · out $${m.outputPrice}/M · ${ctx} ctx · ${m.useCase})`
}
