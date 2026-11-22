import { RetryableError, PermanentError } from '../errors.js';

/** Only official public APIs registered as sources may be fetched by connectors. */
export const ALLOWED_HOSTS = new Set(['hn.algolia.com', 'api.github.com', 'models.github.ai']);
const UA = 'aic-opportunity-scout/1.0 (private single-owner business system; low volume)';

export async function getJson<T>(url: string, opts: { headers?: Record<string, string>; fetchFn?: typeof fetch } = {}): Promise<T> {
  const host = new URL(url).hostname;
  if (!ALLOWED_HOSTS.has(host)) throw new PermanentError(`host not allow-listed: ${host}`);
  let res: Response;
  try {
    res = await (opts.fetchFn ?? fetch)(url, { headers: { 'user-agent': UA, accept: 'application/json', ...(opts.headers ?? {}) }, signal: AbortSignal.timeout(20_000) });
  } catch (e) {
    throw new RetryableError(`fetch failed for ${host}: ${(e as Error).message}`);
  }
  if (res.status === 429 || res.status >= 500) throw new RetryableError(`${host} responded ${res.status}`);
  if (res.status === 403 && res.headers.get('x-ratelimit-remaining') === '0') throw new RetryableError(`${host} rate limit exhausted`);
  if (!res.ok) throw new PermanentError(`${host} responded ${res.status}: ${(await res.text()).slice(0, 200)}`);
  return (await res.json()) as T;
}
