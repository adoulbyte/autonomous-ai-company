// Sends two sample emails to the owner (OWNER_EMAIL secret, never printed): a first-contact prospecting email
// and a client email (quote) with the real logo, exactly as the agents send them.
import { loadConfig } from '../config.js';
import { connect, getSetting } from '../db.js';
import { gmailTransport } from '../email/transport.js';
import { LOGO_CID, logoAttachment, renderHtml, renderText, type Identity } from '../email/template.js';
import { prospectCta, proposalCta } from '../email/cta.js';
import { catalogMenu, getCatalog } from '../agents/pricing.js';
import { renderBrochurePdf } from '../email/brochure.js';

const to = process.env.OWNER_EMAIL;
const mail = gmailTransport(process.env);
if (!to || !mail) { console.error('OWNER_EMAIL and the Gmail secrets are required'); process.exit(1); }
const sql = connect(loadConfig().databaseUrl);
try {
  const id = await getSetting<Identity>(sql, 'business.identity', {} as Identity);
  if (process.env.TEST_MODE === 'mockup') {
    // What a prospect receives after clicking "yes", produced by the real engine (AI texts, real photos, template, screenshots).
    const kind = process.env.TEST_TRADE || 'shop=bakery';
    const samples: Record<string, [string, string]> = {
      'shop=bakery': ['Boulangerie du Parc', 'Mo-Sa 07:00-19:30; Su 07:00-13:00'],
      'shop=hairdresser': ['Salon Belle Mèche', 'Tu-Fr 09:00-19:00; Sa 09:00-17:00'],
      'amenity=restaurant': ['Le Petit Comptoir', 'Tu-Sa 12:00-14:00,19:00-22:30'],
      'craft=plumber': ['Martin Plomberie', 'Mo-Fr 08:00-18:00'],
    };
    const [name, hours] = samples[kind] ?? ['Boutique du Centre', 'Mo-Sa 09:00-19:00'];
    const listing = `Entreprise : ${name}\nActivité : ${kind}\nVille : Lyon\nAdresse : 12 rue de la République 69002 Lyon\nSite web : aucun site web référencé\nE-mail professionnel publié : contact@exemple-fictif.fr\nHoraires : ${hours}`;
    const { AiGateway } = await import('../ai/gateway.js');
    const { buildPreview } = await import('../agents/mockup.js');
    const p = await buildPreview({ ai: new AiGateway(sql, process.env), env: process.env, listing, name, category: kind, city: 'Lyon', lang: 'fr', need: 'website',
      email: 'contact@exemple-fictif.fr', clientMessage: 'Oui, je souhaite voir la maquette gratuite.' });
    const cat = await getCatalog(sql);
    const w = cat.items.website;
    const body = `Bonjour,

Comme promis, voici la maquette de votre site, préparée spécialement pour ${name} (commerce fictif pour ce test ; aperçu ci-dessous, sur ordinateur et sur téléphone).

Notre proposition : ${w?.label.fr ?? 'Site vitrine'} pour ${((w?.price_minor ?? 4900) / 100).toFixed(0)} €, prêt en ${w?.days ?? 3} jours. Tout reste modifiable : textes, couleurs, photos.

La maquette vous plaît ? Cliquez sur le bouton ci-dessous : nous finalisons le site avec vos textes et vos photos, vous le validez, puis nous vous envoyons la facture. Ce n’est pas le bon moment ? Choisissez « Peut-être plus tard », sans aucun engagement.

Vous trouverez notre plaquette en pièce jointe.`;
    const shots = p.shots;
    const imgs = shots ? `<div style="margin:6px 0 18px"><div style="font-size:12px;color:#6b6f78;margin-bottom:8px">Aperçu sur ordinateur et sur téléphone</div>
<img src="cid:mockup-desktop" alt="" width="544" style="display:block;width:100%;max-width:544px;border:1px solid #e7e4dd;border-radius:8px;margin-bottom:12px">
${shots.mobile ? '<img src="cid:mockup-mobile" alt="" width="220" style="display:block;width:220px;border:1px solid #e7e4dd;border-radius:12px">' : ''}</div>` : '';
    const reminder = process.env.TEST_REMINDER === '1';
    const html = renderHtml(body, id, { preheader: 'Votre maquette', blocks: imgs, cta: proposalCta(mail.address, 'fr', 'website', reminder) });
    const logo = html.includes(`cid:${LOGO_CID}`) ? logoAttachment(id) : null;
    const pdf = await renderBrochurePdf(id, cat, 'fr', mail.address);
    await mail.send({ from: `"${id.sender_name}" <${mail.address}>`, to, subject: `[TEST] Votre maquette — ${name}`, text: renderText(body, id), html,
      attachments: [...(logo ? [logo] : []),
        ...(shots ? [{ filename: 'apercu-ordinateur.jpg', content: shots.desktop, contentType: 'image/jpeg', cid: 'mockup-desktop' }] : []),
        ...(shots?.mobile ? [{ filename: 'apercu-telephone.jpg', content: shots.mobile, contentType: 'image/jpeg', cid: 'mockup-mobile' }] : []),
        { filename: `${id.company_name.replace(/[^\w-]+/g, '-')}-plaquette.pdf`, content: pdf, contentType: 'application/pdf' }] });
    // Fictitious sample only: kept as a workflow artifact so the design can be checked.
    const { mkdirSync, writeFileSync } = await import('node:fs');
    mkdirSync('preview', { recursive: true }); writeFileSync('preview/maquette.html', p.html);
    if (shots) { writeFileSync('preview/desktop.jpg', shots.desktop); if (shots.mobile) writeFileSync('preview/mobile.jpg', shots.mobile); }
    console.log(`mockup test email sent (photos: ${p.photos.length}, preview images: ${shots ? 'yes' : 'no browser'})`);
    process.exit(0);
  }
  if (process.env.TEST_MODE === 'subscription') {
    // What a delivered client receives 3 days after the delivery: the monthly pack offer with a sample visual (real engine).
    const { AiGateway } = await import('../ai/gateway.js');
    const { socialPostHtml, getPlans } = await import('../agents/subscriptions.js');
    const { subscriptionCta } = await import('../email/cta.js');
    const { screenshotHtml } = await import('../render/screenshot.js');
    const kind = process.env.TEST_TRADE || 'shop=bakery';
    const names: Record<string, string> = { 'shop=bakery': 'Boulangerie du Parc', 'shop=hairdresser': 'Salon Belle Mèche', 'amenity=restaurant': 'Le Petit Comptoir', 'craft=plumber': 'Martin Plomberie' };
    const name = names[kind] ?? 'Boutique du Centre';
    const lead = { id: 'test', name, email: 'contact@exemple-fictif.fr', lang: 'fr', category: kind, city: 'Lyon', dnc: false,
      listing: `Entreprise : ${name}\nActivité : ${kind}\nVille : Lyon\nAdresse : 12 rue de la République 69002 Lyon` };
    const post = await socialPostHtml({ ai: new AiGateway(sql, process.env), env: process.env, lead, index: 0, theme: 'what makes this business special (its know-how)', avoid: [] });
    const shot = await screenshotHtml(post.html, process.env, 'post');
    const plan = (await getPlans(sql)).social_monthly;
    const price = `${(plan.price_minor / 100).toFixed(0)} €`;
    const body = `Bonjour,

Merci encore pour votre confiance. Pour que vos clients vous voient régulièrement sur les réseaux sociaux, nous proposons un pack simple : ${plan.label.fr.toLowerCase()}, prêts à publier, à vos couleurs et adaptés à votre activité, pour ${price} par mois.

Sans engagement : chaque mois, vous ne payez qu’une fois les visuels prêts, et vous arrêtez quand vous voulez, en un clic.

Voici un exemple préparé pour ${name} (commerce fictif pour ce test ; ci-dessous).`;
    const img = shot ? `<div style="margin:6px 0 18px"><img src="cid:sample-post" alt="" width="300" style="display:block;width:300px;max-width:100%;border:1px solid #e7e4dd;border-radius:10px"></div>` : '';
    const html = renderHtml(body, id, { preheader: plan.label.fr, blocks: img, cta: subscriptionCta(mail.address, 'fr', price) });
    const logo = html.includes(`cid:${LOGO_CID}`) ? logoAttachment(id) : null;
    await mail.send({ from: `"${id.sender_name}" <${mail.address}>`, to, subject: `[TEST] ${plan.label.fr}`, text: renderText(body, id), html,
      attachments: [...(logo ? [logo] : []), ...(shot ? [{ filename: 'exemple.jpg', content: shot.desktop, contentType: 'image/jpeg', cid: 'sample-post' }] : [])] });
    console.log(`subscription test email sent (sample visual: ${shot ? 'yes' : 'no browser'})`);
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
