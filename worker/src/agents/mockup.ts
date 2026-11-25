import { z } from 'zod';
import type { AiGateway } from '../ai/gateway.js';
import type { Handler } from './context.js';
import { finish } from './context.js';
import { PermanentError } from '../errors.js';
import { untrusted } from '../sanitize.js';
import { skillsFor } from '../skills.js';
import { autoApproveIfPolicy, requestApproval } from '../queue.js';
import { getCatalog } from './pricing.js';
import { promisedFreeWork } from './negotiation.js';
import { getMode, isPilot } from '../mode.js';
import { identity } from './comms.js';
import { staticChecks } from './production.js';
import { renderHtml } from '../email/template.js';
import { proposalCta } from '../email/cta.js';
import { renderBrochurePdf } from '../email/brochure.js';
import { screenshotHtml } from '../render/screenshot.js';
import { findPhotos, generatePhoto, tradeProfile } from '../render/photos.js';
import { factsFromListing, PostContentSchema, renderPost, renderSite, SiteContentSchema, type PostContent, type SiteContent } from '../render/site.js';

const ReviewSchema = z.object({ score: z.number().min(0).max(10), issues: z.array(z.string().max(300)).max(10) });

const MAIL: Record<string, { subject: string; site: string; post: string; offer: (label: string, price: string, days: number) => string; free: (label: string, days: number) => string; next: string; brochure: string; preview: string }> = {
  fr: { subject: 'Votre maquette', site: 'Comme promis, voici la maquette de votre site, préparée spécialement pour {name} (aperçu ci-dessous, sur ordinateur et sur téléphone).',
        post: 'Comme promis, voici un exemple de visuel préparé spécialement pour {name} (aperçu ci-dessous).',
        offer: (l, p, d) => `Notre proposition : ${l} pour ${p}, prêt en ${d} jour${d > 1 ? 's' : ''}. Tout reste modifiable : textes, couleurs, photos.`,
        free: (l, d) => `Comme annoncé dans notre premier message, la réalisation (${l}) vous est offerte, prête en ${d} jour${d > 1 ? 's' : ''} ; nous vous demanderons simplement un avis honnête. Tout reste modifiable : textes, couleurs, photos. Cliquez ci-dessous pour lancer la réalisation, ou choisissez « Peut-être plus tard ».`,
        next: 'La maquette vous plaît ? Cliquez sur le bouton ci-dessous : nous finalisons le site avec vos textes et vos photos, vous le validez, puis nous vous envoyons la facture. Ce n’est pas le bon moment ? Choisissez « Peut-être plus tard », sans aucun engagement.',
        brochure: 'Vous trouverez notre plaquette en pièce jointe.', preview: 'Aperçu sur ordinateur et sur téléphone' },
  en: { subject: 'Your preview', site: 'As promised, here is the preview of your website, prepared especially for {name} (desktop and phone views below).',
        post: 'As promised, here is a sample visual prepared especially for {name} (preview below).',
        offer: (l, p, d) => `Our proposal: ${l} for ${p}, ready in ${d} day${d > 1 ? 's' : ''}. Everything can be adjusted: texts, colours, photos.`,
        free: (l, d) => `As announced in our first message, the work (${l}) is free of charge, ready in ${d} day${d > 1 ? 's' : ''}; we only ask for an honest review. Everything can be adjusted: texts, colours, photos. Click below to go ahead, or choose "Maybe later".`,
        next: 'Do you like it? Click the button below: we finish it with your texts and photos, you approve it, and only then do we send the invoice. Not the right time? Choose "Maybe later", with no obligation.',
        brochure: 'Please find our brochure attached.', preview: 'Desktop and phone preview' },
  nl: { subject: 'Uw voorbeeld', site: 'Zoals beloofd, hier is het voorbeeld van uw website, speciaal gemaakt voor {name} (weergave op computer en telefoon hieronder).',
        post: 'Zoals beloofd, hier is een voorbeeldvisual speciaal gemaakt voor {name}.',
        offer: (l, p, d) => `Ons voorstel: ${l} voor ${p}, klaar in ${d} dag${d > 1 ? 'en' : ''}. Alles kan worden aangepast: teksten, kleuren, foto's.`,
        free: (l, d) => `Zoals aangekondigd in ons eerste bericht is het werk (${l}) gratis, klaar in ${d} dag${d > 1 ? 'en' : ''}; we vragen alleen een eerlijke beoordeling. Alles kan worden aangepast. Klik hieronder om te starten, of kies "Misschien later".`,
        next: 'Bevalt het u? Klik op de knop hieronder: we werken het af met uw teksten en foto’s, u keurt het goed en pas daarna sturen we de factuur. Niet het juiste moment? Kies "Misschien later", zonder verplichting.',
        brochure: 'Onze brochure vindt u in de bijlage.', preview: 'Weergave op computer en telefoon' },
  pt: { subject: 'A sua maquete', site: 'Como prometido, eis a maquete do seu site, preparada especialmente para {name} (pré-visualização em computador e telemóvel abaixo).',
        post: 'Como prometido, eis um exemplo de visual preparado especialmente para {name}.',
        offer: (l, p, d) => `A nossa proposta: ${l} por ${p}, pronto em ${d} dia${d > 1 ? 's' : ''}. Tudo pode ser ajustado: textos, cores, fotografias.`,
        free: (l, d) => `Como anunciado na nossa primeira mensagem, o trabalho (${l}) é gratuito, pronto em ${d} dia${d > 1 ? 's' : ''}; pedimos apenas uma avaliação honesta. Tudo pode ser ajustado. Clique abaixo para avançar, ou escolha "Talvez mais tarde".`,
        next: 'Gostou? Clique no botão abaixo: finalizamos com os seus textos e fotos, aprova o resultado e só depois enviamos a fatura. Não é o momento certo? Escolha "Talvez mais tarde", sem compromisso.',
        brochure: 'Segue em anexo a nossa brochura.', preview: 'Pré-visualização em computador e telemóvel' },
};

