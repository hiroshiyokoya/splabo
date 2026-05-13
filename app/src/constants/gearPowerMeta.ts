/**
 * ギアパワーのメタ情報
 *
 * スプラトゥーン3のギアパワーには2種類ある:
 *   - stackable: メイン10pt + サブ3pt で積算されるパワー（両スロット出現）
 *   - main_only: メインスロットにのみ存在するパワー（発動型）
 */

import type { GearCategory } from '../types'

/** メインスロットにのみ存在するギアパワーのID集合 */
export const MAIN_ONLY_SKILL_IDS = new Set<number>([
  100, // スタートダッシュ
  101, // ラストスパート
  102, // 逆境強化
  103, // カムバック
  104, // イカニンジャ
  105, // リベンジ
  106, // サーマルインク
  107, // 復活ペナルティアップ
  108, // ギアパワー倍化（所持データなし、ゲーム上は存在）
  109, // ステルスジャンプ
  110, // 対物攻撃力アップ
  111, // 受け身術
])

/**
 * 発動型スキルが付くギアカテゴリのマッピング
 * （データ実測: 各スキルは1カテゴリ固定）
 */
export const MAIN_ONLY_SKILL_CATEGORY: Record<number, GearCategory> = {
  100: 'head',     // スタートダッシュ
  101: 'head',     // ラストスパート
  102: 'head',     // 逆境強化
  103: 'head',     // カムバック
  104: 'clothing', // イカニンジャ
  105: 'clothing', // リベンジ
  106: 'clothing', // サーマルインク
  107: 'clothing', // 復活ペナルティアップ
  108: 'clothing', // ギアパワー倍化（所持データなし、ゲーム上は存在）
  109: 'shoes',    // ステルスジャンプ
  110: 'shoes',    // 対物攻撃力アップ
  111: 'shoes',    // 受け身術
}

/**
 * 発動型スキルの表示順（個人で調整したい場合はここを編集する）
 * - 絞り込みパネルの発動型表示順
 * - 「メインパワー」並び替え時の発動型の順序
 *
 * 指定がないカテゴリは、スキルID昇順になる。
 */
export const MAIN_ONLY_SKILL_ORDER: Partial<Record<GearCategory, number[]>> = {
  head: [
    100, // スタートダッシュ
    103, // カムバック
    101, // ラストスパート
  ],
}

export function getMainOnlySkillSortRank(skillId: number, category: GearCategory): number {
  const order = MAIN_ONLY_SKILL_ORDER[category]
  if (!order) return Number.POSITIVE_INFINITY
  const idx = order.indexOf(skillId)
  return idx === -1 ? Number.POSITIVE_INFINITY : idx
}

/** ギアパワーの種別 */
export type GearPowerType = 'stackable' | 'main_only'

/** スキルIDからギアパワーの種別を返す */
export function getSkillType(skillId: number): GearPowerType {
  return MAIN_ONLY_SKILL_IDS.has(skillId) ? 'main_only' : 'stackable'
}

/** スタック型かどうか */
export function isStackable(skillId: number): boolean {
  return !MAIN_ONLY_SKILL_IDS.has(skillId)
}

/** メインのみ型かどうか */
export function isMainOnly(skillId: number): boolean {
  return MAIN_ONLY_SKILL_IDS.has(skillId)
}

/**
 * GearItem に対して、特定スタック型スキルの合計ポイントを計算する
 * メインスロット: 10pt、サブスロット: 3pt
 */
import type { GearItem } from '../types'

export function calcSkillPoints(gear: GearItem, skillId: number): number {
  let points = 0
  if (gear.primary_skill.id === skillId) points += 10
  for (const s of gear.additional_skills) {
    if (s.id === skillId) points += 3
  }
  return points
}

/**
 * GearItem がメインのみスキルを持っているか
 * （メインスロットのスキルが一致するかを確認）
 */
export function hasMainOnlySkill(gear: GearItem, skillId: number): boolean {
  return gear.primary_skill.id === skillId
}
