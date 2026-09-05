export interface SupabaseConfig {
  url: string;
  anonKey: string;
  serviceRoleKey?: string;
  reportsBucket: string;
}

/**
 * Configuration boundary for the future Supabase server client. The app keeps
 * using the in-memory adapter when these placeholders are absent, so tests and
 * local development never create or mutate a real Supabase project.
 */
export function getSupabaseConfig(env: Record<string, string | undefined> = {}) : SupabaseConfig | null {
  const url = env.PUBLIC_SUPABASE_URL ?? env.SUPABASE_URL;
  const anonKey = env.PUBLIC_SUPABASE_ANON_KEY ?? env.SUPABASE_ANON_KEY;
  if (!url || !anonKey || url.includes('your-project.supabase.co') || anonKey.includes('development-anon-key')) return null;
  return { url, anonKey, serviceRoleKey: env.SUPABASE_SERVICE_ROLE_KEY, reportsBucket: env.SUPABASE_REPORTS_BUCKET ?? 'case-reports' };
}

