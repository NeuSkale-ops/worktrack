import { useEffect, useId, useRef } from 'react'
import type { ReactNode } from 'react'

/** A native modal dialog, or a side drawer, that opens on mount and reports closing. */
export default function Modal({ title, drawer = false, onClose, children }: { title: ReactNode; drawer?: boolean; onClose: () => void; children: ReactNode }) {
  const ref = useRef<HTMLDialogElement>(null)
  const heading = useId()
  useEffect(() => {
    if (!ref.current?.open) ref.current?.showModal()
  }, [])
  // The dialog's own close event arrives a moment later. If the parent is
  // rebuilt in that gap the event is lost and the dialog reopens, so the
  // button and backdrop report closing straight away. Escape still uses the event.
  const close = () => {
    ref.current?.close()
    onClose()
  }
  return (
    <dialog
      ref={ref}
      className={drawer ? 'drawer' : undefined}
      aria-labelledby={heading}
      onClose={onClose}
      onClick={(event) => {
        if (event.target === ref.current) close()
      }}
    >
      <div className="dialog-heading">
        <h2 id={heading}>{title}</h2>
        <button onClick={close} autoFocus>Close</button>
      </div>
      <div className="dialog-body">{children}</div>
    </dialog>
  )
}
