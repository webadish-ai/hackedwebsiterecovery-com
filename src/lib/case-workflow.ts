import type {
  Actor, AttachmentRecord, CaseEventRecord, CaseRecord, CaseStatus, Organization,
  CredentialRecord, OrderRecord, SiteRecord,
} from './workflow-types.ts';
import { assertDevelopmentWorkflowEnabled } from './auth.ts';
import { decryptCredentialEnvelope, encryptCredentialPayload, type CredentialPayload } from './credentials.ts';

export const RESPONSE_WINDOW_MS = 4 * 60 * 60 * 1000;

// A case may only move along an explicitly listed path. Terminal states have no
// outgoing transitions except a refund/cancellation correction by an admin.
export const CASE_TRANSITIONS: Readonly<Record<CaseStatus, readonly CaseStatus[]>> = {
  awaiting_payment: ['awaiting_access', 'refunded', 'cancelled'],
  awaiting_access: ['triage', 'refunded', 'cancelled'],
  triage: ['awaiting_access', 'awaiting_approval', 'in_progress', 'quoted_separately', 'refunded', 'cancelled'],
  awaiting_approval: ['in_progress', 'quoted_separately', 'cancelled'],
  in_progress: ['awaiting_approval', 'verification', 'awaiting_access', 'cancelled'],
  verification: ['in_progress', 'monitoring', 'completed'],
  monitoring: ['in_progress', 'completed'],
  completed: ['monitoring', 'refunded'],
  quoted_separately: ['awaiting_approval', 'refunded', 'cancelled'],
  refunded: [],
  cancelled: [],
};

export function canTransition(from: CaseStatus, to: CaseStatus): boolean {
  return CASE_TRANSITIONS[from].includes(to);
}

export function calculateResponseDeadline(input: {
  paymentVerifiedAt?: string | Date | null;
  accessUsableAt?: string | Date | null;
}): string | null {
  if (!input.paymentVerifiedAt || !input.accessUsableAt) return null;
  const payment = toMillis(input.paymentVerifiedAt);
  const access = toMillis(input.accessUsableAt);
  if (payment === null || access === null) return null;
  return new Date(Math.max(payment, access) + RESPONSE_WINDOW_MS).toISOString();
}

export function responseClockStarted(input: Pick<CaseRecord, 'paymentVerifiedAt' | 'accessUsableAt'>): boolean {
  return Boolean(calculateResponseDeadline(input));
}

function toMillis(value: string | Date): number | null {
  const result = value instanceof Date ? value.getTime() : Date.parse(value);
  return Number.isFinite(result) ? result : null;
}

export class WorkflowError extends Error {
  readonly code: 'not_found' | 'forbidden' | 'invalid_transition' | 'mfa_required';
  constructor(code: 'not_found' | 'forbidden' | 'invalid_transition' | 'mfa_required', message: string) {
    super(message);
    this.code = code;
    this.name = 'WorkflowError';
  }
}

export class DevelopmentWorkflowStore {
  readonly organizations = new Map<string, Organization>();
  readonly orders = new Map<string, OrderRecord>();
  readonly sites = new Map<string, SiteRecord>();
  readonly cases = new Map<string, CaseRecord>();
  readonly events: CaseEventRecord[] = [];
  readonly attachments = new Map<string, AttachmentRecord>();
  readonly memberships = new Map<string, Map<string, 'owner' | 'member' | 'agency_admin'>>();
  readonly credentials = new Map<string, StoredCredential>();
  private readonly credentialEnv: Record<string, string | undefined>;
  private sequence = 0;

  constructor(credentialEnv: Record<string, string | undefined> = process.env) { this.credentialEnv = credentialEnv; }

  private ensureEnabled() { assertDevelopmentWorkflowEnabled(); }

  private id(prefix: string) { this.sequence += 1; return `${prefix}_dev_${this.sequence}`; }

  createOrganization(name: string, kind: Organization['kind'] = 'owner'): Organization {
    this.ensureEnabled();
    const organization = { id: this.id('org'), name, kind };
    this.organizations.set(organization.id, organization);
    return organization;
  }

  addMember(organizationId: string, userId: string, role: 'owner' | 'member' | 'agency_admin' = 'member') {
    this.ensureEnabled();
    if (!this.organizations.has(organizationId)) throw new WorkflowError('not_found', 'Organization not found.');
    const members = this.memberships.get(organizationId) ?? new Map<string, 'owner' | 'member' | 'agency_admin'>();
    members.set(userId, role);
    this.memberships.set(organizationId, members);
  }