/** lead.mockup — the prospect said yes: build a personalised mockup, review it, send it with the quote and the brochure. */
export const prospectMockup: Handler = async (ctx) => {
  const leadId = String(ctx.task.input.lead_id);
  const [l] = await ctx.sql`select l.*, o.description as listing, o.analysis, o.buyer_name, k.email as contact_email
      from public.leads l join public.opportunities o on o.id = l.opportunity_id left join public.contacts k on k.id = l.contact_id where l.id = ${leadId}`;
  if (!l) throw new PermanentError('lead not found');
  const q = (l.quote ?? {}) as Record<string, unknown>;
  if (q.mockup_sent_at) return finish(ctx, async () => ({ skipped: 'mockup already sent' }));
  if (['won', 'lost', 'disqualified'].includes(String(l.stage))) return finish(ctx, async () => ({ skipped: `lead ${l.stage}` }));
  const a = (l.analysis ?? {}) as { need?: string; language?: string; category?: string; city?: string };
  const lang = a.language ?? 'fr'; const need = a.need === 'website' ? 'website' : 'marketing';
  const [msg] = await ctx.sql`select m.body, m.conversation_id from public.messages m where m.id = ${ctx.task.input.message_id ?? null}`;
  const { html, content, photos, shots, model } = await buildPreview({ ai: ctx.ai, taskId: ctx.task.id, env: ctx.env, fetchFn: ctx.fetchFn,
    listing: String(l.listing ?? l.title), name: String(l.buyer_name ?? ''), category: a.category, city: a.city, lang, need, email: l.contact_email, clientMessage: String(msg?.body ?? '') });
  const id = await identity(ctx.sql);
  const cat = await getCatalog(ctx.sql);
  const item = cat.items[need === 'website' ? 'website' : 'social_pack'] ?? Object.values(cat.items)[0];
  const t = MAIL[lang] ?? MAIL.en;
  const free = isPilot(await getMode(ctx.sql)) || await promisedFreeWork(ctx.sql, leadId);
  const price = `${(item.price_minor / 100).toFixed(0)} ${cat.currency === 'EUR' ? '€' : cat.currency}`;
  const name = String(l.buyer_name ?? '');
  const greet = ({ fr: 'Bonjour,', en: 'Hello,', nl: 'Goedendag,', pt: 'Olá,' } as Record<string, string>)[lang] ?? 'Hello,';
  const body = [greet, (need === 'website' ? t.site : t.post).replace('{name}', name), (free ? t.free(item.label[lang] ?? item.label.en ?? '', item.days) : t.offer(item.label[lang] ?? item.label.en ?? '', price, item.days)), ...(free ? [] : [t.next]), t.brochure].join('\n\n');
  const imgs = shots ? `<div style="margin:6px 0 18px"><div style="font-size:12px;color:#6b6f78;margin-bottom:8px">${t.preview}</div>
<img src="cid:mockup-desktop" alt="" width="544" style="display:block;width:100%;max-width:544px;border:1px solid #e7e4dd;border-radius:8px;margin-bottom:12px">
${shots.mobile ? '<img src="cid:mockup-mobile" alt="" width="220" style="display:block;width:220px;border:1px solid #e7e4dd;border-radius:12px">' : ''}</div>` : '';
  const brochure = await renderBrochurePdf(id, cat, lang, ctx.mail?.address ?? '');
  const attachments = [
    ...(shots ? [{ filename: 'apercu-ordinateur.jpg', content_b64: shots.desktop.toString('base64'), contentType: 'image/jpeg', cid: 'mockup-desktop' }] : []),
    ...(shots?.mobile ? [{ filename: 'apercu-telephone.jpg', content_b64: shots.mobile.toString('base64'), contentType: 'image/jpeg', cid: 'mockup-mobile' }] : []),
    { filename: `${id.company_name.replace(/[^\w-]+/g, '-')}-plaquette.pdf`, content_b64: brochure.toString('base64'), contentType: 'application/pdf' },
  ];
  return finish(ctx, async (tx) => {
    const [conv] = msg?.conversation_id ? [{ id: msg.conversation_id }]
      : await tx`select id from public.conversations where lead_id = ${leadId} order by created_at limit 1`;
    const [c] = await tx`select subject from public.conversations where id = ${conv.id}`;
    const [out] = await tx`insert into public.messages(conversation_id, direction, status, to_addr, subject, body, html, attachments, generated_by_task, idempotency_key)
        values (${conv.id}, 'outbound', 'draft', ${l.contact_email}, ${'Re: ' + String(c?.subject ?? t.subject)}, ${body},
          ${renderHtml(body, id, { preheader: t.preview, blocks: imgs, cta: proposalCta(ctx.mail?.address ?? '', lang, need) })}, ${tx.json(attachments as never)}, ${ctx.task.id}, ${'mockup:' + leadId}) returning id`;
    const approvalId = await requestApproval(tx, {
      actionType: 'message.send', title: `Maquette + devis : ${String(l.title).slice(0, 80)}`, requestedBy: 'specialist_worker',
      reason: 'The prospect asked to see the free preview; it passed an independent review.', riskLevel: 'low',
      ifApproved: 'The preview, the quote and the brochure are emailed automatically.', ifRejected: 'Nothing is sent.',
      entityType: 'message', entityId: out.id, taskId: ctx.task.id, key: `message.send:${out.id}`, payload: { message_id: out.id },
    });
    await tx`update public.messages set status = 'awaiting_approval', approval_id = ${approvalId} where id = ${out.id}`;
    await autoApproveIfPolicy(tx, approvalId);
    await tx`update public.leads set value_minor = ${free ? 0 : item.price_minor}, currency = ${cat.currency}, next_follow_up_at = now() + interval '5 days',
        quote = coalesce(quote, '{}'::jsonb) || ${tx.json({ mockup_sent_at: new Date().toISOString(), mockup_html: html, mockup_content: content, photos: photos.length, mockup_photos: photos.filter((x) => !x.url.startsWith('data:')), need, reminders: 0, catalog: need === 'website' ? 'website' : 'social_pack', price_minor: free ? 0 : item.price_minor, free } as never)}
        where id = ${leadId}`;
    if (['contacted', 'engaged'].includes(String(l.stage))) await tx`update public.leads set stage = 'proposal' where id = ${leadId}`;
    return { message_id: out.id, screenshots: !!shots, model };
  });
};

