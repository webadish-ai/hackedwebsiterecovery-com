import type { APIRoute } from 'astro';
import { getRequestActor } from '../../../lib/request-context.ts';
import { getCaseDataService } from '../../../lib/data-service.ts';

export const prerender = false;

export const GET: APIRoute = async (context) => {
  const actor = await getRequestActor(context);
  const service = getCaseDataService({ client: context.locals?.supabase });
  if (!service) return json({ error: 'Staff queue is not configured.' }, 503);
  if (!actor) return json({ error: 'Staff authentication is required.' }, 401);
  try { return json({ cases: (await service.listCustomerCases(actor)).filter((item) => ['awaiting_access', 'triage', 'awaiting_approval', 'in_progress', 'verification'].includes(item.status)) }, 200); }
  catch { return json({ error: 'Staff access denied.', code: 'forbidden' }, 403); }
};

function json(data: unknown, status: number) { return new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } }); }
