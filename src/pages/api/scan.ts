import type { APIRoute } from 'astro';
import { runScan, normaliseTarget } from '@/lib/scanner';

export const prerender = false;

export const POST: APIRoute = async ({ request }) => {
  const body = await request.json().catch(() => null);
  const raw = body?.url;

  if (!raw || typeof raw !== 'string') {
    return json({ error: 'Please enter a website address to scan.' }, 400);
  }

  // Validate / SSRF-guard before doing any work.
  try {
    normaliseTarget(raw);
  } catch (e: any) {
    return json({ error: e?.message || 'Invalid website address.' }, 400);
  }

  try {
    const result = await runScan(raw, {
      safeBrowsingKey: import.meta.env.SAFE_BROWSING_API_KEY,
    });
    return json(result, 200);
  } catch (e: any) {
    console.error('Scan error:', e);
    return json({ error: 'The scan failed unexpectedly. Please try again.' }, 500);
  }
};

function json(data: unknown, status: number) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}
