export interface Skill {
  id: number
  name: string
  image: string
}

export interface GearItem {
  id: number
  name: string
  name_en?: string | null
  rarity: number
  brand: string
  brand_en?: string | null
  brand_image: string
  image: string
  primary_skill: Skill
  additional_skills: Skill[]
  exp: number
}

export type GearCategory = 'head' | 'clothing' | 'shoes'

export interface GearDB {
  head: GearItem[]
  clothing: GearItem[]
  shoes: GearItem[]
  /** スキル辞書: gearPowerId → Skill（アキ枠は id: -1 で登録） */
  skills?: Record<number, Skill>
}
