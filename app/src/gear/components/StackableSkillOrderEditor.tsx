import { useMemo, useState, type CSSProperties } from 'react'
import { useTranslation } from 'react-i18next'
import {
  DndContext, closestCenter, KeyboardSensor, PointerSensor, useSensor, useSensors,
  type DragEndEvent,
} from '@dnd-kit/core'
import {
  SortableContext, arrayMove, useSortable, verticalListSortingStrategy,
  sortableKeyboardCoordinates,
} from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import {
  DEFAULT_STACKABLE_SKILL_ORDER,
  loadStackableSkillOrder,
  saveStackableSkillOrder,
} from '../constants/gearPowerMeta'
import { skillDisplayName } from '../utils/skillDisplayName'
import { mirrorToStore } from '../../utils/settingsStore'

function ordersEqual(a: number[], b: number[]): boolean {
  return a.length === b.length && a.every((id, i) => id === b[i])
}

function SortableRow({ id }: { id: number }) {
  const { t } = useTranslation()
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id })
  const style: CSSProperties = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.55 : 1,
  }
  const name = skillDisplayName({ id, name: '' }, t)
  return (
    <li ref={setNodeRef} style={style} className="stackable-order__row">
      <button
        type="button"
        className="stackable-order__handle"
        {...attributes}
        {...listeners}
        aria-label={t('common.sortDrag')}
        title={t('common.sortDrag')}
      >⋮⋮</button>
      <span className="stackable-order__name">{name}</span>
    </li>
  )
}

/** 設定 → 表示 → ギア。スタック型の順位をドラッグで並べ替える（#773）。 */
export function StackableSkillOrderEditor() {
  const { t } = useTranslation()
  const [order, setOrder] = useState<number[]>(() => loadStackableSkillOrder())
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  )
  const isDefault = useMemo(
    () => ordersEqual(order, DEFAULT_STACKABLE_SKILL_ORDER),
    [order],
  )

  function persist(next: number[]) {
    setOrder(next)
    saveStackableSkillOrder(next)
    void mirrorToStore()
  }

  function handleDragEnd(event: DragEndEvent) {
    const { active, over } = event
    if (!over || active.id === over.id) return
    const oldIndex = order.indexOf(Number(active.id))
    const newIndex = order.indexOf(Number(over.id))
    if (oldIndex < 0 || newIndex < 0) return
    persist(arrayMove(order, oldIndex, newIndex))
  }

  return (
    <div className="stackable-order">
      <div className="stackable-order__heading">{t('settings.stackableSkillOrder')}</div>
      <p className="settings-note" style={{ marginTop: 0, marginBottom: 8 }}>
        {t('settings.stackableSkillOrderHint')}
      </p>
      <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleDragEnd}>
        <SortableContext items={order} strategy={verticalListSortingStrategy}>
          <ol className="stackable-order__list">
            {order.map(id => <SortableRow key={id} id={id} />)}
          </ol>
        </SortableContext>
      </DndContext>
      {!isDefault && (
        <button
          type="button"
          className="btn-secondary"
          onClick={() => persist([...DEFAULT_STACKABLE_SKILL_ORDER])}
        >
          {t('settings.stackableSkillOrderReset')}
        </button>
      )}
    </div>
  )
}
