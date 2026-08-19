import type { TFunction } from 'i18next'
import type { Skill } from '../types'

/** DB の Skill.name（日本語）を表示言語に合わせて返す。未知 ID は DB 名にフォールバック。
 *  gearPowerId は 0 始まり（0 = インク効率アップ(メイン)）で、id===0 を「アキ」扱いすると
 *  実在のスキルが空欄表示になってしまう。「アキ」は id===-1 のときだけ（#730）。 */
export function skillDisplayName(skill: Pick<Skill, 'id' | 'name'>, t: TFunction): string {
  if (skill.id === -1) {
    return t('gear.empty', { defaultValue: skill.name || 'アキ' })
  }
  return t(`gear.power.${skill.id}`, { defaultValue: skill.name })
}