  createOrder(input: Omit<OrderRecord, 'id' | 'paymentState' | 'paidAt'> & { paymentState?: OrderRecord['paymentState']; paidAt?: string }): OrderRecord {
    this.ensureEnabled();
    const order: OrderRecord = { ...input, id: this.id('order'), paymentState: input.paymentState ?? 'pending' };
    this.orders.set(order.id, order);
    return order;
  }

  createPaidOrder(input: Omit<OrderRecord, 'id' | 'paymentState' | 'paidAt'> & { paidAt?: string }): OrderRecord {
    return this.createOrder({ ...input, paymentState: 'verified', paidAt: input.paidAt ?? new Date().toISOString() });
  }

  verifyPayment(orderId: string, at = new Date()): OrderRecord {
    this.ensureEnabled();
    const order = this.orders.get(orderId);
    if (!order) throw new WorkflowError('not_found', 'Order not found.');
    if (order.paymentState === 'refunded') throw new WorkflowError('forbidden', 'A refunded order cannot be verified.');
    order.paymentState = 'verified';
    order.paidAt = at.toISOString();
    for (const record of this.cases.values()) {
      if (record.orderId !== orderId || record.status !== 'awaiting_payment') continue;
      record.status = 'awaiting_access';
      record.paymentVerifiedAt = order.paidAt;
      record.responseDeadlineAt = calculateResponseDeadline(record) ?? undefined;
      record.updatedAt = order.paidAt;
      this.events.push(this.event(record, 'payment_verified', 'awaiting_payment', 'awaiting_access', 'Payment verified', true, 'system', order.paidAt));
    }
    return order;
  }

  createSite(input: Omit<SiteRecord, 'id' | 'accessState'> & { accessState?: SiteRecord['accessState'] }): SiteRecord {
    this.ensureEnabled();
    this.assertOrderTenant(input.orderId, input.organizationId);
    const site: SiteRecord = { ...input, id: this.id('site'), accessState: input.accessState ?? 'not_requested' };
    this.sites.set(site.id, site);
    return site;
  }

  createCase(input: { organizationId: string; orderId: string; siteId: string; now?: Date }): CaseRecord {
    this.ensureEnabled();
    const order = this.orders.get(input.orderId);
    const site = this.sites.get(input.siteId);
    if (!order || !site || order.organizationId !== input.organizationId || site.organizationId !== input.organizationId) {
      throw new WorkflowError('forbidden', 'The order and site must belong to the same organization.');
    }
    const now = (input.now ?? new Date()).toISOString();
    const record: CaseRecord = {
      id: this.id('case'), organizationId: input.organizationId, orderId: input.orderId, siteId: input.siteId,
      status: order.paymentState === 'verified' ? 'awaiting_access' : 'awaiting_payment',
      paymentVerifiedAt: order.paidAt, createdAt: now, updatedAt: now,
    };
    record.responseDeadlineAt = calculateResponseDeadline(record) ?? undefined;
    this.cases.set(record.id, record);
    this.events.push(this.event(record, 'case_created', undefined, record.status, 'Case created', false, 'system', now));
    return record;
  }

  getCase(id: string, actor: Actor): CaseRecord {
    this.ensureEnabled();
    const record = this.cases.get(id);
    if (!record) throw new WorkflowError('not_found', 'Case not found.');
    this.authorize(record, actor);
    return record;
  }

  listQueue(actor: Actor): CaseRecord[] {
    this.ensureEnabled();
    this.requireStaffMfa(actor);
    return [...this.cases.values()].filter((item) => ['awaiting_access', 'triage', 'awaiting_approval', 'in_progress', 'verification'].includes(item.status))
      .sort((a, b) => (Date.parse(a.responseDeadlineAt ?? '9999-12-31') - Date.parse(b.responseDeadlineAt ?? '9999-12-31')));
  }

  assignCase(id: string, staffId: string, actor: Actor): CaseRecord {
    this.ensureEnabled();
    this.requireStaffMfa(actor);
    const record = this.getCase(id, actor);
    if (actor.role !== 'admin' && actor.userId !== staffId) throw new WorkflowError('forbidden', 'Only an admin can assign another operator.');
    record.assignedStaffId = staffId;
    record.updatedAt = new Date().toISOString();
    this.events.push(this.event(record, 'case_assigned', undefined, undefined, `Case assigned to ${staffId}`, false, actor.userId, record.updatedAt));
    return record;
  }

