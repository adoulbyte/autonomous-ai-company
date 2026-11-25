/**
 * The whole business process, end to end, as it runs in production:
 * prospecting email → "yes, show me the free mockup" → personalised mockup + offer + brochure →
 * "build my website" button → order closed → final site built FROM the approved mockup → double QA →
 * owner validates the invoice → invoice sent → owner confirms the payment → automatic delivery.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { asOwner, freshDb, registerOwner } from './helpers.js';
import { fakeFetch, type Responder } from './fakes.js';
import type { Sql } from '../src/db.js';
import { runWorker, scheduleDueWork } from '../src/runtime.js';
import type { IncomingMail, MailTransport, OutgoingMail } from '../src/email/transport.js';

let db: Awaited<ReturnType<typeof freshDb>>; let sql: Sql;
const env = { GITHUB_TOKEN: 'test-token' } as NodeJS.ProcessEnv;
const outbox: OutgoingMail[] = []; const inbox: IncomingMail[] = []; let uid = 0;
const mail: MailTransport = {
  address: 'studio@example.test',
  async send(m) { outbox.push(m); return { messageId: `<sent-${outbox.length}@example.test>` }; },
  async fetchSince(last) { return inbox.filter((x) => x.uid > last); },
};
const CLIENT = 'salon.belle@mail.example';
/** The prospect answers the last email we sent them (as a click on a mailto button does). */
const clientReplies = (subject: string, text: string) => {
  const i = outbox.map((m) => m.to).lastIndexOf(CLIENT); const id = `<sent-${i + 1}@example.test>`; uid++;
  inbox.push({ uid, messageId: `<c-${uid}@salon.example>`, inReplyTo: id, references: [id], from: CLIENT, fromName: 'Salon', to: mail.address, subject, text, date: new Date() });
};

const OSM = { elements: [{ type: 'node', id: 5, tags: { name: 'Salon Coiffure Belle', shop: 'hairdresser', 'contact:email': CLIENT, 'addr:street': 'rue Mercière', 'addr:housenumber': '8', 'addr:city': 'Lyon', opening_hours: 'Tu-Sa 09:00-19:00' } }] };
const CONTENT = { tagline: 'Coiffure · Lyon', hero_title: 'Votre style, notre savoir-faire', hero_text: 'Un salon chaleureux au cœur de Lyon pour des coupes et des couleurs qui vous ressemblent.',
  cta: 'Prendre rendez-vous', services_title: 'Nos prestations', services_intro: 'Des soins adaptés à chacun.',
  services: [{ title: 'Coupe', text: 'Une coupe pensée pour votre visage et votre quotidien.' }, { title: 'Couleur', text: 'Des nuances naturelles ou audacieuses, réalisées avec soin.' }, { title: 'Soins', text: 'Des soins pour des cheveux forts et brillants.' }],
  about_title: 'Un salon de quartier', about_text: 'Nous accueillons chaque client avec attention, pour un moment de détente et un résultat qui dure.\n\nConseils personnalisés et produits choisis.',
  highlights: [{ title: 'Écoute', text: 'Des conseils adaptés.' }, { title: 'Qualité', text: 'Des produits choisis.' }, { title: 'Proximité', text: 'Au cœur du quartier.' }],
  cta_title: 'Envie de changement ?', cta_text: 'Écrivez-nous.', photo_keywords: ['hair salon'] };
