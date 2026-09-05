import type { APIRoute } from 'astro';
import { isDevelopmentWorkflowEnabled } from '../../../../../lib/auth.ts';
import { developmentWorkflow, WorkflowError } from '../../../../../lib/case-workflow.ts';
import { encryptCredentialPayload, safeCredentialError } from '../../../../../lib/credentials.ts';
import { assertCredentialRateLimit, assertTrustedMutationOrigin } from '../../../../../lib/http-security.ts';
import { getRequestActor } from '../../../../../lib/request-context.ts';
import { createSupabaseServerClient } from '../../../../../lib/supabase-server.ts';

export const prerender = false;

export const GET: APIRoute = async (context) => {
  const actor = await getRequestActor(context);
  if (!actor) return json({ error: 'Sign in with your magic link first.' }, 401);
  const caseId = context.params.id ?? '';
  const supabase = context.locals?.supabase ?? createSupabaseServerClient({ request: context.request, cookies: context.cookies });
  try {
    if (supabase && !isDevelopmentWorkflowEnabled()) {
      const result = await supabase.rpc('list_credentials_metadata', { p_case_id: caseId });
      if (result.error) return json({ error: 'Credential status is unavailable.' }, result.error.code === '42501' ? 403 : 404);
      return json({ credentials: result.data ?? [] }, 200);
    }
    if (!isDevelopmentWorkflowEnabled()) return json({ error: 'Credential storage is not configured.' }, 503);
    return json({ credentials: developmentWorkflow.listCredentialMetadata(caseId, actor) }, 200);
  } catch { return json({ error: 'Credential status is unavailable.' }, 403); }
};

export const POST: APIRoute = async (context) => {
  const originError = assertTrustedMutationOrigin(context.request);
  if (originError) return originError;
  const actor = await getRequestActor(context);
  if (!actor) return json({ error: 'Sign in with your magic link first.' }, 401);
  const rateError = assertCredentialRateLimit(context.request, actor);
  if (rateError) return rateError;
  const body = await context.request.json().catch(() => null) as { action?: unknown; payload?: unknown; expiresAt?: unknown } | null;
  if (body?.action !== 'submit' && body?.action !== 'replace') return json({ error: 'A credential submission action is required.' }, 400);
  if (!body.payload || typeof body.payload !== 'object' || Array.isArray(body.payload)) return json({ error: 'Credential data is required.' }, 400);
  const caseId = context.params.id ?? '';
  const expiresAt = typeof body.expiresAt === 'string' ? body.expiresAt : undefined;
  const supabase = context.locals?.supabase ?? createSupabaseServerClient({ request: context.request, cookies: context.cookies });
  try {
    if (supabase && !isDevelopmentWorkflowEnabled()) {
      const envelope = encryptCredentialPayload(body.payload);
      const result = await supabase.rpc('submit_credentials', { p_case_id: caseId, p_algorithm: envelope.algorithm, p_key_version: envelope.keyVersion, p_nonce: envelope.nonce, p_auth_tag: envelope.authTag, p_ciphertext: envelope.ciphertext, p_expires_at: expiresAt ?? null });
      if (result.error) return json({ error: 'Credential submission failed.' }, result.error.code === '42501' ? 403 : 400);
      return json({ credential: safeMetadata(result.data) }, 201);
    }
    if (!isDevelopmentWorkflowEnabled()) return json({ error: 'Credential storage is not configured.' }, 503);
    return json({ credential: developmentWorkflow.submitCredentials(caseId, body.payload as Record<string, string>, actor, expiresAt) }, 201);
  } catch (error) {
    if (error instanceof WorkflowError && error.code === 'not_found') return json({ error: 'Case not found.' }, 404);
    return json({ error: error instanceof Error && /future|invalid|ownership|staff|configured/i.test(error.message) ? error.message : safeCredentialError() }, 403);
  }
};

export const DELETE: APIRoute = async (context) => {
  const originError = assertTrustedMutationOrigin(context.request);
  if (originError) return originError;
  const actor = await getRequestActor(context);
  if (!actor) return json({ error: 'Sign in with your magic link first.' }, 401);
  const rateError = assertCredentialRateLimit(context.request, actor);
  if (rateError) return rateError;
  const caseId = context.params.id ?? '';
  const body = await context.request.json().catch(() => null) as { credentialSetId?: unknown } | null;
  if (typeof body?.credentialSetId !== 'string' || !body.credentialSetId) return json({ error: 'Credential set is required.' }, 400);
  const supabase = context.locals?.supabase ?? createSupabaseServerClient({ request: context.request, cookies: context.cookies });
  try {
    if (supabase && !isDevelopmentWorkflowEnabled()) {
      const result = await supabase.rpc('revoke_credentials', { p_case_id: caseId, p_credential_set_id: body.credentialSetId });
      if (result.error) return json({ error: 'Credential revocation failed.' }, result.error.code === '42501' ? 403 : 404);
      return json({ credential: safeMetadata(result.data) }, 200);
    }
    if (!isDevelopmentWorkflowEnabled()) return json({ error: 'Credential storage is not configured.' }, 503);
    const stored = developmentWorkflow.credentials.get(body.credentialSetId);
    if (!stored || stored.caseId !== caseId) return json({ error: 'Credential set not found.' }, 404);
    return json({ credential: developmentWorkflow.revokeCredentials(body.credentialSetId, actor) }, 200);
  } catch { return json({ error: 'Credential revocation failed.' }, 403); }
};

function safeMetadata(value: unknown) {
  const row = value as Record<string, unknown> | null;
  return row ? { id: row.id, case_id: row.case_id, organization_id: row.organization_id, state: row.state, algorithm: row.algorithm, key_version: row.key_version, created_at: row.created_at, expires_at: row.expires_at, revoked_at: row.revoked_at, expired_at: row.expired_at } : null;
}
function json(data: unknown, status: number) { return new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } }); }
