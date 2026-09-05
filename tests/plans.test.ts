import assert from 'node:assert/strict';
import test from 'node:test';
import { calculatePrice, getPlan, isValidWebsite } from '../src/lib/plans.ts';

test('all launch plans have exact GST-inclusive totals', () => {
  const recovery = calculatePrice(getPlan('recovery')!);
  assert.deepEqual(recovery, { quantity: 1, subtotalPaise: 799900, gstPaise: 143982, totalPaise: 943882, gstRatePercent: 18 });
  const care = calculatePrice(getPlan('recovery-care')!);
  assert.equal(care.totalPaise, 1769882);
  const agency = calculatePrice(getPlan('agency-care')!);
  assert.equal(agency.totalPaise, 589882);
});

test('quantity is bounded by the plan site allowance', () => {
  assert.equal(calculatePrice(getPlan('recovery')!, 99).quantity, 10);
  assert.equal(calculatePrice(getPlan('agency-care')!, 99).quantity, 1);
});

test('website validation accepts http(s) and rejects unsafe or malformed values', () => {
  assert.equal(isValidWebsite('https://example.com'), true);
  assert.equal(isValidWebsite('http://localhost:3000'), true);
  assert.equal(isValidWebsite('javascript:alert(1)'), false);
  assert.equal(isValidWebsite('example.com'), false);
});
