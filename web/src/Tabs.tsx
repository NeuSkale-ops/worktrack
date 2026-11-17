import type { KeyboardEvent } from 'react'

/** Keyboard-operable tab list. The caller renders the panel with id `${id}-panel`. */
export default function Tabs<T extends string>({ id, label, items, value, onChange }: { id: string; label: string; items: readonly T[]; value: T; onChange: (item: T) => void }) {
  function onKeyDown(event: KeyboardEvent, index: number) {
    const count = items.length
    const next = event.key === 'ArrowRight' ? (index + 1) % count
      : event.key === 'ArrowLeft' ? (index + count - 1) % count
        : event.key === 'Home' ? 0
          : event.key === 'End' ? count - 1 : null
    if (next === null) return
    event.preventDefault()
    onChange(items[next])
    document.getElementById(`${id}-tab-${next}`)?.focus()
  }
  return (
    <div className="task-tabs" role="tablist" aria-label={label}>
      {items.map((item, index) => (
        <button key={item} role="tab" id={`${id}-tab-${index}`} aria-selected={value === item} aria-controls={`${id}-panel`}
          tabIndex={value === item ? 0 : -1} onClick={() => onChange(item)} onKeyDown={event => onKeyDown(event, index)}>{item}</button>
      ))}
    </div>
  )
}