let genericProduction = 0; let goHintSeen = false;
const ai: Responder = (prompt) => {
  if (prompt.includes('B2B prospecting')) return { body: { subject: 'Votre salon à Lyon', claims_made: [], questions_for_buyer: [],
    body: 'Bonjour,\n\nVotre salon apparaît sur une fiche publique avec votre adresse professionnelle, mais sans site internet. Vos clients cherchent souvent vos horaires et vos prestations sur leur téléphone.\n\nNous pouvons vous préparer une maquette de site, sans engagement, pour que vous voyiez le résultat avant toute décision.\n\nSi vous ne souhaitez plus recevoir de message de notre part, répondez simplement STOP.' } };
  if (prompt.includes('Review this outreach email')) return { body: { score: 9, issues: [], verdict: 'send' } };
  if (prompt.includes('Create a free preview for this local business')) return { body: CONTENT };
  if (prompt.includes('Review this free preview')) return { body: { score: 9, issues: [] } };
  if (prompt.includes('You handle the commercial conversation')) {
    goHintSeen = prompt.includes('clicked the button "start the work"');
    return { body: goHintSeen
      ? { intent: 'accept', agreed_price_usd: 49, asked_if_ai: false, scope_summary: '1. Site vitrine une page (base : la maquette validée)', reply: 'Merci, c’est noté : nous lançons la réalisation de votre site. Nous vous montrons le résultat avant la facture.' }
      : { intent: 'question', agreed_price_usd: null, asked_if_ai: false, scope_summary: null, reply: 'Pouvez-vous préciser ?' } };
  }
  if (prompt.includes('Turn this agreed project scope into a delivery plan')) return { body: { summary: 'Site vitrine', out_of_scope: [],
    requirements: [{ description: 'One-page showcase website', acceptance_criteria: ['Shows the business name', 'Mobile friendly'] }],
    work_items: [{ key: 'site', title: 'Site vitrine', requirement_index: 0, format: 'html', instructions: 'Build the final site.' }] } };
  if (prompt.includes('The client ordered their one-page website after approving our mockup')) return { body: { ...CONTENT, phone: '04 72 00 00 00' } };
  if (prompt.includes('Produce the complete deliverable')) { genericProduction++; return { status: 500, body: { error: 'should not be used' } }; }
  if (prompt.includes('independent QA reviewer #')) return { body: { criteria_results: [
    { criterion: 'Shows the business name', met: true, evidence: 'Salon Coiffure Belle' }, { criterion: 'Mobile friendly', met: true, evidence: 'viewport' }], issues: [], summary: 'OK' } };
  if (prompt.includes('Classify this inbound message')) return { body: { category: 'prospect_reply', intent: 'neutral', priority: 'normal', summary: 'reply', reply_draft: null } };
  return { status: 500, body: { error: 'unexpected prompt' } };
};
const net = fakeFetch({ ai, json: { 'https://overpass-api.de/api/interpreter': OSM, 'https://models.github.ai/catalog/models': [{ id: 'openai/gpt-4.1' }, { id: 'openai/gpt-4.1-mini' }] } });
const run = (w: string) => runWorker({ sql, workerId: w, env, fetchFn: net.fn, mail, timeBudgetMs: 150_000 });

beforeAll(async () => {
  db = await freshDb(); sql = db.sql; await registerOwner(sql);
  await sql`update public.sources set enabled = (key = 'osm_businesses')`;
  await sql`update public.settings set value = '{"mode": "paid", "max_active_pilots": 10, "ask_review": true}' where key = 'business.mode'`;
  await sql`update public.settings set value = jsonb_build_object('start_per_day', 5, 'step_per_day', 5, 'max_per_day', 60, 'started_at', now()) where key = 'prospecting.policy'`;
  await sql`update public.settings set value = value || '{"company_name": "Test Studio", "sender_name": "Test Studio", "signature": "Test Studio"}'::jsonb where key = 'business.identity'`;
  await sql`update public.settings set value = value || '{"enabled": true, "beneficiary": "Test Studio", "iban": "FR76 3000 6000 0112 3456 7890 189", "bic": "AGRIFRPP"}'::jsonb where key = 'finance.payment_instructions'`;
});
afterAll(async () => { await db?.drop(); });

