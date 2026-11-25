/**
 * Real photos for mockups: royalty-free stock photos that match the trade.
 *  - Pexels (free API key, Pexels licence: free commercial use, no attribution required) when PEXELS_API_KEY is set;
 *  - Openverse (no key; CC0 / public domain / CC BY photos, credited in the page footer) otherwise;
 *  - an AI-generated image (Cloudflare Workers AI, free tier) when no photo can be found.
 * Every photo URL is checked (reachable, really an image) before it is used.
 */
export type Photo = { url: string; thumb: string; credit: string | null };

/** Theme keys and English stock-photo searches for each OpenStreetMap trade value. */
const TRADES: [RegExp, string, string[]][] = [
  [/bakery|pastry|confectionery|chocolate|patisserie|boulangerie/, 'warm', ['artisan bakery bread', 'croissants pastries', 'bakery shop interior', 'baker bread oven']],
  [/cafe|coffee|tea/, 'warm', ['coffee shop interior', 'latte coffee cup', 'cafe pastries counter', 'barista coffee']],
  [/restaurant|bistro|brasserie|food|pizza|fast_food|caterer|traiteur/, 'food', ['restaurant dining room', 'chef plating dish', 'gourmet food plate', 'restaurant table dinner']],
  [/bar|pub|wine|winery|vineyard|cave|alcohol|beverages/, 'food', ['wine bar', 'wine glasses bottles', 'vineyard grapes', 'cocktail bar']],
  [/butcher|deli|cheese|greengrocer|seafood|farm|organic|grocery|convenience/, 'nature', ['fresh local produce market', 'delicatessen shop', 'organic vegetables', 'cheese shop']],
  [/hairdresser|barber|coiffure/, 'beauty', ['hair salon interior', 'hairdresser styling hair', 'barber shop', 'hair salon chairs']],
  [/beauty|cosmetics|spa|massage|nail|perfumery|tattoo|wellness/, 'beauty', ['beauty salon spa', 'skincare treatment', 'spa massage stones', 'cosmetics products']],
  [/florist|garden|plant/, 'nature', ['florist flowers bouquet', 'flower shop', 'fresh flowers', 'florist arranging flowers']],
  [/car_repair|car|tyres|motorcycle|bicycle/, 'craft', ['car mechanic garage', 'auto repair workshop', 'mechanic tools', 'car service']],
  [/plumber|electrician|hvac|heating|roofer|builder|carpenter|joiner|painter|tiler|locksmith|craft|metal|stonemason|glazier|construction/, 'craft', ['craftsman workshop tools', 'construction worker', 'carpentry woodwork', 'home renovation']],
  [/optician|pharmacy|chemist|dentist|doctor|clinic|physiotherap|veterinary|hearing|medical|healthcare/, 'health', ['modern clinic interior', 'optician glasses', 'healthcare professional', 'pharmacy shelves']],
  [/hotel|guest_house|hostel|camping|chalet|apartment|gite/, 'stay', ['boutique hotel room', 'hotel lobby', 'cozy bedroom', 'guest house exterior']],
  [/fitness|gym|sports|yoga|dance/, 'craft', ['fitness gym', 'yoga class', 'sports training', 'gym equipment']],
  [/clothes|shoes|boutique|fashion|jewelry|jewellery|gift|books|toys|furniture|interior|decoration|art|photo|music|shop/, 'retail', ['boutique shop interior', 'clothing store', 'gift shop', 'retail store display']],
  [/driving_school/, 'craft', ['driving lesson car', 'car steering wheel', 'driving school', 'road driving']],
];

export function tradeProfile(category: string | null | undefined): { theme: string; queries: string[] } {
  const v = String(category ?? '').toLowerCase().replace(/^[a-z]+=/, '');
  const hit = TRADES.find(([re]) => re.test(v));
  return hit ? { theme: hit[1], queries: hit[2] } : { theme: 'pro', queries: [`${v.replace(/_/g, ' ')} business`.trim(), 'small business owner', 'modern shop interior'] };
}

type Fetch = typeof fetch;
const UA = 'aic-mockup-builder/1.0 (low volume)';

async function json<T>(fetchFn: Fetch, url: string, headers: Record<string, string> = {}): Promise<T | null> {
  try {
    const r = await fetchFn(url, { headers: { 'user-agent': UA, accept: 'application/json', ...headers }, signal: AbortSignal.timeout(12000) });
    return r.ok ? ((await r.json()) as T) : null;
  } catch { return null; }
}

