// Lightweight, dependency-free "is my WordPress site hacked?" scanner.
// Runs server-side: fetches the homepage + a few WordPress probe paths, then
// applies heuristic checks for blacklist status, malware/injection signals, and
// common WordPress hardening gaps. Designed to be cautious — clear infections are
// flagged 'critical', heuristic signals are 'warning' to avoid scaring clean sites.

export type Severity = 'critical' | 'warning' | 'ok';
export type Category = 'blacklist' | 'malware' | 'wordpress' | 'ssl';

export interface Finding {
  category: Category;
  severity: Severity;
  title: string;
  detail: string;          // shown in the gated detailed report
  recommendation: string;  // shown in the gated detailed report
}

export interface CategorySummary {
  key: Category;
  label: string;
  status: Severity | 'unknown';
  summary: string;
}

export interface ScanResult {
  url: string;
  finalUrl: string;
  scannedAt: string;
  reachable: boolean;
  isWordPress: boolean;
  verdict: 'clean' | 'warnings' | 'infected' | 'error';
  score: number; // 0–100 health score
  counts: { critical: number; warning: number; ok: number };
  categories: CategorySummary[];
  findings: Finding[];
  error?: string;
}

// Browser-like request headers. Many firewalls/WAFs return 403 to non-browser
// user-agents, which would otherwise produce false "suspended" results for sites
// that load perfectly in a real browser.
const BROWSER_HEADERS: Record<string, string> = {
  'User-Agent':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
  'Accept-Language': 'en-US,en;q=0.9',
  'Upgrade-Insecure-Requests': '1',
};
const FETCH_TIMEOUT_MS = 8000;
const MAX_BODY_BYTES = 2_000_000; // 2 MB cap

/** Normalise user input into a safe, public https/http URL or throw. */
export function normaliseTarget(raw: string): URL {
  let input = (raw || '').trim();
  if (!input) throw new Error('Please enter a website address.');
  if (!/^https?:\/\//i.test(input)) input = 'https://' + input;

  let u: URL;
  try {
    u = new URL(input);
  } catch {
    throw new Error('That does not look like a valid website address.');
  }

  if (u.protocol !== 'http:' && u.protocol !== 'https:') {
    throw new Error('Only http and https websites can be scanned.');
  }

  const host = u.hostname.toLowerCase();

  // SSRF guards: block local / private / metadata targets.
  const blocked =
    host === 'localhost' ||
    host.endsWith('.local') ||
    host.endsWith('.internal') ||
    !host.includes('.') ||                       // single-label hostnames
    host === '0.0.0.0' ||
    host === '::1' ||
    host === '169.254.169.254' ||                // cloud metadata
    /^127\./.test(host) ||
    /^10\./.test(host) ||
    /^192\.168\./.test(host) ||
    /^169\.254\./.test(host) ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(host);

  if (blocked) throw new Error('That address cannot be scanned. Enter a public website domain.');

  return u;
}

interface FetchOutcome {
  ok: boolean;
  status: number;
  finalUrl: string;
  headers: Headers | null;
  body: string;
  error?: string;
}

async function safeFetch(url: string, method: 'GET' | 'HEAD' = 'GET'): Promise<FetchOutcome> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      method,
      redirect: 'follow',
      signal: controller.signal,
      headers: BROWSER_HEADERS,
    });

    let body = '';
    if (method === 'GET' && res.body) {
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let received = 0;
      // eslint-disable-next-line no-constant-condition
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        received += value.byteLength;
        body += decoder.decode(value, { stream: true });
        if (received >= MAX_BODY_BYTES) {
          await reader.cancel().catch(() => {});
          break;
        }
      }
    }

    return { ok: res.ok, status: res.status, finalUrl: res.url || url, headers: res.headers, body };
  } catch (e: any) {
    return {
      ok: false,
      status: 0,
      finalUrl: url,
      headers: null,
      body: '',
      error: e?.name === 'AbortError' ? 'timeout' : (e?.message || 'fetch failed'),
    };
  } finally {
    clearTimeout(timer);
  }
}

// ---- Heuristic check helpers -------------------------------------------------

