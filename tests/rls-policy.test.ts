import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

test('Milestone 2 migration enables RLS and protects customer-visible boundaries', async () => {
  const sql = await readFile(new URL('../supabase/migrations/202609050001_milestone_2_workflow.sql', import.meta.url), 'utf8');
  for (const table of ['profiles', 'organizations', 'organization_members', 'orders', 'payments', 'sites', 'cases', 'case_events', 'quotes', 'credential_sets', 'attachments', 'webhook_events', 'audit_logs']) assert.match(sql, new RegExp(`alter table public\\.${table} enable row level security`, 'i'));
  assert.match(sql, /case_events_customer_safe[\s\S]*customer_visible/);
  assert.match(sql, /case_events_append_only/);
  assert.match(sql, /greatest\(new\.payment_verified_at, new\.access_usable_at\) \+ interval '4 hours'/);
  assert.match(sql, /case_reports_read/);
  assert.match(sql, /auth\.jwt\(\)->>'aal'\) = 'aal2'/);
});
