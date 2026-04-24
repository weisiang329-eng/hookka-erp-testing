// Shared SWR primitive. Pages migrate off bespoke `useEffect + fetch`
// patterns onto `useApi(url)` to get dedup, stale-while-revalidate, and
// keepPreviousData (so tables don't flash empty on pagination).
import useSWR from 'swr'

export async function fetcher<T = unknown>(url: string): Promise<T> {
  const res = await fetch(url, { credentials: 'include' })
  if (!res.ok) {
    const body = await res.text().catch(() => '')
    throw new Error(`HTTP ${res.status} ${res.statusText}${body ? `: ${body}` : ''}`)
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
