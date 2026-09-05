import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { getCaseDataService, SupabaseCaseDataService } from '../src/lib/data-service.ts';
import { getBrowserSupabaseConfig } from '../src/lib/supabase-browser.ts';
import { getPublicSupabaseConfig } from '../src/lib/supabase.ts';
import { protectedPath, staffPath } from '../src/lib/request-context.ts';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '../src/lib/database.types.ts';

const validEnv = { PUBLIC_SUPABASE_URL: 'https://demo.supabase.co', PUBLIC_SUPABASE_ANON_KEY: 'anon-key' };

test('Supabase config accepts only valid public URL and anon key', () => {
  assert.deepEqual(getPublicSupabaseConfig(validEnv), { url: validEnv.PUBLIC_SUPABASE_URL, anonKey: validEnv.PUBLIC_SUPABASE_ANON_KEY });
  assert.deepEqual(getBrowserSupabaseConfig(validEnv), getPublicSupabaseConfig(validEnv));
  assert.equal(getPublicSupabaseConfig({ ...validEnv, PUBLIC_SUPABASE_URL: 'not-a-url' }), null);
  assert.equal(getPublicSupabaseConfig({ PUBLIC_SUPABASE_URL: 'https://your-project.supabase.co', PUBLIC_SUPABASE_ANON_KEY: 'secret' }), null);
  assert.equal(getPublicSupabaseConfig({ ...validEnv, PUBLIC_SUPABASE_ANON_KEY: 'your-development-anon-key' }), null);
});

test('data service selects Supabase only with valid config and development only with explicit flag', () => {
  assert.equal(getCaseDataService({ env: {} }), null);
  assert.equal(getCaseDataService({ env: { ENABLE_DEVELOPMENT_WORKFLOW: 'false', NODE_ENV: 'test' } }), null);
  assert.equal(getCaseDataService({ env: { ...validEnv, ENABLE_DEVELOPMENT_WORKFLOW: 'false', NODE_ENV: 'test' } })?.kind, 'supabase');
  assert.equal(getCaseDataService({ env: { ENABLE_DEVELOPMENT_WORKFLOW: 'true', NODE_ENV: 'test' } })?.kind, 'development');
  assert.equal(getCaseDataService({ env: { ENABLE_DEVELOPMENT_WORKFLOW: 'true', NODE_ENV: 'production' } }), null);
});

test('protected route matching covers portal and staff views', () => {
  assert.equal(protectedPath('/portal/'), true);
  assert.equal(protectedPath('/staff/cases/case_1'), true);
  assert.equal(protectedPath('/public-case-study'), false);
  assert.equal(staffPath('/staff'), true);
  assert.equal(staffPath('/portal'), false);
});

test('service role source is server-only and browser module contains no service-role reference', async () => {
  const browser = await readFile(new URL('../src/lib/supabase-browser.ts', import.meta.url), 'utf8');
  const server = await readFile(new URL('../src/lib/supabase-server.ts', import.meta.url), 'utf8');
  assert.doesNotMatch(browser, /SERVICE_ROLE|serviceRole/i);
  assert.match(server, /SUPABASE_SERVICE_ROLE_KEY/);
  assert.match(server, /createSupabaseServiceRoleClient/);
});

test('Supabase timeline reads apply customer visibility and organization filters', async () => {
  const calls: string[] = [];
  const event = { id: 'event_1', case_id: 'case_1', organization_id: 'org_1', type: 'update', from_status: null, to_status: null, body: 'Customer update', customer_visible: true, actor_user_id: 'staff_1', created_at: '2026-09-05T08:00:00Z' };
  const client = {
    from(table: string) {
      const query = {
        select(columns: string) { calls.push(`${table}.select:${columns}`); return query; },
        eq(column: string, value: string | boolean) { calls.push(`${table}.eq:${column}=${String(value)}`); return query; },
        in(column: string, values: string[]) { calls.push(`${table}.in:${column}=${values.join(',')}`); return query; },
        order(column: string) { calls.push(`${table}.order:${column}`); return Promise.resolve({ data: [event], error: null }); },
      };
      return query;
    },
  } as unknown as SupabaseClient<Database>;
  const service = new SupabaseCaseDataService(client);
  const customerEvents = await service.customerTimeline('case_1', { userId: 'customer_1', role: 'customer', organizationIds: ['org_1'] });
  assert.equal(customerEvents[0]?.body, 'Customer update');
  assert.ok(calls.includes('case_events.eq:customer_visible=true'));
  assert.ok(calls.includes('case_events.in:organization_id=org_1'));
  calls.length = 0;
  const staffEvents = await service.internalTimeline('case_1', { userId: 'staff_1', role: 'staff', organizationIds: [], mfaVerifiedAt: new Date().toISOString() });
  assert.equal(staffEvents[0]?.body, 'Customer update');
  assert.ok(!calls.some((call) => call.includes('customer_visible')));
});
