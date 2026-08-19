import type { APIRoute } from 'astro';
import { Resend } from 'resend';
import { runScan, normaliseTarget, type ScanResult, type Finding } from '@/lib/scanner';

export const prerender = false;

const TEAM_INBOX = 'snehal@webadish.com';
const OWNER_BCC = 'dilipparmar@gmail.com';
const FROM = 'WordPressRecovery.in <help@webadish.com>';

export const POST: APIRoute = async ({ request }) => {
  const body = await request.json().catch(() => null);
  const email = (body?.email || '').trim();
  const phone = (body?.phone || '').trim();
  const raw = body?.url;

  if (!email || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
    return json({ error: 'Please enter a valid email address.' }, 400);
  }
  if (!raw || typeof raw !== 'string') {
    return json({ error: 'Missing the scanned website address.' }, 400);
  }
  try {
    normaliseTarget(raw);
  } catch (e: any) {
    return json({ error: e?.message || 'Invalid website address.' }, 400);
  }

  // Re-run the scan server-side so the emailed report is authoritative.
  let result: ScanResult;
  try {
    result = await runScan(raw, { safeBrowsingKey: import.meta.env.SAFE_BROWSING_API_KEY });
  } catch {
    return json({ error: 'We could not complete the scan for your report. Please try again.' }, 500);
  }

  const apiKey = import.meta.env.RESEND_API_KEY;
  if (!apiKey) {
    // Still return the result so the UI can unlock; just skip emailing.
    return json({ ok: true, emailed: false, result }, 200);
  }

  const resend = new Resend(apiKey);
  const hot = result.verdict === 'infected';

  // 1) Hot-lead alert to the team.
  await resend.emails
    .send({
      from: FROM,
      to: [TEAM_INBOX],
      bcc: [OWNER_BCC],
      reply_to: email,
      subject: `${hot ? '🔴 HOT LEAD' : 'Scan lead'} – ${result.finalUrl} (${verdictLabel(result)})`,
      html: teamEmail(result, email, phone),
    })
    .catch((e) => console.error('Team lead email failed:', e));

  // 2) The visitor's own report.
  await resend.emails
    .send({
      from: FROM,
      to: [email],
      reply_to: TEAM_INBOX,
      subject: `Your WordPress security scan report – ${hostOf(result.finalUrl)}`,
      html: reportEmail(result),
    })
    .catch((e) => console.error('User report email failed:', e));

  return json({ ok: true, emailed: true, result }, 200);
};

// ---- helpers ----------------------------------------------------------------

function hostOf(u: string) {
  try { return new URL(u).host; } catch { return u; }
}

function verdictLabel(r: ScanResult) {
  return r.verdict === 'infected'
    ? `${r.counts.critical} critical`
    : r.verdict === 'warnings'
    ? `${r.counts.warning} warnings`
    : 'clean';
}

const sevColor = (s: Finding['severity']) =>
  s === 'critical' ? '#dc2626' : s === 'warning' ? '#d97706' : '#16a34a';
const sevLabel = (s: Finding['severity']) =>
  s === 'critical' ? 'CRITICAL' : s === 'warning' ? 'WARNING' : 'OK';

function findingsRows(r: ScanResult) {
  return r.findings
    .filter((f) => f.severity !== 'ok')
    .map(
      (f) => `
      <tr>
        <td style="padding:14px 16px;border:1px solid #e2e8f0;vertical-align:top;">
          <span style="display:inline-block;font-size:11px;font-weight:700;color:#fff;background:${sevColor(f.severity)};padding:2px 8px;border-radius:4px;">${sevLabel(f.severity)}</span>
          <div style="font-weight:600;margin:8px 0 4px;color:#0f172a;">${esc(f.title)}</div>
          <div style="font-size:13px;color:#475569;line-height:1.6;">${esc(f.detail)}</div>
          <div style="font-size:13px;color:#1d4ed8;line-height:1.6;margin-top:6px;"><strong>Fix:</strong> ${esc(f.recommendation)}</div>
        </td>
      </tr>`,
    )
    .join('');
}

