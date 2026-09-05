import type { APIRoute } from 'astro';
import { isDevelopmentWorkflowEnabled } from '../../../../lib/auth.ts';
import { developmentWorkflow, WorkflowError } from '../../../../lib/case-workflow.ts';
import { notifications } from '../../../../lib/notifications.ts';
import type { CaseStatus } from '../../../../lib/workflow-types.ts';
import { getRequestActor } from '../../../../lib/request-context.ts';
import { getCaseDataService } from '../../../../lib/data-service.ts';

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
  if (!isDevelopmentWorkflowEnabled()) return json({ error: 'Development workflow is unavailable.' }, 404);
  const actor = await getRequestActor(context);
  if (!actor) return json({ error: 'Staff authentication is required.' }, 401);
  const body = await request.json().catch(() => null) as { action?: unknown; status?: unknown; text?: unknown; customerVisible?: unknown; staffId?: unknown; accessUsableAt?: unknown; } | null;
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

function json(data: unknown, status: number) { return new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } }); }
