import type { APIRoute } from 'astro';
import { actorFromHeaders } from '../../../lib/auth.ts';
import { developmentWorkflow, WorkflowError } from '../../../lib/case-workflow.ts';

export const prerender = false;

export const GET: APIRoute = async ({ request }) => {
  const actor = actorFromHeaders(request);
  if (!actor) return json({ error: 'Staff authentication is required.' }, 401);
  try { return json({ cases: developmentWorkflow.listQueue(actor) }, 200); }
  catch (error) { return json({ error: error instanceof WorkflowError ? error.message : 'Staff access denied.', code: error instanceof WorkflowError ? error.code : 'forbidden' }, error instanceof WorkflowError && error.code === 'mfa_required' ? 403 : 403); }
};

function json(data: unknown, status: number) { return new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } }); }
