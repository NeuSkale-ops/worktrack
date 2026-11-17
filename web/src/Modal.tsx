import { useEffect, useId, useRef } from 'react'
import type { ReactNode } from 'react'

/** A native modal dialog, or a side drawer, that opens on mount and reports closing. */
export default function Modal({ title, drawer = false, onClose, children }: { title: ReactNode; drawer?: boolean; onClose: () => void; children: ReactNode }) {
  const ref = useRef<HTMLDialogElement>(null)
  const heading = useId()
  useEffect(() => {
    if (!ref.current?.open) ref.current?.showModal()
  }, [])
  return (
    <dialog
      ref={ref}
      className={drawer ? 'drawer' : undefined}
      aria-labelledby={heading}
      onClose={onClose}
      onClick={(event) => {
        if (event.target === ref.current) ref.current?.close()
      }}
    >
      <div className="dialog-heading">
        <h2 id={heading}>{title}</h2>
        <button onClick={() => ref.current?.close()} autoFocus>Close</button>
      </div>
      <div className="dialog-body">{children}</div>
    </dialog>
  )
}
