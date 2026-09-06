export type NotificationKind = 'magic_link' | 'case_update' | 'response_due' | 'report_ready';
export interface NotificationRequest { kind: NotificationKind; recipientUserId: string; caseId?: string; templateData: Record<string, string>; }

// Notification delivery is deliberately an interface. The development adapter
// records safe metadata only; production wiring can use Resend/Supabase Edge Functions.
export interface NotificationAdapter { send(request: NotificationRequest): Promise<void>; }
export class DevelopmentNotificationAdapter implements NotificationAdapter {
  readonly sent: NotificationRequest[] = [];
  async send(request: NotificationRequest): Promise<void> { this.sent.push({ ...request, templateData: { ...request.templateData } }); }
}
export const notifications = new DevelopmentNotificationAdapter();
