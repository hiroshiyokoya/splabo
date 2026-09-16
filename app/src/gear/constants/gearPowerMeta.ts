/**
 * ギアパワーのメタ情報
 *
 * スプラトゥーン3のギアパワーには2種類ある:
 *   - stackable: メイン10pt + サブ3pt で積算されるパワー（両スロット出現）
 *   - main_only: メインスロットにのみ存在するパワー（発動型）
 *
 * スキルIDの調べ方:
 *   - 一覧表示: geartoon/tools で `python3 scripts/find_combo.py --list-skills` を実行する
 *   - ローカルDB: geartoon/tools/data/gear_db.json の primary_skill.id と additional_skills[].id を参照する
 */

import type { GearCategory, GearItem } from '../types'

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
  clothing: [
    104, // イカニンジャ
    105, // リベンジ
    106, // サーマルインク
    107, // 復活ペナルティアップ
    108, // ギアパワー倍化（所持データなし、ゲーム上は存在）
  ],
  shoes: [
    109, // ステルスジャンプ
    110, // 対物攻撃力アップ
    111, // 受け身術
  ],
}

export function getMainOnlySkillSortRank(skillId: number, category: GearCategory): number {
  const order = MAIN_ONLY_SKILL_ORDER[category]
  if (!order) return Number.POSITIVE_INFINITY
  const idx = order.indexOf(skillId)
  return idx === -1 ? Number.POSITIVE_INFINITY : idx
}

/**
 * スタック型スキルの既定の表示順（ゲーム内と同じ）。
 * ユーザーが設定で並べ替えた結果は `loadStackableSkillOrder()` が返す（#773）。
 * - 絞り込みパネルのスタック型表示順
 * - 「ギアパワー」並び替え時: この順でポイント（メイン10+サブ3）の高いギアを先にする
 */
export const DEFAULT_STACKABLE_SKILL_ORDER: number[] = [
  0,  // インク効率アップ(メイン)
  1,  // インク効率アップ(サブ)
  2,  // インク回復力アップ
  3,  // ヒト移動速度アップ
  4,  // イカダッシュ速度アップ
  5,  // スペシャル増加量アップ
  6,  // スペシャル減少量ダウン
  7,  // スペシャル性能アップ
  8,  // 復活時間短縮
  9,  // スーパージャンプ時間短縮
  10, // サブ性能アップ
  11, // 相手インク影響軽減
  12, // サブ影響軽減
  13, // アクション強化
]

/** gearPowerId → 画像キャッシュの stat.ink キー（#773 設定リストのアイコン）。 */
export const STACKABLE_ABILITY_KEY_BY_ID: Record<number, string> = {
  0: 'ink_saver_main',
  1: 'ink_saver_sub',
  2: 'ink_recovery_up',
  3: 'run_speed_up',
  4: 'swim_speed_up',
  5: 'special_charge_up',
  6: 'special_saver',
  7: 'special_power_up',
  8: 'quick_respawn',
  9: 'quick_super_jump',
  10: 'sub_power_up',
  11: 'ink_resistance_up',
  12: 'sub_resistance_up',
  13: 'intensify_action',
}

const LS_STACKABLE_SKILL_ORDER_KEY = 'splabo:stackableSkillOrder'

export function normalizeStackableSkillOrder(raw: unknown): number[] {
  const seen = new Set<number>()
  const out: number[] = []
  if (Array.isArray(raw)) {
    for (const x of raw) {
      if (typeof x !== 'number' || !Number.isInteger(x)) continue
      if (x === -1 || MAIN_ONLY_SKILL_IDS.has(x) || seen.has(x)) continue
      seen.add(x)
      out.push(x)
    }
  }
  for (const id of DEFAULT_STACKABLE_SKILL_ORDER) {
    if (seen.has(id)) continue
    seen.add(id)
    out.push(id)
  }
  return out
}

export function loadStackableSkillOrder(): number[] {
  try {
    const raw = localStorage.getItem(LS_STACKABLE_SKILL_ORDER_KEY)
    if (!raw) return [...DEFAULT_STACKABLE_SKILL_ORDER]
    return normalizeStackableSkillOrder(JSON.parse(raw) as unknown)
  } catch {
    return [...DEFAULT_STACKABLE_SKILL_ORDER]
  }
}

export function saveStackableSkillOrder(ids: number[]): void {
  localStorage.setItem(LS_STACKABLE_SKILL_ORDER_KEY, JSON.stringify(normalizeStackableSkillOrder(ids)))
}

export function getStackableSkillSortRank(skillId: number): number {
  const idx = loadStackableSkillOrder().indexOf(skillId)
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

/**
 * スタック型のポイント（メイン10 + サブ3）を、設定した順位で高い方を先にする。
 * スロット位置は見ない。同じ構成は同じキーになる。
 */
export function compareStackablePowerDesc(a: GearItem, b: GearItem): number {
  const order = loadStackableSkillOrder()
  const listed = new Set(order)
  const extra: number[] = []
  for (const gear of [a, b]) {
    for (const s of [gear.primary_skill, ...gear.additional_skills]) {
      const id = s.id
      if (id === -1 || MAIN_ONLY_SKILL_IDS.has(id) || listed.has(id) || extra.includes(id)) continue
      extra.push(id)
    }
  }
  extra.sort((x, y) => x - y)
  for (const id of [...order, ...extra]) {
    const diff = calcSkillPoints(b, id) - calcSkillPoints(a, id)
    if (diff !== 0) return diff
  }
  return 0
}
