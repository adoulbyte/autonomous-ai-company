import type { Handler } from './context.js';
import { finish } from './context.js';
import { PermanentError } from '../errors.js';
import { getSetting, logEvent, type Sql, type Tx } from '../db.js';
import { autoApproveIfPolicy, enqueue, requestApproval } from '../queue.js';
import { renderHtml } from '../email/template.js';
import { identity } from './comms.js';
import { connectDomain, pagesProjectName, publishSite } from '../hosting/pages.js';

/**
 * Option "website online": once the client has paid, we publish the delivered website (Cloudflare Pages, free) and connect
 * a domain name in the client's name. The domain is bought by the owner on demand (one approval, ~10 EUR, after payment);
 * the system then connects it and tells the client. Revisions are republished automatically.
 */
const T: Record<string, { online: (url: string, domain: string | null) => string; subject: string; subject2: string }> = {
  fr: { subject: 'Votre site est en ligne', subject2: 'Votre nom de domaine est actif',
        online: (u, d) => `Bonjour,\n\nVotre site est en ligne : ${u}\n\nVous pouvez déjà le consulter et le partager.${d ? ` Votre nom de domaine www.${d} sera activé très prochainement : nous vous prévenons dès qu’il fonctionne.` : ' Nous vous prévenons dès que votre nom de domaine est activé.'}\n\nLes fichiers sources vous ont aussi été envoyés. Pour toute modification, répondez simplement à ce message.` },
  en: { subject: 'Your website is online', subject2: 'Your domain name is active',
        online: (u, d) => `Hello,\n\nYour website is online: ${u}\n\nYou can already view and share it.${d ? ` Your domain name www.${d} will be activated very soon: we will let you know as soon as it works.` : ' We will let you know as soon as your domain name is active.'}\n\nYou have also received the source files. For any change, simply reply to this message.` },
  nl: { subject: 'Uw website staat online', subject2: 'Uw domeinnaam is actief',
        online: (u, d) => `Goedendag,\n\nUw website staat online: ${u}\n\nU kunt hem al bekijken en delen.${d ? ` Uw domeinnaam www.${d} wordt binnenkort geactiveerd; we laten het u weten.` : ' We laten het u weten zodra uw domeinnaam actief is.'}\n\nU hebt ook de bronbestanden ontvangen. Voor een wijziging antwoordt u gewoon op dit bericht.` },
  pt: { subject: 'O seu site está online', subject2: 'O seu domínio está ativo',
        online: (u, d) => `Olá,\n\nO seu site está online: ${u}\n\nJá o pode ver e partilhar.${d ? ` O seu domínio www.${d} será ativado muito em breve: avisamos assim que funcionar.` : ' Avisamos assim que o seu domínio estiver ativo.'}\n\nTambém recebeu os ficheiros fonte. Para qualquer alteração, basta responder a esta mensagem.` },
};
const CONNECTED: Record<string, (d: string) => string> = {
  fr: (d) => `Bonjour,\n\nVotre nom de domaine est actif : votre site est accessible à l’adresse https://www.${d}\n(la mise en service complète peut prendre quelques heures selon les fournisseurs d’accès).\n\nLe nom de domaine est enregistré à votre nom. Votre formule comprend l’hébergement et le nom de domaine pendant un an ; nous vous préviendrons avant l’échéance.`,
  en: (d) => `Hello,\n\nYour domain name is active: your website is available at https://www.${d}\n(it can take a few hours to work everywhere).\n\nThe domain name is registered in your name. Your plan includes hosting and the domain name for one year; we will remind you before it ends.`,
};

async function leadOf(sql: Sql | Tx, projectId: string) {
  const [p] = await sql`select p.id, p.lead_id, l.quote, o.buyer_name, o.description as listing, o.analysis, k.email
      from public.projects p join public.leads l on l.id = p.lead_id left join public.opportunities o on o.id = l.opportunity_id
      left join public.contacts k on k.id = l.contact_id where p.id = ${projectId}`;
  return p;
}

