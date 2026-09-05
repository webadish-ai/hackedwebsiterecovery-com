import assert from 'node:assert/strict';
import test from 'node:test';
import { decryptCredentialEnvelope, encryptCredentialPayload, redactCredentialText, type CredentialEnvelope } from '../src/lib/credentials.ts';
import { createDevelopmentFixture, DevelopmentWorkflowStore, WorkflowError } from '../src/lib/case-workflow.ts';
import { assertCredentialRateLimit, assertTrustedMutationOrigin, credentialRateLimiter } from '../src/lib/http-security.ts';

process.env.ENABLE_DEVELOPMENT_WORKFLOW = 'true';
process.env.NODE_ENV = 'test';
process.env.CREDENTIAL_KEY_VERSION = 'test-v1';
process.env.CREDENTIAL_MASTER_KEY = Buffer.alloc(32, 7).toString('base64');
process.env.PUBLIC_SITE_URL = 'https://portal.example.test';

test('AES-256-GCM envelope round trips and rejects tampering without exposing plaintext', () => {
  const payload = { wordpress_password: 'correct horse battery staple', host: 'wp.example.test' };
  const envelope = encryptCredentialPayload(payload);
  assert.equal(envelope.algorithm, 'aes-256-gcm');
  assert.equal(envelope.keyVersion, 'test-v1');
  assert.deepEqual(decryptCredentialEnvelope(envelope), payload);
  assert.equal(JSON.stringify(envelope).includes(payload.wordpress_password), false);
  const tampered = { ...envelope, ciphertext: `${envelope.ciphertext[0] === 'A' ? 'B' : 'A'}${envelope.ciphertext.slice(1)}` } as CredentialEnvelope;
  assert.throws(() => decryptCredentialEnvelope(tampered), /could not be verified/i);
  assert.throws(() => decryptCredentialEnvelope({ ...envelope, authTag: `${envelope.authTag[0] === 'A' ? 'B' : 'A'}${envelope.authTag.slice(1)}` }), /could not be verified/i);
});

test('customer credential ownership, assigned-staff MFA, replacement, and revocation are enforced', () => {
  const fixture = createDevelopmentFixture(new DevelopmentWorkflowStore(process.env));
  const first = fixture.store.submitCredentials(fixture.case.id, { username: 'owner', password: 'first-secret' }, fixture.customer, undefined, new Date('2026-09-05T08:00:00Z'));
  assert.equal('ciphertext' in first, false);
  assert.equal([...fixture.store.credentials.values()][0].ciphertext?.includes('first-secret'), false);
  assert.throws(() => fixture.store.revealCredentials(first.id, fixture.customer), /Staff access/);
  const otherStaff = { userId: 'other-staff', role: 'staff' as const, organizationIds: [], mfaVerifiedAt: new Date().toISOString() };
  assert.throws(() => fixture.store.submitCredentials(fixture.case.id, { username: 'wrong-staff' }, otherStaff), /manage credentials/i);
  assert.throws(() => fixture.store.revokeCredentials(first.id, otherStaff), /manage credentials/i);
  assert.throws(() => fixture.store.listCredentialMetadata(fixture.case.id, otherStaff), /manage credentials/i);
  fixture.store.assignCase(fixture.case.id, fixture.staff.userId, fixture.staff);
  assert.throws(() => fixture.store.revealCredentials(first.id, otherStaff), /assigned/i);
  assert.throws(() => fixture.store.revealCredentials(first.id, { ...fixture.staff, mfaVerifiedAt: undefined }), /MFA/i);
  assert.deepEqual(fixture.store.revealCredentials(first.id, fixture.staff), { username: 'owner', password: 'first-secret' });
  const second = fixture.store.replaceCredentials(fixture.case.id, { username: 'owner', password: 'second-secret' }, fixture.customer, undefined, new Date('2026-09-05T09:00:00Z'));
  assert.equal(fixture.store.credentials.get(first.id)?.state, 'revoked');
  assert.throws(() => fixture.store.revealCredentials(first.id, fixture.staff), /unavailable/i);
  assert.deepEqual(fixture.store.revealCredentials(second.id, fixture.staff), { username: 'owner', password: 'second-secret' });
  assert.equal(fixture.store.revokeCredentials(second.id, fixture.customer).state, 'revoked');
  assert.equal(fixture.store.revokeCredentials(second.id, fixture.customer).state, 'revoked');
  assert.throws(() => fixture.store.revealCredentials(second.id, fixture.staff), (error: unknown) => error instanceof WorkflowError && error.code === 'forbidden');
});

