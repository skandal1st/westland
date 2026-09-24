'use client'

import { useEffect, useId, useRef } from 'react'
import { X } from 'lucide-react'
import { CategoryTreeControl, type TreeChoice } from '@/components/CategoryTreeControl'

export function CategoryTreeDialog({
  open,
  nodes,
  selectedId,
  onSelect,
  onClose,
}: {
  open: boolean
  nodes: TreeChoice[]
  selectedId?: string | null
  onSelect: (node: TreeChoice) => void
  onClose: () => void
}) {
  const dialogRef = useRef<HTMLDialogElement>(null)
  const titleId = useId()
  const descriptionId = useId()

  useEffect(() => {
    const dialog = dialogRef.current
    if (!dialog) return
    if (open && !dialog.open) dialog.showModal()
    if (!open && dialog.open) dialog.close()
  }, [open])

  return <dialog
    className="category-tree-dialog"
    ref={dialogRef}
    aria-labelledby={titleId}
    aria-describedby={descriptionId}
    onCancel={event => { event.preventDefault(); onClose() }}
    onClose={onClose}
    onMouseDown={event => { if (event.target === event.currentTarget) onClose() }}
  >
    <div className="category-tree-dialog-head">
      <div><h2 id={titleId}>Выберите категорию</h2><p id={descriptionId}>Раскройте нужную ветку или найдите категорию по названию.</p></div>
      <button type="button" className="icon-button" aria-label="Закрыть выбор категории" onClick={onClose}><X /></button>
    </div>
    <CategoryTreeControl
      nodes={nodes}
      selectedId={selectedId}
      onSelect={node => { onSelect(node); onClose() }}
      label="Полное дерево каталога"
      searchable
    />
    <div className="category-tree-dialog-actions">
      <button type="button" className="button button-secondary" onClick={onClose}>Закрыть</button>
    </div>
  </dialog>
}