const OBFUSCATION_PATTERNS: { re: RegExp; label: string }[] = [
  { re: /eval\s*\(\s*(?:atob|unescape|String\.fromCharCode|function)/i, label: 'eval() of decoded/obfuscated code' },
  { re: /document\.write\s*\(\s*unescape\s*\(/i, label: 'document.write(unescape(...))' },
  { re: /String\.fromCharCode\((?:\s*\d+\s*,){15,}/i, label: 'long String.fromCharCode payload' },
  { re: /\\x[0-9a-f]{2}(?:\\x[0-9a-f]{2}){20,}/i, label: 'long hex-encoded string' },
  { re: /(?:var|let|const)\s+_0x[a-f0-9]{4,}/i, label: 'obfuscated _0x variable (packed JS)' },
  { re: /atob\s*\(\s*['"][A-Za-z0-9+/=]{120,}/i, label: 'large base64 blob passed to atob()' },
];

const SPAM_KEYWORDS = [
  'viagra', 'cialis', 'pharmacy', 'casino', 'poker', 'payday loan', 'replica watches', 'escort',
];

const KNOWN_BAD_SNIPPETS: { re: RegExp; label: string }[] = [
  { re: /coinhive|coin-hive|cryptonight|cryptoloot/i, label: 'cryptominer script' },
  { re: /\.top\/[a-z0-9]{6,}\.js/i, label: 'script from a suspicious .top domain' },
  { re: /megalayer|wp-vcd|class\.wp\.php|wp-tmp\.php/i, label: 'known WordPress malware marker (wp-vcd family)' },
];

// Identify when a 403/503 is a firewall / bot-protection block rather than a
// genuine outage or suspension. Returns the provider name, or null.
function detectFirewall(headers: Headers | null, body: string, status: number): string | null {
  const h = (n: string) => (headers?.get(n) || '').toLowerCase();
  const server = h('server');
  const b = (body || '').toLowerCase();

  if (h('cf-ray') || h('cf-mitigated') || server.includes('cloudflare') ||
      b.includes('attention required') || b.includes('cloudflare') ||
      b.includes('just a moment') || b.includes('cf-browser-verification')) return 'Cloudflare';
  if (h('x-sucuri-id') || h('x-sucuri-block') || b.includes('sucuri website firewall') ||
      b.includes('access denied - sucuri')) return 'Sucuri';
  if (h('x-iinfo') || server.includes('incapsula') || b.includes('incapsula') || b.includes('imperva')) return 'Imperva / Incapsula';
  if (server.includes('akamaighost') || server.includes('akamai')) return 'Akamai';
  if (h('x-amzn-waf-action') || server.includes('awselb')) return 'AWS WAF';
  if (b.includes('wordfence') || b.includes('generated by wordfence')) return 'Wordfence';
  if (status === 403 && (b.includes('web application firewall') || b.includes('access denied') ||
      b.includes('request blocked') || b.includes('forbidden'))) return 'a web application firewall';
  return null;
}

function detectWordPress(html: string, headers: Headers | null): boolean {
  if (/wp-content|wp-includes|\/wp-json\//i.test(html)) return true;
  if (/<meta[^>]+name=["']generator["'][^>]+WordPress/i.test(html)) return true;
  const link = headers?.get('link') || '';
  if (/wp\.me|\/wp-json\//i.test(link)) return true;
  return false;
}

// ---- Google Safe Browsing (optional, needs API key) --------------------------

async function checkSafeBrowsing(url: string, apiKey?: string): Promise<Finding | null | 'unknown'> {
  if (!apiKey) return 'unknown';
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(
      `https://safebrowsing.googleapis.com/v4/threatMatches:find?key=${encodeURIComponent(apiKey)}`,
      {
        method: 'POST',
        signal: controller.signal,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          client: { clientId: 'wordpressrecovery-in', clientVersion: '1.0' },
          threatInfo: {
            threatTypes: ['MALWARE', 'SOCIAL_ENGINEERING', 'UNWANTED_SOFTWARE', 'POTENTIALLY_HARMFUL_APPLICATION'],
            platformTypes: ['ANY_PLATFORM'],
            threatEntryTypes: ['URL'],
            threatEntries: [{ url }],
          },
        }),
      },
    );
    if (!res.ok) return 'unknown';
    const data = await res.json().catch(() => ({}));
    if (data?.matches?.length) {
      const types = [...new Set(data.matches.map((m: any) => m.threatType))].join(', ');
      return {
        category: 'blacklist',
        severity: 'critical',
        title: 'Flagged by Google Safe Browsing',
        detail: `Google Safe Browsing currently lists this site as a threat (${types}). Visitors see a red "deceptive site" or "site may be hacked" warning, and traffic collapses while the flag is live.`,
        recommendation: 'Remove the malware causing the flag, then submit a reconsideration request in Google Search Console. This is included in our cleanup service.',
      };
    }
    return null; // clean
  } catch {
    return 'unknown';
  } finally {
    clearTimeout(timer);
  }
}

// ---- Main entry --------------------------------------------------------------

export async function runScan(rawUrl: string, opts: { safeBrowsingKey?: string } = {}): Promise<ScanResult> {
  const target = normaliseTarget(rawUrl);
  const base = `${target.protocol}//${target.host}`;
  const scannedAt = new Date().toISOString();

  const home = await safeFetch(target.href, 'GET');

  if (!home.ok && home.status === 0) {
    return {
      url: target.href,
      finalUrl: home.finalUrl,
      scannedAt,
      reachable: false,
      isWordPress: false,
      verdict: 'error',
      score: 0,
      counts: { critical: 0, warning: 0, ok: 0 },
      categories: [],
      findings: [],
      error:
        home.error === 'timeout'
          ? 'The site took too long to respond. It may be down, suspended, or blocking automated requests.'
          : 'We could not reach this site. Check the address, or it may be offline or suspended.',
    };
  }

  const html = home.body || '';
  const headers = home.headers;
  // A 403/503 to our scanner is usually firewall/bot protection, not a real
  // outage — detect it so we don't cry "suspended" on a healthy site.
  const blocked = home.status === 403 || home.status === 503;
  const firewall = blocked ? detectFirewall(headers, html, home.status) : null;
  const isWordPress = !blocked && detectWordPress(html, headers);

  // Probe a few WordPress paths in parallel (cheap, polite set).
  const [readme, uploads, configBak] = await Promise.all([
    safeFetch(`${base}/readme.html`, 'GET'),
    safeFetch(`${base}/wp-content/uploads/`, 'GET'),
    safeFetch(`${base}/wp-config.php.bak`, 'GET'),
  ]);

  const sb = await checkSafeBrowsing(target.href, opts.safeBrowsingKey);

  const findings: Finding[] = [];
  let blacklistKnown = true;

  // --- Blacklist ---
  if (sb === 'unknown') {
    blacklistKnown = false;
  } else if (sb) {
    findings.push(sb);
  }

  // --- Reachability / hosting state ---
  if (blocked && firewall) {
    findings.push({
      category: 'ssl',
      severity: 'warning',
      title: `Scan blocked by ${firewall}`,
      detail: `The site is protected by ${firewall}, which blocked our automated scanner (HTTP ${home.status}). This is a good sign — a firewall is a positive security control — but it means we could not fully inspect the homepage from here. If the site loads normally in your browser, it is not suspended.`,
      recommendation: 'No action needed for this item if the site loads in a browser. For a complete check behind the firewall, we can scan with hosting access or from an allow-listed source.',
    });
  } else if (blocked) {
    findings.push({
      category: 'ssl',
      severity: 'warning',
      title: `Site returned HTTP ${home.status} to our scanner`,
      detail: `The homepage responded with status ${home.status}. This usually means bot or firewall protection blocked our scanner — or, less often, the hosting account is suspended. If the site loads fine in your browser, it is almost certainly bot/firewall protection rather than a hack.`,
      recommendation: 'If the site does NOT load in a browser either, it may be suspended and needs cleaning to your host’s requirements. If it loads fine, no action is needed for this item.',
    });
  }

  // --- SSL / headers ---
  const isHttps = home.finalUrl.startsWith('https://');
  if (!isHttps) {
    findings.push({
      category: 'ssl',
      severity: 'warning',
      title: 'No HTTPS / SSL',
      detail: 'The site loaded over plain HTTP. Browsers mark it "Not secure" and any login or checkout data is sent unencrypted.',
      recommendation: 'Install a valid SSL certificate (most hosts offer free Let’s Encrypt) and force HTTPS.',
    });
  } else if (home.ok) {
    // Only judge security headers off a genuine 2xx homepage — a firewall block
    // page's headers are not the site's real headers.
    const hsts = headers?.get('strict-transport-security');
    const xcto = headers?.get('x-content-type-options');
    const xfo = headers?.get('x-frame-options');
    const missing: string[] = [];
    if (!hsts) missing.push('Strict-Transport-Security');
    if (!xcto) missing.push('X-Content-Type-Options');
    if (!xfo) missing.push('X-Frame-Options');
    if (missing.length) {
      findings.push({
        category: 'ssl',
        severity: 'warning',
        title: 'Missing security headers',
        detail: `These hardening headers are not set: ${missing.join(', ')}. They help defend against clickjacking, MIME sniffing, and protocol-downgrade attacks.`,
        recommendation: 'Add the missing security headers at the server or via a security plugin as part of hardening.',
      });
    }
  }

  // --- WordPress exposure ---
  if (isWordPress) {
    const genMatch = html.match(/<meta[^>]+name=["']generator["'][^>]+content=["']WordPress\s+([\d.]+)/i);
    const readmeVer = readme.ok ? (readme.body.match(/Version\s+([\d.]+)/i)?.[1] || null) : null;
    const exposedVersion = genMatch?.[1] || readmeVer;
    if (exposedVersion) {
      findings.push({
        category: 'wordpress',
        severity: 'warning',
        title: `WordPress version exposed (${exposedVersion})`,
        detail: `Your WordPress version (${exposedVersion}) is publicly visible${readmeVer ? ' via /readme.html' : ' via the generator meta tag'}. Attackers use this to target version-specific exploits.`,
        recommendation: 'Remove the generator meta tag and delete or block /readme.html, and keep WordPress core updated.',
      });
    }

    if (uploads.ok && /<title>Index of|Directory listing for|\[PARENTDIR\]/i.test(uploads.body)) {
      findings.push({
        category: 'wordpress',
        severity: 'warning',
        title: 'Directory listing enabled on uploads',
        detail: 'Your /wp-content/uploads/ directory shows a public file listing. This exposes your media and can reveal malicious files dropped by an attacker.',
        recommendation: 'Disable directory indexing (Options -Indexes) at the server or via .htaccess.',
      });
    }

    if (configBak.ok && /DB_PASSWORD|DB_NAME|table_prefix/i.test(configBak.body)) {
      findings.push({
        category: 'wordpress',
        severity: 'critical',
        title: 'Exposed wp-config backup file',
        detail: 'A backup of wp-config.php (wp-config.php.bak) is publicly downloadable and contains your database credentials. This is a severe exposure that can lead to full site takeover.',
        recommendation: 'Delete the exposed backup immediately and rotate your database password and WordPress salts.',
      });
    }
  }

  // --- Malware / injection signals in the HTML (only on a genuine page load) ---
  if (home.ok && !blocked) {
  for (const p of OBFUSCATION_PATTERNS) {
    if (p.re.test(html)) {
      findings.push({
        category: 'malware',
        severity: 'warning',
        title: 'Obfuscated JavaScript detected',
        detail: `The page contains ${p.label}. Obfuscated code is a strong indicator of injected malware, though some legitimate scripts are also minified.`,
        recommendation: 'Have the obfuscated code reviewed and removed if malicious, and scan the full file system for backdoors.',
      });
      break; // one obfuscation finding is enough
    }
  }

  for (const p of KNOWN_BAD_SNIPPETS) {
    if (p.re.test(html)) {
      findings.push({
        category: 'malware',
        severity: 'critical',
        title: 'Known malware signature found',
        detail: `The page matches a ${p.label} — a known malicious pattern. This strongly indicates the site is actively infected.`,
        recommendation: 'Take a backup and begin a full malware cleanup and backdoor removal immediately.',
      });
      break;
    }
  }

  const lowerHtml = html.toLowerCase();
  const foundSpam = SPAM_KEYWORDS.filter((k) => lowerHtml.includes(k));
  if (foundSpam.length >= 2) {
    findings.push({
      category: 'malware',
      severity: 'critical',
      title: 'Pharma/spam keywords injected',
      detail: `The page contains spam keywords (${foundSpam.slice(0, 4).join(', ')}). Injected pharma/casino spam is a classic sign of a hacked WordPress site.`,
      recommendation: 'Clean the injected content from files and database, then close the entry point so it cannot return.',
    });
  }

  // Japanese SEO spam heuristic: Japanese characters in <title> on a non-JP TLD.
  const titleText = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] || '';
  const hasJapanese = /[぀-ヿ一-龯]/.test(titleText);
  if (hasJapanese && !target.hostname.endsWith('.jp')) {
    findings.push({
      category: 'malware',
      severity: 'critical',
      title: 'Possible Japanese keyword hack',
      detail: 'The page title contains Japanese characters, but the domain is not a Japanese site. This is the signature of the Japanese keyword (SEO spam) hack.',
      recommendation: 'Remove the spam-page generator and backdoors, clean Search Console, and harden the entry point.',
    });
  }

  // Meta-refresh / JS redirect to an external host.
  const metaRefresh = html.match(/<meta[^>]+http-equiv=["']refresh["'][^>]+url=([^"'>\s]+)/i)?.[1];
  if (metaRefresh && /^https?:\/\//i.test(metaRefresh) && !metaRefresh.includes(target.hostname)) {
    findings.push({
      category: 'malware',
      severity: 'critical',
      title: 'Redirect to an external site',
      detail: `The homepage attempts to redirect visitors to an external address (${metaRefresh.slice(0, 80)}). Unwanted external redirects are a hallmark of a redirect-virus infection.`,
      recommendation: 'Trace and remove the redirect at its source (.htaccess, database, or backdoor), not just the visible code.',
    });
  }
  } // end malware heuristics (home.ok && !blocked)

  // --- Positive "ok" markers so a clean site shows green checks ---
  if (home.ok && !blocked && !findings.some((f) => f.category === 'malware')) {
    findings.push({ category: 'malware', severity: 'ok', title: 'No obvious malware signals on the homepage', detail: 'Our homepage heuristics did not detect injected spam, obfuscated malware, or unwanted redirects.', recommendation: 'A homepage scan is not a full file/database audit — a clean result here does not guarantee a clean server.' });
  }
  if (blacklistKnown && !findings.some((f) => f.category === 'blacklist')) {
    findings.push({ category: 'blacklist', severity: 'ok', title: 'Not on Google Safe Browsing blacklist', detail: 'Google Safe Browsing did not return a threat match for this URL.', recommendation: 'Keep the site clean and monitored so it stays off blacklists.' });
  }
  if (isHttps && !findings.some((f) => f.category === 'ssl')) {
    findings.push({ category: 'ssl', severity: 'ok', title: 'HTTPS and core security headers present', detail: 'The site loads over HTTPS with the key hardening headers set.', recommendation: 'Maintain your certificate and headers.' });
  }

  // --- Roll up ---
  const counts = {
    critical: findings.filter((f) => f.severity === 'critical').length,
    warning: findings.filter((f) => f.severity === 'warning').length,
    ok: findings.filter((f) => f.severity === 'ok').length,
  };

  const verdict: ScanResult['verdict'] =
    counts.critical > 0 ? 'infected' : counts.warning > 0 ? 'warnings' : 'clean';

  const score = Math.max(0, 100 - counts.critical * 30 - counts.warning * 10);

  const categories: CategorySummary[] = (['blacklist', 'malware', 'wordpress', 'ssl'] as Category[]).map((key) => {
    const label = { blacklist: 'Google Blacklist', malware: 'Malware & Injection', wordpress: 'WordPress Hardening', ssl: 'SSL & Headers' }[key];
    const inCat = findings.filter((f) => f.category === key);
    if (key === 'blacklist' && !blacklistKnown) {
      return { key, label, status: 'unknown', summary: 'Live blacklist check not configured' };
    }
    if (blocked && (key === 'malware' || key === 'wordpress')) {
      return { key, label, status: 'unknown', summary: 'Could not scan — site is firewall-protected' };
    }
    if (key === 'wordpress' && !isWordPress) {
      return { key, label, status: 'ok', summary: 'WordPress not detected on this URL' };
    }
    const worst: Severity = inCat.some((f) => f.severity === 'critical')
      ? 'critical'
      : inCat.some((f) => f.severity === 'warning')
      ? 'warning'
      : 'ok';
    const crit = inCat.filter((f) => f.severity === 'critical').length;
    const warn = inCat.filter((f) => f.severity === 'warning').length;
    const summary =
      worst === 'critical' ? `${crit} critical issue${crit > 1 ? 's' : ''} found`
      : worst === 'warning' ? `${warn} warning${warn > 1 ? 's' : ''} found`
      : 'No issues detected';
    return { key, label, status: worst, summary };
  });

  return {
    url: target.href,
    finalUrl: home.finalUrl,
    scannedAt,
    reachable: true,
    isWordPress,
    verdict,
    score,
    counts,
    categories,
    findings,
  };
}
