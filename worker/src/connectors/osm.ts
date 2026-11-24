import type { Connector, RawOpportunity } from './types.js';
import { getJson } from './http.js';
import { RetryableError } from '../errors.js';

/**
 * Local businesses from OpenStreetMap (open data, ODbL) that PUBLISH a business email address.
 * Used for B2B prospecting: a business without a website is offered a showcase site; one with a website is offered
 * other quick wins (ad scripts, documents, simple design). Chains/brands and public bodies are excluded.
 * Official public Overpass API, one small query per run, rotating through cities (cursor kept in the source config).
 */

type City = [string, number, number] | [string, number, number, string, string];   // name, lat, lon, country, language

export const FRANCE_AND_NEIGHBOURS: City[] = [
  ['Lyon', 45.764, 4.8357], ['Marseille', 43.2965, 5.3698], ['Toulouse', 43.6047, 1.4442], ['Nice', 43.7102, 7.262], ['Nantes', 47.2184, -1.5536],
  ['Montpellier', 43.6108, 3.8767], ['Strasbourg', 48.5734, 7.7521], ['Bordeaux', 44.8378, -0.5792], ['Lille', 50.6292, 3.0573], ['Rennes', 48.1173, -1.6778],
  ['Paris', 48.8566, 2.3522], ['Reims', 49.2583, 4.0317], ['Toulon', 43.1242, 5.928], ['Saint-Étienne', 45.4397, 4.3872], ['Le Havre', 49.4944, 0.1079],
  ['Grenoble', 45.1885, 5.7245], ['Dijon', 47.322, 5.0415], ['Angers', 47.4784, -0.5632], ['Nîmes', 43.8367, 4.3601], ['Clermont-Ferrand', 45.7772, 3.087],
  ['Le Mans', 48.0061, 0.1996], ['Aix-en-Provence', 43.5297, 5.4474], ['Brest', 48.3904, -4.4861], ['Tours', 47.3941, 0.6848], ['Amiens', 49.8941, 2.2958],
  ['Limoges', 45.8336, 1.2611], ['Annecy', 45.8992, 6.1294], ['Perpignan', 42.6887, 2.8948], ['Metz', 49.1193, 6.1757], ['Besançon', 47.2378, 6.0241],
  ['Orléans', 47.9029, 1.9093], ['Rouen', 49.4432, 1.0999], ['Mulhouse', 47.7508, 7.3359], ['Caen', 49.1829, -0.3707], ['Nancy', 48.6921, 6.1844],
  ['Avignon', 43.9493, 4.8055], ['Poitiers', 46.5802, 0.3404], ['La Rochelle', 46.1603, -1.1511], ['Pau', 43.2951, -0.3708], ['Bayonne', 43.4929, -1.4748],
  ['Valence', 44.9334, 4.8924], ['Chambéry', 45.5646, 5.9178], ['Colmar', 48.0794, 7.3585], ['Troyes', 48.2973, 4.0744], ['Lorient', 47.7483, -3.37],
  ['Vannes', 47.6582, -2.7608], ['Quimper', 47.996, -4.1024], ['Saint-Malo', 48.6493, -2.0257], ['Niort', 46.3237, -0.4588], ['Angoulême', 45.6484, 0.1562],
  ['Agen', 44.2033, 0.6163], ['Montauban', 44.0176, 1.355], ['Albi', 43.9289, 2.1464], ['Béziers', 43.3442, 3.2158], ['Narbonne', 43.1844, 3.0039],
  ['Carcassonne', 43.213, 2.3491], ['Ajaccio', 41.9192, 8.7386], ['Bastia', 42.697, 9.4508], ['Cannes', 43.5528, 7.0174], ['Antibes', 43.5808, 7.1251],
  ['Fréjus', 43.433, 6.737], ['Arles', 43.6766, 4.6278], ['Valenciennes', 50.357, 3.5235], ['Dunkerque', 51.0344, 2.3768], ['Calais', 50.9513, 1.8587],
  ['Boulogne-sur-Mer', 50.7264, 1.6147], ['Arras', 50.291, 2.7775], ['Douai', 50.3675, 3.08], ['Beauvais', 49.4295, 2.0807], ['Compiègne', 49.4179, 2.8261],
  ['Saint-Quentin', 49.8465, 3.2876], ['Charleville-Mézières', 49.7621, 4.7266], ['Épinal', 48.1724, 6.4496], ['Belfort', 47.638, 6.8628], ['Chalon-sur-Saône', 46.7806, 4.8539],
  ['Mâcon', 46.3069, 4.8287], ['Bourg-en-Bresse', 46.2052, 5.2255], ['Roanne', 46.0367, 4.0689], ['Vichy', 46.1278, 3.4258], ['Nevers', 46.9909, 3.159],
  ['Bourges', 47.081, 2.3988], ['Châteauroux', 46.8103, 1.6913], ['Blois', 47.5861, 1.3359], ['Chartres', 48.4439, 1.489], ['Évreux', 49.027, 1.1508],
  ['Alençon', 48.4329, 0.0913], ['Laval', 48.0707, -0.7734], ['Cholet', 47.06, -0.8786], ['La Roche-sur-Yon', 46.6705, -1.426], ['Saint-Nazaire', 47.2735, -2.2138],
  ['Brive-la-Gaillarde', 45.159, 1.5331], ['Périgueux', 45.1846, 0.7218], ['Mont-de-Marsan', 43.8902, -0.4994], ['Tarbes', 43.2328, 0.0781], ['Rodez', 44.3506, 2.575],
  ['Cahors', 44.4475, 1.4419], ['Aurillac', 44.9264, 2.4398], ['Le Puy-en-Velay', 45.0434, 3.8858], ['Gap', 44.5594, 6.0786], ['Sète', 43.4028, 3.6967],
  ['Montélimar', 44.5581, 4.7509], ['Vienne', 45.5255, 4.8749], ['Thonon-les-Bains', 46.3705, 6.4793], ['Annemasse', 46.1934, 6.2342], ['Versailles', 48.8049, 2.1204],
  ['Saint-Denis', 48.9362, 2.3574], ['Boulogne-Billancourt', 48.8397, 2.2399], ['Montreuil', 48.8638, 2.4485], ['Nanterre', 48.8924, 2.2071], ['Créteil', 48.7904, 2.4556],
  ['Cergy', 49.0364, 2.0761], ['Meaux', 48.9601, 2.8788], ['Melun', 48.539, 2.6608],
  ['Bruxelles', 50.8503, 4.3517, 'BE', 'fr'], ['Liège', 50.6326, 5.5797, 'BE', 'fr'], ['Namur', 50.4674, 4.8712, 'BE', 'fr'], ['Charleroi', 50.4108, 4.4446, 'BE', 'fr'],
  ['Mons', 50.4542, 3.9567, 'BE', 'fr'], ['Luxembourg', 49.6116, 6.1319, 'LU', 'fr'], ['Montréal', 45.5017, -73.5673, 'CA', 'fr'], ['Québec', 46.8139, -71.208, 'CA', 'fr'],
];

