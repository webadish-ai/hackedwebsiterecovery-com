import type { Plan } from './plans';
import { calculatePrice, PLAN_VERSION } from './plans';

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
  email: string;
  website: string;
  status: MockOrderStatus;
  createdAt: string;
}

const orders = new Map<string, MockOrder>();

export function createMockOrder(input: { plan: Plan; quantity: number; email: string; website: string }): MockOrder {
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
    email: input.email,
    website: input.website,
    status: 'pending_payment',
    createdAt: new Date().toISOString(),
  };
  orders.set(id, order);
  return order;
}

export function getMockOrder(id: string | null | undefined): MockOrder | undefined {
  return id ? orders.get(id) : undefined;
}

export function confirmMockPayment(id: string): MockOrder | undefined {
  const order = orders.get(id);
  if (!order) return undefined;
  if (order.status === 'pending_payment') order.status = 'paid';
  return order;
}

export function updateMockOrder(id: string, status: MockOrderStatus): MockOrder | undefined {
  const order = orders.get(id);
  if (!order) return undefined;
  order.status = status;
  return order;
}
