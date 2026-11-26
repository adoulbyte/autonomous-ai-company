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
  if (prompt.includes('Create a free preview for this local business')) return { body: { tagline: 'Coiffure · Lyon', hero_title: 'Votre style, notre savoir-faire',
    hero_text: 'Un salon chaleureux au cœur de Lyon pour des coupes et des couleurs qui vous ressemblent.', cta: 'Prendre rendez-vous',
    services_title: 'Nos prestations', services_intro: 'Des soins adaptés à chacun.', services: [{ title: 'Coupe', text: 'Une coupe pensée pour votre visage et votre quotidien.' },
      { title: 'Couleur', text: 'Des nuances naturelles ou audacieuses, réalisées avec soin.' }, { title: 'Soins', text: 'Des soins pour des cheveux forts et brillants.' }],
    about_title: 'Un salon de quartier', about_text: 'Nous accueillons chaque client avec attention, pour un moment de détente et un résultat qui dure.\n\nConseils personnalisés et produits de qualité.',
    highlights: [{ title: 'Écoute', text: 'Des conseils adaptés.' }, { title: 'Qualité', text: 'Des produits choisis.' }, { title: 'Proximité', text: 'Au cœur du quartier.' }],
    cta_title: 'Envie de changement ?', cta_text: 'Écrivez-nous.', photo_keywords: ['hair salon'] } };
  if (prompt.includes('Review this free preview')) return { body: { score: 9, issues: [] } };
  if (prompt.includes('Classify this inbound message')) return { body: { category: 'prospect_reply', intent: 'neutral', priority: 'normal', summary: 'reply', reply_draft: null } };
  return { status: 500, body: { error: 'unexpected prompt' } };
};
const net = fakeFetch({ ai, json: { 'https://overpass-api.de/api/interpreter': OSM, 'https://hn.algolia.com/': { hits: [] }, 'https://api.github.com/search/issues': { items: [] },
  'https://remotive.com/api/remote-jobs': { jobs: [] }, 'https://models.github.ai/catalog/models': [{ id: 'openai/gpt-4.1' }, { id: 'openai/gpt-4.1-mini' }] } });

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
    const [o] = await sql`select analysis from public.opportunities where buyer_contact = 'contact@boulangerie-parc.example'`;
    expect((o.analysis as { country?: string }).country).toBe('FR');   // the country is kept (marketing stats, domain names)
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
  it('a prospect who clicks "yes" receives a personalised mockup, the quote and the brochure', async () => {
    const target = outbox.find((m) => m.to === 'salon.belle@mail.example') ?? outbox[1];
    const sentId = `<sent-${outbox.indexOf(target) + 1}@example.test>`;
    inbox.push({ uid: 10, messageId: '<yes-1@salon.example>', inReplyTo: sentId, references: [sentId], from: String(target.to), fromName: 'Salon',
      to: mail.address, subject: 'Intéressé – maquette gratuite', text: 'Oui, je souhaite voir la maquette gratuite.', date: new Date() });
    const before = outbox.length;
    await runWorker({ sql, workerId: 'w4', env, fetchFn: net.fn, mail, timeBudgetMs: 120_000, log: console.log });
    const sent = outbox.slice(before).find((m) => m.to === target.to);
    expect(sent).toBeDefined();
    expect(sent!.html).toContain('cid:'); // designed email (logo/preview images)
    const pdf = sent!.attachments!.find((x) => x.filename.endsWith('.pdf'));
    expect(Buffer.from(pdf!.content as Buffer).subarray(0, 4).toString()).toBe('%PDF');
    expect(sent!.text).toMatch(/maquette/);
    expect(sent!.text).toMatch(/offerte/); // launch mode in this test: the work stays free
    const [l] = await sql`select l.stage, l.quote from public.leads l join public.contacts c on c.id = l.contact_id where c.email = ${target.to}`;
    expect(l.stage).toBe('proposal');
    expect((l.quote as { mockup_sent_at?: string }).mockup_sent_at).toBeTruthy();
  }, 120_000);

  it('"maybe later" keeps the prospect, the reminder repeats the proposal with a "not interested" button, which is honoured', async () => {
    const proposal = outbox[outbox.length - 1];
    expect(proposal.html).toContain('Je veux la réalisation');
    expect(proposal.html).toContain('Peut-être plus tard');
    expect(proposal.html).not.toContain('Pas intéressé');
    const to = String(proposal.to);
    const sentId = `<sent-${outbox.length}@example.test>`;
    inbox.push({ uid: 11, messageId: '<later-1@salon.example>', inReplyTo: sentId, references: [sentId], from: to, fromName: 'Salon', to: mail.address,
      subject: 'Peut-être plus tard', text: 'Bonjour, merci pour la maquette. Ce n’est pas le bon moment pour moi, vous pouvez me recontacter plus tard.', date: new Date() });
    const before = outbox.length;
    await runWorker({ sql, workerId: 'w5', env, fetchFn: net.fn, mail, timeBudgetMs: 120_000 });
    expect(outbox.length).toBe(before);   // no reply needed
    const [l] = await sql`select l.id, l.stage, l.next_follow_up_at from public.leads l join public.contacts c on c.id = l.contact_id where c.email = ${to}`;
    expect(l.stage).toBe('proposal');
    expect(new Date(l.next_follow_up_at).getTime() - Date.now()).toBeGreaterThan(29 * 86_400_000);

    await sql`update public.leads set next_follow_up_at = now() - interval '1 minute' where id = ${l.id}`;
    await scheduleDueWork(sql, new Date(), 'reminder');
    await runWorker({ sql, workerId: 'w6', env, fetchFn: net.fn, mail, timeBudgetMs: 120_000 });
    const reminder = outbox.slice(before).find((m) => m.to === to);
    expect(reminder).toBeDefined();
    expect(reminder!.html).toContain('Je veux la réalisation');
    expect(reminder!.html).toContain('Pas intéressé');
    expect(reminder!.attachments!.some((x) => x.filename.endsWith('.pdf'))).toBe(true);

    const rid = `<sent-${outbox.indexOf(reminder!) + 1}@example.test>`;
    inbox.push({ uid: 12, messageId: '<no-1@salon.example>', inReplyTo: rid, references: [rid], from: to, fromName: 'Salon', to: mail.address,
      subject: 'STOP', text: 'Merci de ne plus me contacter.', date: new Date() });
    await runWorker({ sql, workerId: 'w7', env, fetchFn: net.fn, mail, timeBudgetMs: 120_000 });
    const [after] = await sql`select l.stage, c.do_not_contact from public.leads l join public.contacts c on c.id = l.contact_id where c.email = ${to}`;
    expect(after.stage).toBe('lost');
    expect(after.do_not_contact).toBe(true);
  }, 180_000);
  void HANDLERS;
});

