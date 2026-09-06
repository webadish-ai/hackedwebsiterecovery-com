// High-accuracy WordPress security & SEO hijack scanner.
// Runs server-side: fetches the homepage (both as browser and Googlebot for cloaking detection)
// + WordPress probe paths, then applies heuristic checks for blacklist status, malware signatures,
// SEO hijacks (casino/gambling spam, pharma hack, Japanese keyword hack, hidden link farms),
// cloaking differentials, and WordPress hardening gaps.

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
// user-agents, which would otherwise produce false "suspended" results.
const BROWSER_HEADERS: Record<string, string> = {
  'User-Agent':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
  'Accept-Language': 'en-US,en;q=0.9',
  'Upgrade-Insecure-Requests': '1',
};

// Googlebot request headers to detect conditional search engine cloaking.
const BOT_HEADERS: Record<string, string> = {
  'User-Agent': 'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)',
  Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'Accept-Language': 'en-US,en;q=0.9',
  Referer: 'https://www.google.com/',
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

async function safeFetch(
  url: string,
  method: 'GET' | 'HEAD' = 'GET',
  customHeaders: Record<string, string> = BROWSER_HEADERS
): Promise<FetchOutcome> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      method,
      redirect: 'follow',
      signal: controller.signal,
      headers: customHeaders,
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

// ---- Detection Pattern Dictionaries -----------------------------------------

const OBFUSCATION_PATTERNS: { re: RegExp; label: string }[] = [
  { re: /eval\s*\(\s*(?:atob|unescape|String\.fromCharCode|function)/i, label: 'eval() of decoded/obfuscated code' },
  { re: /document\.write\s*\(\s*unescape\s*\(/i, label: 'document.write(unescape(...))' },
  { re: /String\.fromCharCode\((?:\s*\d+\s*,){15,}/i, label: 'long String.fromCharCode payload' },
  { re: /\\x[0-9a-f]{2}(?:\\x[0-9a-f]{2}){20,}/i, label: 'long hex-encoded string' },
  { re: /(?:var|let|const)\s+_0x[a-f0-9]{4,}/i, label: 'obfuscated _0x variable (packed JS)' },
  { re: /atob\s*\(\s*['"][A-Za-z0-9+/=]{120,}/i, label: 'large base64 blob passed to atob()' },
];

// High-confidence Casino, Gambling, and Slot keywords (English, Indonesian, Asian hacks)
const CASINO_SLOT_PHRASES = [
  // Indonesian / Asian slot spam (extremely common in WordPress hacks)
  'slot gacor', 'judi online', 'situs slot', 'slot online', 'bandar togel', 'toto macau', 'agen judi',
  'daftar slot', 'link gacor', 'bocoran slot', 'slot88', 'slot deposit', 'pragmatic play', 'pg soft',
  'maxwin', 'rtp live', 'rtp slot', 'judi slot', 'taruhan bola', 'agen slot', 'situs judi',
  'bonus new member', 'deposit pulsa', 'menang jackpot', 'slot pulsa', 'togel online', 'agen togel',
  'bonanza138', 'pakar69', 'bigo234', 'pangkalantoto', 'sbobettop',
  // English casino & betting
  'online casino', 'slot machine', 'casino bonus', 'free spins', 'no deposit bonus', 'baccarat online',
  'roulette online', 'poker online', 'sportsbook', 'sports betting', 'betting odds', 'live casino',
  'bet online', 'sbobet', 'jackpot games', 'crypto casino', 'gambling site',
  // Thai & Vietnamese gambling keywords
  'สล็อต', 'คาสิโน', 'แทงบอล', 'เว็บบอล', 'บาคาร่า', 'nhà cái', 'cá cược', 'game bài', 'nổ hũ',
  // Adult / Escort / MMS spam injections
  'desi mms', 'aagmaal', 'escort service', 'call girls', 'adult webcam', 'sex chat', 'xxx video', 'porn video'
];

// Pharma spam phrases and high-risk terms
const PHARMA_PHRASES = [
  'buy viagra', 'generic viagra', 'cheap viagra', 'buy cialis', 'generic cialis', 'cheap cialis',
  'buy levitra', 'kamagra online', 'tramadol without prescription', 'buy phentermine',
  'canadian pharmacy online', 'no prescription pharmacy', 'buy modafinil', 'cialis without doctor prescription',
  'buy ambien online', 'cheap xanax online', 'buy ivermectin online'
];

const SINGLE_PHARMA_KEYWORDS = [
  'viagra', 'cialis', 'levitra', 'kamagra', 'tramadol', 'phentermine', 'ambien', 'xanax', 'modafinil'
];

// Japanese keyword hack terms (counterfeit luxury / shopping spam)
const JAPANESE_SPAM_TERMS = [
  '激安', '通販', '人気', '送料無料', '割引', '財布', '時計', 'ルイヴィトン', 'グッチ', 'シャネル',
  'スニーカー', '新作', '通販専門店', 'スーパーコピー', '偽物'
];

// Chinese doorway spam keywords
const CHINESE_GAMBLING_TERMS = [
  '博彩', '开奖', '澳门新葡京', '真人视讯', '六合彩', '皇冠体育', '网络赌博', '在线赌场'
];

const KNOWN_BAD_SNIPPETS: { re: RegExp; label: string }[] = [
  { re: /coinhive|coin-hive|cryptonight|cryptoloot|webminepool/i, label: 'cryptominer script' },
  { re: /megalayer|wp-vcd|class\.wp\.php|wp-tmp\.php|wso-shell|alfa-rex/i, label: 'known WordPress malware marker (wp-vcd/webshell family)' },
  { re: /<script[^>]+src=["']https?:\/\/[^"']+\.(?:top|icu|click|buzz|monster|cf|ga|gq|ml|tk|pw|cc)\/[^"']*["']/i, label: 'script from a high-risk / spam TLD' },
  { re: /(?:pushwelcome|webpushservice|smart-display-system|adsterra|onclickads|adskeeper)/i, label: 'injected adware / push-notification spam script' },
  { re: /document\.referrer\s*\.match\s*\(\s*['"][^'"]*(?:google|bing|yahoo|yandex|facebook)/i, label: 'search-engine referrer sniffing redirect' },
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

// Helper to extract text from tags
function extractTagContent(html: string, tagName: string): string {
  const match = html.match(new RegExp(`<${tagName}[^>]*>([\\s\\S]*?)<\\/${tagName}>`, 'i'));
  return match ? match[1].replace(/<[^>]+>/g, ' ').trim() : '';
}

function extractMetaContent(html: string, nameOrProp: string): string {
  const match = html.match(new RegExp(`<meta[^>]+(?:name|property)=["']${nameOrProp}["'][^>]+content=["']([^"']+)["']`, 'i'))
    || html.match(new RegExp(`<meta[^>]+content=["']([^"']+)["'][^>]+(?:name|property)=["']${nameOrProp}["']`, 'i'));
  return match ? match[1].trim() : '';
}

// ---- Main entry --------------------------------------------------------------

export async function runScan(rawUrl: string, opts: { safeBrowsingKey?: string } = {}): Promise<ScanResult> {
  const target = normaliseTarget(rawUrl);
  const base = `${target.protocol}//${target.host}`;
  const scannedAt = new Date().toISOString();

  // Run primary browser fetch, Googlebot cloaking probe, and WordPress probe paths concurrently.
  const [home, botHome, readme, uploads, configBak, sb] = await Promise.all([
    safeFetch(target.href, 'GET', BROWSER_HEADERS),
    safeFetch(target.href, 'GET', BOT_HEADERS),
    safeFetch(`${base}/readme.html`, 'GET'),
    safeFetch(`${base}/wp-content/uploads/`, 'GET'),
    safeFetch(`${base}/wp-config.php.bak`, 'GET'),
    checkSafeBrowsing(target.href, opts.safeBrowsingKey),
  ]);

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
  const botHtml = botHome.body || '';
  const headers = home.headers;

  // A 403/503 to our scanner is usually firewall/bot protection, not a real outage
  const blocked = home.status === 403 || home.status === 503;
  const firewall = blocked ? detectFirewall(headers, html, home.status) : null;
  const isWordPress = !blocked && (detectWordPress(html, headers) || detectWordPress(botHtml, botHome.headers));

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

  // --- Malware / SEO Hijack / Injections (only on a genuine page load) ---
  if (home.ok && !blocked) {
    // 1. Obfuscated JavaScript
    for (const p of OBFUSCATION_PATTERNS) {
      if (p.re.test(html)) {
        findings.push({
          category: 'malware',
          severity: 'warning',
          title: 'Obfuscated JavaScript detected',
          detail: `The page contains ${p.label}. Obfuscated code is a strong indicator of injected malware, though some legitimate scripts are also minified.`,
          recommendation: 'Have the obfuscated code reviewed and removed if malicious, and scan the full file system for backdoors.',
        });
        break;
      }
    }

    // 2. Known malware / backdoor signatures
    for (const p of KNOWN_BAD_SNIPPETS) {
      if (p.re.test(html) || p.re.test(botHtml)) {
        findings.push({
          category: 'malware',
          severity: 'critical',
          title: 'Known malware signature found',
          detail: `The page matches ${p.label} — a known malicious pattern. This indicates the site is actively infected.`,
          recommendation: 'Take a backup and begin a full malware cleanup and backdoor removal immediately.',
        });
        break;
      }
    }

    // 3. Hidden Links & Parasite Link Farm Detection (CSS trickery)
    const hiddenLinkRegex = /<a\s+[^>]*style\s*=\s*["'][^"']*(?:display\s*:\s*none|visibility\s*:\s*hidden|position\s*:\s*absolute\s*;\s*(?:left|top)\s*:\s*-\d{3,5}px|font-size\s*:\s*0(?:px|pt|em|rem)?|text-indent\s*:\s*-\d{3,5}px|opacity\s*:\s*0\b)[^"']*["'][^>]*>([\s\S]*?)<\/a>/gi;
    const directHiddenLinks = [...html.matchAll(hiddenLinkRegex)];

    const hiddenContainerRegex = /<(?:div|span|p|ul|li|section)\s+[^>]*style\s*=\s*["'][^"']*(?:display\s*:\s*none|visibility\s*:\s*hidden|position\s*:\s*absolute\s*;\s*(?:left|top)\s*:\s*-\d{3,5}px|font-size\s*:\s*0(?:px|pt|em|rem)?|text-indent\s*:\s*-\d{3,5}px|opacity\s*:\s*0\b)[^"']*["'][^>]*>([\s\S]*?)<\/(?:div|span|p|ul|li|section)>/gi;
    let containerHiddenLinksCount = 0;
    const sampleHiddenLinks: string[] = [];

    for (const match of html.matchAll(hiddenContainerRegex)) {
      const linkMatches = [...match[1].matchAll(/<a\s+[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi)];
      containerHiddenLinksCount += linkMatches.length;
      for (const lm of linkMatches) {
        if (sampleHiddenLinks.length < 3) {
          const anchor = lm[2].replace(/<[^>]+>/g, '').trim();
          sampleHiddenLinks.push(anchor ? `${anchor} (${lm[1]})` : lm[1]);
        }
      }
    }

    // Add samples from direct hidden links
    for (const dm of directHiddenLinks) {
      if (sampleHiddenLinks.length < 3) {
        const href = dm[0].match(/href=["']([^"']+)["']/i)?.[1] || '';
        const anchor = dm[1].replace(/<[^>]+>/g, '').trim();
        sampleHiddenLinks.push(anchor ? `${anchor} (${href})` : href);
      }
    }

    const totalHiddenLinks = Math.max(directHiddenLinks.length, containerHiddenLinksCount);
    if (totalHiddenLinks >= 2) {
      findings.push({
        category: 'malware',
        severity: 'critical',
        title: `Hidden link farm / Parasite SEO injection detected (${totalHiddenLinks} hidden links)`,
        detail: `Found ${totalHiddenLinks} hidden outbound link(s) concealed using CSS (display:none / off-screen positioning). Sample injected links: ${sampleHiddenLinks.slice(0, 3).join(', ')}. Attackers inject hidden links to turn infected WordPress sites into link farms for illegal gambling, phishing, or adult networks without the owner seeing them.`,
        recommendation: 'Remove the injected links from your active theme, header/footer hooks, and database, and eliminate the backdoor entry point.',
      });
    }

    // 4. Casino / Gambling / Slot Keywords (Multi-Language)
    const lowerHtml = html.toLowerCase();
    const lowerBotHtml = botHtml.toLowerCase();
    const foundCasino = CASINO_SLOT_PHRASES.filter(
      (k) => lowerHtml.includes(k.toLowerCase()) || lowerBotHtml.includes(k.toLowerCase())
    );

    if (foundCasino.length > 0) {
      findings.push({
        category: 'malware',
        severity: 'critical',
        title: 'Casino / Gambling / Slot SEO spam keywords detected',
        detail: `Injected casino/gambling keywords detected: ${foundCasino.slice(0, 6).join(', ')}. Attackers inject high-volume gambling spam (such as slot gacor, judi online, casino backlinks) to hijack your domain authority for search rankings.`,
        recommendation: 'Scan database posts, options table, and template files for injected spam content, clean all spam URLs, and secure the site.',
      });
    }

    // 5. Pharma Spam Detection
    const foundPharmaPhrases = PHARMA_PHRASES.filter(
      (k) => lowerHtml.includes(k.toLowerCase()) || lowerBotHtml.includes(k.toLowerCase())
    );
    const foundSinglePharma = SINGLE_PHARMA_KEYWORDS.filter(
      (k) => new RegExp(`\\b${k}\\b`, 'i').test(lowerHtml) || new RegExp(`\\b${k}\\b`, 'i').test(lowerBotHtml)
    );

    if (foundPharmaPhrases.length > 0 || foundSinglePharma.length >= 2) {
      const combinedPharma = [...new Set([...foundPharmaPhrases, ...foundSinglePharma])];
      findings.push({
        category: 'malware',
        severity: 'critical',
        title: 'Pharma hack keywords detected',
        detail: `Injected pharmaceutical spam detected: ${combinedPharma.slice(0, 5).join(', ')}. The pharma hack injects rogue pages and backlinks for illegal medications.`,
        recommendation: 'Clean injected database entries, remove rogue sitemaps, and submit clean URLs for re-indexing in Google Search Console.',
      });
    }

    // 6. Japanese & Foreign Character SEO Spam (Doorway Pages)
    const browserTitle = extractTagContent(html, 'title');
    const botTitle = extractTagContent(botHtml, 'title');
    const browserMetaDesc = extractMetaContent(html, 'description');
    const botMetaDesc = extractMetaContent(botHtml, 'description');
    const browserOgTitle = extractMetaContent(html, 'og:title');
    const botOgTitle = extractMetaContent(botHtml, 'og:title');

    const isJpDomain = target.hostname.endsWith('.jp');
    const isCnDomain = target.hostname.endsWith('.cn') || target.hostname.endsWith('.hk') || target.hostname.endsWith('.tw');

    const hasJapaneseChars =
      /[぀-ヿ一-龯]/.test(browserTitle) ||
      /[぀-ヿ一-龯]/.test(botTitle) ||
      /[぀-ヿ一-龯]/.test(browserMetaDesc) ||
      /[぀-ヿ一-龯]/.test(botMetaDesc) ||
      /[぀-ヿ一-龯]/.test(browserOgTitle) ||
      /[぀-ヿ一-龯]/.test(botOgTitle);

    const foundJpSpam = JAPANESE_SPAM_TERMS.filter((term) => html.includes(term) || botHtml.includes(term));

    if (!isJpDomain && (hasJapaneseChars || foundJpSpam.length >= 2)) {
      findings.push({
        category: 'malware',
        severity: 'critical',
        title: 'Japanese keyword hack (SEO Spam) detected',
        detail: `Japanese characters or commercial spam terms were detected on a non-Japanese website (Title: "${botTitle || browserTitle || 'Injected metadata'}"). The Japanese keyword hack creates thousands of fake indexed spam pages for counterfeit goods.`,
        recommendation: 'Remove the spam-page generator scripts, clean rogue .htaccess rewrites, and request indexing removal in Google Search Console.',
      });
    }

    // Chinese doorway spam check
    const foundCnSpam = CHINESE_GAMBLING_TERMS.filter((term) => html.includes(term) || botHtml.includes(term));
    if (!isCnDomain && foundCnSpam.length > 0) {
      findings.push({
        category: 'malware',
        severity: 'critical',
        title: 'Chinese gambling doorway hack detected',
        detail: `Injected Chinese gambling keywords detected: ${foundCnSpam.join(', ')}. Attackers use compromised sites to host illegal gambling doorway portals.`,
        recommendation: 'Clean compromised files and database entries, remove malicious redirects, and harden WordPress credentials.',
      });
    }

    // 7. Googlebot Cloaking Differentials (Conditional Hijacking)
    if (botHome.ok && home.ok) {
      // Differential redirect
      if (botHome.finalUrl !== home.finalUrl && !botHome.finalUrl.includes(target.hostname)) {
        findings.push({
          category: 'malware',
          severity: 'critical',
          title: 'Search engine cloaked redirect detected',
          detail: `When visited as Googlebot, the site redirects to an external destination (${botHome.finalUrl.slice(0, 80)}), while human visitors see the normal homepage. This is intentional search engine cloaking.`,
          recommendation: 'Inspect .htaccess, index.php, and theme functions for User-Agent/Referer conditional redirection rules.',
        });
      }

      // Differential Title (Googlebot sees spam title that site owners don't see)
      if (botTitle && browserTitle && botTitle !== browserTitle && (hasJapaneseChars || foundCasino.length > 0 || foundPharmaPhrases.length > 0)) {
        findings.push({
          category: 'malware',
          severity: 'critical',
          title: 'Cloaked SEO spam title detected (Googlebot cloaking)',
          detail: `Search engines see a completely different title ("${botTitle.slice(0, 70)}") than normal visitors ("${browserTitle.slice(0, 70)}"). This stealth technique tricks Google into indexing spam keywords while hiding the hack from you.`,
          recommendation: 'Clean the conditional cloaking script from your core files/database and request a re-crawl.',
        });
      }
    }

    // 8. Meta-refresh / JS redirect to an external host
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

    // 9. Hidden iframes
    const hiddenIframeRegex = /<iframe[^>]+(?:width=["']0["']|height=["']0["']|style=["'][^"']*(?:display\s*:\s*none|visibility\s*:\s*hidden|position\s*:\s*absolute\s*;\s*(?:left|top)\s*:\s*-\d{3,5}px)[^"']*)[^>]*>/i;
    if (hiddenIframeRegex.test(html)) {
      findings.push({
        category: 'malware',
        severity: 'critical',
        title: 'Hidden iframe injection detected',
        detail: 'The page contains a hidden iframe (zero width/height or styled invisible). Attackers use hidden iframes to silently load exploit kits or conduct drive-by downloads.',
        recommendation: 'Inspect theme templates and injected widgets for unauthorized iframe tags.',
      });
    }
  } // end malware heuristics

  // --- Positive "ok" markers so a clean site shows green checks ---
  if (home.ok && !blocked && !findings.some((f) => f.category === 'malware')) {
    findings.push({
      category: 'malware',
      severity: 'ok',
      title: 'No obvious malware or SEO spam signals on the homepage',
      detail: 'Our heuristics did not detect injected casino/pharma keywords, Japanese SEO spam, hidden link farms, cloaked redirects, or obfuscated malware.',
      recommendation: 'A homepage scan is a fast front-end triage — a clean result here does not guarantee a clean database or backdoors deeper in the server.',
    });
  }
  if (blacklistKnown && !findings.some((f) => f.category === 'blacklist')) {
    findings.push({
      category: 'blacklist',
      severity: 'ok',
      title: 'Not on Google Safe Browsing blacklist',
      detail: 'Google Safe Browsing did not return a threat match for this URL.',
      recommendation: 'Keep the site clean and monitored so it stays off blacklists.',
    });
  }
  if (isHttps && !findings.some((f) => f.category === 'ssl')) {
    findings.push({
      category: 'ssl',
      severity: 'ok',
      title: 'HTTPS and core security headers present',
      detail: 'The site loads over HTTPS with key hardening headers set.',
      recommendation: 'Maintain your certificate and headers.',
    });
  }

  // --- Roll up ---
  const counts = {
    critical: findings.filter((f) => f.severity === 'critical').length,
    warning: findings.filter((f) => f.severity === 'warning').length,
    ok: findings.filter((f) => f.severity === 'ok').length,
  };

  const verdict: ScanResult['verdict'] =
    counts.critical > 0 ? 'infected' : counts.warning > 0 ? 'warnings' : 'clean';

  const score = Math.max(0, 100 - counts.critical * 35 - counts.warning * 10);

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