/** Countries where a first B2B email to a published business address is allowed with an opt-out (no prior consent needed).
 *  Deliberately excluded: Germany, Austria, Switzerland, Spain, Italy (prior consent required for B2B email marketing).
 *  USA requires a postal address in every commercial email: only enabled when one is configured. */
export const INTERNATIONAL: City[] = [
  ['London', 51.5074, -0.1278, 'GB', 'en'], ['Dublin', 53.3498, -6.2603, 'IE', 'en'], ['Amsterdam', 52.3676, 4.9041, 'NL', 'nl'], ['Lisboa', 38.7223, -9.1393, 'PT', 'pt'],
  ['Casablanca', 33.5731, -7.5898, 'MA', 'fr'], ['Toronto', 43.6532, -79.3832, 'CA', 'en'], ['Sydney', -33.8688, 151.2093, 'AU', 'en'], ['Tunis', 36.8065, 10.1815, 'TN', 'fr'],
  ['Manchester', 53.4808, -2.2426, 'GB', 'en'], ['Rotterdam', 51.9244, 4.4777, 'NL', 'nl'], ['Porto', 41.1579, -8.6291, 'PT', 'pt'], ['Rabat', 34.0209, -6.8416, 'MA', 'fr'],
  ['Melbourne', -37.8136, 144.9631, 'AU', 'en'], ['Vancouver', 49.2827, -123.1207, 'CA', 'en'], ['Birmingham', 52.4862, -1.8904, 'GB', 'en'], ['Cork', 51.8985, -8.4756, 'IE', 'en'],
  ['Den Haag', 52.0705, 4.3007, 'NL', 'nl'], ['Marrakech', 31.6295, -7.9811, 'MA', 'fr'], ['Auckland', -36.8485, 174.7633, 'NZ', 'en'], ['Leeds', 53.8008, -1.5491, 'GB', 'en'],
  ['Utrecht', 52.0907, 5.1214, 'NL', 'nl'], ['Braga', 41.5454, -8.4265, 'PT', 'pt'], ['Dakar', 14.7167, -17.4677, 'SN', 'fr'], ['Brisbane', -27.4698, 153.0251, 'AU', 'en'],
  ['Glasgow', 55.8642, -4.2518, 'GB', 'en'], ['Ottawa', 45.4215, -75.6972, 'CA', 'en'], ['Tanger', 35.7595, -5.834, 'MA', 'fr'], ['Eindhoven', 51.4416, 5.4697, 'NL', 'nl'],
  ['Liverpool', 53.4084, -2.9916, 'GB', 'en'], ['Abidjan', 5.36, -4.0083, 'CI', 'fr'], ['Coimbra', 40.2033, -8.4103, 'PT', 'pt'], ['Perth', -31.9505, 115.8605, 'AU', 'en'],
  ['Bristol', 51.4545, -2.5879, 'GB', 'en'], ['Galway', 53.2707, -9.0568, 'IE', 'en'], ['Sfax', 34.7406, 10.7603, 'TN', 'fr'], ['Groningen', 53.2194, 6.5665, 'NL', 'nl'],
  ['Edinburgh', 55.9533, -3.1883, 'GB', 'en'], ['Calgary', 51.0447, -114.0719, 'CA', 'en'], ['Fès', 34.0181, -5.0078, 'MA', 'fr'], ['Faro', 37.0194, -7.9322, 'PT', 'pt'],
  ['Wellington', -41.2865, 174.7762, 'NZ', 'en'], ['Sheffield', 53.3811, -1.4701, 'GB', 'en'], ['Sousse', 35.8256, 10.6084, 'TN', 'fr'], ['Agadir', 30.4278, -9.5981, 'MA', 'fr'],
  ['Newcastle upon Tyne', 54.9783, -1.6178, 'GB', 'en'], ['Nottingham', 52.9548, -1.1581, 'GB', 'en'], ['Cardiff', 51.4816, -3.1791, 'GB', 'en'], ['Brighton', 50.8225, -0.1372, 'GB', 'en'],
];
export const USA: City[] = [
  ['New York', 40.7128, -74.006, 'US', 'en'], ['Los Angeles', 34.0522, -118.2437, 'US', 'en'], ['Chicago', 41.8781, -87.6298, 'US', 'en'], ['Houston', 29.7604, -95.3698, 'US', 'en'],
  ['Miami', 25.7617, -80.1918, 'US', 'en'], ['Austin', 30.2672, -97.7431, 'US', 'en'], ['Seattle', 47.6062, -122.3321, 'US', 'en'], ['Boston', 42.3601, -71.0589, 'US', 'en'],
];

