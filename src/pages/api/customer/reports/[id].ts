import type { APIRoute } from 'astro';
import { getRequestActor } from '../../../../lib/request-context.ts';
import { getCaseDataService } from '../../../../lib/data-service.ts';

export const prerender = false;
export const GET: APIRoute = async (context) => {
  const actor = await getRequestActor(context);
  const service = getCaseDataService({ client: context.locals?.supabase });
  if (!service) return json({ error: 'Report delivery is not configured.' }, 503);
  if (!actor) return json({ error: 'Sign in with your magic link first.' }, 401);
  try { return json(await service.reportDownload(context.params.id ?? '', actor), 200); }
  catch { return json({ error: 'Report download failed.' }, 403); }
};
function json(data: unknown, status: number) { return new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'private, no-store' } }); }
