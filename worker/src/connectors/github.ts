import type { Connector, RawOpportunity } from './types.js';
import { getJson } from './http.js';
import { PermanentError } from '../errors.js';

interface SearchIssues { items: { id: number; html_url: string; title: string; body: string | null; created_at: string; updated_at: string;
  repository_url: string; user: { login: string }; labels: { name: string }[]; comments: number }[] }

/** Open GitHub issues carrying a bounty label. Official REST search API, authenticated with the Actions token. */
export const githubBounty: Connector = async ({ config, maxItems, env, fetchFn }) => {
  const token = env.GITHUB_TOKEN;
  if (!token) throw new PermanentError('GITHUB_TOKEN not available to the worker');
  const since = new Date(Date.now() - Number(config.updated_within_days ?? 30) * 86_400_000).toISOString().slice(0, 10);
  const q = `${config.query ?? 'label:bounty state:open type:issue'} updated:>=${since}`;
  const data = await getJson<SearchIssues>(
    `https://api.github.com/search/issues?q=${encodeURIComponent(q)}&sort=updated&order=desc&per_page=${Math.min(maxItems, 50)}`,
    { fetchFn, headers: { authorization: `Bearer ${token}`, 'x-github-api-version': '2022-11-28' } });
  return data.items.slice(0, maxItems).map<RawOpportunity>((i) => {
    const repo = i.repository_url.replace('https://api.github.com/repos/', '');
    const labels = i.labels.map((l) => l.name);
    const body = (i.body ?? '').slice(0, 6000);
    return {
      externalId: String(i.id),
      url: i.html_url,
      title: `${repo}: ${i.title}`.slice(0, 200),
      text: `Repository: ${repo}\nLabels: ${labels.join(', ')}\nComments: ${i.comments}\n\n${i.title}\n\n${body}`,
      buyerName: repo.split('/')[0],
      buyerContact: i.html_url,
      postedAt: new Date(i.created_at),
      raw: { repo, labels, comments: i.comments, updated_at: i.updated_at, author: i.user.login },
    };
  });
};