export type PreviewInput = { ai: Pick<AiGateway, 'generate'>; taskId?: string; env: NodeJS.ProcessEnv; fetchFn?: typeof fetch; listing: string; name: string;
  category?: string | null; city?: string | null; lang: string; need: 'website' | 'marketing'; email?: string | null; clientMessage: string };

/** Texts by the AI (reviewed by another model), real photos of the trade, professional template, screenshots. */
export async function buildPreview(o: PreviewInput) {
  const { ai, taskId, env, listing, name, lang, need, email, clientMessage } = o;
  const a = { category: o.category ?? undefined, city: o.city ?? undefined };
  const langName = ({ fr: 'French', en: 'English', nl: 'Dutch', pt: 'Portuguese' } as Record<string, string>)[lang] ?? 'English';
  const facts = factsFromListing(listing, name, a.city, email);
  const profile = tradeProfile(a.category);
  const brief = need === 'website'
    ? `the texts of a modern one-page showcase website (hero, services, about, highlights, call to action). The layout, colours and photos are handled by our designers: write ONLY the texts, as JSON with exactly these keys:
{tagline (short eyebrow, e.g. trade + city), hero_title (punchy, max 8 words), hero_text (1-2 sentences), cta (button label, e.g. "Nous contacter" or "Réserver"),
 services_title, services_intro, services: [3 to 6 × {title, text}] (typical offer of this trade, described generically, without prices),
 about_title, about_text (2 short paragraphs separated by a blank line, warm and specific to the trade and the city),
 highlights: [3 × {title, text}] (e.g. savoir-faire, local, welcome), cta_title, cta_text, photo_keywords: [2-4 English stock-photo searches for THIS trade]}`
    : `the texts of ONE social-media post (square visual) promoting this business. The layout, colours and photo are handled by our designers: write ONLY the texts, as JSON
{headline (max 7 words), text (one sentence), bullets: [2-3 very short benefits], cta (short), photo_keywords: [2-4 English stock-photo searches for THIS trade]}`;
  const prompt = `${skillsFor('production', need === 'website' ? 'html website vitrine copywriting' : 'design visual social post copywriting')}

Create a free preview for this local business: write ${brief}
Language of all texts (except photo_keywords): ${langName}. Use ONLY facts from the listing and the client's message below (name, trade, city).
Never invent prices, reviews, ratings, awards, years of experience, staff names, phone numbers or opening hours; keep claims generic and true for any good business of this trade.
Tone: professional, warm, concrete, no clichés, no exclamation marks overload. Trade: ${a.category ?? ''}. City: ${a.city ?? ''}.

${untrusted('business-listing', listing, 3000)}
${untrusted('client-message', clientMessage, 2000)}`;
  const schema = (need === 'website' ? SiteContentSchema : PostContentSchema) as z.ZodType<SiteContent | PostContent>;
  let res = await ai.generate({ roleKey: 'specialist_worker', taskId, tier: 'strong', allowDowngrade: true, schema, maxTokens: 3000, temperature: 0.6,
    messages: [{ role: 'user', content: prompt }] });
  for (let round = 0; round < 2; round++) {
    const review = await ai.generate({ roleKey: 'qa_reviewer', taskId, tier: 'standard', schema: ReviewSchema, maxTokens: 600, temperature: 0, avoidModel: res.model,
      messages: [{ role: 'user', content: `${skillsFor('qa', 'website copywriting')}
Review this free preview for a local business as a demanding copywriter. Score 0-10: persuasive and specific to the trade, correct ${langName} (spelling, grammar),
no invented facts (prices, reviews, years, names, hours not in the listing), no placeholder text, consistent tone. Return JSON {score, issues}.
${untrusted('preview-texts', JSON.stringify(res.data).slice(0, 12000), 12000)}
${untrusted('business-listing', listing, 2000)}` }] });
    if (review.data.score >= 7) break;
    if (round === 1) throw new Error(`mockup below quality bar (score ${review.data.score})`);
    res = await ai.generate({ roleKey: 'specialist_worker', taskId, tier: 'strong', allowDowngrade: true, schema, maxTokens: 3000, temperature: 0.5,
      messages: [{ role: 'user', content: `${prompt}\n\nA reviewer found these problems in your previous version; fix all of them:\n${review.data.issues.map((i) => `- ${i}`).join('\n')}` }] });
  }
  // Real photos of the trade (searches from our trade profile first, then the AI's suggestions).
  const fetchFn = o.fetchFn ?? fetch;
  const queries = [...new Set([...profile.queries.slice(0, 2), ...res.data.photo_keywords, ...profile.queries.slice(2)])];
  let photos = await findPhotos(queries, need === 'website' ? 10 : 1, env, fetchFn);
  if (!photos.length) { const g = await generatePhoto(`${queries[0]}, ${a.city ?? ''}`, env, fetchFn); if (g) photos = [g]; }
  const html = need === 'website' ? renderSite(res.data as SiteContent, facts, photos, profile.theme, lang) : renderPost(res.data as PostContent, facts, photos, profile.theme, lang);
  const problems = staticChecks(html, 'html').filter((i) => need === 'website' || !/viewport/.test(i));
  if (problems.length) throw new Error(`mockup failed static checks: ${problems.join('; ').slice(0, 300)}`);
  const shots = await screenshotHtml(html, env, need === 'website' ? 'site' : 'post');
  return { html, content: res.data, photos, shots, model: res.model };
}

