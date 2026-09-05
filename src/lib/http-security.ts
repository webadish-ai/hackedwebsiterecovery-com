import type { Actor } from './workflow-types.ts';
import { getTrustedSiteUrl } from './supabase.ts';

type RuntimeEnv = Record<string, string | undefined>;

export function trustedOriginForRequest(env: RuntimeEnv = process.env): string | null {
  try { return getTrustedSiteUrl(env); } catch { return null; }
}

export function assertTrustedMutationOrigin(request: Request, env: RuntimeEnv = process.env): Response | null {
  const expected = trustedOriginForRequest(env);
  const origin = request.headers.get('origin');
  if (!expected || !origin || origin !== expected) return json({ error: 'This request could not be verified.' }, expected ? 403 : 503);
  return null;
}

class FixedWindowLimiter {
  private readonly windows = new Map<string, number[]>();
  allow(key: string, limit = 5, windowMs = 60_000, now = Date.now()): boolean {
    const recent = (this.windows.get(key) ?? []).filter((time) => now - time < windowMs);
    if (recent.length >= limit) { this.windows.set(key, recent); return false; }
    recent.push(now); this.windows.set(key, recent); return true;
  }
  clear() { this.windows.clear(); }
}

export const credentialRateLimiter = new FixedWindowLimiter();

export function assertCredentialRateLimit(request: Request, actor: Actor): Response | null {
  const ip = request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() || 'unknown';
  if (!credentialRateLimiter.allow(`${actor.userId}:${ip}`)) return json({ error: 'Too many credential requests. Try again later.' }, 429);
  return null;
}

function json(data: unknown, status: number) { return new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } }); }
