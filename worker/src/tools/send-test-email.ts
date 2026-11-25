// Sends two sample emails to the owner (OWNER_EMAIL secret, never printed): a first-contact prospecting email
// and a client email (quote) with the real logo, exactly as the agents send them.
import { loadConfig } from '../config.js';
import { connect, getSetting } from '../db.js';
import { gmailTransport } from '../email/transport.js';
import { logoAttachment, renderHtml, renderText, type Identity } from '../email/template.js';
import { prospectCta } from '../email/cta.js';
import { catalogMenu, getCatalog } from '../agents/pricing.js';

const to = process.env.OWNER_EMAIL;
const mail = gmailTransport(process.env);
if (!to || !mail) { console.error('OWNER_EMAIL and the Gmail secrets are required'); process.exit(1); }
const sql = connect(loadConfig().databaseUrl);
try {
  const id = await getSetting<Identity>(sql, 'business.identity', {} as Identity);
  if (process.env.TEST_MODE === 'buttons') {
    // Diagnostic: personal-looking email (no header, no hidden text, no image) with quick-reply buttons, in two button styles.
    const cat = await getCatalog(sql);
    const cta = prospectCta(mail.address, 'fr', cat);
    const esc = (x: string) => x.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
    const intro = `<p>Bonjour,</p><p>C'est un message de vérification envoyé par ta plateforme, avec des boutons de réponse rapide.</p><p>Peux-tu me dire s'il est arrivé dans la boîte de réception ou dans les spams ?</p>`;
    const sig = `<p>${esc(id.signature).replace(/\n/g, '<br>')}</p>`;
    const variants: [string, string][] = [
      ['Petite question (A)', `${intro}<p><a href="${esc(cta.yes.href)}">${esc(cta.yes.label)}</a><br><a href="${esc(cta.no.href)}">${esc(cta.no.label)}</a></p>${sig}`],
      ['Petite question (B)', `${intro}<p><a href="${esc(cta.yes.href)}" style="display:inline-block;padding:10px 16px;background:#111827;color:#ffffff;text-decoration:none;border-radius:6px;font-weight:bold">${esc(cta.yes.label)}</a>&nbsp;&nbsp;<a href="${esc(cta.no.href)}" style="display:inline-block;padding:9px 14px;border:1px solid #cccccc;color:#555555;text-decoration:none;border-radius:6px">${esc(cta.no.label)}</a></p>${sig}`],
    ];
    for (const [subject, body] of variants) {
      await mail.send({ from: `"${id.sender_name}" <${mail.address}>`, to, subject,
        text: `Bonjour,\n\nC'est un message de vérification envoyé par ta plateforme, avec des boutons de réponse rapide.\nPeux-tu me dire s'il est arrivé dans la boîte de réception ou dans les spams ?\n\n${id.signature}`,
        html: `<div style="font-family:Arial,sans-serif;font-size:14px;color:#202124">${body}</div>` });
      await new Promise((r) => setTimeout(r, 20000));
    }
    console.log('2 button test emails sent');
    process.exit(0);
  }
  if (process.env.TEST_MODE === 'plain') {
    // Diagnostic: a short plain-text email, no HTML, no link, no button — tells whether content or reputation decides.
    await mail.send({ from: `"${id.sender_name}" <${mail.address}>`, to, subject: 'Petite question',
      text: `Bonjour,\n\nC'est un message de vérification envoyé par ta plateforme, en texte simple.\nPeux-tu me dire s'il est arrivé dans la boîte de réception ou dans les spams ?\n\nMerci,\n${id.signature}` });
    console.log('plain-text test email sent');
    process.exit(0);
  }
  const cat = await getCatalog(sql);
  const cold = `Bonjour,

En parcourant les commerces du quartier, j’ai remarqué que la Boulangerie du Parc (exemple fictif) n’a pas encore de site internet. Vos clients qui cherchent vos horaires ou vos spécialités sur leur téléphone ne trouvent donc rien.

Nous pourrions vous préparer une page simple et élégante : présentation de la boutique, vos pains et pâtisseries phares, horaires, plan d’accès et contact.

Si l’idée vous intéresse, un simple clic ci-dessous suffit pour recevoir un devis gratuit et sans engagement.

Si vous ne souhaitez plus recevoir de message de notre part, répondez simplement STOP.`;
  await mail.send({ from: `"${id.sender_name}" <${mail.address}>`, to, subject: 'Une idée pour la Boulangerie du Parc',
    // Exactly what a prospect receives (same rendering as the agents' sending code).
    text: renderText(cold, id), html: renderHtml(cold, id, { cta: prospectCta(mail.address, 'fr', cat), noImages: true, personal: true }) });
  if (process.env.TEST_MODE === 'prospect') { console.log('prospecting test email sent'); process.exit(0); }
  const quote = `Bonjour,

Merci pour votre réponse. Voici notre devis pour la Boulangerie du Parc (exemple fictif) :

- Site vitrine une page : ${(cat.items.website?.price_minor ?? 4900) / 100} €, prêt en ${cat.items.website?.days ?? 3} jours

Pour commencer, il nous suffit de votre accord écrit en réponse à ce message, ainsi que vos textes, photos et horaires si vous en avez. Nous vous montrons un aperçu du site terminé, puis nous vous envoyons la facture ; les fichiers vous sont livrés dès réception du paiement.

Notre carte complète :
${catalogMenu(cat, 'fr')}`;
  const html = renderHtml(quote, id, { preheader: 'Exemple de devis' });
  const logo = html.includes('cid:') ? logoAttachment(id) : null;
  await mail.send({ from: `"${id.sender_name}" <${mail.address}>`, to, subject: '[TEST] Votre devis — Boulangerie du Parc',
    text: renderText(quote, id), html, attachments: logo ? [logo] : [] });
  console.log(`2 test emails sent (logo in the quote email: ${logo ? 'yes' : 'no — upload it in Settings'})`);
} finally { await sql.end({ timeout: 5 }); }
