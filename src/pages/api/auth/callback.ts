import type { APIRoute } from 'astro';
import { createSupabaseServerClient } from '../../../lib/supabase-server.ts';

export const prerender = false;

export const GET: APIRoute = async (context) => {
  const code = new URL(context.request.url).searchParams.get('code');
  const client = createSupabaseServerClient({ request: context.request, cookies: context.cookies });
  if (!client || !code) return Response.redirect(new URL('/login?error=invalid_link', context.request.url), 303);
  const { error } = await client.auth.exchangeCodeForSession(code);
  return error ? Response.redirect(new URL('/login?error=expired_link', context.request.url), 303) : Response.redirect(new URL('/portal/', context.request.url), 303);
};