function reportEmail(r: ScanResult) {
  const issues = r.findings.filter((f) => f.severity !== 'ok').length;
  const headline =
    r.verdict === 'infected'
      ? 'We found critical issues that need attention'
      : r.verdict === 'warnings'
      ? 'We found some warnings worth fixing'
      : 'No critical issues found on the homepage';
  return `
  <div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Arial,sans-serif;max-width:640px;margin:0 auto;color:#1e293b;">
    <div style="background:#0f172a;padding:24px 32px;border-radius:8px 8px 0 0;">
      <p style="color:#94a3b8;margin:0;font-size:13px;">WordPressRecovery.in · Security Scan Report</p>
      <h1 style="color:#fff;margin:8px 0 0;font-size:20px;">${esc(hostOf(r.finalUrl))}</h1>
    </div>
    <div style="border:1px solid #e2e8f0;border-top:none;padding:28px 32px;border-radius:0 0 8px 8px;">
      <p style="font-size:16px;font-weight:700;margin:0 0 4px;color:${r.verdict === 'clean' ? '#16a34a' : sevColor(r.verdict === 'infected' ? 'critical' : 'warning')};">${esc(headline)}</p>
      <p style="font-size:13px;color:#64748b;margin:0 0 20px;">Health score: ${r.score}/100 · ${r.counts.critical} critical, ${r.counts.warning} warnings · scanned ${new Date(r.scannedAt).toUTCString()}</p>

      ${issues ? `<table style="width:100%;border-collapse:collapse;margin-bottom:24px;">${findingsRows(r)}</table>` : `<p style="color:#475569;line-height:1.6;">Our homepage heuristics did not detect malware, blacklisting, or unwanted redirects. Note: this is a homepage-level scan, not a full file and database audit.</p>`}

      <div style="background:#eff6ff;border:1px solid #bfdbfe;border-radius:8px;padding:18px 20px;margin-top:8px;">
        <p style="margin:0 0 6px;font-weight:700;color:#1e3a8a;">Want us to fix this for you?</p>
        <p style="margin:0 0 12px;font-size:13px;color:#1e40af;line-height:1.6;">We remove malware, clear Google warnings, and harden your site — with a 30-day reinfection guarantee. Free diagnosis, fixed quote before any work.</p>
        <a href="https://wa.me/919998757045?text=I%20ran%20the%20scanner%20on%20${encodeURIComponent(hostOf(r.finalUrl))}%20and%20need%20help." style="display:inline-block;background:#16a34a;color:#fff;font-weight:700;text-decoration:none;padding:10px 20px;border-radius:8px;font-size:14px;">WhatsApp our team</a>
      </div>
      <p style="font-size:12px;color:#94a3b8;margin:20px 0 0;line-height:1.6;">This automated scan checks public, homepage-level signals only. A clean result does not guarantee a clean server; a flagged result is a strong indicator worth investigating. Reply to this email to talk to a human.</p>
    </div>
  </div>`;
}

function teamEmail(r: ScanResult, email: string, phone: string) {
  return `
  <div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Arial,sans-serif;max-width:640px;margin:0 auto;color:#1e293b;">
    <div style="background:${r.verdict === 'infected' ? '#7f1d1d' : '#0f172a'};padding:24px 32px;border-radius:8px 8px 0 0;">
      <p style="color:#cbd5e1;margin:0;font-size:13px;">Scanner Lead</p>
      <h1 style="color:#fff;margin:8px 0 0;font-size:20px;">${esc(hostOf(r.finalUrl))} — ${verdictLabel(r)}</h1>
    </div>
    <div style="border:1px solid #e2e8f0;border-top:none;padding:28px 32px;border-radius:0 0 8px 8px;">
      <table style="width:100%;border-collapse:collapse;margin-bottom:20px;">
        <tr><td style="padding:6px 0;color:#64748b;font-size:13px;width:110px;">Email</td><td style="padding:6px 0;"><a href="mailto:${esc(email)}" style="color:#1d4ed8;">${esc(email)}</a></td></tr>
        <tr><td style="padding:6px 0;color:#64748b;font-size:13px;">WhatsApp</td><td style="padding:6px 0;">${phone ? `<a href="https://wa.me/${phone.replace(/\D/g, '')}" style="color:#16a34a;font-weight:600;">${esc(phone)}</a>` : '<em style="color:#94a3b8">not provided</em>'}</td></tr>
        <tr><td style="padding:6px 0;color:#64748b;font-size:13px;">Site</td><td style="padding:6px 0;"><a href="${esc(r.finalUrl)}" style="color:#1d4ed8;">${esc(r.finalUrl)}</a></td></tr>
        <tr><td style="padding:6px 0;color:#64748b;font-size:13px;">Verdict</td><td style="padding:6px 0;font-weight:700;">${esc(r.verdict)} (score ${r.score}/100)</td></tr>
        <tr><td style="padding:6px 0;color:#64748b;font-size:13px;">WordPress</td><td style="padding:6px 0;">${r.isWordPress ? 'detected' : 'not detected'}</td></tr>
      </table>
      <table style="width:100%;border-collapse:collapse;">${findingsRows(r) || '<tr><td style="padding:10px;color:#64748b;">No non-OK findings.</td></tr>'}</table>
    </div>
  </div>`;
}

function esc(s: string) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
}

function json(data: unknown, status: number) {
  return new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });
}
