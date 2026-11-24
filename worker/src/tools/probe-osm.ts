// Prints how many contactable businesses the prospecting source finds for the first cities (no data stored).
import { osmBusinesses } from '../connectors/osm.js';
for (const cursor of [0, 1]) {
  const t = Date.now();
  try {
    const items = await osmBusinesses({ config: { cursor, radius_m: 4000 }, maxItems: 40, env: {} });
    const web = items.filter((i) => i.raw.need === 'website').length;
    console.log(`city #${cursor}: ${items.length} businesses with a published email (${web} without website) in ${Date.now() - t} ms`);
  } catch (e) { console.log(`city #${cursor}: failed after ${Date.now() - t} ms: ${(e as Error).message}`); }
}
