import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

test('transactional routes are noindex and demo checkout has no credential fields', async () => {
  const pages = ['cart', 'checkout', 'compare', 'payment-confirmation', 'onboarding', 'portal'];
  for (const page of pages) {
    const source = await readFile(new URL(`../src/pages/${page}.astro`, import.meta.url), 'utf8');
    assert.match(source, /noindex=\{true\}/, `${page} should be noindex`);
  }
  const checkout = await readFile(new URL('../src/pages/checkout.astro', import.meta.url), 'utf8');
  assert.doesNotMatch(checkout, /type=["']password|name=["'][^"']*(password|credential|secret|api[_ -]?key)/i);
});