describe('a first email whose draft failed review is not left waiting forever', () => {
  it('gets a fresh attempt the next day, and is set aside after three failures', async () => {
    const { enqueue } = await import('../src/queue.js');
    const [l] = await sql`insert into public.leads(title, source, stage) values ('Stuck prospect', 'test', 'qualified') returning id`;
    const fail = async (key: string) => {
      const id = await enqueue(sql, { type: 'lead.draft_outreach', key, role: 'sales_agent', entityType: 'lead', entityId: String(l.id), input: { lead_id: l.id } });
      await sql`update public.tasks set status = 'dead', error = 'Error: outreach draft below quality bar', created_at = now() - interval '1 day' where id = ${id}`;
    };
    await fail(`outreach:${l.id}`);
    await scheduleDueWork(sql, new Date(), 'retry1');
    const [{ n }] = await sql`select count(*)::int n from public.tasks where type = 'lead.draft_outreach' and entity_id::text = ${String(l.id)} and status = 'pending'`;
    expect(n).toBe(1);
    await sql`update public.tasks set status = 'dead', created_at = now() - interval '1 day' where type = 'lead.draft_outreach' and entity_id::text = ${String(l.id)} and status = 'pending'`;
    await fail(`outreach:${l.id}:extra`);
    await scheduleDueWork(sql, new Date(), 'retry2');
    const [after] = await sql`select stage, lost_reason from public.leads where id = ${l.id}`;
    expect(after.stage).toBe('disqualified');
  });
});

describe('overpass fallback', () => {
  it('uses a mirror when the main server is overloaded', async () => {
    const { osmBusinesses } = await import('../src/connectors/osm.js');
    const f = (async (url: string) => url.startsWith('https://overpass-api.de') ? new Response('busy', { status: 502 }) : Response.json(OSM)) as unknown as typeof fetch;
    const items = await osmBusinesses({ config: { cursor: 0 }, maxItems: 10, env: {}, fetchFn: f });
    expect(items.length).toBe(3);
  });
});


describe('fallback when OpenStreetMap is busy', () => {
  it('uses Wikidata businesses of the same area', async () => {
    const { osmBusinesses } = await import('../src/connectors/osm.js');
    const f = (async (url: string) => url.startsWith('https://query.wikidata.org') ? Response.json({ results: { bindings: [
      { item: { value: 'http://www.wikidata.org/entity/Q101' }, itemLabel: { value: 'Brasserie du Port' }, email: { value: 'mailto:contact@brasserie-port.example' }, types: { value: 'brasserie|restaurant' } },
      { item: { value: 'http://www.wikidata.org/entity/Q102' }, itemLabel: { value: 'Mairie' }, email: { value: 'mailto:mairie@ville.example' }, types: { value: 'mairie|commune' } },
    ] } }) : new Response('busy', { status: 502 })) as unknown as typeof fetch;
    const items = await osmBusinesses({ config: { cursor: 0 }, maxItems: 10, env: {}, fetchFn: f });
    expect(items.map((i) => i.buyerContact)).toEqual(['contact@brasserie-port.example']);
    expect(items[0].url).toBe('https://www.wikidata.org/wiki/Q101');
  });
});
