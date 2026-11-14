import { createClient } from '@supabase/supabase-js'

const url = import.meta.env.VITE_SUPABASE_URL?.trim()
const publishableKey = import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY?.trim()

// Only a public publishable key belongs in VITE_ variables. Never use a secret key.
const configured = Boolean(url && publishableKey?.startsWith('sb_publishable_'))
export const supabase = configured ? createClient(url!, publishableKey!) : null

export type ConnectionStatus = 'checking' | 'connected' | 'unavailable' | 'unconfigured'

/** Read-only API check. Does not create users, read rows, or change the schema. */
export async function checkSupabaseConnection(): Promise<ConnectionStatus> {
  if (!supabase) return 'unconfigured'
  try {
    const response = await fetch(`${url}/auth/v1/settings`, {
      headers: { apikey: publishableKey! },
      signal: AbortSignal.timeout(8000),
      cache: 'no-store',
    })
    return response.ok ? 'connected' : 'unavailable'
  } catch {
    return 'unavailable'
  }
}
