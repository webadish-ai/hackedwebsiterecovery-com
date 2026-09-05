import type { APIRoute } from 'astro';
import { createMockOrder } from '@/lib/mock-orders';
import { calculatePrice, getPlan, isValidWebsite } from '@/lib/plans';

export const prerender = false;

export const POST: APIRoute = async ({ request }) => {
  const body = await request.json().catch(() => null) as Record<string, unknown> | null;
  const plan = getPlan(typeof body?.planId === 'string' ? body.planId : '');
  const email = typeof body?.email === 'string' ? body.email.trim() : '';
  const phone = typeof body?.phone === 'string' ? body.phone.trim() : '';
  const billingName = typeof body?.billingName === 'string' ? body.billingName.trim() : '';
  const website = typeof body?.website === 'string' ? body.website.trim() : '';
  const quantity = typeof body?.quantity === 'number' ? body.quantity : Number(body?.quantity || 1);

  if (!plan) return json({ error: 'Please select a valid recovery plan.' }, 400);
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return json({ error: 'Please enter a valid email address.' }, 400);
  if (!/^[+\d][\d\s().-]{7,}$/.test(phone)) return json({ error: 'Please enter a valid phone number.' }, 400);
  if (billingName.length < 2) return json({ error: 'Please enter the billing name.' }, 400);
  if (!isValidWebsite(website)) return json({ error: 'Please enter a valid website URL, including https://.' }, 400);
  if (body?.termsAccepted !== true || body?.scopeAccepted !== true) return json({ error: 'Please accept the policies and service scope.' }, 400);

  const totals = calculatePrice(plan, quantity);
  if (body?.subtotalPaise !== undefined && Number(body.subtotalPaise) !== totals.subtotalPaise) {
    return json({ error: 'The order total changed. Please refresh and try again.' }, 409);
  }

  const order = createMockOrder({ plan, quantity: totals.quantity, email, website });
  return json({
    ok: true,
    mode: 'mock',
    message: 'Mock checkout created. No live payment provider was contacted.',
    order: {
      id: order.id,
      transactionId: order.transactionId,
      planId: order.planId,
      planVersion: order.planVersion,
      quantity: order.quantity,
      subtotalPaise: order.subtotalPaise,
      gstPaise: order.gstPaise,
      totalPaise: order.totalPaise,
    },
  }, 201);
};

function json(data: unknown, status: number) {
  return new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } });
}