/** Rotation: two French-speaking cities, then one international city, so every market is reached early. */
export function citiesFor(config: Record<string, unknown>): City[] {
  if (Array.isArray(config.cities)) return config.cities as City[];
  const intl = [...INTERNATIONAL, ...(config.include_us === true ? USA : [])];
  const out: City[] = []; let i = 0, j = 0;
  while (i < FRANCE_AND_NEIGHBOURS.length || j < intl.length) {
    for (let k = 0; k < 2 && i < FRANCE_AND_NEIGHBOURS.length; k++) out.push(FRANCE_AND_NEIGHBOURS[i++]);
    if (j < intl.length) out.push(intl[j++]);
  }
  return out;
}
export const DEFAULT_CITIES = FRANCE_AND_NEIGHBOURS;

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

export function toProspect(el: OsmEl, city: string, country = 'FR', language = 'fr'): RawOpportunity | null {
  const t = el.tags ?? {};
  const email = (t.email ?? t['contact:email'] ?? '').split(/[;,\s]/)[0].trim().toLowerCase();
  const website0 = t.website ?? t['contact:website'] ?? t.url ?? null;
  if ((!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email) && !website0) || !t.name || t.brand || t['brand:wikidata'] || t.operator?.match(/\b(ville|mairie|commune|département|région)\b/i)) return null;
  const category = businessCategory(t); if (!category) return null;
  const website = t.website ?? t['contact:website'] ?? t.url ?? null;
  const need = website ? 'marketing' : 'website';
  const address = [t['addr:housenumber'], t['addr:street'], t['addr:postcode'], t['addr:city'] ?? city].filter(Boolean).join(' ');
  const text = [`Entreprise : ${t.name}`, `Activité : ${category}`, `Ville : ${t['addr:city'] ?? city}`, address ? `Adresse : ${address}` : null,
    `Site web : ${website ?? 'aucun site web référencé'}`, email ? `E-mail professionnel publié : ${email}` : null,
    t.opening_hours ? `Horaires : ${t.opening_hours}` : null, t.description ? `Description : ${t.description}` : null].filter(Boolean).join('\n');
  return {
    externalId: `osm:${el.type}/${el.id}`, url: `https://www.openstreetmap.org/${el.type}/${el.id}`,
    title: need === 'website' ? `Site vitrine pour ${t.name} (${category}, ${city})` : `Supports marketing pour ${t.name} (${category}, ${city})`,
    text, buyerName: t.name.slice(0, 120), buyerContact: email || null, postedAt: new Date(),
    raw: { prospect: true, need, category, city, website, language, country },
  };
}

