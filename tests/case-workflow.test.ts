import assert from 'node:assert/strict';
import test from 'node:test';
import { calculateResponseDeadline, canTransition, createDevelopmentFixture, DevelopmentWorkflowStore, WorkflowError } from '../src/lib/case-workflow.ts';
import { actorFromHeaders, consumeMagicLink, isDevelopmentWorkflowEnabled, requestMagicLink, requireStaffMfa } from '../src/lib/auth.ts';
import { POST as magicLinkPost } from '../src/pages/api/auth/magic-link.ts';
import { GET as getStaffQueue } from '../src/pages/api/staff/queue.ts';
import { GET as getCustomerCases } from '../src/pages/api/customer/cases.ts';

process.env.ENABLE_DEVELOPMENT_WORKFLOW = 'true';
if (process.env.NODE_ENV === 'production') delete process.env.NODE_ENV;

test('response clock waits for both verified payment and usable access', () => {
  assert.equal(calculateResponseDeadline({ paymentVerifiedAt: '2026-09-05T08:00:00Z' }), null);
  assert.equal(calculateResponseDeadline({ accessUsableAt: '2026-09-05T08:30:00Z' }), null);
  assert.equal(calculateResponseDeadline({ paymentVerifiedAt: '2026-09-05T08:00:00Z', accessUsableAt: '2026-09-05T08:30:00Z' }), '2026-09-05T12:30:00.000Z');
});

test('payment verification opens a case while the response clock still waits for access', () => {
  const fixture = createDevelopmentFixture();
  const pending = fixture.store.createOrder({ organizationId: fixture.organization.id, customerUserId: 'customer_dev', planId: 'recovery', planVersion: '2026-09-05', quantity: 1, subtotalPaise: 799900, gstPaise: 143982, totalPaise: 943882, termsVersion: '2026-09-05' });
  const site = fixture.store.createSite({ organizationId: fixture.organization.id, orderId: pending.id, url: 'https://pending.example.test' });
  const record = fixture.store.createCase({ organizationId: fixture.organization.id, orderId: pending.id, siteId: site.id });
  fixture.store.setAccessUsable(record.id, '2026-09-05T08:00:00Z', fixture.staff);
  assert.equal(fixture.store.getCase(record.id, fixture.customer).responseDeadlineAt, undefined);
  fixture.store.verifyPayment(pending.id, new Date('2026-09-05T09:00:00Z'));
  assert.equal(fixture.store.getCase(record.id, fixture.customer).status, 'awaiting_access');
  assert.equal(fixture.store.getCase(record.id, fixture.customer).responseDeadlineAt, '2026-09-05T13:00:00.000Z');
});

test('workflow accepts only explicit state transitions', () => {
  assert.equal(canTransition('awaiting_access', 'triage'), true);
  assert.equal(canTransition('awaiting_access', 'completed'), false);
  assert.equal(canTransition('verification', 'completed'), true);
});

test('tenant and MFA checks protect staff workflow', () => {
  const fixture = createDevelopmentFixture();
  const other = { userId: 'other', role: 'customer' as const, organizationIds: [fixture.store.createOrganization('Other').id] };
  assert.throws(() => fixture.store.getCase(fixture.case.id, other), (error: unknown) => error instanceof WorkflowError && error.code === 'forbidden');
  assert.throws(() => fixture.store.transitionCase(fixture.case.id, 'triage', { userId: 'staff', role: 'staff', organizationIds: [] }), (error: unknown) => error instanceof WorkflowError && error.code === 'mfa_required');
  fixture.store.setAccessUsable(fixture.case.id, new Date(), fixture.staff);
  fixture.store.transitionCase(fixture.case.id, 'triage', fixture.staff);
});

test('customer timeline excludes internal notes', () => {
  const fixture = createDevelopmentFixture();
  fixture.store.addUpdate(fixture.case.id, 'Customer safe update', true, fixture.staff);
  fixture.store.addUpdate(fixture.case.id, 'Internal triage note', false, fixture.staff);
  assert.equal(fixture.store.customerTimeline(fixture.case.id, fixture.customer).some((event) => event.body.includes('Internal')), false);
  assert.equal(fixture.store.internalTimeline(fixture.case.id, fixture.staff).length, 3);
  assert.throws(() => fixture.store.addUpdate(fixture.case.id, 'password=do-not-store', false, fixture.staff), /Secrets must never/);
});

