import { useEffect, useState } from 'react'

export function Meter({ percent }: { percent: number }) {
  return <span className="meter" aria-hidden="true"><i style={{ width: `${percent}%` }} /></span>
}

/** A screenshot that says so while it loads, and when its signed link has expired. */
export function Screenshot({ url, alt }: { url: string; alt: string }) {
  const [state, setState] = useState<'loading' | 'loaded' | 'failed'>('loading')
  useEffect(() => {
    const timeout = window.setTimeout(() => setState(current => current === 'loading' ? 'failed' : current), 15000)
    return () => window.clearTimeout(timeout)
  }, [url])
  return (
    <span className={`image-preview ${state}`}>
      {state === 'loading' && <span role="status">Loading screenshot…</span>}
      {state === 'failed' && <span role="status">Screenshot expired or unavailable. Refresh to retry.</span>}
      <img src={url} alt={alt} onLoad={() => setState('loaded')} onError={() => setState('failed')} />
    </span>
  )
}
