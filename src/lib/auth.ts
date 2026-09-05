import type { Actor, UserRole } from './workflow-types.ts';

export interface MagicLinkRequest { id: string; emailHash: string; expiresAt: string; consumedAt?: string; }
const links = new Map<string, { request: MagicLinkRequest; tokenHash: string; userId: string }>();
const sessions = new Map<string, Actor>();

export function isDevelopmentWorkflowEnabled(env: Record<string, string | undefined> = process.env): boolean {
  return env.ENABLE_DEVELOPMENT_WORKFLOW === 'true' && env.NODE_ENV !== 'production';
}

export function assertDevelopmentWorkflowEnabled(): void {
  if (!isDevelopmentWorkflowEnabled()) throw new Error('Development workflow is disabled.');
}

function digest(value: string): string {
  // The development adapter avoids a crypto dependency. Production Supabase Auth
  // owns token generation and verification; this hash is only a fixture boundary.
  let hash = 2166136261;
  for (const char of value) hash = Math.imul(hash ^ char.charCodeAt(0), 16777619);
  return (hash >>> 0).toString(16);
}

export function requestMagicLink(email: string, now = new Date()): { request: MagicLinkRequest; developmentToken: string } {
  assertDevelopmentWorkflowEnabled();
  const normalised = email.trim().toLowerCase();
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(normalised)) throw new Error('A valid email address is required.');
  const token = `dev_${crypto.randomUUID()}`;
  const request: MagicLinkRequest = { id: `ml_${crypto.randomUUID()}`, emailHash: digest(normalised), expiresAt: new Date(now.getTime() + 15 * 60 * 1000).toISOString() };
  links.set(request.id, { request, tokenHash: digest(token), userId: `user_${digest(normalised)}` });
  return { request, developmentToken: token };
}

export function consumeMagicLink(requestId: string, token: string, now = new Date()): Actor | null {
  if (!isDevelopmentWorkflowEnabled()) return null;
  const entry = links.get(requestId);
  if (!entry || entry.request.consumedAt || Date.parse(entry.request.expiresAt) <= now.getTime() || entry.tokenHash !== digest(token)) return null;
  entry.request.consumedAt = now.toISOString();
  return { userId: entry.userId, role: 'customer', organizationIds: [] };
}

export function createDevelopmentSession(actor: Actor): string {
  assertDevelopmentWorkflowEnabled();
  const session = `dev_session_${crypto.randomUUID()}`;
  sessions.set(session, actor);
  return session;
}

export function requireStaffMfa(actor: Actor, now = new Date(), maxAgeMs = 15 * 60 * 1000): void {
  if (actor.role !== 'staff' && actor.role !== 'admin') throw new Error('Staff access is required.');
  const age = actor.mfaVerifiedAt ? now.getTime() - Date.parse(actor.mfaVerifiedAt) : Number.POSITIVE_INFINITY;
  if (!Number.isFinite(age) || age < 0 || age > maxAgeMs) throw new Error('Recent staff MFA verification is required.');
}

export function actorFromHeaders(request: Request): Actor | null {
  if (!isDevelopmentWorkflowEnabled()) return null;
  const cookieSession = request.headers.get('cookie')?.match(/(?:^|;\s*)dev_session=([^;]+)/)?.[1];
  if (cookieSession && sessions.has(cookieSession)) return sessions.get(cookieSession)!;
  const userId = request.headers.get('x-development-user-id');
  const role = request.headers.get('x-development-role') as UserRole | null;
  if (!userId || !role || !['customer', 'staff', 'admin'].includes(role)) return null;
  const organizationIds = (request.headers.get('x-development-organizations') ?? '').split(',').map((item) => item.trim()).filter(Boolean);
  const mfaVerifiedAt = request.headers.get('x-development-mfa-at') ?? undefined;
  return { userId, role, organizationIds, mfaVerifiedAt };
}
