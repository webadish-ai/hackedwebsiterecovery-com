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
  assert.match(sql, /foreign key \(order_id, organization_id\) references public\.orders\(id, organization_id\)/g);
  assert.match(sql, /foreign key \(site_id, organization_id\) references public\.sites\(id, organization_id\)/g);
  assert.match(sql, /foreign key \(case_id, organization_id\) references public\.cases\(id, organization_id\)/g);
  const caseEventInsert = sql.split('\n').find((line) => line.includes('create policy case_events_staff_insert')) ?? '';
  assert.match(caseEventInsert, /with check \(public\.is_staff\(\)\)/);
  assert.doesNotMatch(caseEventInsert, /customer_visible/);
  assert.doesNotMatch(sql, /audit_insert_authenticated/);
  assert.doesNotMatch(sql, /create policy credentials_/);
  for (const fn of ['set_response_deadline', 'enforce_case_transition', 'prevent_event_update', 'prevent_audit_update']) assert.match(sql, new RegExp(`function public\\.${fn}\\(\\) returns trigger language plpgsql set search_path = public`));
  for (const fn of ['staff_assign_case', 'staff_transition_case', 'staff_add_case_update', 'staff_mark_access_usable']) {
    assert.match(sql, new RegExp(`function public\\.${fn}`));
    assert.match(sql, new RegExp(`function public\\.${fn}[\\s\\S]*?public\\.is_staff\\(\\)`));
    assert.match(sql, new RegExp(`function public\\.${fn}[\\s\\S]*?security definer set search_path = public`));
  }
  assert.match(sql, /staff_transition_case[\s\S]*?case_status_transition_allowed/);
  assert.match(sql, /staff_transition_case[\s\S]*?insert into public\.case_events[\s\S]*?insert into public\.audit_logs/);
  assert.match(sql, /staff_add_case_update[\s\S]*?password\|secret\|api/);
  assert.doesNotMatch(sql, /create policy cases_staff_write/);
});