/** The area explored for a given cursor: every city centre and 4 neighbourhoods, in rotation. */
export function areaAt(config: Record<string, unknown>) {
  const cities = citiesFor(config);
  const areas = cities.flatMap(([name, la, lo, country = 'FR', lang = 'fr']) => AREA_OFFSETS.map(([dy, dx]) => ({ name, lat: la + dy, lon: lo + dx, country, lang })));
  const cursor = Number(config.cursor ?? 0) % areas.length;
  const a = areas[cursor];
  return { cursor, city: a.name, lat: a.lat, lon: a.lon, country: a.country, language: a.lang, total: areas.length, cities: cities.length };
}

export const osmBusinesses: Connector = async ({ config, maxItems, fetchFn }) => {
  const { cursor, city, lat, lon, country, language } = areaAt(config);
  const r = Number(config.radius_m ?? 1500);
  // Small areas keep each Overpass query light (the public servers reject heavy queries when busy).
  let elements: OsmEl[] | null = null; const errors: string[] = [];
  const q = `[out:json][timeout:25];(nwr(around:${r},${lat},${lon})["email"]["name"];nwr(around:${r},${lat},${lon})["contact:email"]["name"];nwr(around:${r},${lat},${lon})["website"]["name"]["shop"];nwr(around:${r},${lat},${lon})["website"]["name"]["craft"];nwr(around:${r},${lat},${lon})["website"]["name"]["amenity"~"restaurant|cafe|bar|fast_food|pub|dentist|doctors|veterinary|driving_school"];);out tags 400;`;
  for (const host of OVERPASS_HOSTS) {
    try { elements = (await getJson<{ elements: OsmEl[] }>(`https://${host}/api/interpreter?data=${encodeURIComponent(q)}`, { fetchFn })).elements ?? []; break; }
    catch (e) { errors.push((e as Error).message.slice(0, 160)); }
  }
  if (!elements) throw new RetryableError(`all OpenStreetMap servers busy: ${errors.join(' | ')}`);
  const data = { elements };
  const seen = new Set<string>();
  const out: RawOpportunity[] = [];
  for (const el of data.elements ?? []) {
    const p = toProspect(el, city, country, language);
    const k = String(p?.buyerContact ?? p?.raw.website ?? '');
    if (!p || seen.has(k)) continue;
    seen.add(k);
    out.push(p);
  }
  // Businesses without a website first (strongest need), then those with a published email, then website-only ones.
  const rank = (p: RawOpportunity) => (p.raw.need === 'website' ? 2 : 0) + (p.buyerContact ? 1 : 0);
  out.sort((a, b) => rank(b) - rank(a));
  return out.slice(0, maxItems).map((p) => ({ ...p, raw: { ...p.raw, cursor } }));
};
