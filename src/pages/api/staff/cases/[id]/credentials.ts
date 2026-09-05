import type { APIRoute } from 'astro';
import { isDevelopmentWorkflowEnabled, requireStaffMfa } from '../../../../../lib/auth.ts';
import { developmentWorkflow, WorkflowError } from '../../../../../lib/case-workflow.ts';
import { decryptCredentialEnvelope, safeCredentialError, type CredentialEnvelope } from '../../../../../lib/credentials.ts';
import { assertCredentialRateLimit, assertTrustedMutationOrigin } from '../../../../../lib/http-security.ts';
import { getRequestActor } from '../../../../../lib/request-context.ts';
import { createSupabaseServerClient } from '../../../../../lib/supabase-server.ts';

export const prerender = false;

export const POST: APIRoute = async (context) => {
  const originError = assertTrustedMutationOrigin(context.request);
  if (originError) return originError;
  const actor = await getRequestActor(context);
  if (!actor) return json({ error: 'Staff authentication is required.' }, 401);
  try { requireStaffMfa(actor); } catch { return json({ error: 'Recent staff MFA verification is required.' }, 403); }
  const rateError = assertCredentialRateLimit(context.request, actor);
  if (rateError) return rateError;
  const body = await context.request.json().catch(() => null) as { action?: unknown; credentialSetId?: unknown } | null;
  if (body?.action !== 'reveal' || typeof body.credentialSetId !== 'string' || !body.credentialSetId) return json({ error: 'A credential reveal request is required.' }, 400);
  const supabase = context.locals?.supabase ?? createSupabaseServerClient({ request: context.request, cookies: context.cookies });
  try {
    if (supabase && !isDevelopmentWorkflowEnabled()) {
      const result = await supabase.rpc('reveal_credentials', { p_case_id: context.params.id ?? '', p_credential_set_id: body.credentialSetId });
      if (result.error || !result.data || typeof result.data !== 'object' || Array.isArray(result.data)) return json({ error: 'Credential reveal failed.' }, result.error?.code === '42501' ? 403 : 400);
      const payload = decryptCredentialEnvelope(result.data as unknown as CredentialEnvelope);
      return json({ credentials: payload }, 200);
    }
    if (!isDevelopmentWorkflowEnabled()) return json({ error: 'Credential storage is not configured.' }, 503);
    const stored = developmentWorkflow.credentials.get(body.credentialSetId);
    if (!stored || stored.caseId !== (context.params.id ?? '')) return json({ error: 'Credential set not found.' }, 404);
    return json({ credentials: developmentWorkflow.revealCredentials(body.credentialSetId, actor) }, 200);
  } catch (error) {
    if (error instanceof WorkflowError && error.code === 'not_found') return json({ error: 'Credential set not found.' }, 404);
    return json({ error: error instanceof Error && /MFA|assigned|unavailable/i.test(error.message) ? error.message : safeCredentialError() }, 403);
  }
};

function json(data: unknown, status: number) { return new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } }); }
