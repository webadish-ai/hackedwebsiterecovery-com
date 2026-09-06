export type UserRole = 'customer' | 'staff' | 'admin';

export type CaseStatus =
  | 'awaiting_payment'
  | 'awaiting_access'
  | 'triage'
  | 'awaiting_approval'
  | 'in_progress'
  | 'verification'
  | 'monitoring'
  | 'completed'
  | 'quoted_separately'
  | 'refunded'
  | 'cancelled';

export type PaymentState = 'pending' | 'verified' | 'failed' | 'refunded';
export type AccessState = 'not_requested' | 'requested' | 'usable' | 'revoked';
export type MembershipRole = 'owner' | 'member' | 'agency_admin';
export type AttachmentKind = 'host_report' | 'final_report' | 'invoice';

export interface Actor {
  userId: string;
  role: UserRole;
  organizationIds: string[];
  mfaVerifiedAt?: string;
}
export interface Organization {
  id: string;
  name: string;
  kind: 'owner' | 'agency';
}

export interface OrderRecord {
  id: string;
  organizationId: string;
  customerUserId: string;
  planId: string;
  planVersion: string;
  quantity: number;
  subtotalPaise: number;
  gstPaise: number;
  totalPaise: number;
  termsVersion: string;
  paymentState: PaymentState;
  paidAt?: string;
}

export interface SiteRecord {
  id: string;
  organizationId: string;
  orderId: string;
  url: string;
  accessState: AccessState;
}

export interface CaseRecord {
  id: string;
  organizationId: string;
  orderId: string;
  siteId: string;
  status: CaseStatus;
  assignedStaffId?: string;
  paymentVerifiedAt?: string;
  accessUsableAt?: string;
  responseDeadlineAt?: string;
  createdAt: string;
  updatedAt: string;
}

export interface CaseEventRecord {
  id: string;
  caseId: string;
  organizationId: string;
  type: string;
  fromStatus?: CaseStatus;
  toStatus?: CaseStatus;
  body: string;
  customerVisible: boolean;
  actorUserId: string;
  createdAt: string;
}

export interface AttachmentRecord {
  id: string;
  organizationId: string;
  caseId: string;
  kind: AttachmentKind;
  storagePath: string;
  contentType: string;
  byteSize: number;
  customerVisible: boolean;
  createdAt: string;
}