  setAccessUsable(id: string, at: string | Date, actor: Actor): CaseRecord {
    this.ensureEnabled();
    const record = this.getCase(id, actor);
    if (!isStaff(actor) && !actor.organizationIds.includes(record.organizationId)) throw new WorkflowError('forbidden', 'Organization access is required.');
    record.accessUsableAt = at instanceof Date ? at.toISOString() : at;
    const site = this.sites.get(record.siteId);
    if (site) site.accessState = 'usable';
    record.responseDeadlineAt = calculateResponseDeadline(record) ?? undefined;
    record.updatedAt = new Date().toISOString();
    this.events.push(this.event(record, 'access_verified', undefined, undefined, 'Usable access received', true, actor.userId, record.updatedAt));
    return record;
  }

  transitionCase(id: string, to: CaseStatus, actor: Actor, body = ''): CaseRecord {
    this.ensureEnabled();
    this.requireStaffMfa(actor);
    const record = this.getCase(id, actor);
    if (record.assignedStaffId && record.assignedStaffId !== actor.userId && actor.role !== 'admin') throw new WorkflowError('forbidden', 'Only the assigned operator may update this case.');
    if (!canTransition(record.status, to)) throw new WorkflowError('invalid_transition', `Cannot move a case from ${record.status} to ${to}.`);
    const order = this.orders.get(record.orderId);
    if (to === 'awaiting_access' && order?.paymentState !== 'verified') throw new WorkflowError('forbidden', 'Payment must be verified before access can be requested.');
    if (to === 'triage' && !record.accessUsableAt) throw new WorkflowError('forbidden', 'Usable access is required before triage.');
    if (containsSecretLikeText(body)) throw new WorkflowError('forbidden', 'Secrets must never be written to case events.');
    const from = record.status;
    record.status = to;
    record.updatedAt = new Date().toISOString();
    this.events.push(this.event(record, 'status_changed', from, to, body, true, actor.userId, record.updatedAt));
    return record;
  }

  addUpdate(id: string, body: string, customerVisible: boolean, actor: Actor): CaseEventRecord {
    this.ensureEnabled();
    const record = this.getCase(id, actor);
    if (!isStaff(actor) && !customerVisible) throw new WorkflowError('forbidden', 'Customers cannot create internal notes.');
    if (!body.trim() || body.length > 5000) throw new WorkflowError('forbidden', 'Update text is empty or too long.');
    if (containsSecretLikeText(body)) throw new WorkflowError('forbidden', 'Secrets must never be written to case events.');
    if (customerVisible && !isStaff(actor) && actor.userId !== this.orders.get(record.orderId)?.customerUserId) throw new WorkflowError('forbidden', 'Case ownership is required.');
    const event = this.event(record, customerVisible ? 'customer_update' : 'internal_note', undefined, undefined, body.trim(), customerVisible, actor.userId, new Date().toISOString());
    this.events.push(event);
    return event;
  }

  customerTimeline(id: string, actor: Actor): CaseEventRecord[] {
    this.ensureEnabled();
    const record = this.getCase(id, actor);
    return this.events.filter((event) => event.caseId === record.id && event.customerVisible);
  }

  internalTimeline(id: string, actor: Actor): CaseEventRecord[] {
    this.ensureEnabled();
    this.requireStaffMfa(actor);
    const record = this.getCase(id, actor);
    return this.events.filter((event) => event.caseId === record.id);
  }

  private event(record: CaseRecord, type: string, fromStatus: CaseStatus | undefined, toStatus: CaseStatus | undefined, body: string, customerVisible: boolean, actorUserId: string, createdAt: string): CaseEventRecord {
    return { id: this.id('event'), caseId: record.id, organizationId: record.organizationId, type, fromStatus, toStatus, body, customerVisible, actorUserId, createdAt };
  }
  private assertOrderTenant(orderId: string, organizationId: string) { const order = this.orders.get(orderId); if (!order || order.organizationId !== organizationId) throw new WorkflowError('forbidden', 'Organization does not own this order.'); }
  private authorize(record: CaseRecord, actor: Actor) { if (!isStaff(actor) && !actor.organizationIds.includes(record.organizationId)) throw new WorkflowError('forbidden', 'Organization access is required.'); }
  private requireStaffMfa(actor: Actor) {
    if (!isStaff(actor)) throw new WorkflowError('forbidden', 'Staff access is required.');
    const assuranceAge = actor.mfaVerifiedAt ? Date.now() - Date.parse(actor.mfaVerifiedAt) : Number.POSITIVE_INFINITY;
    if (!Number.isFinite(assuranceAge) || assuranceAge < 0 || assuranceAge > 15 * 60 * 1000) throw new WorkflowError('mfa_required', 'Recent staff MFA verification is required.');
  }

