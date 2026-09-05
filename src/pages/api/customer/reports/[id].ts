import type { APIRoute } from 'astro';
import { actorFromHeaders } from '../../../../lib/auth.ts';
import { developmentWorkflow, WorkflowError } from '../../../../lib/case-workflow.ts';

export const prerender = false;
export const GET: APIRoute = async ({ request, params }) => {
  const actor = actorFromHeaders(request);
  if (!actor) return json({ error: 'Sign in with your magic link first.' }, 401);
  try { return json(developmentWorkflow.createReportDownload(params.id ?? '', actor), 200); }
  catch (error) { const e = error instanceof WorkflowError ? error : new WorkflowError('forbidden', 'Report download failed.'); return json({ error: e.message, code: e.code }, e.code === 'not_found' ? 404 : 403); }
};
function json(data: unknown, status: number) { return new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'private, no-store' } }); }
