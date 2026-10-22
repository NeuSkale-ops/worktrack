import { useEffect, useState } from 'react'
import { fetchWindowsRelease } from './windowsRelease'
import type { WindowsRelease } from './windowsRelease'

export default function DownloadCard() {
  const [release, setRelease] = useState<WindowsRelease | null>(null)
  const [loading, setLoading] = useState(true)
  const [attempt, setAttempt] = useState(0)
  useEffect(() => {
    let controller: AbortController | undefined
    let timeout: number | undefined
    const load = async () => {
      controller?.abort()
      window.clearTimeout(timeout)
      const current = new AbortController()
      controller = current
      timeout = window.setTimeout(() => current.abort(), 15000)
      setRelease(null)
      setLoading(true)
      try {
        const next = await fetchWindowsRelease(location.origin, current.signal)
        if (controller === current && !current.signal.aborted) setRelease(next)
      } catch {
        // No stale installer fallback when the feed is unavailable or unpublished.
      } finally {
        if (controller === current) {
          window.clearTimeout(timeout)
          setLoading(false)
        }
      }
    }
    const refresh = () => { void load() }
    refresh()
    window.addEventListener('focus', refresh)
    const timer = window.setInterval(refresh, 5 * 60 * 1000)
    return () => {
      controller?.abort()
      controller = undefined
      window.clearTimeout(timeout)
      window.clearInterval(timer)
      window.removeEventListener('focus', refresh)
    }
  }, [attempt])
  return (
    <section className="card download" aria-labelledby="download-heading" aria-busy={loading}>
      <div>
        <h2 id="download-heading">WorkTrack for Windows</h2>
        <p className="muted" role="status">{loading ? 'Checking latest Windows release…' : release ? `Version ${release.version}, 64-bit` : 'Windows download unavailable or not yet published. Please retry.'}</p>
      </div>
      {release && <a className="button" href={release.url} download>Download</a>}
      {!loading && !release && <button onClick={() => setAttempt(value => value + 1)}>Retry download check</button>}
      <details>
        <summary>Install steps</summary>
        <ol>
          <li>If upgrading, stop tracking and wait until queued records have synced. Do not uninstall or remove app data.</li>
          <li>Download and install WorkTrack. Windows may show a publisher warning.</li>
          <li>Sign in, allow Windows location, then select Start tracking.</li>
        </ol>
        {release && <p className="muted"><a href={release.checksums}>View SHA-256 checksums</a></p>}
      </details>
    </section>
  )
}