async function sendClient(tx: Tx, taskId: string, leadId: string, projectId: string | null, to: string, subject: string, body: string, key: string, title: string) {
  const id = await identity(tx as unknown as Sql);
  // Linked to the project: a reply to this email (a change, a question) is handled as an after-delivery request.
  const [conv] = await tx`insert into public.conversations(lead_id, project_id, contact_id, channel, subject)
      values (${leadId}, ${projectId}, (select contact_id from public.leads where id = ${leadId}), 'email', ${subject}) returning id`;
  const [out] = await tx`insert into public.messages(conversation_id, direction, status, to_addr, subject, body, html, generated_by_task, idempotency_key)
      values (${conv.id}, 'outbound', 'draft', ${to}, ${subject}, ${body}, ${renderHtml(body, id, { preheader: subject })}, ${taskId}, ${key})
      on conflict (idempotency_key) do nothing returning id`;
  if (!out) return;
  const approvalId = await requestApproval(tx, { actionType: 'message.send', title, requestedBy: 'project_manager', reason: 'Website hosting for a paying client.',
    riskLevel: 'low', ifApproved: 'The email is sent.', ifRejected: 'Nothing is sent.', entityType: 'message', entityId: out.id, taskId, key: `message.send:${out.id}`, payload: { message_id: out.id } });
  await tx`update public.messages set status = 'awaiting_approval', approval_id = ${approvalId} where id = ${out.id}`;
  await autoApproveIfPolicy(tx, approvalId);
}

/** hosting.publish — publish (or republish after a change) the delivered website of a client who chose the online option. */
export const publishHosting: Handler = async (ctx) => {
  const projectId = String(ctx.task.input.project_id);
  const p = await leadOf(ctx.sql, projectId);
  if (!p) throw new PermanentError('project not found');
  const [paid] = await ctx.sql`select public.project_is_paid(${projectId}) as ok`;
  if (!paid.ok) throw new PermanentError('not paid: nothing is published');
  const [site] = await ctx.sql`select content from public.deliverables where project_id = ${projectId} and format = 'html' and status in ('delivered','ready_for_delivery') order by version desc limit 1`;
  if (!site) return finish(ctx, async () => ({ skipped: 'no website in this project' }));
  const [hosted] = await ctx.sql`select * from public.hosted_sites where lead_id = ${p.lead_id}`;
  let project = hosted?.pages_project as string | undefined;
  if (!project) {
    project = pagesProjectName(String(p.buyer_name ?? 'site'));
    const [taken] = await ctx.sql`select 1 from public.hosted_sites where pages_project = ${project}`;
    if (taken) project = `${project}-${String(p.lead_id).slice(0, 4)}`;
  }
  const url = await publishSite(project, String(site.content), ctx.env);
  const q = (p.quote ?? {}) as { domain_suggestion?: string | null };
  const lang = ((p.analysis ?? {}) as { language?: string }).language ?? 'fr'; const t = T[lang] ?? T.en;
  return finish(ctx, async (tx) => {
    if (hosted) { await tx`update public.hosted_sites set url = ${url}, project_id = ${projectId}, status = 'online' where id = ${hosted.id}`; return { republished: url }; }
    const domain = q.domain_suggestion ?? null;
    const [h] = await tx`insert into public.hosted_sites(lead_id, project_id, pages_project, url, domain, domain_status)
        values (${p.lead_id}, ${projectId}, ${project}, ${url}, ${domain}, 'to_buy') returning id`;
    if (p.email) await sendClient(tx, ctx.task.id, String(p.lead_id), projectId, String(p.email), t.subject, t.online(url, domain), `hosting-online:${h.id}`, `Site en ligne : ${String(p.buyer_name).slice(0, 70)}`);
    // The owner buys the domain name (in the client's name) once — then the system connects it.
    const holder = [p.buyer_name, String(p.listing ?? '').match(/^Adresse\s*:\s*(.+)$/m)?.[1], p.email].filter(Boolean).join(' · ');
    const approvalId = await requestApproval(tx, {
      actionType: 'domain.purchase', title: `Acheter le nom de domaine ${domain ?? '(à choisir)'} — ${String(p.buyer_name).slice(0, 60)} (~10 €)`, requestedBy: 'project_manager',
      reason: `Le client a payé la formule « site en ligne + nom de domaine ». Son site est déjà en ligne sur ${url}.`,
      evidence: [{ titulaire_du_domaine: holder }, { etape_1: `Acheter ${domain ? domain : 'un nom disponible (indiquez-le dans la note de validation)'} chez votre registraire (OVH, Gandi…), au nom du client (titulaire ci-dessus).` },
        { etape_2: `Dans la zone DNS du domaine : enregistrement CNAME « www » → ${project}.pages.dev ; et une redirection du domaine sans « www » vers https://www.${domain ?? 'domaine'}` },
        { etape_3: 'Cliquez sur « Valider » (si vous avez choisi un autre nom, écrivez-le dans la note). Le système relie le domaine au site et prévient le client.' }],
      expectedBenefit: 'Le client a son site sur son propre nom de domaine, comme prévu dans sa formule.', risk: 'Coût du domaine (~10 €/an), déjà payé par le client.', riskLevel: 'low',
      costMinor: 1000, currency: 'EUR', ifApproved: 'Le système relie le domaine au site et envoie la confirmation au client.', ifRejected: 'Le site reste en ligne sur son adresse provisoire.',
      entityType: 'hosted_site', entityId: h.id, taskId: ctx.task.id, key: `domain.purchase:${h.id}`, payload: { hosted_site_id: h.id, domain },
    });
    await enqueue(tx, { type: 'hosting.connect_domain', key: `connect-domain:${h.id}`, role: 'project_manager', entityType: 'hosted_site', entityId: h.id,
      input: { hosted_site_id: h.id, approval_id: approvalId }, priority: 70, title: `Connect domain: ${String(p.buyer_name).slice(0, 60)}`, approvalId, timeoutSeconds: 120 });
    await logEvent(tx, 'hosted_site', h.id, 'site_online', `Website online (${String(p.buyer_name)}) — domain to buy: ${domain ?? 'to choose'}`, {}, 'warning');
    return { published: url, domain };
  });
};

