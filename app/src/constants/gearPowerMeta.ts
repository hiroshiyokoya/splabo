/**
 * ギアパワーのメタ情報
 *
 * スプラトゥーン3のギアパワーには2種類ある:
 *   - stackable: メイン10pt + サブ3pt で積算されるパワー（両スロット出現）
 *   - main_only: メインスロットにのみ存在するパワー（オン/オフの概念）
 */

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
