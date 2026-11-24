import type { RawOpportunity } from './types.js';
import { getJson } from './http.js';

/**
 * Contact enrichment for postings that do not print an email address.
 * Only BUSINESS contact addresses that the company itself publishes are used:
 *  - the public email of the GitHub organisation/user that owns the repository (profile field), or
 *  - a role address (contact@, hello@, jobs@, ...) printed on the company's own website (home or contact page),
 *    on the company's own domain. Personal-looking addresses are never collected.
 * Low volume (a few pages per company), honours robots.txt, https only, public hosts only.
 */

const UA = 'aic-opportunity-scout/1.0 (private single-owner business system; low volume)';
const EMAIL_G = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
export const ROLE_LOCALPARTS = ['jobs', 'careers', 'hiring', 'recruiting', 'talent', 'work', 'hello', 'hi', 'contact', 'info', 'team', 'business', 'sales', 'partners', 'founders', 'office'];
const NOT_COMPANY_SITES = /(^|\.)(ycombinator\.com|github\.com|githubusercontent\.com|remotive\.com|weworkremotely\.com|linkedin\.com|twitter\.com|x\.com|facebook\.com|instagram\.com|youtube\.com|medium\.com|google\.com|goo\.gl|bit\.ly|notion\.site|notion\.so|lever\.co|greenhouse\.io|ashbyhq\.com|workable\.com|wellfound\.com|angel\.co|breezy\.hr|recruitee\.com|smartrecruiters\.com|bamboohr\.com|typeform\.com|calendly\.com|docs\.google\.com|forms\.gle|discord\.gg|discord\.com|t\.me|wikipedia\.org|apple\.com|microsoft\.com|amazon\.com)$/i;

export function rootDomain(host: string): string { return host.toLowerCase().replace(/^www\./, ''); }

/** Company website candidates: explicit links in the posting, excluding job boards, social networks and ATS. */
export function companySites(text: string): string[] {
  const urls = text.match(/https?:\/\/[^\s<>"')\]]+/gi) ?? [];
  const bare = text.match(/\b(?:www\.)?[a-z0-9-]+(?:\.[a-z0-9-]+)*\.(?:com|io|ai|co|dev|app|net|org|tech|fr|de|uk|eu|so|xyz)\b/gi) ?? [];
  const hosts = [...urls.map((u) => { try { return new URL(u).hostname; } catch { return ''; } }), ...bare];
  return [...new Set(hosts.map(rootDomain).filter((h) => h.includes('.') && !/^\d+(\.\d+)+$/.test(h) && !NOT_COMPANY_SITES.test(h) && !h.endsWith('.local')))].slice(0, 2);
}

/** Pick the best role address on the company's own domain. */
export function pickRoleEmail(html: string, domain: string): string | null {
  const found = [...new Set((html.match(EMAIL_G) ?? []).map((e) => e.toLowerCase()))]
    .filter((e) => { const d = e.split('@')[1]; return d === domain || d.endsWith(`.${domain}`); })
    .filter((e) => !/\.(png|jpg|jpeg|gif|svg|webp)$/.test(e));
  for (const role of ROLE_LOCALPARTS) { const hit = found.find((e) => e.split('@')[0] === role); if (hit) return hit; }
  return null;
}

async function fetchPage(url: string, fetchFn: typeof fetch): Promise<string | null> {
  try {
    const u = new URL(url);
    if (u.protocol !== 'https:' || !u.hostname.includes('.') || /^\d+(\.\d+)+$/.test(u.hostname) || /^(localhost|.*\.internal)$/i.test(u.hostname)) return null;
    const res = await fetchFn(url, { headers: { 'user-agent': UA, accept: 'text/html,text/plain' }, redirect: 'follow', signal: AbortSignal.timeout(8000) });
    if (!res.ok) return null;
    const type = res.headers.get('content-type') ?? '';
    if (!/text\/(html|plain)/i.test(type)) return null;
    return (await res.text()).slice(0, 400_000);
  } catch { return null; }
}

/** Minimal robots.txt check for our generic user agent (honours "Disallow" rules for *). */
export function robotsAllows(robots: string | null, path: string): boolean {
  if (!robots) return true;
  let applies = false; const rules: string[] = [];
  for (const raw of robots.split('\n')) {
    const line = raw.split('#')[0].trim(); if (!line) continue;
    const [k, ...v] = line.split(':'); const key = k.trim().toLowerCase(); const val = v.join(':').trim();
    if (key === 'user-agent') applies = val === '*';
    else if (applies && key === 'disallow' && val) rules.push(val);
  }
  return !rules.some((r) => path.startsWith(r));
}

export async function emailFromWebsite(domain: string, fetchFn: typeof fetch = fetch): Promise<{ email: string; source: string } | null> {
  const robots = await fetchPage(`https://${domain}/robots.txt`, fetchFn);
  for (const path of ['/', '/contact', '/contact-us', '/about']) {
    if (!robotsAllows(robots, path)) continue;
    const html = await fetchPage(`https://${domain}${path}`, fetchFn);
    if (!html) continue;
    const email = pickRoleEmail(html.replace(/&#64;|\[at\]|\(at\)/gi, '@'), domain);
    if (email) return { email, source: `https://${domain}${path}` };
  }
  return null;
}

async function emailFromGithubOwner(owner: string, env: NodeJS.ProcessEnv, fetchFn: typeof fetch): Promise<{ email: string; source: string } | null> {
  try {
    const u = await getJson<{ email: string | null; blog: string | null; type: string }>(`https://api.github.com/users/${encodeURIComponent(owner)}`,
      { fetchFn, headers: { ...(env.GITHUB_TOKEN ? { authorization: `Bearer ${env.GITHUB_TOKEN}` } : {}), 'x-github-api-version': '2022-11-28' } });
    // Organisation profile email = published business contact. Individual users: only role addresses on their own domain.
    if (u.email && (u.type === 'Organization' || ROLE_LOCALPARTS.includes(u.email.split('@')[0].toLowerCase()))) return { email: u.email.toLowerCase(), source: `https://github.com/${owner}` };
    if (u.blog) { const d = companySites(u.blog.startsWith('http') ? u.blog : `https://${u.blog}`)[0]; if (d) return emailFromWebsite(d, fetchFn); }
  } catch { /* no public contact */ }
  return null;
}

const hasEmail = (c: string | null | undefined) => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(String(c ?? ''));

/** Fill buyerContact for items without an email, within a time budget. Records where the address was published. */
export async function enrichContacts(items: RawOpportunity[], opts: { env: NodeJS.ProcessEnv; fetchFn?: typeof fetch; budgetMs?: number; concurrency?: number }): Promise<number> {
  const fetchFn = opts.fetchFn ?? fetch;
  const deadline = Date.now() + (opts.budgetMs ?? 60_000);
  const todo = items.filter((i) => !hasEmail(i.buyerContact));
  let found = 0, next = 0;
  const work = async () => {
    while (next < todo.length && Date.now() < deadline) {
      const it = todo[next++];
      let r: { email: string; source: string } | null = null;
      const owner = typeof it.raw.repo === 'string' ? String(it.raw.repo).split('/')[0] : null;
      if (owner) r = await emailFromGithubOwner(owner, opts.env, fetchFn);
      for (const d of r ? [] : companySites(it.text)) { if (Date.now() >= deadline) break; r = await emailFromWebsite(d, fetchFn); if (r) break; }
      if (r) { it.buyerContact = r.email; it.raw = { ...it.raw, contact_published_at: r.source }; found++; }
    }
  };
  await Promise.all(Array.from({ length: opts.concurrency ?? 4 }, work));
  return found;
}
