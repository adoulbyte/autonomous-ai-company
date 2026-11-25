// Sends two sample emails to the owner (OWNER_EMAIL secret, never printed): a first-contact prospecting email
// and a client email (quote) with the real logo, exactly as the agents send them.
import { loadConfig } from '../config.js';
import { connect, getSetting } from '../db.js';
import { gmailTransport } from '../email/transport.js';
import { logoAttachment, renderHtml, renderText, type Identity } from '../email/template.js';
import { prospectCta, prospectHighlights } from '../email/cta.js';
import { catalogMenu, getCatalog } from '../agents/pricing.js';

const to = process.env.OWNER_EMAIL;
const mail = gmailTransport(process.env);
if (!to || !mail) { console.error('OWNER_EMAIL and the Gmail secrets are required'); process.exit(1); }
const sql = connect(loadConfig().databaseUrl);
try {
  const id = await getSetting<Identity>(sql, 'business.identity', {} as Identity);
  const cat = await getCatalog(sql);
  const cold = `Bonjour,

En parcourant les commerces du quartier, j’ai remarqué que la Boulangerie du Parc (exemple fictif) n’a pas encore de site internet. Vos clients qui cherchent vos horaires ou vos spécialités sur leur téléphone ne trouvent donc rien.

Nous pourrions vous préparer une page simple et élégante : présentation de la boutique, vos pains et pâtisseries phares, horaires, plan d’accès et contact.

Si l’idée vous intéresse, un simple clic ci-dessous suffit pour recevoir un devis gratuit et sans engagement.

Si vous ne souhaitez plus recevoir de message de notre part, répondez simplement STOP.`;
  await mail.send({ from: `"${id.sender_name}" <${mail.address}>`, to, subject: '[TEST] Une idée pour la Boulangerie du Parc',
    text: renderText(cold, id), html: renderHtml(cold, id, { preheader: 'Exemple de premier contact', cta: prospectCta(mail.address, 'fr', cat), highlights: prospectHighlights('fr', 'website'), noImages: true }),
    listUnsubscribe: `mailto:${mail.address}?subject=STOP` });
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
