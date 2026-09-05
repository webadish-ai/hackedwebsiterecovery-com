import type { APIRoute } from 'astro';
import { getMockOrder, updateMockOrder } from '@/lib/mock-orders';

export const prerender = false;

export const POST: APIRoute = async ({ request }) => {
  const body = await request.json().catch(() => null) as { orderId?: unknown; ready?: unknown } | null;
  const orderId = typeof body?.orderId === 'string' ? body.orderId : '';
  const order = getMockOrder(orderId);
  if (!order || !['paid', 'onboarding_started', 'onboarding_complete'].includes(order.status)) {
    return json({ error: 'Confirm the payment before starting onboarding.' }, 400);
  }
  if (body?.ready !== true) return json({ error: 'Please confirm that you can provide access through the secure portal in the next step.' }, 400);
  const updated = updateMockOrder(orderId, 'onboarding_complete');
  return json({ ok: true, mode: 'mock', status: updated?.status }, 200);
};

function json(data: unknown, status: number) {
  return new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } });
}
