import type { Connector, RawOpportunity } from './types.js';
import { getJson } from './http.js';
import { htmlToText } from '../sanitize.js';

interface AlgoliaSearch { hits: { objectID: string; title: string; created_at: string }[] }
interface AlgoliaItem { id: number; author: string | null; text: string | null; created_at: string; children: AlgoliaItem[] }

/**
 * Hacker News monthly "Ask HN: Freelancer? Seeking freelancer?" thread (posted by `whoishiring`).
 * Top-level comments beginning with "SEEKING FREELANCER" are public requests for paid services.
 * Official public API: https://hn.algolia.com/api
 */
export const hnFreelancer: Connector = async ({ config, maxItems, fetchFn }) => {
  const search = await getJson<AlgoliaSearch>(
    'https://hn.algolia.com/api/v1/search_by_date?tags=story,author_whoishiring&query=%22Seeking%20freelancer%22&hitsPerPage=3', { fetchFn });
  const maxAge = Number(config.max_thread_age_days ?? 45);
  const thread = search.hits
    .filter((h) => /seeking freelancer/i.test(h.title))
    .find((h) => (Date.now() - new Date(h.created_at).getTime()) / 86_400_000 <= maxAge);
  if (!thread) return [];
  const item = await getJson<AlgoliaItem>(`https://hn.algolia.com/api/v1/items/${thread.objectID}`, { fetchFn });
  const out: RawOpportunity[] = [];
  for (const c of item.children ?? []) {
    if (!c.text || !c.author) continue;
    const text = htmlToText(c.text);
    if (!/^\s*seeking\s+freelancer/i.test(text)) continue;   // only buyers, not freelancers advertising
    const firstLine = text.split('\n')[0].replace(/^\s*seeking\s+freelancer\s*[|:\-–]*\s*/i, '').trim();
    const parts = firstLine.split('|').map((p) => p.trim()).filter(Boolean);
    const emailMatch = text.match(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/);
    out.push({
      externalId: String(c.id),
      url: `https://news.ycombinator.com/item?id=${c.id}`,
      title: (firstLine || text.slice(0, 120)).slice(0, 200),
      text,
      buyerName: parts[0] && parts[0].length < 80 ? parts[0] : `HN user ${c.author}`,
      buyerContact: emailMatch ? emailMatch[0] : `https://news.ycombinator.com/user?id=${c.author}`,
      postedAt: new Date(c.created_at),
      raw: { thread_id: thread.objectID, thread_title: thread.title, author: c.author },
    });
    if (out.length >= maxItems) break;
  }
  return out;
};
