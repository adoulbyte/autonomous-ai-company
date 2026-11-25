// Sends two sample emails to the owner (OWNER_EMAIL secret, never printed): a first-contact prospecting email
// and a client email (quote) with the real logo, exactly as the agents send them.
import { loadConfig } from '../config.js';
import { connect, getSetting } from '../db.js';
import { gmailTransport } from '../email/transport.js';
import { LOGO_CID, logoAttachment, renderHtml, renderText, type Identity } from '../email/template.js';
import { prospectCta } from '../email/cta.js';
import { catalogMenu, getCatalog } from '../agents/pricing.js';
import { screenshotHtml } from '../render/screenshot.js';
import { renderBrochurePdf } from '../email/brochure.js';

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
  if (process.env.TEST_MODE === 'mockup') {
    // What a prospect receives after clicking "yes": preview images (desktop + phone), the offer and the PDF brochure.
    const cat = await getCatalog(sql);
    const page = `<!doctype html><html lang="fr"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Boulangerie du Parc</title>
<style>body{margin:0;font-family:Georgia,serif;color:#2b2118;background:#fbf6ee}header{background:linear-gradient(135deg,#6b3f1d,#b0773f);color:#fff;padding:64px 24px;text-align:center}
h1{font-size:44px;margin:0 0 10px}header p{font-size:19px;margin:0;opacity:.92}.btn{display:inline-block;margin-top:24px;background:#fff;color:#6b3f1d;padding:12px 22px;border-radius:30px;text-decoration:none;font-family:Arial;font-weight:bold}
main{max-width:980px;margin:auto;padding:40px 20px}.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(240px,1fr));gap:18px}.card{background:#fff;border-radius:14px;padding:22px;box-shadow:0 4px 14px rgba(0,0,0,.06)}
h2{color:#6b3f1d}footer{background:#2b2118;color:#e9dccb;text-align:center;padding:28px;font-family:Arial;font-size:14px}</style></head>
<body><header><h1>Boulangerie du Parc</h1><p>Pains au levain, viennoiseries et pâtisseries faits maison</p><a class="btn" href="#contact">Nous trouver</a></header>
<main><h2>Nos spécialités</h2><div class="grid"><div class="card"><h3>Pains</h3><p>Baguettes de tradition et pains au levain, cuits plusieurs fois par jour.</p></div>
<div class="card"><h3>Viennoiseries</h3><p>Croissants et pains au chocolat pur beurre, chaque matin.</p></div><div class="card"><h3>Pâtisseries</h3><p>Tartes de saison et gâteaux sur commande.</p></div></div>
<h2 id="contact">Venir nous voir</h2><div class="card"><p>Découvrez nos horaires et notre adresse, et passez commande pour vos événements.</p></div></main>
<footer>Boulangerie du Parc — exemple fictif</footer></body></html>`;
    const shots = await screenshotHtml(page, process.env);
    const w = cat.items.website;
    const body = `Bonjour,

Comme promis, voici la maquette de votre site, préparée spécialement pour la Boulangerie du Parc (exemple fictif ; aperçu ci-dessous, sur ordinateur et sur téléphone).

Notre proposition : ${w?.label.fr ?? 'Site vitrine'} pour ${((w?.price_minor ?? 4900) / 100).toFixed(0)} €, prêt en ${w?.days ?? 3} jours. Tout reste modifiable : textes, couleurs, photos.

Pour lancer la réalisation, il suffit de répondre « oui ». Nous vous montrons le résultat terminé avant d’envoyer la facture ; les fichiers sont livrés dès réception du paiement.

Vous trouverez notre plaquette en pièce jointe.`;
    const imgs = shots ? `<div style="margin:6px 0 18px"><div style="font-size:12px;color:#6b6f78;margin-bottom:8px">Aperçu sur ordinateur et sur téléphone</div>
<img src="cid:mockup-desktop" alt="" width="544" style="display:block;width:100%;max-width:544px;border:1px solid #e7e4dd;border-radius:8px;margin-bottom:12px">
<img src="cid:mockup-mobile" alt="" width="220" style="display:block;width:220px;border:1px solid #e7e4dd;border-radius:12px"></div>` : '';
    const html = renderHtml(body, id, { preheader: 'Votre maquette', blocks: imgs });
    const logo = html.includes(`cid:${LOGO_CID}`) ? logoAttachment(id) : null;
    const pdf = await renderBrochurePdf(id, cat, 'fr', mail.address);
    await mail.send({ from: `"${id.sender_name}" <${mail.address}>`, to, subject: '[TEST] Votre maquette — Boulangerie du Parc', text: renderText(body, id), html,
      attachments: [...(logo ? [logo] : []),
        ...(shots ? [{ filename: 'apercu-ordinateur.jpg', content: shots.desktop, contentType: 'image/jpeg', cid: 'mockup-desktop' },
          { filename: 'apercu-telephone.jpg', content: shots.mobile, contentType: 'image/jpeg', cid: 'mockup-mobile' }] : []),
        { filename: `${id.company_name.replace(/[^\w-]+/g, '-')}-plaquette.pdf`, content: pdf, contentType: 'application/pdf' }] });
    console.log(`mockup test email sent (preview images: ${shots ? 'yes' : 'no browser'})`);
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
