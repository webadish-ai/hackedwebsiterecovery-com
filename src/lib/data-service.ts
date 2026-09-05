import type { SupabaseClient } from '@supabase/supabase-js';
import type { Actor, AttachmentRecord, CaseEventRecord, CaseRecord } from './workflow-types.ts';
import { requireStaffMfa, isDevelopmentWorkflowEnabled } from './auth.ts';
import { developmentWorkflow } from './case-workflow.ts';
import { getPublicSupabaseConfig } from './supabase.ts';
import { createClient } from '@supabase/supabase-js';
import type { Database } from './database.types.ts';

type AttachmentRow = Database['public']['Tables']['attachments']['Row'];

export interface CaseDataService {
  readonly kind: 'supabase' | 'development';
  listCustomerCases(actor: Actor): Promise<CaseRecord[]>;
  customerTimeline(caseId: string, actor: Actor): Promise<CaseEventRecord[]>;
  internalTimeline(caseId: string, actor: Actor): Promise<CaseEventRecord[]>;
  listAttachments(caseId: string, actor: Actor): Promise<AttachmentRecord[]>;
  reportDownload(attachmentId: string, actor: Actor): Promise<{ attachmentId: string; expiresAt: string; signedUrl?: string; downloadToken?: string }>;
}

export class DevelopmentCaseDataService implements CaseDataService {
  readonly kind = 'development' as const;
  listCustomerCases(actor: Actor) { if (actor.role === 'staff' || actor.role === 'admin') requireStaffMfa(actor); return Promise.resolve([...developmentWorkflow.cases.values()].filter((item) => actor.role !== 'customer' || actor.organizationIds.includes(item.organizationId))); }
  customerTimeline(caseId: string, actor: Actor) { return Promise.resolve(developmentWorkflow.customerTimeline(caseId, actor)); }
  internalTimeline(caseId: string, actor: Actor) { return Promise.resolve(developmentWorkflow.internalTimeline(caseId, actor)); }
  listAttachments(caseId: string, actor: Actor) { return Promise.resolve(developmentWorkflow.listAttachments(caseId, actor)); }
  reportDownload(attachmentId: string, actor: Actor) { return Promise.resolve(developmentWorkflow.createReportDownload(attachmentId, actor)); }
}

export class SupabaseCaseDataService implements CaseDataService {
  readonly kind = 'supabase' as const;
  private readonly client: SupabaseClient<Database>;
  constructor(client: SupabaseClient<Database>) { this.client = client; }

  async listCustomerCases(actor: Actor): Promise<CaseRecord[]> {
    if (actor.role !== 'customer' && actor.role !== 'staff' && actor.role !== 'admin') throw new Error('Authenticated access is required.');
    if (actor.role === 'staff' || actor.role === 'admin') requireStaffMfa(actor);
    let query = this.client.from('cases').select('*');
    if (actor.role === 'customer') query = query.in('organization_id', actor.organizationIds);
    const result = await query.order('response_deadline_at', { ascending: true });
    if (result.error) throw result.error;
    return (result.data ?? []).map(mapCase);
  }

  async customerTimeline(caseId: string, actor: Actor): Promise<CaseEventRecord[]> {
    let query = this.client.from('case_events').select('*').eq('case_id', caseId).eq('customer_visible', true);
    if (actor.role === 'customer') query = query.in('organization_id', actor.organizationIds);
    const result = await query.order('created_at', { ascending: true });
    if (result.error) throw result.error;
    return (result.data ?? []).map(mapEvent);
  }

  async internalTimeline(caseId: string, actor: Actor): Promise<CaseEventRecord[]> {
    requireStaffMfa(actor);
    const result = await this.client.from('case_events').select('*').eq('case_id', caseId).order('created_at', { ascending: true });
    if (result.error) throw result.error;
    return (result.data ?? []).map(mapEvent);
  }

  async listAttachments(caseId: string, actor: Actor): Promise<AttachmentRecord[]> {
    if (actor.role === 'staff' || actor.role === 'admin') requireStaffMfa(actor);
    let query = this.client.from('attachments').select('*').eq('case_id', caseId).order('created_at', { ascending: true });
    if (actor.role === 'customer') query = query.eq('customer_visible', true);
    const result = await query as unknown as { data: AttachmentRow[] | null; error: Error | null };
    if (result.error) throw result.error;
    return (result.data ?? []).map((row) => ({ id: row.id, organizationId: row.organization_id, caseId: row.case_id, kind: row.kind as AttachmentRecord['kind'], storagePath: row.storage_path, contentType: row.content_type, byteSize: Number(row.byte_size), customerVisible: row.customer_visible, scanState: row.scan_state as AttachmentRecord['scanState'], createdAt: row.created_at }));
  }

  async reportDownload(attachmentId: string, actor: Actor) {
    if (actor.role === 'staff' || actor.role === 'admin') requireStaffMfa(actor);
    let query = this.client.from('attachments').select('id,storage_path,customer_visible').eq('id', attachmentId).eq('scan_state', 'clean');
    if (actor.role === 'customer') query = query.eq('customer_visible', true);
    const result = await query.maybeSingle() as unknown as { data: Pick<AttachmentRow, 'id' | 'storage_path'> | null; error: Error | null };
    if (result.error || !result.data) throw new Error('Report not found.');
    const bucket = process.env.SUPABASE_REPORTS_BUCKET ?? 'case-reports';
    const signed = await this.client.storage.from(bucket).createSignedUrl(result.data.storage_path, 300);
    if (signed.error || !signed.data?.signedUrl) throw new Error('Report download is unavailable.');
    return { attachmentId: result.data.id, expiresAt: new Date(Date.now() + 5 * 60 * 1000).toISOString(), signedUrl: signed.data.signedUrl };
  }
}

export function getCaseDataService(input: { client?: SupabaseClient<Database> | null; env?: Record<string, string | undefined> } = {}): CaseDataService | null {
  if (input.client) return new SupabaseCaseDataService(input.client);
  const config = getPublicSupabaseConfig(input.env ?? process.env);
  if (config) return new SupabaseCaseDataService(createClient<Database>(config.url, config.anonKey));
  return isDevelopmentWorkflowEnabled(input.env ?? process.env) ? new DevelopmentCaseDataService() : null;
}

function mapCase(row: Database['public']['Tables']['cases']['Row']): CaseRecord {
  return { id: row.id, organizationId: row.organization_id, orderId: row.order_id, siteId: row.site_id, status: row.status, assignedStaffId: row.assigned_staff_id ?? undefined, paymentVerifiedAt: row.payment_verified_at ?? undefined, accessUsableAt: row.access_usable_at ?? undefined, responseDeadlineAt: row.response_deadline_at ?? undefined, createdAt: row.created_at, updatedAt: row.updated_at };
}
function mapEvent(row: Database['public']['Tables']['case_events']['Row']): CaseEventRecord {
  return { id: row.id, caseId: row.case_id, organizationId: row.organization_id, type: row.type, fromStatus: row.from_status ?? undefined, toStatus: row.to_status ?? undefined, body: row.body, customerVisible: row.customer_visible, actorUserId: row.actor_user_id, createdAt: row.created_at };
}
