import type { APIRoute } from 'astro';
import { actorFromHeaders } from '../../../lib/auth.ts';
import { developmentWorkflow, WorkflowError } from '../../../lib/case-workflow.ts';

export const prerender = false;

export const GET: APIRoute = async ({ request }) => {
  const actor = actorFromHeaders(request);
  if (!actor) return json({ error: 'Sign in with your magic link first.' }, 401);
  const caseId = new URL(request.url).searchParams.get('caseId');
  try {
    if (caseId) {
      const record = developmentWorkflow.getCase(caseId, actor);
      return json({ case: record, timeline: developmentWorkflow.customerTimeline(caseId, actor), attachments: developmentWorkflow.listAttachments(caseId, actor) }, 200);
    }
    const cases = [...developmentWorkflow.cases.values()].filter((item) => actor.organizationIds.includes(item.organizationId));
    return json({ cases }, 200);
  } catch (error) { return workflowError(error); }
};

function workflowError(error: unknown) { const e = error instanceof WorkflowError ? error : new WorkflowError('forbidden', 'Unable to access this case.'); return json({ error: e.message, code: e.code }, e.code === 'not_found' ? 404 : 403); }
function json(data: unknown, status: number) { return new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } }); }