test('report metadata is private and downloads expire quickly', () => {
  const fixture = createDevelopmentFixture();
  const attachment = fixture.store.addAttachment({ organizationId: fixture.organization.id, caseId: fixture.case.id, kind: 'final_report', storagePath: `${fixture.case.id}/report.pdf`, contentType: 'application/pdf', byteSize: 1024, customerVisible: true }, fixture.staff);
  const download = fixture.store.createReportDownload(attachment.id, fixture.customer, new Date('2026-09-05T08:00:00Z'));
  assert.equal(download.expiresAt, '2026-09-05T08:05:00.000Z');
  assert.match(download.downloadToken, /^dev_report_/);
});

test('magic links are one-time and expire', () => {
  const issued = requestMagicLink('owner@example.com', new Date('2026-09-05T08:00:00Z'));
  assert.ok(consumeMagicLink(issued.request.id, issued.developmentToken, new Date('2026-09-05T08:01:00Z')));
  assert.equal(consumeMagicLink(issued.request.id, issued.developmentToken, new Date('2026-09-05T08:02:00Z')), null);
  const expired = requestMagicLink('expired@example.com', new Date('2026-09-05T08:00:00Z'));
  assert.equal(consumeMagicLink(expired.request.id, expired.developmentToken, new Date('2026-09-05T08:16:00Z')), null);
});

test('staff recent MFA is required for staff actions', () => {
  assert.throws(() => requireStaffMfa({ userId: 's', role: 'staff', organizationIds: [] }, new Date('2026-09-05T08:20:00Z')), /MFA/i);
  requireStaffMfa({ userId: 's', role: 'staff', organizationIds: [], mfaVerifiedAt: '2026-09-05T08:10:00Z' }, new Date('2026-09-05T08:20:00Z'));
});

test('API route guards deny unauthenticated customer and staff requests', async () => {
  const request = new Request('http://localhost/api/cases');
  const context = { request } as Parameters<typeof getStaffQueue>[0];
  assert.equal((await getStaffQueue(context)).status, 401);
  assert.equal((await getCustomerCases(context)).status, 401);
  const forged = new Request('http://localhost/api/cases', { headers: { 'x-development-user-id': 'staff', 'x-development-role': 'staff' } });
  assert.equal((await getStaffQueue({ request: forged } as Parameters<typeof getStaffQueue>[0])).status, 403);
});

test('development fixtures are disabled by default and cannot run in production', async () => {
  const originalFlag = process.env.ENABLE_DEVELOPMENT_WORKFLOW;
  const originalNodeEnv = process.env.NODE_ENV;
  try {
    process.env.ENABLE_DEVELOPMENT_WORKFLOW = 'false';
    process.env.NODE_ENV = 'test';
    assert.equal(isDevelopmentWorkflowEnabled(), false);
    assert.equal(actorFromHeaders(new Request('http://localhost', { headers: { 'x-development-user-id': 'staff', 'x-development-role': 'staff' } })), null);
    assert.throws(() => requestMagicLink('disabled@example.com'), /disabled/i);
    assert.throws(() => new DevelopmentWorkflowStore().createOrganization('disabled'), /disabled/i);
    assert.equal((await magicLinkPost({ request: new Request('http://localhost/api/auth/magic-link', { method: 'POST', body: JSON.stringify({ email: 'disabled@example.com' }) }) } as Parameters<typeof magicLinkPost>[0])).status, 503);

    process.env.ENABLE_DEVELOPMENT_WORKFLOW = 'true';
    process.env.NODE_ENV = 'production';
    assert.equal(isDevelopmentWorkflowEnabled(), false);
    assert.equal(actorFromHeaders(new Request('http://localhost', { headers: { cookie: 'dev_session=forged', 'x-development-user-id': 'staff', 'x-development-role': 'staff' } })), null);
    assert.equal((await magicLinkPost({ request: new Request('http://localhost/api/auth/magic-link', { method: 'POST', body: JSON.stringify({ email: 'production@example.com' }) }) } as Parameters<typeof magicLinkPost>[0])).status, 503);
  } finally {
    if (originalFlag === undefined) delete process.env.ENABLE_DEVELOPMENT_WORKFLOW; else process.env.ENABLE_DEVELOPMENT_WORKFLOW = originalFlag;
    if (originalNodeEnv === undefined) delete process.env.NODE_ENV; else process.env.NODE_ENV = originalNodeEnv;
  }
});