describe('full process, from the first email to the delivery', () => {
  it('first email: the service and the free mockup, no price', async () => {
    await run('s-1');
    const first = outbox.find((m) => m.to === CLIENT);
    expect(first).toBeDefined();
    expect(first!.text).not.toMatch(/€|prix|paiement|facture/i);
    expect(first!.html).toContain('maquette gratuite');   // the "yes" button
  });

  it('"yes" → personalised mockup, offer, brochure and two clear buttons', async () => {
    clientReplies('Intéressé – maquette gratuite', 'Bonjour,\n\nOui, je souhaite voir la maquette gratuite.');
    await run('s-2');
    const proposal = outbox.filter((m) => m.to === CLIENT).at(-1)!;
    expect(proposal.text).toMatch(/49 €/);
    expect(proposal.html).toContain('Je veux la réalisation');
    expect(proposal.html).toContain('Peut-être plus tard');
    expect(proposal.attachments!.some((a) => a.filename.endsWith('.pdf'))).toBe(true);
    const [l] = await sql`select stage, next_follow_up_at from public.leads`;
    expect(l.stage).toBe('proposal');
    expect(l.next_follow_up_at).not.toBeNull();   // a reminder is planned if they do not answer
  }, 120_000);

  it('"build my website" → order closed, reminders stopped, final site built from the approved mockup, double QA', async () => {
    clientReplies('Oui – je lance la réalisation', 'Bonjour,\n\nJe souhaite lancer la réalisation selon votre proposition.\n\nInformations utiles : notre téléphone est le 04 72 00 00 00.');
    await run('s-3');
    await run('s-4');
    expect(goHintSeen).toBe(true);
    const [l] = await sql`select stage, agreed_price_minor, next_follow_up_at from public.leads`;
    expect(l.stage).toBe('won');
    expect(Number(l.agreed_price_minor)).toBe(4900);
    expect(l.next_follow_up_at).toBeNull();
    const [p] = await sql`select status, budget_minor from public.projects`;
    expect(p.status).toBe('ready_for_delivery');
    expect(genericProduction).toBe(0);
    const [d] = await sql`select content, status from public.deliverables order by version desc limit 1`;
    expect(d.content).toContain('Salon Coiffure Belle');
    expect(d.content).toContain('04 72 00 00 00');      // the client's information
    expect(d.content).toContain('Votre style, notre savoir-faire');   // the approved mockup's texts
    expect((await sql`select count(*)::int n from public.qa_reviews where verdict = 'pass'`)[0].n).toBe(2);
    // No "are you still interested?" reminder once they ordered.
    await scheduleDueWork(sql, new Date(Date.now() + 40 * 86_400_000), 'later');
    expect((await sql`select count(*)::int n from public.tasks where type = 'lead.proposal_reminder'`)[0].n).toBe(0);
  }, 180_000);

  it('owner validates the invoice, confirms the payment → automatic delivery', async () => {
    const [ap] = await sql`select id from public.approvals where action_type = 'payment.request.send' and status = 'pending'`;
    expect(ap).toBeDefined();
    await asOwner(sql, (tx) => tx`select public.decide_approval(${ap.id}, true, 'facture validée')`);
    await run('s-5');
    const invoice = outbox.find((m) => m.to === CLIENT && m.attachments?.some((a) => /^INV-.*\.pdf$/.test(a.filename)));
    expect(invoice).toBeDefined();
    const [inv] = await sql`select * from public.invoices`;
    expect(Number(inv.amount_minor)).toBe(4900);
    await asOwner(sql, (tx) => tx`select * from public.owner_record_payment(${inv.id}, ${inv.amount_minor}, ${inv.currency}, 'bank_transfer', 'REF-1', true, 'statement_line', 'Relevé ligne 1', null, null)`);
    await run('s-6');
    const delivery = outbox.filter((m) => m.to === CLIENT).at(-1)!;
    expect(delivery.attachments!.some((a) => Buffer.from(a.content as Buffer).toString().includes('Salon Coiffure Belle'))).toBe(true);
    expect((await sql`select status from public.projects`)[0].status).toBe('delivered');
  }, 120_000);
});

describe('safety nets', () => {
  it('a long task that cannot finish before the machine is stopped is handed back without losing an attempt', async () => {
    const { enqueue } = await import('../src/queue.js');
    const id = await enqueue(sql, { type: 'system.health_check', key: 'long-task-test', role: 'orchestrator', priority: 99, timeoutSeconds: 400 });
    await runWorker({ sql, workerId: 'hard', env: { ...env, WORKER_HARD_LIMIT_SECONDS: '60' }, fetchFn: net.fn, mail, timeBudgetMs: 100_000, maxTasks: 1 });
    const [t] = await sql`select status, attempts, error from public.tasks where id = ${id}`;
    expect(t.status).toBe('retry_wait');
    expect(t.attempts).toBe(0);
  });

  it('a prospect who said yes always gets an answer, even if the mockup keeps failing', async () => {
    const { enqueue } = await import('../src/queue.js');
    const [l] = await sql`insert into public.leads(title, source, stage) values ('Mockup failing', 'test', 'engaged') returning id`;
    const kill = async (key: string) => {
      const t = await enqueue(sql, { type: 'lead.mockup', key, role: 'specialist_worker', entityType: 'lead', entityId: String(l.id), input: { lead_id: l.id, message_id: null } });
      await sql`update public.tasks set status = 'dead', created_at = now() - interval '1 day' where id = ${t}`;
    };
    await kill(`mockup:${l.id}`);
    await scheduleDueWork(sql, new Date(), 'mk1');
    expect((await sql`select count(*)::int n from public.tasks where type = 'lead.mockup' and entity_id::text = ${String(l.id)} and status = 'pending'`)[0].n).toBe(1);
    await sql`update public.tasks set status = 'dead', created_at = now() - interval '1 day' where type = 'lead.mockup' and entity_id::text = ${String(l.id)}`;
    await sql`update public.tasks set input = jsonb_build_object('lead_id', ${String(l.id)}::text, 'message_id', gen_random_uuid()) where type = 'lead.mockup' and entity_id::text = ${String(l.id)}`;
    await scheduleDueWork(sql, new Date(), 'mk2');
    expect((await sql`select count(*)::int n from public.tasks where type = 'lead.respond' and entity_id::text = ${String(l.id)}`)[0].n).toBe(1);
  });
});
