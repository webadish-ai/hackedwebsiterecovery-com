import { createBrowserClient } from '@supabase/ssr';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from './database.types.ts';
import { getPublicSupabaseConfig, type PublicSupabaseConfig } from './supabase.ts';

type BrowserEnv = Record<string, string | undefined>;

function browserEnv(): BrowserEnv {
  return ((import.meta as ImportMeta & { env?: BrowserEnv }).env ?? {});
}

export function getBrowserSupabaseConfig(env?: BrowserEnv): PublicSupabaseConfig | null {
  return getPublicSupabaseConfig(env ?? browserEnv());
}

export function createSupabaseBrowserClient(env?: BrowserEnv): SupabaseClient<Database> | null {
  const config = getBrowserSupabaseConfig(env);
  return config ? createBrowserClient<Database>(config.url, config.anonKey) : null;
}