/** hosting.connect_domain — runs after the owner bought the domain (approval): connects it and tells the client. */
export const connectHostingDomain: Handler = async (ctx) => {
  const { hosted_site_id: hid, approval_id: aid } = ctx.task.input as { hosted_site_id: string; approval_id: string };
  const [h] = await ctx.sql`select h.*, o.analysis, k.email from public.hosted_sites h join public.leads l on l.id = h.lead_id
      left join public.opportunities o on o.id = l.opportunity_id left join public.contacts k on k.id = l.contact_id where h.id = ${hid}`;
  const [a] = await ctx.sql`select decision_note from public.approvals where id = ${aid}`;
  if (!h) throw new PermanentError('hosted site not found');
  const noted = String(a?.decision_note ?? '').toLowerCase().match(/\b(?:www\.)?([a-z0-9-]+(?:\.[a-z0-9-]+)*\.[a-z]{2,})\b/)?.[1];
  const domain = noted ?? (h.domain as string | null);
  if (!domain) throw new PermanentError('no domain name: write the purchased domain in the approval note');
  await connectDomain(String(h.pages_project), `www.${domain}`, ctx.env, ctx.fetchFn ?? fetch);
  const lang = ((h.analysis ?? {}) as { language?: string }).language ?? 'fr';
  return finish(ctx, async (tx) => {
    await tx`update public.hosted_sites set domain = ${domain}, domain_status = 'connected', url = ${`https://www.${domain}`} where id = ${hid}`;
    if (h.email) await sendClient(tx, ctx.task.id, String(h.lead_id), h.project_id ? String(h.project_id) : null, String(h.email), (T[lang] ?? T.en).subject2, (CONNECTED[lang] ?? CONNECTED.en)(domain), `hosting-domain:${hid}`, `Domaine actif : ${domain}`);
    return { connected: domain };
  });
};

/** Yearly renewal: the owner is reminded to invoice it (49 EUR) a month before the end of the year paid. */
export async function scheduleHostingRenewals(sql: Sql): Promise<number> {
  const plan = await getSetting<{ renewal_minor: number; remind_days_before: number }>(sql, 'hosting.plan', { renewal_minor: 4900, remind_days_before: 30 });
  const due = await sql`select h.id, h.url, h.domain, h.renews_at, o.buyer_name from public.hosted_sites h join public.leads l on l.id = h.lead_id
      left join public.opportunities o on o.id = l.opportunity_id
      where h.status = 'online' and h.renewal_requested_at is null and h.renews_at <= now() + make_interval(days => ${plan.remind_days_before})`;
  for (const d of due) {
    await requestApproval(sql, { actionType: 'hosting.renewal', title: `Renouvellement à facturer : ${String(d.buyer_name)} — ${(plan.renewal_minor / 100).toFixed(0)} € (échéance ${new Date(d.renews_at).toLocaleDateString('fr-FR')})`,
      requestedBy: 'finance_agent', reason: `Hébergement + nom de domaine ${d.domain ?? ''} (${d.url}) arrivent à échéance.`, riskLevel: 'low', costMinor: 0, currency: 'EUR',
      ifApproved: 'Pris en compte : facturez le renouvellement au client.', ifRejected: 'Le site ne sera pas renouvelé.', entityType: 'hosted_site', entityId: d.id, key: `hosting.renewal:${d.id}:${new Date(d.renews_at).getFullYear()}` });
    await sql`update public.hosted_sites set renewal_requested_at = now() where id = ${d.id}`;
  }
  return due.length;
}
