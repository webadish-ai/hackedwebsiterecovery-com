export interface PublicSupabaseConfig {
  url: string;
  anonKey: string;
}
/**
 * Configuration boundary for the future Supabase server client. The app keeps
 * using the in-memory adapter when these placeholders are absent, so tests and
 * local development never create or mutate a real Supabase project.
 */
export function getPublicSupabaseConfig(env: Record<string, string | undefined> = {}): PublicSupabaseConfig | null {
  const url = env.PUBLIC_SUPABASE_URL;
  const anonKey = env.PUBLIC_SUPABASE_ANON_KEY;
  if (!url || !anonKey || url.includes('your-project.supabase.co') || anonKey.includes('development-anon-key')) return null;
  try { if (!['http:', 'https:'].includes(new URL(url).protocol)) return null; } catch { return null; }
  return { url, anonKey };
}

/** Backwards-compatible public-only name. It intentionally never reads a service-role key. */
export const getSupabaseConfig = getPublicSupabaseConfig;
