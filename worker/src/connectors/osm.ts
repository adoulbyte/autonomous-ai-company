import type { Connector, RawOpportunity } from './types.js';
import { getJson } from './http.js';
import { RetryableError } from '../errors.js';

/**
 * Local businesses from OpenStreetMap (open data, ODbL) that PUBLISH a business email address.
 * Used for B2B prospecting: a business without a website is offered a showcase site; one with a website is offered
 * other quick wins (ad scripts, documents, simple design). Chains/brands and public bodies are excluded.
 * Official public Overpass API, one small query per run, rotating through cities (cursor kept in the source config).
 */

export const DEFAULT_CITIES: [string, number, number][] = [
  ['Lyon', 45.764, 4.8357], ['Marseille', 43.2965, 5.3698], ['Toulouse', 43.6047, 1.4442], ['Nice', 43.7102, 7.262], ['Nantes', 47.2184, -1.5536],
  ['Montpellier', 43.6108, 3.8767], ['Strasbourg', 48.5734, 7.7521], ['Bordeaux', 44.8378, -0.5792], ['Lille', 50.6292, 3.0573], ['Rennes', 48.1173, -1.6778],
  ['Paris', 48.8566, 2.3522], ['Reims', 49.2583, 4.0317], ['Toulon', 43.1242, 5.928], ['Saint-Étienne', 45.4397, 4.3872], ['Le Havre', 49.4944, 0.1079],
  ['Grenoble', 45.1885, 5.7245], ['Dijon', 47.322, 5.0415], ['Angers', 47.4784, -0.5632], ['Nîmes', 43.8367, 4.3601], ['Clermont-Ferrand', 45.7772, 3.087],
  ['Le Mans', 48.0061, 0.1996], ['Aix-en-Provence', 43.5297, 5.4474], ['Brest', 48.3904, -4.4861], ['Tours', 47.3941, 0.6848], ['Amiens', 49.8941, 2.2958],
  ['Limoges', 45.8336, 1.2611], ['Annecy', 45.8992, 6.1294], ['Perpignan', 42.6887, 2.8948], ['Metz', 49.1193, 6.1757], ['Besançon', 47.2378, 6.0241],
  ['Orléans', 47.9029, 1.9093], ['Rouen', 49.4432, 1.0999], ['Mulhouse', 47.7508, 7.3359], ['Caen', 49.1829, -0.3707], ['Nancy', 48.6921, 6.1844],
  ['Avignon', 43.9493, 4.8055], ['Poitiers', 46.5802, 0.3404], ['La Rochelle', 46.1603, -1.1511], ['Pau', 43.2951, -0.3708], ['Bayonne', 43.4929, -1.4748],
];

const PUBLIC_OR_UNSUITABLE = /^(townhall|school|college|university|kindergarten|place_of_worship|police|fire_station|hospital|clinic|courthouse|prison|post_office|library|social_facility|community_centre|bank|atm|fuel|parking|public_bookcase|grave_yard|government|political_party|religion|diplomatic|charging_station|vending_machine)$/;

/** City centre + four neighbourhoods around it (~2.5 km away). */
export const AREA_OFFSETS: [number, number][] = [[0, 0], [0.022, 0], [-0.022, 0], [0, 0.032], [0, -0.032]];

export const OVERPASS_HOSTS = ['overpass-api.de', 'overpass.kumi.systems', 'overpass.private.coffee'];

interface OsmEl { type: string; id: number; tags?: Record<string, string> }

export function businessCategory(t: Record<string, string>): string | null {
  for (const k of ['shop', 'craft', 'office', 'amenity', 'tourism', 'healthcare', 'leisure']) {
    const v = t[k]; if (!v) continue;
    if (PUBLIC_OR_UNSUITABLE.test(v) || v === 'yes' || v === 'vacant') return null;
    return `${k}=${v}`;
  }
  return null;
}

export function toProspect(el: OsmEl, city: string): RawOpportunity | null {
  const t = el.tags ?? {};
  const email = (t.email ?? t['contact:email'] ?? '').split(/[;,\s]/)[0].trim().toLowerCase();
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email) || !t.name || t.brand || t['brand:wikidata'] || t.operator?.match(/\b(ville|mairie|commune|département|région)\b/i)) return null;
  const category = businessCategory(t); if (!category) return null;
  const website = t.website ?? t['contact:website'] ?? t.url ?? null;
  const need = website ? 'marketing' : 'website';
  const address = [t['addr:housenumber'], t['addr:street'], t['addr:postcode'], t['addr:city'] ?? city].filter(Boolean).join(' ');
  const text = [`Entreprise : ${t.name}`, `Activité : ${category}`, `Ville : ${t['addr:city'] ?? city}`, address ? `Adresse : ${address}` : null,
    `Site web : ${website ?? 'aucun site web référencé'}`, `E-mail professionnel publié : ${email}`,
    t.opening_hours ? `Horaires : ${t.opening_hours}` : null, t.description ? `Description : ${t.description}` : null].filter(Boolean).join('\n');
  return {
    externalId: `osm:${el.type}/${el.id}`, url: `https://www.openstreetmap.org/${el.type}/${el.id}`,
    title: need === 'website' ? `Site vitrine pour ${t.name} (${category}, ${city})` : `Supports marketing pour ${t.name} (${category}, ${city})`,
    text, buyerName: t.name.slice(0, 120), buyerContact: email, postedAt: new Date(),
    raw: { prospect: true, need, category, city, website, language: 'fr', country: 'FR' },
  };
}

export const osmBusinesses: Connector = async ({ config, maxItems, fetchFn }) => {
  const cities = (config.cities as [string, number, number][] | undefined) ?? DEFAULT_CITIES;
  const areas = cities.flatMap(([name, la, lo]) => AREA_OFFSETS.map(([dy, dx]) => [name, la + dy, lo + dx] as [string, number, number]));
  const cursor = Number(config.cursor ?? 0) % areas.length;
  const [city, lat, lon] = areas[cursor];
  const r = Number(config.radius_m ?? 1500);
  // Small areas keep each Overpass query light (the public servers reject heavy queries when busy).
  let elements: OsmEl[] | null = null; const errors: string[] = [];
  const q = `[out:json][timeout:25];(nwr(around:${r},${lat},${lon})["email"]["name"];nwr(around:${r},${lat},${lon})["contact:email"]["name"];);out tags 300;`;
  for (const host of OVERPASS_HOSTS) {
    try { elements = (await getJson<{ elements: OsmEl[] }>(`https://${host}/api/interpreter?data=${encodeURIComponent(q)}`, { fetchFn })).elements ?? []; break; }
    catch (e) { errors.push((e as Error).message.slice(0, 160)); }
  }
  if (!elements) throw new RetryableError(`all OpenStreetMap servers busy: ${errors.join(' | ')}`);
  const data = { elements };
  const seen = new Set<string>();
  const out: RawOpportunity[] = [];
  for (const el of data.elements ?? []) {
    const p = toProspect(el, city);
    if (!p || seen.has(String(p.buyerContact))) continue;
    seen.add(String(p.buyerContact));
    out.push(p);
  }
  // Businesses without a website first (strongest need), then the others.
  out.sort((a, b) => Number(b.raw.need === 'website') - Number(a.raw.need === 'website'));
  return out.slice(0, maxItems).map((p) => ({ ...p, raw: { ...p.raw, cursor } }));
};