const REMIND: Record<string, { intro: (name: string) => string; again: string; last: string }> = {
  fr: { intro: (n) => `Bonjour,\n\nJe reviens vers vous au sujet de la maquette préparée pour ${n}. Elle est toujours disponible, et notre proposition reste la même.`,
        again: 'Vous retrouverez l’aperçu ci-dessous et notre plaquette en pièce jointe. Un simple clic sur l’un des boutons suffit pour nous indiquer votre choix.',
        last: 'C’est notre dernier message à ce sujet : sans réponse, nous ne vous relancerons plus.' },
  en: { intro: (n) => `Hello,\n\nI am getting back to you about the mockup we prepared for ${n}. It is still available, and our proposal remains the same.`,
        again: 'You will find the preview below and our brochure attached. One click on a button is enough to let us know your choice.',
        last: 'This is our last message on this subject: without a reply, we will not follow up again.' },
  nl: { intro: (n) => `Goedendag,\n\nIk kom bij u terug over het voorbeeld dat we voor ${n} hebben gemaakt. Het is nog steeds beschikbaar en ons voorstel blijft hetzelfde.`,
        again: 'Hieronder vindt u het voorbeeld en in de bijlage onze brochure. Eén klik op een knop volstaat om ons uw keuze te laten weten.',
        last: 'Dit is ons laatste bericht hierover: zonder antwoord nemen we geen contact meer op.' },
  pt: { intro: (n) => `Olá,\n\nVolto a contactá-lo sobre a maquete que preparámos para ${n}. Continua disponível e a nossa proposta mantém-se.`,
        again: 'Encontra a pré-visualização abaixo e a nossa brochura em anexo. Basta um clique num dos botões para nos indicar a sua escolha.',
        last: 'É a nossa última mensagem sobre este assunto: sem resposta, não voltaremos a contactá-lo.' },
};
export const MAX_PROPOSAL_REMINDERS = 3;

