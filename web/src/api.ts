export interface User {
  id: string
  name: string
  email: string
  role: 'owner' | 'manager' | 'worker'
}
export interface Worker extends User {
  working: boolean
  last_seen_at: string | null
}
export interface Block {
  id: string
  user_id: string
  session_id: string
  start_at: string
  end_at: string
  duration_seconds: number
  active_seconds: number
  screenshot_url: string | null
}
export interface Hours {
  user_id: string
  name: string
  date: string
  seconds: number
  hours: number
}
export interface Invite {
  token: string
  url: string
  expires_at: string
}
export class ApiError extends Error {
  status: number
  constructor(message: string, status: number) {
    super(message)
    this.status = status
  }
}
export async function api<T>(
  path: string,
  options: RequestInit = {},
): Promise<T> {
  const response = await fetch(`/api${path}`, {
    ...options,
    signal: options.signal ?? AbortSignal.timeout(20000),
    credentials: 'include',
    headers: {
      ...(options.body ? { 'Content-Type': 'application/json' } : {}),
      ...options.headers,
    },
  })
  if (!response.ok) {
    const body = (await response.json().catch(() => null)) as {
      error?: string
    } | null
    throw new ApiError(
      body?.error || `Request failed (${response.status}). Try again.`,
      response.status,
    )
  }
  return response.json() as Promise<T>
}
export const post = <T>(path: string, body: unknown) =>
  api<T>(path, { method: 'POST', body: JSON.stringify(body) })
