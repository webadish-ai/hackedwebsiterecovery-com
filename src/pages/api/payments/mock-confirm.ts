import type { APIRoute } from 'astro';
import { confirmMockPayment } from '@/lib/mock-orders';

export const prerender = false;

export const POST: APIRoute = async ({ request }) => {
  const body = await request.json().catch(() => null) as { orderId?: unknown } | null;
  const orderId = typeof body?.orderId === 'string' ? body.orderId : '';
  const order = confirmMockPayment(orderId);
  if (!order) return json({ error: 'This simulated order is unavailable or has expired.' }, 404);
  return json({ ok: true, mode: 'mock', order: { ...order, email: undefined, website: undefined } }, 200);
};

function json(data: unknown, status: number) {
  return new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } });
}