async function pexels(q: string, env: NodeJS.ProcessEnv, fetchFn: Fetch): Promise<Photo[]> {
  if (!env.PEXELS_API_KEY) return [];
  const r = await json<{ photos?: { src: { large2x: string; large: string; medium: string }; photographer: string }[] }>(fetchFn,
    `https://api.pexels.com/v1/search?query=${encodeURIComponent(q)}&per_page=12&orientation=landscape`, { authorization: env.PEXELS_API_KEY });
  return (r?.photos ?? []).map((p) => ({ url: p.src.large2x, thumb: p.src.large, credit: `${p.photographer} / Pexels` }));
}

async function openverse(q: string, fetchFn: Fetch): Promise<Photo[]> {
  const r = await json<{ results?: { url: string; thumbnail: string; creator: string | null; license: string; width: number | null; height: number | null; source: string }[] }>(fetchFn,
    `https://api.openverse.org/v1/images/?q=${encodeURIComponent(q)}&license=cc0,pdm,by&category=photograph&mature=false&aspect_ratio=wide&size=large&page_size=20`);
  const good = ['wordpress', 'stocksnap', 'rawpixel', 'nappy', 'flickr', 'wikimedia'];
  return (r?.results ?? [])
    .filter((x) => /^https:\/\//.test(x.url) && (x.width ?? 1200) >= 900 && (x.width ?? 3) / (x.height ?? 2) >= 1.2)
    .sort((a, b) => (good.indexOf(a.source) + 99) % 99 - (good.indexOf(b.source) + 99) % 99)
    .map((x) => ({ url: x.url, thumb: x.url, credit: x.license === 'by' ? `${x.creator ?? 'auteur inconnu'} (CC BY) / Openverse` : null }));
}

/** True when the URL answers with an image (avoids broken pictures in the preview). */
async function isImage(url: string, fetchFn: Fetch): Promise<boolean> {
  try {
    const r = await fetchFn(url, { headers: { 'user-agent': UA }, redirect: 'follow', signal: AbortSignal.timeout(8000) });
    const ok = r.ok && /^image\/(jpeg|png|webp)/i.test(r.headers.get('content-type') ?? '') && Number(r.headers.get('content-length') ?? 0) < 12_000_000;
    try { await r.body?.cancel(); } catch { /* ignore */ }
    return ok;
  } catch { return false; }
}

/** Up to `count` distinct, reachable photos for the given searches. */
export async function findPhotos(queries: string[], count: number, env: NodeJS.ProcessEnv, fetchFn: Fetch = fetch): Promise<Photo[]> {
  const pool: Photo[] = []; const seen = new Set<string>();
  for (const q of queries.slice(0, 5)) {
    if (pool.length >= count * 2) break;
    const found = env.PEXELS_API_KEY ? await pexels(q, env, fetchFn) : [];
    for (const p of found.length ? found : await openverse(q, fetchFn)) {
      if (seen.has(p.url)) continue; seen.add(p.url);
      pool.push(p); if (pool.length >= count * 2) break;
    }
  }
  // Interleave the searches (hero from the first search, variety afterwards) and keep only working images.
  const checks = await Promise.all(pool.map(async (p) => ((await isImage(p.url, fetchFn)) ? p : null)));
  return checks.filter((p): p is Photo => !!p).slice(0, count);
}

/** One AI-generated photo-like image (Cloudflare Workers AI, free tier) as a data URL, or null. */
export async function generatePhoto(prompt: string, env: NodeJS.ProcessEnv, fetchFn: Fetch = fetch): Promise<Photo | null> {
  if (!env.CLOUDFLARE_ACCOUNT_ID || !env.CLOUDFLARE_API_TOKEN) return null;
  try {
    const r = await fetchFn(`https://api.cloudflare.com/client/v4/accounts/${env.CLOUDFLARE_ACCOUNT_ID}/ai/run/@cf/black-forest-labs/flux-1-schnell`, {
      method: 'POST', headers: { authorization: `Bearer ${env.CLOUDFLARE_API_TOKEN}`, 'content-type': 'application/json' },
      body: JSON.stringify({ prompt: `${prompt}, professional photography, natural light, high detail, no text, no logo`, steps: 6 }), signal: AbortSignal.timeout(60000) });
    if (!r.ok) return null;
    const b = (await r.json()) as { result?: { image?: string } };
    return b.result?.image ? { url: `data:image/jpeg;base64,${b.result.image}`, thumb: `data:image/jpeg;base64,${b.result.image}`, credit: null } : null;
  } catch { return null; }
}
