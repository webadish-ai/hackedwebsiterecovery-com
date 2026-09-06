import { defineMiddleware } from 'astro:middleware';
import { isDevelopmentWorkflowEnabled } from './lib/auth.ts';
import { createSupabaseServerClient } from './lib/supabase-server.ts';
import { protectedPath, staffPath } from './lib/request-context.ts';

export const onRequest = defineMiddleware(async (context, next) => {
  if (isDevelopmentWorkflowEnabled()) return next();
  const client = createSupabaseServerClient({ request: context.request, cookies: context.cookies });
  if (!client) return protectedPath(context.url.pathname) ? Response.redirect(new URL(`/login?next=${encodeURIComponent(context.url.pathname)}`, context.request.url), 303) : next();
  const { data: { user } } = await client.auth.getUser();
  context.locals.supabase = client;
  context.locals.user = user ?? undefined;
  if (protectedPath(context.url.pathname) && !user) return Response.redirect(new URL(`/login?next=${encodeURIComponent(context.url.pathname)}`, context.request.url), 303);
  if (staffPath(context.url.pathname) && user) {
    const [{ data: profile }, { data: assurance }] = await Promise.all([
      client.from('profiles').select('role,mfa_enrolled_at').eq('id', user.id).maybeSingle() as unknown as Promise<{ data: { role: 'customer' | 'staff' | 'admin'; mfa_enrolled_at: string | null } | null }>,
      client.auth.mfa.getAuthenticatorAssuranceLevel(),
    ]);
    if (!profile || !['staff', 'admin'].includes(profile.role) || !profile.mfa_enrolled_at || assurance?.currentLevel !== 'aal2') return new Response('Staff MFA is required for this route.', { status: 403 });
  }
  return next();
});
