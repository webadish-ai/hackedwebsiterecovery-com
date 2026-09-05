import assert from 'node:assert/strict';
import test from 'node:test';
import { POST } from '../src/pages/api/checkout.ts';
import { getMockOrder } from '../src/lib/mock-orders.ts';

const validCheckout = {
  planId: 'recovery',
  quantity: 1,
  subtotalPaise: 799900,
  email: 'demo@example.com',
  phone: '+919999999999',
  billingName: 'Demo Owner',
  company: 'Demo Company',
  gstin: '27ABCDE1234F1Z5',
  website: 'https://example.com',
  symptoms: 'Redirecting visitors',
  termsAccepted: true,
  scopeAccepted: true,
};

async function post(body: Record<string, unknown>) {
  return POST({ request: new Request('http://localhost/api/checkout', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }) } as Parameters<typeof POST>[0]);
}

test('checkout creates a paid-path mock order without retaining submitted PII', async () => {
  const response = await post(validCheckout);
  assert.equal(response.status, 201);
  const result = await response.json();
  assert.equal(result.ok, true);
  assert.equal(result.order.totalPaise, 943882);
  const stored = getMockOrder(result.order.id);
  assert.ok(stored);
  assert.equal('email' in stored, false);
  assert.equal('website' in stored, false);
  assert.equal('phone' in stored, false);
  assert.equal('billingName' in stored, false);
  assert.equal('gstin' in stored, false);
  assert.equal('symptoms' in stored, false);
});

test('checkout rejects a client subtotal that does not match server pricing', async () => {
  const response = await post({ ...validCheckout, subtotalPaise: 1 });
  assert.equal(response.status, 409);
  assert.match(await response.text(), /order total changed/i);
});

test('checkout rejects an invalid website URL', async () => {
  const response = await post({ ...validCheckout, website: 'javascript:alert(1)' });
  assert.equal(response.status, 400);
  assert.match(await response.text(), /valid website url/i);
});

test('checkout rejects missing policy acceptance', async () => {
  const response = await post({ ...validCheckout, termsAccepted: false });
  assert.equal(response.status, 400);
  assert.match(await response.text(), /policies and service scope/i);
});

test('mock orders expire and evict oldest records at capacity', async () => {
  const { createMockOrder, MOCK_ORDER_CAPACITY, MOCK_ORDER_TTL_MS } = await import('../src/lib/mock-orders.ts');
  const plan = (await import('../src/lib/plans.ts')).getPlan('recovery')!;
  const expired = createMockOrder({ plan, quantity: 1 }, new Date(Date.now() - MOCK_ORDER_TTL_MS - 1));
  assert.equal(getMockOrder(expired.id), undefined);
  const ids = Array.from({ length: MOCK_ORDER_CAPACITY + 1 }, () => createMockOrder({ plan, quantity: 1 }).id);
  assert.equal(getMockOrder(ids[0]), undefined);
  assert.ok(getMockOrder(ids.at(-1)));
});
