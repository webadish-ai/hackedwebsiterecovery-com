import type { APIRoute } from 'astro';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '../../../../lib/database.types.ts';
import { isDevelopmentWorkflowEnabled } from '../../../../lib/auth.ts';
import { developmentWorkflow, WorkflowError } from '../../../../lib/case-workflow.ts';
import { notifications } from '../../../../lib/notifications.ts';
import type { CaseStatus } from '../../../../lib/workflow-types.ts';
import { getRequestActor } from '../../../../lib/request-context.ts';
import { getCaseDataService } from '../../../../lib/data-service.ts';
import { createSupabaseServerClient } from '../../../../lib/supabase-server.ts';

export const prerender = false;

export const GET: APIRoute = async (context) => {
  const { params } = context;
  const actor = await getRequestActor(context);
  const service = getCaseDataService({ client: context.locals.supabase });
  if (!service) return json({ error: 'Staff case views are not configured.' }, 503);
  if (!actor) return json({ error: 'Staff authentication is required.' }, 401);
  try {
    const record = (await service.listCustomerCases(actor)).find((item) => item.id === (params.id ?? ''));
    if (!record) return json({ error: 'Case not found.' }, 404);
    return json({ case: record, timeline: await service.internalTimeline(record.id, actor), attachments: await service.listAttachments(record.id, actor) }, 200);
  } catch { return json({ error: 'Case access failed.', code: 'forbidden' }, 403); }
};

export const POST: APIRoute = async (context) => {
  const { request, params } = context;
  const body = await request.json().catch(() => null) as { action?: unknown; status?: unknown; text?: unknown; customerVisible?: unknown; staffId?: unknown; accessUsableAt?: unknown; } | null;
  const supabase = context.locals?.supabase ?? createSupabaseServerClient({ request, cookies: context.cookies });
  if (supabase) {
    const actor = await getRequestActor(context);
    if (!actor) return json({ error: 'Staff authentication is required.' }, 401);
    return dispatchSupabaseAction(supabase, params.id ?? '', actor, body);
  }
  if (!isDevelopmentWorkflowEnabled()) return json({ error: 'Development workflow is unavailable.' }, 404);
  const actor = await getRequestActor(context);
  if (!actor) return json({ error: 'Staff authentication is required.' }, 401);
  try {
    const id = params.id ?? '';
    switch (body?.action) {
      case 'transition': {
        const updated = developmentWorkflow.transitionCase(id, body.status as CaseStatus, actor, typeof body.text === 'string' ? body.text : '');
        const order = developmentWorkflow.orders.get(updated.orderId);
        if (order) await notifications.send({ kind: 'case_update', recipientUserId: order.customerUserId, caseId: updated.id, templateData: { status: updated.status } });
        return json({ case: updated }, 200);
      }
      case 'assign': return json({ case: developmentWorkflow.assignCase(id, typeof body.staffId === 'string' ? body.staffId : actor.userId, actor) }, 200);
      case 'access_usable': return json({ case: developmentWorkflow.setAccessUsable(id, typeof body.accessUsableAt === 'string' ? body.accessUsableAt : new Date(), actor) }, 200);
      case 'update': {
        const event = developmentWorkflow.addUpdate(id, typeof body.text === 'string' ? body.text : '', body.customerVisible === true, actor);
        if (event.customerVisible) { const caseRecord = developmentWorkflow.cases.get(event.caseId); const order = caseRecord ? developmentWorkflow.orders.get(caseRecord.orderId) : undefined; if (order) await notifications.send({ kind: 'case_update', recipientUserId: order.customerUserId, caseId: event.caseId, templateData: { status: 'update' } }); }
        return json({ event }, 201);
      }
      default: return json({ error: 'Unknown case action.' }, 400);
    }
  } catch (error) { const e = error instanceof WorkflowError ? error : new WorkflowError('forbidden', 'Case action failed.'); return json({ error: e.message, code: e.code }, e.code === 'not_found' ? 404 : 403); }
};

async function dispatchSupabaseAction(client: SupabaseClient<Database>, caseId: string, actor: { userId: string }, body: { action?: unknown; status?: unknown; text?: unknown; customerVisible?: unknown; staffId?: unknown; accessUsableAt?: unknown; } | null) {
  switch (body?.action) {
    case 'transition': {
      const validStatuses: CaseStatus[] = ['awaiting_payment', 'awaiting_access', 'triage', 'awaiting_approval', 'in_progress', 'verification', 'monitoring', 'completed', 'quoted_separately', 'refunded', 'cancelled'];
      if (typeof body.status !== 'string' || !validStatuses.includes(body.status as CaseStatus)) return json({ error: 'A valid case status is required.' }, 400);
      const result = await client.rpc('staff_transition_case', { p_case_id: caseId, p_to_status: body.status as CaseStatus, p_body: typeof body.text === 'string' ? body.text : '' });
      return rpcResponse(result, 'case');
    }
    case 'assign': {
      const staffId = typeof body.staffId === 'string' && body.staffId.trim() ? body.staffId.trim() : actor.userId;
      const result = await client.rpc('staff_assign_case', { p_case_id: caseId, p_staff_id: staffId });
      return rpcResponse(result, 'case');
    }
    case 'access_usable': {
      const accessUsableAt = typeof body.accessUsableAt === 'string' ? body.accessUsableAt : new Date().toISOString();
      const result = await client.rpc('staff_mark_access_usable', { p_case_id: caseId, p_access_usable_at: accessUsableAt });
      return rpcResponse(result, 'case');
    }
    case 'update': {
      if (typeof body.text !== 'string' || typeof body.customerVisible !== 'boolean') return json({ error: 'Update text and visibility are required.' }, 400);
      const result = await client.rpc('staff_add_case_update', { p_case_id: caseId, p_body: body.text, p_customer_visible: body.customerVisible });
      return rpcResponse(result, 'event', 201);
    }
    default: return json({ error: 'Unknown case action.' }, 400);
  }
}

function rpcResponse(result: { data: unknown; error: { code?: string } | null }, key: 'case' | 'event', successStatus = 200) {
  if (!result.error) return json({ [key]: result.data }, successStatus);
  const status = result.error.code === 'P0002' ? 404 : result.error.code === '42501' ? 403 : 400;
  return json({ error: 'Case action failed.', code: status === 403 ? 'forbidden' : 'invalid_request' }, status);
}

function json(data: unknown, status: number) { return new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } }); }
