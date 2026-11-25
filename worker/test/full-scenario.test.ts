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
let genericProduction = 0; let goHintSeen = false; let posts = 0;
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
  if (prompt.includes('The client ordered their one-page website after approving our mockup')) {
    const texts = JSON.parse(prompt.split('<untrusted_data source="mockup-texts">\n')[1].split('\n</untrusted_data>')[0]);
    return { body: { ...texts, phone: '04 72 00 00 00' } };
  }
  if (prompt.includes('You edit an existing')) {
    const req = prompt.split('-request">')[1] ?? '';
    if (req.includes('bleu marine')) return { body: { is_change_request: true, operations: [{ op: 'set_text', path: 'hero_title', value: 'Coiffure & bien-être à Lyon' }, { op: 'set_color', role: 'primary', value: '#1f3a5f' }],
      changes_for_client: ['Titre remplacé par « Coiffure & bien-être à Lyon »', 'Couleur principale : bleu marine'], unclear_question: null, other_message: null } };
    if (req.includes('Réserver maintenant')) return { body: { is_change_request: true, operations: [{ op: 'set_text', path: 'cta', value: 'Réserver maintenant' }],
      changes_for_client: ['Texte du bouton : « Réserver maintenant »'], unclear_question: null, other_message: null } };
    if (req.includes('visuel 2')) return prompt.includes('creation 2 of') ? { body: { is_change_request: true, operations: [{ op: 'set_text', path: 'headline', value: 'Nouveau : soin kératine' }],
      changes_for_client: ['Titre du visuel 2 : « Nouveau : soin kératine »'], unclear_question: null, other_message: null } }
      : { body: { is_change_request: false, operations: [], changes_for_client: [], unclear_question: null, other_message: null } };
    if (req.includes('plus joli')) return { body: { is_change_request: true, operations: [], changes_for_client: [], unclear_question: 'Que souhaitez-vous changer exactement : les couleurs, les photos ou les textes ?', other_message: null } };
    return { body: { is_change_request: false, operations: [], changes_for_client: [], unclear_question: null, other_message: null } };
  }
  if (prompt.includes('Check a modification of a')) return { body: { exact: true, missing: [], unwanted: [] } };
  if (prompt.includes('A client replied after we delivered')) return { body: { rating: null, comment: null, permission_to_publish: false, wants_changes: true, change_request: 'see message', reply: 'Merci, c’est noté.' } };
  if (prompt.includes('Produce the complete deliverable')) { genericProduction++; return { status: 500, body: { error: 'should not be used' } }; }
  if (prompt.includes('independent QA reviewer #')) {
    const crit = [...(prompt.split('Acceptance criteria:')[1] ?? '').matchAll(/^\d+\. (.+)$/gm)].map((m) => m[1]);
    return { body: { criteria_results: crit.map((c) => ({ criterion: c, met: true, evidence: 'checked' })), issues: [], summary: 'OK' } };
  }
  if (prompt.includes('Write the texts of ONE social-media post')) { posts++;
    return { body: { headline: `Idée coiffure n°${posts}`, text: 'Une coupe qui vous ressemble, au cœur de Lyon.', bullets: ['Conseils personnalisés', 'Produits choisis'], cta: 'Prenez rendez-vous', photo_keywords: ['hair salon'] } }; }
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

  it('a precise change on the mockup changes exactly that, nothing else; an unclear request gets a question', async () => {
    const [before] = await sql`select quote from public.leads`;
    clientReplies('Re: Votre maquette', 'Bonjour, c’est bien. Pouvez-vous mettre le titre « Coiffure & bien-être à Lyon » et la couleur principale en bleu marine ?');
    await run('s-2b');
    const revised = outbox.filter((m) => m.to === CLIENT).at(-1)!;
    expect(revised.text).toMatch(/Ce que nous avons modifié/);
    expect(revised.text).toMatch(/bleu marine/);
    expect(revised.html).toContain('Je veux la réalisation');
    const [after] = await sql`select quote, stage from public.leads`;
    const a = (after.quote as { mockup_design: { content: Record<string, unknown>; style: Record<string, string>; photos: unknown[] } }).mockup_design;
    const b = (before.quote as { mockup_design: { content: Record<string, unknown>; photos: unknown[] } }).mockup_design;
    expect(a.content.hero_title).toBe('Coiffure & bien-être à Lyon');
    expect(a.style.primary).toBe('#1f3a5f');
    expect({ ...a.content, hero_title: null }).toEqual({ ...b.content, hero_title: null });   // every other text identical
    expect(a.photos).toEqual(b.photos);                                                      // same photos
    expect((after.quote as { mockup_html: string }).mockup_html).toContain('#1f3a5f');
    expect(after.stage).toBe('proposal');
    clientReplies('Re: Votre maquette', 'Faites-le plus joli.');
    await run('s-2c');
    expect(outbox.filter((m) => m.to === CLIENT).at(-1)!.text).toMatch(/Que souhaitez-vous changer exactement/);
    const [same] = await sql`select quote from public.leads`;
    expect((same.quote as { mockup_html: string }).mockup_html).toBe((after.quote as { mockup_html: string }).mockup_html);   // nothing changed
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
    expect(d.content).toContain('Coiffure &amp; bien-être à Lyon');   // the approved mockup, with the changes made before the order
    expect(d.content).toContain('#1f3a5f');
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

describe('changes after the delivery', () => {
  it('only the requested change is made, the rest is identical, and it is re-delivered without a new invoice', async () => {
    const [before] = await sql`select design, content from public.deliverables where status = 'delivered' order by version desc limit 1`;
    clientReplies('Re: Livraison', 'Merci, très bien ! Pourriez-vous remplacer le texte du bouton par « Réserver maintenant » ?');
    await run('r-1'); await run('r-2');
    const delivery = outbox.filter((m) => m.to === CLIENT).at(-1)!;
    expect(delivery.text).toMatch(/version mise à jour/);
    expect(delivery.text).toMatch(/Réserver maintenant/);
    const site = delivery.attachments!.map((a) => Buffer.from(a.content as Buffer).toString()).find((x) => x.includes('<html'))!;
    expect(site).toContain('Réserver maintenant');
    expect(site.replaceAll('Réserver maintenant', 'X')).toBe(String(before.content).replaceAll(String((before.design as { content: { cta: string } }).content.cta), 'X'));   // nothing else changed
    expect((await sql`select count(*)::int n from public.invoices`)[0].n).toBe(1);   // no new invoice
    expect((await sql`select status from public.projects where subscription_id is null`)[0].status).toBe('delivered');
  }, 180_000);
});

describe('monthly subscription after the delivery', () => {
  it('offers the monthly pack with a sample visual a few days after the delivery', async () => {
    await sql`update public.projects set delivered_at = now() - interval '4 days'`;
    const before = outbox.length;
    await run('s-7');
    const offer = outbox.slice(before).find((m) => m.to === CLIENT);
    expect(offer).toBeDefined();
    expect(offer!.html).toContain('Je m’abonne');
    expect(offer!.html).toContain('19 €');
    expect(offer!.html).toContain('cid:sample-post');
    await run('s-7b');
    expect(outbox.slice(before).filter((m) => m.to === CLIENT).length).toBe(1);   // offered once
  }, 120_000);

  it('"subscribe" → a month of visuals is produced, QA-checked, invoiced with a watermarked preview, then delivered as images after payment', async () => {
    clientReplies('Abonnement – je m’abonne', 'Bonjour,\n\nJe souhaite m’abonner au pack visuels mensuel.');
    await run('s-8');
    await run('s-9');
    const [s] = await sql`select * from public.subscriptions`;
    expect(s.status).toBe('active');
    expect(s.cycles).toBe(1);
    const [p] = await sql`select * from public.projects where subscription_id = ${s.id}`;
    expect(p.status).toBe('ready_for_delivery');
    expect(Number(p.budget_minor)).toBe(1900);
    expect((await sql`select count(*)::int n from public.deliverables where project_id = ${p.id} and format = 'social'`)[0].n).toBe(4);
    const [ap] = await sql`select id from public.approvals where action_type = 'payment.request.send' and status = 'pending'`;
    await asOwner(sql, (tx) => tx`select public.decide_approval(${ap.id}, true, 'ok')`);
    await run('s-10');
    const invoice = outbox.filter((m) => m.to === CLIENT).at(-1)!;
    expect(invoice.html).toContain('cid:preview-1');
    const [inv] = await sql`select * from public.invoices where project_id = ${p.id}`;
    await asOwner(sql, (tx) => tx`select * from public.owner_record_payment(${inv.id}, ${inv.amount_minor}, ${inv.currency}, 'bank_transfer', 'REF-2', true, 'statement_line', 'Relevé ligne 2', null, null)`);
    await run('s-11');
    const delivery = outbox.filter((m) => m.to === CLIENT).at(-1)!;
    expect(delivery.attachments!.filter((a) => a.filename.endsWith('.jpg')).length).toBe(4);
    expect(delivery.text).toMatch(/Arrêter l’abonnement/);
  }, 240_000);

  it('a change on visual 2 changes only visual 2', async () => {
    const [p] = await sql`select id from public.projects where subscription_id is not null`;
    const before = await sql`select work_item, content from public.deliverables where project_id = ${p.id} and status = 'delivered' order by work_item`;
    clientReplies('Re: Livraison', 'Bonjour, sur le visuel 2, pouvez-vous mettre le titre « Nouveau : soin kératine » ?');
    await run('v-1'); await run('v-2');
    const after = await sql`select distinct on (work_item) work_item, content, status from public.deliverables where project_id = ${p.id} order by work_item, version desc`;
    for (const [i, a] of after.entries()) {
      if (a.work_item === 'post-2') { expect(a.content).toContain('Nouveau : soin kératine'); expect(a.content).not.toBe(before[i].content); }
      else expect(a.content).toBe(before[i].content);
    }
    expect(after.every((a) => a.status === 'delivered')).toBe(true);
  }, 180_000);

  it('an unpaid month pauses the subscription; "stop" ends it', async () => {
    const [s] = await sql`select id from public.subscriptions`;
    await sql`update public.subscriptions set next_cycle_at = now() - interval '1 minute' where id = ${s.id}`;
    await run('s-12');   // month 2 starts (month 1 is paid)
    expect((await sql`select cycles from public.subscriptions`)[0].cycles).toBe(2);
    await sql`update public.subscriptions set next_cycle_at = now() - interval '1 minute' where id = ${s.id}`;
    await run('s-13');   // month 2 not paid yet → paused, no month 3
    const [paused] = await sql`select status, cycles from public.subscriptions`;
    expect(paused.status).toBe('paused');
    expect(paused.cycles).toBe(2);
    clientReplies('Arrêter l’abonnement', 'Bonjour, merci d’arrêter mon abonnement.');
    await run('s-14');
    expect((await sql`select status from public.subscriptions`)[0].status).toBe('cancelled');
  }, 240_000);
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
