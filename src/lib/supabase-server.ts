import { createServerClient } from '@supabase/ssr';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import type { AstroCookies } from 'astro';
import type { Database } from './database.types.ts';
import { getPublicSupabaseConfig } from './supabase.ts';

type RuntimeEnv = Record<string, string | undefined>;
const runtimeEnv = (): RuntimeEnv => process.env;

export function createSupabaseServerClient(input: { cookies: AstroCookies; request: Request; env?: RuntimeEnv }): SupabaseClient<Database> | null {
  const config = getPublicSupabaseConfig(input.env ?? runtimeEnv());
  if (!config) return null;
  return createServerClient<Database>(config.url, config.anonKey, {
    cookies: {
      getAll: () => parseCookieHeader(input.request.headers.get('cookie')),
      setAll: (cookiesToSet) => cookiesToSet.forEach(({ name, value, options }) => input.cookies.set(name, value, options)),
    },
  });
}

/** Server-only administrative client. Keep this module out of browser imports. */
export function createSupabaseServiceRoleClient(env: RuntimeEnv = runtimeEnv()): SupabaseClient<Database> | null {
  const config = getPublicSupabaseConfig(env);
  const serviceRoleKey = env.SUPABASE_SERVICE_ROLE_KEY;
  return config && serviceRoleKey && serviceRoleKey !== 'server-only-placeholder'
    ? createClient<Database>(config.url, serviceRoleKey, { auth: { autoRefreshToken: false, persistSession: false } })
    : null;
}

function parseCookieHeader(header: string | null): { name: string; value: string }[] {
  return (header ?? '').split(';').map((part) => part.trim()).filter(Boolean).map((part) => {
    const separator = part.indexOf('=');
    const rawValue = separator < 0 ? '' : part.slice(separator + 1);
    let value = rawValue;
    try { value = decodeURIComponent(rawValue); } catch { /* Ignore malformed cookie encoding and let Supabase reject it. */ }
    return { name: separator < 0 ? part : part.slice(0, separator), value };
  });
}
