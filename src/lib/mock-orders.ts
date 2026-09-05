import type { Plan } from './plans.ts';
import { calculatePrice, PLAN_VERSION } from './plans.ts';

export type MockOrderStatus = 'pending_payment' | 'paid' | 'onboarding_started' | 'onboarding_complete';

export interface MockOrder {
  id: string;
  transactionId: string;
  planId: Plan['id'];
  planVersion: string;
  quantity: number;
  subtotalPaise: number;
  gstPaise: number;
  totalPaise: number;
  status: MockOrderStatus;
  createdAt: string;
}

export const MOCK_ORDER_TTL_MS = 15 * 60 * 1000;
export const MOCK_ORDER_CAPACITY = 100;
const orders = new Map<string, MockOrder>();

export function createMockOrder(input: { plan: Plan; quantity: number }, now = new Date()): MockOrder {
  pruneMockOrders(now.getTime());
  const totals = calculatePrice(input.plan, input.quantity);
  const id = `mock_${crypto.randomUUID()}`;
  const order: MockOrder = {
    id,
    transactionId: `MOCK-${crypto.randomUUID().replaceAll('-', '').slice(0, 18).toUpperCase()}`,
    planId: input.plan.id,
    planVersion: PLAN_VERSION,
    quantity: totals.quantity,
    subtotalPaise: totals.subtotalPaise,
    gstPaise: totals.gstPaise,
    totalPaise: totals.totalPaise,
    status: 'pending_payment',
    createdAt: now.toISOString(),
  };
  while (orders.size >= MOCK_ORDER_CAPACITY) {
    const oldest = [...orders.entries()].sort(([, a], [, b]) => Date.parse(a.createdAt) - Date.parse(b.createdAt))[0]?.[0];
    if (!oldest) break;
    orders.delete(oldest);
  }
  orders.set(id, order);
  return order;
}

export function getMockOrder(id: string | null | undefined): MockOrder | undefined {
  pruneMockOrders();
  return id ? orders.get(id) : undefined;
}

export function confirmMockPayment(id: string): MockOrder | undefined {
  const order = getMockOrder(id);
  if (!order) return undefined;
  if (order.status === 'pending_payment') order.status = 'paid';
  return order;
}

export function updateMockOrder(id: string, status: MockOrderStatus): MockOrder | undefined {
  const order = getMockOrder(id);
  if (!order) return undefined;
  order.status = status;
  return order;
}

export function pruneMockOrders(now = Date.now()): void {
  for (const [id, order] of orders) {
    if (now - Date.parse(order.createdAt) >= MOCK_ORDER_TTL_MS) orders.delete(id);
  }
}
