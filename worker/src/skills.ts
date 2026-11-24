import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const DIR = join(dirname(fileURLToPath(import.meta.url)), '../skills');
const cache = new Map<string, string>();
function load(name: string): string {
  if (!cache.has(name)) { try { cache.set(name, readFileSync(join(DIR, `${name}.md`), 'utf8')); } catch { cache.set(name, ''); } }
  return cache.get(name)!;
}
export function availableSkills(): string[] { try { return readdirSync(DIR).filter((f) => f.endsWith('.md')).map((f) => f.replace(/\.md$/, '')); } catch { return []; } }

/** Pick the skill playbooks relevant to a piece of work (by format and keywords). */
export function skillsFor(kind: 'sales' | 'negotiation' | 'production' | 'qa', hints = ''): string {
  const h = hints.toLowerCase();
  const names = new Set<string>();
  if (kind === 'sales' || kind === 'negotiation') { names.add('client-communication'); names.add('proposals-and-pricing'); }
  if (kind === 'production' || kind === 'qa') {
    if (/code|python|script|api|javascript|typescript|react|node|bug|software|app|automation/.test(h)) names.add('software-development');
    if (/data|csv|excel|etl|scrap|automation|pipeline/.test(h)) names.add('data-and-automation');
    if (/html|website|site|vitrine|landing/.test(h)) names.add('showcase-website');
    if (/ad|ads|publicit|campaign|social|instagram|facebook|tiktok|marketing|script/.test(h)) names.add('marketing-and-ads');
    if (/pdf|flyer|menu|brochure|price list|tarif|guide/.test(h)) names.add('documents-and-pdf');
    if (/spreadsheet|excel|planning|budget|stock|csv/.test(h)) names.add('spreadsheets');
    if (/svg|logo|design|visual|banner|post/.test(h)) names.add('simple-design');
    if (/markdown|text|research|report|proposal|document|content|writing|article/.test(h) || names.size === 0) names.add('research-and-writing');
    if (kind === 'qa') names.add('quality-review');
  }
  return [...names].map(load).filter(Boolean).join('\n\n');
}
