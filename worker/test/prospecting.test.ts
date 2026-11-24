/**
 * Continuous B2B prospecting: local businesses that publish a professional email (OpenStreetMap) →
 * personalised French email (free showcase site / quick win, opt-out sentence) → reviewed → emailed via the mailbox,
 * within a daily warm-up cap → follow-ups until a reply → a "STOP" reply is honoured permanently.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { freshDb, registerOwner } from './helpers.js';
import { fakeFetch, type Responder } from './fakes.js';
import type { Sql } from '../src/db.js';
import { runWorker, scheduleDueWork } from '../src/runtime.js';
import { HANDLERS } from '../src/runtime.js';
import type { IncomingMail, MailTransport, OutgoingMail } from '../src/email/transport.js';
import { dailyProspectCap } from '../src/agents/opportunity.js';
import { toProspect } from '../src/connectors/osm.js';
import { followUpBody } from '../src/agents/comms.js';

let db: Awaited<ReturnType<typeof freshDb>>; let sql: Sql;
const env = { GITHUB_TOKEN: 'test-token' } as NodeJS.ProcessEnv;
const outbox: OutgoingMail[] = []; const inbox: IncomingMail[] = [];
const mail: MailTransport = {
  address: 'studio@example.test',
  async send(m) { outbox.push(m); return { messageId: `<sent-${outbox.length}@example.test>` }; },
  async fetchSince(last) { return inbox.filter((x) => x.uid > last); },
};

const OSM: { elements: { type: string; id: number; tags: Record<string, string> }[] } = { elements: [
  { type: 'node', id: 1, tags: { name: 'Boulangerie du Parc', shop: 'bakery', email: 'contact@boulangerie-parc.example', 'addr:city': 'Lyon' } },
  { type: 'node', id: 2, tags: { name: 'Garage Martin', shop: 'car_repair', email: 'garage.martin@mail.example', website: 'https://garage-martin.example' } },
  { type: 'node', id: 3, tags: { name: 'Big Chain Store', shop: 'supermarket', brand: 'BigChain', email: 'info@bigchain.example' } },
  { type: 'node', id: 4, tags: { name: 'Mairie', amenity: 'townhall', email: 'mairie@ville.example' } },
  { type: 'node', id: 5, tags: { name: 'Salon Coiffure Belle', shop: 'hairdresser', 'contact:email': 'salon.belle@mail.example' } },
] };

const ai: Responder = (prompt) => {
  if (prompt.includes('B2B prospecting')) return { body: { subject: 'Votre site web à Lyon',
    body: 'Bonjour,\n\nNous avons vu votre adresse professionnelle sur votre fiche publique. Nous lançons notre studio et proposons de créer gratuitement un site vitrine simple et moderne pour votre commerce, en échange d\'un avis honnête. Vous verrez un aperçu avant toute décision.\n\nSouhaitez-vous que nous commencions ? Répondez simplement « oui ».\n\nSi vous ne souhaitez plus recevoir de message de notre part, répondez simplement STOP.',
    claims_made: [], questions_for_buyer: [] } };
  if (prompt.includes('Review this outreach email')) return { body: { score: 9, issues: [], verdict: 'send' } };
  if (prompt.includes('Classify this inbound message')) return { body: { category: 'prospect_reply', intent: 'neutral', priority: 'normal', summary: 'reply', reply_draft: null } };
  return { status: 500, body: { error: 'unexpected prompt' } };
};
const net = fakeFetch({ ai, json: { 'https://overpass-api.de/api/interpreter': OSM, 'https://hn.algolia.com/': { hits: [] }, 'https://api.github.com/search/issues': { items: [] },
  'https://remotive.com/api/remote-jobs': { jobs: [] }, 'https://models.github.ai/catalog/models': [] } });

beforeAll(async () => {
  db = await freshDb(); sql = db.sql; await registerOwner(sql);
  await sql`update public.sources set enabled = (key = 'osm_businesses')`;
  await sql`update public.settings set value = value || '{"mode": "free_pilot"}'::jsonb where key = 'business.mode'`;
  await sql`update public.settings set value = jsonb_build_object('start_per_day', 2, 'step_per_day', 10, 'max_per_day', 120, 'started_at', now()) where key = 'prospecting.policy'`;
});
afterAll(async () => { await db?.drop(); });

describe('prospect selection', () => {
  it('keeps independent businesses that publish an email, excludes chains and public bodies', () => {
    const kept = OSM.elements.map((e) => toProspect(e, 'Lyon')).filter(Boolean);
    expect(kept.map((p) => p!.buyerName)).toEqual(['Boulangerie du Parc', 'Garage Martin', 'Salon Coiffure Belle']);
    expect(kept[0]!.raw.need).toBe('website');
    expect(kept[1]!.raw.need).toBe('marketing');
  });
  it('warms the mailbox up progressively', () => {
    const p = { start_per_day: 20, step_per_day: 10, max_per_day: 120, started_at: '2026-01-01T00:00:00Z' };
    expect(dailyProspectCap(p, new Date('2026-01-01T12:00:00Z'))).toBe(20);
    expect(dailyProspectCap(p, new Date('2026-01-04T12:00:00Z'))).toBe(50);
    expect(dailyProspectCap(p, new Date('2026-03-01T12:00:00Z'))).toBe(120);
  });
  it('follow-ups are in French, polite, and always offer an opt-out', () => {
    expect(followUpBody(1, 3, 'Site vitrine', 'fr')).toMatch(/Bonjour[\s\S]*STOP/);
    expect(followUpBody(3, 3, 'Site vitrine', 'fr')).toMatch(/nous ne vous écrirons plus/);
  });
});

describe('continuous prospecting cycle', () => {
  it('finds businesses, writes personalised emails and sends them within the daily cap', async () => {
    await runWorker({ sql, workerId: 'w1', env, fetchFn: net.fn, mail, timeBudgetMs: 120_000, log: console.log });
    expect(outbox.length).toBe(2);                                  // daily warm-up cap = 2
    expect(outbox[0].to).toBe('contact@boulangerie-parc.example');  // businesses without a website first
    expect(outbox[0].text).toMatch(/STOP/);
    const [{ n: kept }] = await sql`select count(*)::int n from public.opportunities where source_key = 'osm_businesses' and status = 'monitoring'`;
    expect(kept).toBe(1);                                           // third business kept for the next day
    const [c] = await sql`select lawful_basis from public.contacts where email = 'contact@boulangerie-parc.example'`;
    expect(c.lawful_basis).toBe('legitimate_interest');
    const [p] = await sql`select config from public.sources where key = 'osm_businesses'`;
    expect(Number((p.config as { cursor: number }).cursor)).toBe(1);   // next run explores the next city
  });

  it('follows up when there is no reply, and honours STOP for good', async () => {
    await sql`update public.leads set next_follow_up_at = now() - interval '1 minute' where stage = 'contacted'`;
    await scheduleDueWork(sql, new Date(), 'fu');
    await runWorker({ sql, workerId: 'w2', env, fetchFn: net.fn, mail, timeBudgetMs: 120_000 });
    const followUps = outbox.filter((m) => m.subject.startsWith('Re:'));
    expect(followUps.length).toBeGreaterThanOrEqual(1);
    expect(followUps[0].text).toMatch(/Bonjour/);

    const first = outbox[0];
    inbox.push({ uid: 1, messageId: '<stop-1@boulangerie.example>', inReplyTo: '<sent-1@example.test>', references: ['<sent-1@example.test>'],
      from: 'contact@boulangerie-parc.example', fromName: 'Boulangerie', to: mail.address, subject: `Re: ${first.subject}`, text: 'STOP', date: new Date() });
    await runWorker({ sql, workerId: 'w3', env, fetchFn: net.fn, mail, timeBudgetMs: 120_000, log: console.log });
    const [c] = await sql`select do_not_contact from public.contacts where email = 'contact@boulangerie-parc.example'`;
    expect(c.do_not_contact).toBe(true);
    const [l] = await sql`select l.stage from public.leads l join public.contacts c on c.id = l.contact_id where c.email = 'contact@boulangerie-parc.example'`;
    expect(l.stage).toBe('lost');
  });
  void HANDLERS;
});

describe('overpass fallback', () => {
  it('uses a mirror when the main server is overloaded', async () => {
    const { osmBusinesses } = await import('../src/connectors/osm.js');
    const f = (async (url: string) => url.startsWith('https://overpass-api.de') ? new Response('busy', { status: 502 }) : Response.json(OSM)) as unknown as typeof fetch;
    const items = await osmBusinesses({ config: { cursor: 0 }, maxItems: 10, env: {}, fetchFn: f });
    expect(items.length).toBe(3);
  });
});

