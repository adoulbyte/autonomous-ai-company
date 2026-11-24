import type { Connector, RawOpportunity } from './types.js';
import { getJson, getText } from './http.js';
import { htmlToText } from '../sanitize.js';

const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/;
const CONTRACT = /\b(contract(or)?|freelance(r)?|part[- ]time|consultant|consulting|project[- ]based|fixed[- ]price)\b/i;
const NOT_A_CONTACT = /(noreply|no-reply|example\.com|privacy|abuse|unsubscribe)/i;
const pickEmail = (t: string) => { const m = t.match(new RegExp(EMAIL.source, 'g')) ?? []; return m.find((e) => !NOT_A_CONTACT.test(e)) ?? null; };

interface AlgoliaSearch { hits: { objectID: string; title: string; created_at: string }[] }
interface AlgoliaItem { id: number; author: string | null; text: string | null; created_at: string; children: AlgoliaItem[] }

/** HN "Who is hiring?" — keep only contract / freelance / part-time posts (work a service company can take). */
export const hnHiring: Connector = async ({ config, maxItems, fetchFn }) => {
  const search = await getJson<AlgoliaSearch>('https://hn.algolia.com/api/v1/search_by_date?tags=story,author_whoishiring&hitsPerPage=12', { fetchFn });
  const maxAge = Number(config.max_thread_age_days ?? 75);
  const thread = search.hits.filter((h) => /who is hiring/i.test(h.title)).find((h) => (Date.now() - new Date(h.created_at).getTime()) / 86_400_000 <= maxAge);
  if (!thread) return [];
  const item = await getJson<AlgoliaItem>(`https://hn.algolia.com/api/v1/items/${thread.objectID}`, { fetchFn });
  const out: RawOpportunity[] = [];
  for (const c of [...(item.children ?? [])].sort((a, b) => +new Date(b.created_at) - +new Date(a.created_at))) {
    if (!c.text || !c.author) continue;
    const text = htmlToText(c.text);
    const head = text.split('\n')[0];
    if (!CONTRACT.test(head) && !CONTRACT.test(text.slice(0, 400))) continue;
    const parts = head.split('|').map((p) => p.trim()).filter(Boolean);
    out.push({ externalId: String(c.id), url: `https://news.ycombinator.com/item?id=${c.id}`, title: head.slice(0, 200), text,
      buyerName: parts[0] && parts[0].length < 80 ? parts[0] : `HN user ${c.author}`,
      buyerContact: pickEmail(text) ?? `https://news.ycombinator.com/user?id=${c.author}`,
      postedAt: new Date(c.created_at), raw: { thread_id: thread.objectID, author: c.author } });
    if (out.length >= maxItems) break;
  }
  return out;
};

interface RemotiveJobs { jobs: { id: number; url: string; title: string; company_name: string; category: string; job_type: string;
  publication_date: string; candidate_required_location: string; salary: string; description: string }[] }

/** Remotive public API — remote contract / freelance jobs. */
export const remotive: Connector = async ({ config, maxItems, fetchFn }) => {
  const cats: string[] = config.categories ?? ['software-dev'];
  const types = new Set<string>(config.job_types ?? ['contract', 'freelance']);
  const out: RawOpportunity[] = [];
  for (const cat of cats) {
    const data = await getJson<RemotiveJobs>(`https://remotive.com/api/remote-jobs?category=${encodeURIComponent(cat)}&limit=100`, { fetchFn });
    for (const j of data.jobs) {
      if (!types.has(j.job_type)) continue;
      const text = `${j.title} — ${j.company_name}\nType: ${j.job_type} · Location: ${j.candidate_required_location} · Salary: ${j.salary || 'n/a'}\n\n${htmlToText(j.description).slice(0, 6000)}\n\nSource: Remotive (${j.url})`;
      out.push({ externalId: String(j.id), url: j.url, title: `${j.company_name}: ${j.title}`.slice(0, 200), text, buyerName: j.company_name,
        buyerContact: pickEmail(text) ?? j.url, postedAt: new Date(j.publication_date), raw: { category: j.category, job_type: j.job_type } });
      if (out.length >= maxItems) return out;
    }
  }
  return out;
};

/** Minimal, dependency-free RSS 2.0 item parser. */
export function parseRss(xml: string): { title: string; link: string; description: string; pubDate: string; guid: string }[] {
  const tag = (b: string, t: string) => { const m = b.match(new RegExp(`<${t}[^>]*>([\\s\\S]*?)<\\/${t}>`, 'i')); return m ? m[1].replace(/^<!\[CDATA\[|\]\]>$/g, '').trim() : ''; };
  return [...xml.matchAll(/<item[\s>][\s\S]*?<\/item>/gi)].map((m) => { const b = m[0];
    return { title: htmlToText(tag(b, 'title')), link: tag(b, 'link'), description: tag(b, 'description'), pubDate: tag(b, 'pubDate'), guid: tag(b, 'guid') || tag(b, 'link') }; });
}

/** We Work Remotely RSS — keep contract / freelance positions. */
export const wwrRss: Connector = async ({ config, maxItems, fetchFn }) => {
  const out: RawOpportunity[] = [];
  for (const feed of (config.feeds as string[]) ?? []) {
    for (const it of parseRss(await getText(feed, { fetchFn }))) {
      const text = `${it.title}\n\n${htmlToText(it.description).slice(0, 6000)}\n\nSource: We Work Remotely (${it.link})`;
      if (!CONTRACT.test(text)) continue;
      const company = it.title.includes(':') ? it.title.split(':')[0].trim() : null;
      out.push({ externalId: it.guid, url: it.link, title: it.title.slice(0, 200), text, buyerName: company, buyerContact: pickEmail(text) ?? it.link,
        postedAt: it.pubDate ? new Date(it.pubDate) : null, raw: { feed } });
      if (out.length >= maxItems) return out;
    }
  }
  return out;
};
