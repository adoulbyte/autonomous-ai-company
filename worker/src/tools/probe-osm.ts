// Prints how many contactable businesses the prospecting source finds for the first cities (no data stored).
import { osmBusinesses } from '../connectors/osm.js';
for (const [cursor, radius] of [[0, 1500], [1, 4000]]) {
  const t = Date.now();
  try {
    const items = await osmBusinesses({ config: { cursor, radius_m: radius }, maxItems: 40, env: {} });
    const web = items.filter((i) => i.raw.need === 'website').length;
    console.log(`city #${cursor}: ${items.length} businesses with a published email (${web} without website) in ${Date.now() - t} ms`);
  } catch (e) { console.log(`city #${cursor}: failed after ${Date.now() - t} ms: ${(e as Error).message}`); }
}

// Raw reachability of each server with a trivial query.
for (const host of ['overpass-api.de', 'overpass.kumi.systems', 'overpass.private.coffee']) {
  const t = Date.now();
  try {
    const r = await fetch(`https://${host}/api/interpreter?data=${encodeURIComponent('[out:json][timeout:10];node(1);out;')}`, { headers: { 'user-agent': 'aic-opportunity-scout/1.0 (private single-owner business system; low volume)' }, signal: AbortSignal.timeout(20000) });
    console.log(`${host}: HTTP ${r.status} in ${Date.now() - t} ms — ${(await r.text()).slice(0, 120).replace(/\s+/g, ' ')}`);
  } catch (e) { console.log(`${host}: ${(e as Error).message} after ${Date.now() - t} ms`); }
}
