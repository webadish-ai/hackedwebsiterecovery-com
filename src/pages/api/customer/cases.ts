import type { APIRoute } from 'astro';
import { getRequestActor } from '../../../lib/request-context.ts';
import { getCaseDataService } from '../../../lib/data-service.ts';

export const prerender = false;

export const GET: APIRoute = async (context) => {
  const { request } = context;
  const actor = await getRequestActor(context);
  const service = getCaseDataService({ client: context.locals?.supabase });
  if (!service) return json({ error: 'Customer portal is not configured.' }, 503);
  if (!actor) return json({ error: 'Sign in with your magic link first.' }, 401);
  const caseId = new URL(request.url).searchParams.get('caseId');
  try {
    if (caseId) {
      const record = (await service.listCustomerCases(actor)).find((item) => item.id === caseId);
      if (!record) return json({ error: 'Case not found.' }, 404);
      return json({ case: record, timeline: await service.customerTimeline(caseId, actor), attachments: await service.listAttachments(caseId, actor) }, 200);
    }
    return json({ cases: await service.listCustomerCases(actor) }, 200);
  } catch { return json({ error: 'Unable to access this case.' }, 403); }
};

function json(data: unknown, status: number) { return new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } }); }
