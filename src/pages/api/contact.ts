import type { APIRoute } from 'astro';
import { Resend } from 'resend';

export const prerender = false;

export const POST: APIRoute = async ({ request }) => {
  const body = await request.json().catch(() => null);

  if (!body?.name || !body?.email || !body?.problem) {
    return new Response(JSON.stringify({ error: 'Missing required fields' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  const apiKey = import.meta.env.RESEND_API_KEY;
  if (!apiKey) {
    return new Response(JSON.stringify({ error: 'Email service not configured' }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  const resend = new Resend(apiKey);

  const { error } = await resend.emails.send({
    from: 'WordPressRecovery.in <help@webadish.com>',
    to: ['snehal@webadish.com'],
    bcc: ['dilipparmar@gmail.com'],
    reply_to: body.email,
    subject: `Emergency Recovery Request – ${body.website || body.email}`,
    html: `
      <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Arial, sans-serif; max-width: 600px; margin: 0 auto; color: #1e293b;">
        <div style="background: #0f172a; padding: 24px 32px; border-radius: 8px 8px 0 0;">
          <p style="color: #94a3b8; margin: 0; font-size: 13px;">WordPressRecovery.in</p>
          <h1 style="color: #ffffff; margin: 8px 0 0; font-size: 20px;">New Emergency Recovery Request</h1>
        </div>
        <div style="border: 1px solid #e2e8f0; border-top: none; padding: 32px; border-radius: 0 0 8px 8px;">
          <table style="width: 100%; border-collapse: collapse; margin-bottom: 24px;">
            <tr><td style="padding: 8px 0; color: #64748b; font-size: 13px; width: 110px;">Name</td><td style="padding: 8px 0; font-weight: 600;">${body.name}</td></tr>
            <tr><td style="padding: 8px 0; color: #64748b; font-size: 13px;">Email</td><td style="padding: 8px 0;"><a href="mailto:${body.email}" style="color: #1d4ed8;">${body.email}</a></td></tr>
            <tr><td style="padding: 8px 0; color: #64748b; font-size: 13px;">WhatsApp</td><td style="padding: 8px 0;">${body.phone ? `<a href="https://wa.me/${body.phone.replace(/\D/g, '')}" style="color: #16a34a; font-weight: 600;">${body.phone}</a>` : '<em style="color:#94a3b8">not provided</em>'}</td></tr>
            <tr><td style="padding: 8px 0; color: #64748b; font-size: 13px;">Website</td><td style="padding: 8px 0;">${body.website ? `<a href="${body.website}" style="color: #1d4ed8;">${body.website}</a>` : '<em style="color:#94a3b8">not provided</em>'}</td></tr>
          </table>
          <div style="background: #fef9c3; border: 1px solid #fde047; border-radius: 8px; padding: 16px 20px;">
            <p style="margin: 0 0 8px; font-size: 13px; color: #713f12; font-weight: 600;">PROBLEM REPORTED</p>
            <p style="margin: 0; line-height: 1.6; white-space: pre-wrap;">${body.problem}</p>
          </div>
          <p style="margin: 24px 0 0; font-size: 13px; color: #94a3b8;">Reply directly to this email to respond to ${body.name}.</p>
        </div>
      </div>
    `,
  });

  if (error) {
    console.error('Resend error:', error);
    return new Response(JSON.stringify({ error: 'Failed to send email' }), {
      status: 502,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  return new Response(JSON.stringify({ ok: true }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
};