  addAttachment(input: Omit<AttachmentRecord, 'id' | 'createdAt' | 'scanState'> & { scanState?: AttachmentRecord['scanState'] }, actor: Actor): AttachmentRecord {
    this.ensureEnabled();
    this.requireStaffMfa(actor);
    const record = this.getCase(input.caseId, actor);
    if (record.organizationId !== input.organizationId) throw new WorkflowError('forbidden', 'Organization does not own this case.');
    if (!['application/pdf', 'text/plain'].includes(input.contentType) || input.byteSize <= 0 || input.byteSize > 25 * 1024 * 1024) throw new WorkflowError('forbidden', 'Attachment type or size is not allowed.');
    const attachment: AttachmentRecord = { ...input, scanState: input.scanState ?? 'quarantined', id: this.id('attachment'), createdAt: new Date().toISOString() };
    this.attachments.set(attachment.id, attachment);
    return attachment;
  }

  listAttachments(caseId: string, actor: Actor): AttachmentRecord[] {
    this.ensureEnabled();
    const record = this.getCase(caseId, actor);
    return [...this.attachments.values()].filter((item) => item.caseId === record.id && (isStaff(actor) || item.customerVisible));
  }

  createReportDownload(attachmentId: string, actor: Actor, now = new Date()): { attachmentId: string; expiresAt: string; downloadToken: string } {
    this.ensureEnabled();
    const attachment = this.attachments.get(attachmentId);
    if (!attachment) throw new WorkflowError('not_found', 'Report not found.');
    this.getCase(attachment.caseId, actor);
    if (!isStaff(actor) && !attachment.customerVisible) throw new WorkflowError('forbidden', 'This report is not available to the customer.');
    if (attachment.scanState !== 'clean') throw new WorkflowError('forbidden', 'This report is not available yet.');
    return { attachmentId, expiresAt: new Date(now.getTime() + 5 * 60 * 1000).toISOString(), downloadToken: `dev_report_${crypto.randomUUID()}` };
  }

  markAttachmentClean(attachmentId: string, actor: Actor): AttachmentRecord {
    this.ensureEnabled(); this.requireStaffMfa(actor);
    const attachment = this.attachments.get(attachmentId);
    if (!attachment) throw new WorkflowError('not_found', 'Attachment not found.');
    this.getCase(attachment.caseId, actor);
    attachment.scanState = 'clean';
    return attachment;
  }

  submitCredentials(caseId: string, payload: CredentialPayload, actor: Actor, expiresAt?: string, now = new Date()): CredentialRecord {
    this.ensureEnabled();
    const record = this.getCase(caseId, actor);
    this.assertCredentialActor(record, actor, false);
    if (expiresAt && (!Number.isFinite(Date.parse(expiresAt)) || Date.parse(expiresAt) <= now.getTime())) throw new WorkflowError('forbidden', 'Credential expiry must be in the future.');
    const envelope = encryptCredentialPayload(payload, this.credentialEnv);
    for (const existing of this.credentials.values()) {
      if (existing.caseId === caseId && existing.state === 'active') this.revokeStored(existing, now, 'replaced');
    }
    const stored: StoredCredential = { id: this.id('credential'), organizationId: record.organizationId, caseId, state: 'active', algorithm: envelope.algorithm, keyVersion: envelope.keyVersion, nonce: envelope.nonce, authTag: envelope.authTag, ciphertext: envelope.ciphertext, createdAt: now.toISOString(), expiresAt };
    this.credentials.set(stored.id, stored);
    return this.credentialMetadata(stored);
  }

  replaceCredentials(caseId: string, payload: CredentialPayload, actor: Actor, expiresAt?: string, now = new Date()): CredentialRecord {
    return this.submitCredentials(caseId, payload, actor, expiresAt, now);
  }

  listCredentialMetadata(caseId: string, actor: Actor): CredentialRecord[] {
    this.ensureEnabled(); const record = this.getCase(caseId, actor); this.assertCredentialActor(record, actor, false);
    return [...this.credentials.values()].filter((item) => item.caseId === caseId).map((item) => this.credentialMetadata(item));
  }

  revokeCredentials(credentialId: string, actor: Actor, now = new Date()): CredentialRecord {
    this.ensureEnabled();
    const stored = this.credentials.get(credentialId);
    if (!stored) throw new WorkflowError('not_found', 'Credential set not found.');
    const record = this.getCase(stored.caseId, actor); this.assertCredentialActor(record, actor, false);
    if (stored.state === 'active') this.revokeStored(stored, now, 'revoked');
    return this.credentialMetadata(stored);
  }

