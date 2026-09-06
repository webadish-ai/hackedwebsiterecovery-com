import type { APIRoute } from 'astro';
import { consumeMagicLink, createDevelopmentSession, isDevelopmentWorkflowEnabled, requestMagicLink } from '../../../lib/auth.ts';
import { createSupabaseServerClient } from '../../../lib/supabase-server.ts';
import { getTrustedSiteUrl } from '../../../lib/supabase.ts';

export const prerender = false;

export const POST: APIRoute = async (context) => {
  const { request } = context;
  const body = await request.json().catch(() => null) as { email?: unknown; requestId?: unknown; token?: unknown } | null;
  const email = typeof body?.email === 'string' ? body.email.trim() : '';
  if (email && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return json({ error: 'A valid email address is required.' }, 400);
  const supabase = createSupabaseServerClient({ request, cookies: context.cookies });
  if (supabase) {
    if (!email) return json({ error: 'A valid email address is required.' }, 400);
    const redirectTo = getMagicLinkRedirectUrl();
    if (!redirectTo) return json({ error: 'Authentication is not configured.' }, 503);
    const { error } = await supabase.auth.signInWithOtp({ email, options: { emailRedirectTo: redirectTo } });
    return error ? json({ error: 'Unable to send a sign-in link. Please try again.' }, 502) : json({ ok: true, mode: 'supabase', message: 'Check your email for a secure sign-in link.' }, 200);
  }
  if (!isDevelopmentWorkflowEnabled()) return json({ error: 'Authentication is not configured.' }, 503);
  if (email) {
    try {
      const result = requestMagicLink(email);
      return json({ ok: true, mode: 'development', requestId: result.request.id, developmentToken: result.developmentToken, expiresAt: result.request.expiresAt }, 201);
    } catch (error) { return json({ error: error instanceof Error ? error.message : 'Unable to send magic link.' }, 400); }
  }
  if (typeof body?.requestId === 'string' && typeof body?.token === 'string') {
    const actor = consumeMagicLink(body.requestId, body.token);
    if (!actor) return json({ error: 'This magic link is invalid or expired.' }, 401);
    const response = json({ ok: true, actor }, 200);
    response.headers.set('Set-Cookie', `dev_session=${createDevelopmentSession(actor)}; HttpOnly; Secure; SameSite=Lax; Path=/`);
    return response;
  }
  return json({ error: 'Email or magic-link verification fields are required.' }, 400);
};

function json(data: unknown, status: number) { return new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } }); }

export function getMagicLinkRedirectUrl(env: Record<string, string | undefined> = process.env): string | null {
  const siteUrl = getTrustedSiteUrl(env);
  return siteUrl ? new URL('/api/auth/callback', siteUrl).toString() : null;
}