test('credential expiry and retention purge destroy encrypted material idempotently', () => {
  const fixture = createDevelopmentFixture(new DevelopmentWorkflowStore(process.env));
  const expired = fixture.store.submitCredentials(fixture.case.id, { token: 'short-lived' }, fixture.customer, '2026-09-05T09:00:00Z', new Date('2026-09-05T08:00:00Z'));
  fixture.store.assignCase(fixture.case.id, fixture.staff.userId, fixture.staff);
  assert.throws(() => fixture.store.revealCredentials(expired.id, fixture.staff, new Date('2026-09-05T10:00:00Z')), /unavailable/i);
  const stored = fixture.store.credentials.get(expired.id)!;
  assert.equal(stored.ciphertext, undefined);
  fixture.store.setAccessUsable(fixture.case.id, new Date('2026-09-05T08:00:00Z'), fixture.staff);
  fixture.store.transitionCase(fixture.case.id, 'triage', fixture.staff);
  fixture.store.transitionCase(fixture.case.id, 'in_progress', fixture.staff);
  fixture.store.transitionCase(fixture.case.id, 'verification', fixture.staff);
  fixture.store.transitionCase(fixture.case.id, 'completed', fixture.staff);
  assert.equal(fixture.store.purgeExpiredCredentials(new Date('2026-09-05T09:00:00Z')), 0);
  const retained = fixture.store.submitCredentials(fixture.case.id, { token: 'retained-until-cutoff' }, fixture.customer, undefined, new Date('2026-09-05T10:00:00Z'));
  assert.equal(fixture.store.purgeExpiredCredentials(new Date('2026-09-12T10:00:00Z'), new Date('2026-09-12T10:00:00Z')), 0);
  assert.equal(fixture.store.purgeExpiredCredentials(new Date('2026-09-12T10:00:00Z'), new Date('2026-09-20T10:00:00Z')), 1);
  assert.equal(fixture.store.credentials.get(retained.id)?.ciphertext, undefined);
  assert.equal(fixture.store.purgeExpiredCredentials(new Date('2026-09-12T10:00:00Z'), new Date('2026-09-20T10:00:00Z')), 0);
});

test('quarantined attachments cannot produce downloads until clean', () => {
  const fixture = createDevelopmentFixture(new DevelopmentWorkflowStore(process.env));
  const attachment = fixture.store.addAttachment({ organizationId: fixture.organization.id, caseId: fixture.case.id, kind: 'final_report', storagePath: `${fixture.case.id}/quarantined.pdf`, contentType: 'application/pdf', byteSize: 1024, customerVisible: true }, fixture.staff);
  assert.equal(attachment.scanState, 'quarantined');
  assert.throws(() => fixture.store.createReportDownload(attachment.id, fixture.customer), /not available/i);
  fixture.store.markAttachmentClean(attachment.id, fixture.staff);
  assert.match(fixture.store.createReportDownload(attachment.id, fixture.customer).downloadToken, /^dev_report_/);
});

test('credential mutations require the configured trusted origin and are rate limited', () => {
  const attacker = new Request('https://attacker.example/api/customer/cases/case/credentials', { method: 'POST', headers: { origin: 'https://attacker.example' } });
  assert.equal(assertTrustedMutationOrigin(attacker, process.env)?.status, 403);
  const trusted = new Request('https://attacker.example/api/customer/cases/case/credentials', { method: 'POST', headers: { origin: 'https://portal.example.test', 'x-forwarded-for': '198.51.100.4' } });
  const actor = { userId: 'rate-test', role: 'customer' as const, organizationIds: [] };
  credentialRateLimiter.clear();
  for (let i = 0; i < 5; i += 1) assert.equal(assertCredentialRateLimit(trusted, actor), null);
  assert.equal(assertCredentialRateLimit(trusted, actor)?.status, 429);
  assert.equal(redactCredentialText('password=super-secret token=abc'), 'password=[redacted] token=[redacted]');
});