/** lead.proposal_reminder — the same proposal again (preview, offer, brochure) with three buttons: go / later / not interested. */
export const proposalReminder: Handler = async (ctx) => {
  const leadId = String(ctx.task.input.lead_id);
  const [l] = await ctx.sql`select l.*, o.analysis, o.buyer_name, k.email as contact_email, k.do_not_contact
      from public.leads l join public.opportunities o on o.id = l.opportunity_id left join public.contacts k on k.id = l.contact_id where l.id = ${leadId}`;
  const q = (l?.quote ?? {}) as { mockup_sent_at?: string; mockup_html?: string; need?: string; reminders?: number; free?: boolean; catalog?: string; price_minor?: number };
  const n = Number(q.reminders ?? 0) + 1;
  if (!l || l.stage !== 'proposal' || !q.mockup_sent_at || !l.contact_email || l.do_not_contact || n > MAX_PROPOSAL_REMINDERS) {
    if (l) await ctx.sql`update public.leads set next_follow_up_at = null where id = ${leadId} and stage <> 'proposal'`;
    return finish(ctx, async () => ({ skipped: 'not eligible' }));
  }
  const a = (l.analysis ?? {}) as { language?: string; need?: string };
  const lang = a.language ?? 'fr'; const need = q.need === 'marketing' || a.need !== 'website' ? 'marketing' : 'website';
  const t = MAIL[lang] ?? MAIL.en; const r = REMIND[lang] ?? REMIND.en;
  const id = await identity(ctx.sql);
  const cat = await getCatalog(ctx.sql);
  const item = cat.items[q.catalog ?? (need === 'website' ? 'website' : 'social_pack')] ?? Object.values(cat.items)[0];
  const price = `${(Number(q.price_minor ?? item.price_minor) / 100).toFixed(0)} ${cat.currency === 'EUR' ? '€' : cat.currency}`;
  const label = item.label[lang] ?? item.label.en ?? '';
  const offer = q.free ? t.free(label, item.days) : t.offer(label, price, item.days);
  const body = [r.intro(String(l.buyer_name ?? '')), offer, r.again, ...(n === MAX_PROPOSAL_REMINDERS ? [r.last] : [])].join('\n\n');
  const shots = q.mockup_html ? await screenshotHtml(q.mockup_html, ctx.env, need === 'website' ? 'site' : 'post') : null;
  const imgs = shots ? `<div style="margin:6px 0 18px"><div style="font-size:12px;color:#6b6f78;margin-bottom:8px">${t.preview}</div>
<img src="cid:mockup-desktop" alt="" width="544" style="display:block;width:100%;max-width:544px;border:1px solid #e7e4dd;border-radius:8px;margin-bottom:12px">
${shots.mobile ? '<img src="cid:mockup-mobile" alt="" width="220" style="display:block;width:220px;border:1px solid #e7e4dd;border-radius:12px">' : ''}</div>` : '';
  const brochure = await renderBrochurePdf(id, cat, lang, ctx.mail?.address ?? '');
  const attachments = [
    ...(shots ? [{ filename: 'apercu-ordinateur.jpg', content_b64: shots.desktop.toString('base64'), contentType: 'image/jpeg', cid: 'mockup-desktop' }] : []),
    ...(shots?.mobile ? [{ filename: 'apercu-telephone.jpg', content_b64: shots.mobile.toString('base64'), contentType: 'image/jpeg', cid: 'mockup-mobile' }] : []),
    { filename: `${id.company_name.replace(/[^\w-]+/g, '-')}-plaquette.pdf`, content_b64: brochure.toString('base64'), contentType: 'application/pdf' },
  ];
  const html = renderHtml(body, id, { preheader: t.preview, blocks: imgs, cta: proposalCta(ctx.mail?.address ?? '', lang, need, true) });
  return finish(ctx, async (tx) => {
    const [conv] = await tx`select c.id, c.subject from public.conversations c where c.lead_id = ${leadId} order by c.updated_at desc limit 1`;
    if (!conv) return { skipped: 'no conversation' };
    const [out] = await tx`insert into public.messages(conversation_id, direction, status, to_addr, subject, body, html, attachments, generated_by_task, idempotency_key)
        values (${conv.id}, 'outbound', 'draft', ${l.contact_email}, ${String(conv.subject ?? t.subject).startsWith('Re:') ? String(conv.subject) : 'Re: ' + String(conv.subject ?? t.subject)}, ${body},
          ${html}, ${tx.json(attachments as never)}, ${ctx.task.id}, ${`proposal-reminder:${leadId}:${n}`}) on conflict (idempotency_key) do nothing returning id`;
    if (!out) return { skipped: 'already queued' };
    const approvalId = await requestApproval(tx, {
      actionType: 'message.send', title: `Rappel ${n} – proposition : ${String(l.title).slice(0, 70)}`, requestedBy: 'sales_agent',
      reason: 'No decision yet on the proposal; same offer, with a "not interested" option.', riskLevel: 'low',
      ifApproved: 'The reminder is emailed.', ifRejected: 'Nothing is sent.', entityType: 'message', entityId: out.id, taskId: ctx.task.id,
      key: `message.send:${out.id}`, payload: { message_id: out.id },
    });
    await tx`update public.messages set status = 'awaiting_approval', approval_id = ${approvalId} where id = ${out.id}`;
    await autoApproveIfPolicy(tx, approvalId);
    await tx`update public.leads set quote = coalesce(quote, '{}'::jsonb) || ${tx.json({ reminders: n, last_reminder_at: new Date().toISOString() } as never)},
        next_follow_up_at = ${n < MAX_PROPOSAL_REMINDERS ? new Date(Date.now() + 21 * 86_400_000) : null} where id = ${leadId}`;
    return { reminder: n, screenshots: !!shots };
  });
};
