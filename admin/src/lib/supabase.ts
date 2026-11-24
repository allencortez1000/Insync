import { createClient } from '@supabase/supabase-js';

const url = import.meta.env.VITE_SUPABASE_URL as string | undefined;
const key = import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined;

export const supabaseConfigured = Boolean(url && key);

export const supabase = createClient(url ?? 'http://localhost:54321', key ?? 'missing-key', {
  auth: { persistSession: true, autoRefreshToken: true },
});

type Result<T> = { data: T | null; error: { message: string; details?: string | null; hint?: string | null } | null };

/**
 * Unwraps a Supabase query/RPC result, throwing a readable Error on failure.
 * The client is untyped, so the caller states the row shape (T). This also avoids
 * supabase-js inferring many-to-one embeds such as `sites(name)` as arrays.
 */
export async function q<T>(p: PromiseLike<Result<unknown>>): Promise<T> {
  const { data, error } = await p;
  if (error) throw new Error(error.message || error.details || 'Request failed');
  return data as T;
}

export function rpc<T = unknown>(fn: string, args?: Record<string, unknown>): Promise<T> {
  return q<T>(supabase.rpc(fn, args ?? {}));
}
