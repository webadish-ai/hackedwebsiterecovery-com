import type { APIRoute } from 'astro';
import { consumeMagicLink, createDevelopmentSession, requestMagicLink } from '../../../lib/auth.ts';

export const prerender = false;

export const POST: APIRoute = async ({ request }) => {
  const body = await request.json().catch(() => null) as { email?: unknown; requestId?: unknown; token?: unknown } | null;
  if (typeof body?.email === 'string') {
    try {
      const result = requestMagicLink(body.email);
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
