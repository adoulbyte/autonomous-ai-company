/**
 * Full autonomous cycle with a simulated mailbox (test double for Gmail) and simulated AI:
 * outreach is emailed → client replies "agreed" → deal closed automatically → work produced and double-QA'd →
 * invoice PDF + preview emailed → owner confirms payment (only manual step) → deliverables emailed → deal completed.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { asOwner, freshDb, registerOwner } from './helpers.js';
import { fakeFetch, HN_ITEM, HN_SEARCH, type Responder } from './fakes.js';
import type { Sql } from '../src/db.js';
import { runWorker } from '../src/runtime.js';
import type { IncomingMail, MailTransport, OutgoingMail } from '../src/email/transport.js';

let db: Awaited<ReturnType<typeof freshDb>>; let sql: Sql;
const env = { GITHUB_TOKEN: 'test-token' } as NodeJS.ProcessEnv;
const outbox: OutgoingMail[] = []; const inbox: IncomingMail[] = []; let uid = 0;
const mail: MailTransport = {
  address: 'studio@example.test',
  async send(m) { outbox.push(m); return { messageId: `<sent-${outbox.length}@example.test>` }; },
  async fetchSince(last) { return inbox.filter((x) => x.uid > last); },
};
const clientWrites = (text: string) => { const last = outbox.at(-1)!; uid++;
  inbox.push({ uid, messageId: `<client-${uid}@acme.example>`, inReplyTo: `<sent-${outbox.length}@example.test>`, references: [`<sent-${outbox.length}@example.test>`],
    from: 'ops@acme-logistics.example', fromName: 'Acme Ops', to: mail.address, subject: `Re: ${last.subject}`, text, date: new Date() }); };

let produced = 0; let freeOfferSeen = false; let feedbackMode: 'changes' | 'positive' = 'changes';
const ai: Responder = (prompt) => {
  if (prompt.includes('Analyze this potential business opportunity')) return { body: { is_real_request: true, business_model: 'freelance', revenue_mechanism: 'fixed price', buyer_name: 'Acme Logistics',
    stated_budget_usd: 800, est_revenue_usd: 800, est_hours: 10, skills_required: ['python'], skill_fit: 0.9, difficulty: 0.3, competition: 0.4, risk: 0.15, risk_flags: [],
    p_win: 0.45, p_paid: 0.9, evidence_quality: 0.85, strategic_value: 0.6, confidence: 0.7, unknowns: [], rationale: 'Clear scope and budget.' } };
  if (prompt.includes('You are a pricing analyst')) return { body: { low_usd: 600, typical_usd: 900, high_usd: 1400, typical_hourly_rate_usd: 75, rationale: 'market' } };
  if (prompt.includes('Review this outreach email')) return { body: { score: 9, issues: [], verdict: 'send' } };
  if (prompt.includes('A client replied after we delivered')) return { body: feedbackMode === 'changes'
    ? { rating: null, comment: null, permission_to_publish: false, wants_changes: true, change_request: 'Add the count of distinct shipment_ids to the summary.', reply: 'Thank you — we are adding this now and will send the updated version shortly.' }
    : { rating: 5, comment: 'Fast and flawless.', permission_to_publish: true, wants_changes: false, change_request: null, reply: 'Thank you very much for your kind feedback!' } };
  if (prompt.includes('Write a first reply')) { if (prompt.includes('FREE OF CHARGE')) freeOfferSeen = true; return { body: { subject: 'Python CSV automation for Acme Logistics',
    body: 'Hello Acme team,\n\nYou need a Python automation that validates your daily shipment CSV exports and produces a Markdown summary and a cleaned CSV. We can deliver it as a tested script with usage docs for 800 USD, within your budget. We share a preview first; files are released on payment.\n\nShall we start?',
    claims_made: [], questions_for_buyer: [] } }; }
  if (prompt.includes('Classify this inbound message')) return { body: { category: 'prospect_reply', intent: 'positive', priority: 'high', summary: 'Client agrees', reply_draft: null } };
  if (prompt.includes('You handle the commercial conversation')) return { body: { intent: 'accept', agreed_price_usd: prompt.includes('LAUNCH PROGRAM') ? 0 : 800, asked_if_ai: false,
    scope_summary: '1. Python script validating shipment CSV rows (rejects empty shipment_id)\n2. Markdown summary report with row counts',
    reply: 'Thank you — confirmed: 800 USD for the scope below. We start now and will share a preview shortly; the full files are released on payment of the invoice.' } };
  if (prompt.includes('Turn this agreed project scope into a delivery plan')) return { body: { summary: 'CSV validator', out_of_scope: [],
    requirements: [{ description: 'Validate rows and report', acceptance_criteria: ['Rejects rows with empty shipment_id', 'Prints a Markdown summary with counts'] }],
    work_items: [{ key: 'validator', title: 'CSV validator script', requirement_index: 0, format: 'code', instructions: 'Write the script.' }] } };
  if (prompt.includes('Produce the complete deliverable')) { produced++;
    return { body: { title: 'validator.py', notes: 'Single file.', limitations: [],
      content: `import csv, sys\n\ndef validate(path):\n    ok, bad = [], []\n    with open(path) as f:\n        for row in csv.DictReader(f):\n            (bad if not row.get('shipment_id') else ok).append(row)\n    return ok, bad\n\nif __name__ == '__main__':\n    ok, bad = validate(sys.argv[1])\n    print(f"# Shipment report\\n\\n- valid rows: {len(ok)}\\n- rejected rows: {len(bad)}")\n` } }; }
  if (prompt.includes('independent QA reviewer #')) return { body: { criteria_results: [
    { criterion: 'Rejects rows with empty shipment_id', met: true, evidence: "row.get('shipment_id')" }, { criterion: 'Prints a Markdown summary with counts', met: true, evidence: '# Shipment report' }],
    issues: [], summary: 'Meets all criteria' } };
  return { status: 500, body: { error: 'unexpected prompt' } };
};
const net = fakeFetch({ ai, json: { 'https://hn.algolia.com/api/v1/search_by_date': HN_SEARCH, 'https://hn.algolia.com/api/v1/items/90000001': HN_ITEM,
  'https://api.github.com/search/issues': { items: [] }, 'https://remotive.com/api/remote-jobs': { jobs: [] }, 'https://weworkremotely.com/': '<rss><channel></channel></rss>', 'https://models.github.ai/catalog/models': [{ id: 'openai/gpt-4.1' }, { id: 'openai/gpt-4.1-mini' }] } });
const run = (w: string) => runWorker({ sql, workerId: w, env, fetchFn: net.fn, mail, timeBudgetMs: 120_000 });

beforeAll(async () => {
  db = await freshDb(); sql = db.sql; await registerOwner(sql);
    await sql`update public.settings set value = value || '{"enabled": true, "beneficiary": "Autonomous AI Studio", "iban": "FR76 3000 6000 0112 3456 7890 189", "bic": "AGRIFRPP"}'::jsonb where key = 'finance.payment_instructions'`;
});
afterAll(async () => { await db.drop(); });

describe('launch mode: free work in exchange for honest feedback', () => {
  it('offers free work, closes on agreement, produces + double QA, delivers free without invoice', async () => {
    await run('p-1');
    const first = outbox.find((m) => m.subject.includes('Python CSV automation'));
    expect(first).toBeDefined();
    expect(freeOfferSeen).toBe(true);                 // the sales agent was instructed to offer the work for free
    clientWrites('Sounds great, yes please go ahead.');
    await run('p-2'); await run('p-3');
    const [p] = await sql`select * from public.projects`;
    expect(Number(p.budget_minor)).toBe(0);
    expect(p.status).toBe('delivered');
    expect((await sql`select count(*)::int n from public.invoices`)[0].n).toBe(0);   // no invoice in launch mode
    const delivery = outbox.find((m) => m.subject.startsWith('Delivery:'))!;
    expect(delivery.text).toContain('free of charge');
    expect(delivery.text).toContain('honest feedback');
    expect(delivery.attachments!.length).toBe(1);
  });
  it('turns a change request into a new version, re-delivers, then records feedback with permission', async () => {
    clientWrites('Thanks! Could you also print the number of distinct shipment_ids in the summary?');
    feedbackMode = 'changes';
    await run('p-4'); await run('p-5');
    expect((await sql`select count(*)::int n from public.deliverables where version = 2`)[0].n).toBe(1);
    expect(outbox.filter((m) => m.subject.startsWith('Delivery:')).length).toBe(2);
    feedbackMode = 'positive';
    clientWrites('Perfect, works great. 5/5 — and yes, you can mention us as a reference: "Fast and flawless."');
    await run('p-6');
    const [fb] = await sql`select * from public.client_feedback order by created_at desc limit 1`;
    expect(fb.rating).toBe(5); expect(fb.permission_to_publish).toBe(true);
    expect((await sql`select status from public.projects`)[0].status).toBe('closed');
    expect((await sql`select count(*)::int n from public.portfolio_items`)[0].n).toBe(1);
  });
});
