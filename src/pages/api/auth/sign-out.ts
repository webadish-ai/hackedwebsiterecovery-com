import type { APIRoute } from 'astro';
import { createSupabaseServerClient } from '../../../lib/supabase-server.ts';

export const prerender = false;

export const POST: APIRoute = async (context) => {
  const client = createSupabaseServerClient({ request: context.request, cookies: context.cookies });
  if (client) await client.auth.signOut();
  return Response.redirect(new URL('/login?signed_out=1', context.request.url), 303);
};