  revealCredentials(credentialId: string, actor: Actor, now = new Date()): CredentialPayload {
    this.ensureEnabled();
    const stored = this.credentials.get(credentialId);
    if (!stored) throw new WorkflowError('not_found', 'Credential set not found.');
    const record = this.getCase(stored.caseId, actor); this.assertCredentialActor(record, actor, true);
    if (stored.state !== 'active') throw new WorkflowError('forbidden', 'Credential set is unavailable.');
    if (stored.expiresAt && Date.parse(stored.expiresAt) <= now.getTime()) { stored.state = 'expired'; stored.expiredAt = now.toISOString(); stored.nonce = undefined; stored.authTag = undefined; stored.ciphertext = undefined; throw new WorkflowError('forbidden', 'Credential set is unavailable.'); }
    return decryptCredentialEnvelope({ version: 1, algorithm: stored.algorithm, keyVersion: stored.keyVersion, nonce: stored.nonce!, authTag: stored.authTag!, ciphertext: stored.ciphertext! }, this.credentialEnv);
  }

  purgeExpiredCredentials(completedBefore: Date, now = new Date()): number {
    this.ensureEnabled();
    if (completedBefore.getTime() > now.getTime() - 7 * 24 * 60 * 60 * 1000) return 0;
    let count = 0;
    for (const stored of this.credentials.values()) {
      const record = this.cases.get(stored.caseId);
      if (record?.status === 'completed' && Date.parse(record.updatedAt) <= completedBefore.getTime() && stored.state === 'active') { stored.state = 'expired'; stored.expiredAt = now.toISOString(); stored.nonce = undefined; stored.authTag = undefined; stored.ciphertext = undefined; count += 1; }
    }
    return count;
  }

  private revokeStored(stored: StoredCredential, at: Date, reason: 'revoked' | 'replaced') { stored.state = 'revoked'; stored.revokedAt = at.toISOString(); stored.nonce = undefined; stored.authTag = undefined; stored.ciphertext = undefined; stored.revokeReason = reason; }
  private credentialMetadata(stored: StoredCredential): CredentialRecord { return { id: stored.id, organizationId: stored.organizationId, caseId: stored.caseId, state: stored.state, keyVersion: stored.keyVersion, algorithm: stored.algorithm, createdAt: stored.createdAt, expiresAt: stored.expiresAt, revokedAt: stored.revokedAt, expiredAt: stored.expiredAt }; }
  private assertCredentialActor(record: CaseRecord, actor: Actor, reveal: boolean) {
    const owner = this.orders.get(record.orderId)?.customerUserId;
    if (isStaff(actor)) { this.requireStaffMfa(actor); if (reveal && record.assignedStaffId !== actor.userId && actor.role !== 'admin') throw new WorkflowError('forbidden', 'Only the assigned operator or an admin may reveal credentials.'); if (!reveal && record.assignedStaffId !== actor.userId && actor.role !== 'admin') throw new WorkflowError('forbidden', 'Only the assigned operator or an admin may manage credentials.'); return; }
    if (reveal || actor.userId !== owner) throw new WorkflowError('forbidden', reveal ? 'Staff access is required.' : 'Credential ownership is required.');
  }
}

type StoredCredential = CredentialRecord & { nonce?: string; authTag?: string; ciphertext?: string; revokeReason?: string };

export function isStaff(actor: Actor): boolean { return actor.role === 'staff' || actor.role === 'admin'; }
function containsSecretLikeText(value: string): boolean { return /(?:password|secret|api[_ -]?key|bearer|private key)\s*[:=]/i.test(value); }
export const developmentWorkflow = new DevelopmentWorkflowStore();

export function createDevelopmentFixture(store = new DevelopmentWorkflowStore()) {
  const organization = store.createOrganization('Development customer');
  const order = store.createPaidOrder({ organizationId: organization.id, customerUserId: 'customer_dev', planId: 'recovery', planVersion: '2026-09-05', quantity: 1, subtotalPaise: 799900, gstPaise: 143982, totalPaise: 943882, termsVersion: '2026-09-05' });
  const site = store.createSite({ organizationId: organization.id, orderId: order.id, url: 'https://example.test' });
  const record = store.createCase({ organizationId: organization.id, orderId: order.id, siteId: site.id });
  return { store, organization, order, site, case: record, customer: { userId: 'customer_dev', role: 'customer' as const, organizationIds: [organization.id] }, staff: { userId: 'staff_dev', role: 'staff' as const, organizationIds: [], mfaVerifiedAt: new Date().toISOString() } };
}
