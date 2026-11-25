import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';
import type { Identity } from './template.js';
import type { Catalog } from '../agents/pricing.js';

const T: Record<string, { title: string; menu: string; days: string; how: string; steps: string[]; contact: string }> = {
  fr: { title: 'Prestations rapides pour votre activité', menu: 'Notre carte', days: 'jours', how: 'Comment ça marche',
        steps: ['Vous choisissez une prestation et nous envoyez vos informations.', 'Nous réalisons le travail et vous montrons un aperçu.', 'Vous validez : nous envoyons la facture.', 'Dès le paiement reçu, vous recevez vos fichiers.'], contact: 'Contact' },
  en: { title: 'Quick services for your business', menu: 'Our menu', days: 'days', how: 'How it works',
        steps: ['You choose a service and send us your information.', 'We do the work and show you a preview.', 'You approve: we send the invoice.', 'As soon as payment arrives, you receive your files.'], contact: 'Contact' },
  nl: { title: 'Snelle diensten voor uw zaak', menu: 'Ons aanbod', days: 'dagen', how: 'Hoe het werkt',
        steps: ['U kiest een dienst en stuurt ons uw gegevens.', 'Wij voeren het werk uit en tonen u een voorbeeld.', 'U keurt goed: wij sturen de factuur.', 'Na ontvangst van de betaling ontvangt u uw bestanden.'], contact: 'Contact' },
  pt: { title: 'Serviços rápidos para o seu negócio', menu: 'A nossa oferta', days: 'dias', how: 'Como funciona',
        steps: ['Escolhe um serviço e envia-nos as suas informações.', 'Fazemos o trabalho e mostramos uma pré-visualização.', 'Aprova: enviamos a fatura.', 'Assim que o pagamento chega, recebe os seus ficheiros.'], contact: 'Contacto' },
};
const printable = (s: string) => s.replace(/[’‘]/g, "'").replace(/[“”«»]/g, '"').replace(/[–—]/g, '-').replace(/€/g, 'EUR').replace(/[^\x20-\x7E\xA0-\xFF]/g, '');

/** One-page brochure in the brand colours (black, white, silver) with the logo, the quick-service menu and the process. */
export async function renderBrochurePdf(id: Identity, cat: Catalog, lang: string, contactEmail: string): Promise<Buffer> {
  const t = T[lang] ?? T.en;
  const doc = await PDFDocument.create();
  const page = doc.addPage([595, 842]);
  const font = await doc.embedFont(StandardFonts.Helvetica); const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  const black = rgb(0.04, 0.04, 0.04), white = rgb(1, 1, 1), silver = rgb(0.78, 0.79, 0.81), grey = rgb(0.38, 0.39, 0.41), light = rgb(0.96, 0.96, 0.96);
  const txt = (s: string, x: number, y: number, size = 11, f = font, color = black) => page.drawText(printable(s), { x, y, size, font: f, color });
  // Header band with the logo
  page.drawRectangle({ x: 0, y: 692, width: 595, height: 150, color: black });
  const m = /^data:image\/(png|jpeg);base64,(.+)$/.exec(id.logo_data_url ?? '');
  let textX = 48;
  if (m) {
    const img = m[1] === 'png' ? await doc.embedPng(Buffer.from(m[2], 'base64')) : await doc.embedJpg(Buffer.from(m[2], 'base64'));
    page.drawImage(img, { x: 40, y: 712, width: 110, height: 110 }); textX = 170;
  }
  txt(id.company_name, textX, 785, 24, bold, white);
  txt(id.tagline.slice(0, 70), textX, 762, 10, font, silver);
  if (id.tagline.length > 70) txt(id.tagline.slice(70, 140), textX, 748, 10, font, silver);
  page.drawRectangle({ x: 0, y: 689, width: 595, height: 3, color: silver });
  txt(t.title, 48, 650, 18, bold);
  // Menu
  txt(t.menu.toUpperCase(), 48, 615, 10, bold, grey);
  let y = 590;
  for (const item of Object.values(cat.items)) {
    page.drawRectangle({ x: 44, y: y - 8, width: 507, height: 26, color: light });
    txt(item.label[lang] ?? item.label.en ?? Object.values(item.label)[0], 56, y, 12);
    txt(`${(item.price_minor / 100).toFixed(0)} ${cat.currency === 'EUR' ? 'EUR' : cat.currency}`, 420, y, 12, bold);
    txt(`${item.days} ${t.days}`, 490, y, 10, font, grey);
    y -= 32;
  }
  // Process
  y -= 18; txt(t.how.toUpperCase(), 48, y, 10, bold, grey); y -= 26;
  t.steps.forEach((s, i) => {
    page.drawCircle({ x: 58, y: y + 4, size: 10, color: black });
    txt(String(i + 1), 55, y, 10, bold, white);
    txt(s, 78, y, 11.5); y -= 28;
  });
  // Footer
  page.drawRectangle({ x: 0, y: 0, width: 595, height: 70, color: black });
  txt(`${t.contact} : ${contactEmail}`, 48, 40, 11, bold, white);
  txt(String(id.ai_disclosure ?? '').slice(0, 100), 48, 22, 8, font, silver);
  return Buffer.from(await doc.save());
}
