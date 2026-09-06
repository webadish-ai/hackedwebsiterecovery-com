import type { APIContext } from 'astro';
import type { Actor } from './workflow-types.ts';
import { actorFromHeaders, isDevelopmentWorkflowEnabled } from './auth.ts';
import { createSupabaseServerClient } from './supabase-server.ts';

export async function getRequestActor(context: Pick<APIContext, 'request' | 'cookies' | 'locals'>): Promise<Actor | null> {
  if (isDevelopmentWorkflowEnabled()) return actorFromHeaders(context.request);
  const client = context.locals.supabase ?? createSupabaseServerClient({ request: context.request, cookies: context.cookies });
  if (!client) return null;
  const { data: { user } } = await client.auth.getUser();
  if (!user) return null;
  const [{ data: profile }, { data: memberships }, { data: assurance }] = await Promise.all([
    client.from('profiles').select('role,mfa_enrolled_at').eq('id', user.id).maybeSingle() as unknown as Promise<{ data: { role: 'customer' | 'staff' | 'admin'; mfa_enrolled_at: string | null } | null }>,
    client.from('organization_members').select('organization_id').eq('user_id', user.id) as unknown as Promise<{ data: { organization_id: string }[] | null }>,
    client.auth.mfa.getAuthenticatorAssuranceLevel(),
  ]);
  const role = profile?.role ?? 'customer';
  return { userId: user.id, role, organizationIds: (memberships ?? []).map((item) => item.organization_id), mfaVerifiedAt: role === 'staff' || role === 'admin' ? (profile?.mfa_enrolled_at && assurance?.currentLevel === 'aal2' ? new Date().toISOString() : undefined) : undefined };
}

export function protectedPath(pathname: string): boolean {
  return pathname === '/portal' || pathname.startsWith('/portal/') || pathname === '/staff' || pathname.startsWith('/staff/') || pathname.startsWith('/cases/');
}

export function staffPath(pathname: string): boolean { return pathname === '/staff' || pathname.startsWith('/staff/'); }
