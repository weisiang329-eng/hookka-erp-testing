// Shared SWR primitive. Pages migrate off bespoke `useEffect + fetch`
// patterns onto `useApi(url)` to get dedup, stale-while-revalidate, and
// keepPreviousData (so tables don't flash empty on pagination).
import useSWR from 'swr'
import { humanizeError } from './humanize-error'

export async function fetcher<T = unknown>(url: string): Promise<T> {
  const res = await fetch(url, { credentials: 'include' })
  if (!res.ok) {
    // Operators must never see "HTTP 500 ...". Lift a clean backend message if
    // there is one; humanizeError replaces anything technical with a plain
    // line. The status is kept on the thrown error for callers that inspect it.
    const body = await res.text().catch(() => '')
    let backendMsg: string | undefined
    try { backendMsg = (JSON.parse(body) as { error?: string })?.error } catch { /* not JSON */ }
    const err = new Error(humanizeError({ status: res.status, message: backendMsg })) as Error & { status?: number }
    err.status = res.status
    throw err
  }
  return res.json() as Promise<T>
}

export function useApi<T = unknown>(url: string | null) {
  const { data, error, isLoading, mutate } = useSWR<T>(url, fetcher, {
    keepPreviousData: true,
    revalidateOnFocus: false,
    dedupingInterval: 2000,
  })
  return { data, error, isLoading, mutate }
}
