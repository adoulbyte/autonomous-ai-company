import type { Cta, Highlights } from './template.js';
import { catalogMenu, type Catalog } from '../agents/pricing.js';

/** Reply buttons for a prospecting email. They open a pre-filled reply (mailto), so everything stays in the conversation:
 *  no tracking, no external link (better deliverability), and the agents read the answer like any reply. */
const T: Record<string, { yes: string; no: string; subjYes: string; subjNo: string; intro: string; choose: string; info: string; when: string; phone: string; stopBody: string }> = {
  fr: { yes: 'Je suis intéressé(e) – recevoir un devis', no: 'Pas intéressé', subjYes: 'Intéressé – demande de devis', subjNo: 'STOP',
        intro: 'Bonjour,\n\nJe suis intéressé(e). Voici ma demande de devis :', choose: 'Prestation(s) souhaitée(s) – gardez la ou les lignes qui vous intéressent :',
        info: 'Informations utiles (activité, textes, couleurs, réseaux sociaux…) :', when: 'Délai souhaité :', phone: 'Téléphone (facultatif) :', stopBody: 'Merci de ne plus me contacter.' },
  en: { yes: 'I am interested – get a quote', no: 'Not interested', subjYes: 'Interested – quote request', subjNo: 'STOP',
        intro: 'Hello,\n\nI am interested. Here is my quote request:', choose: 'Service(s) wanted – keep the line(s) you are interested in:',
        info: 'Useful information (activity, texts, colours, social media…):', when: 'Preferred deadline:', phone: 'Phone (optional):', stopBody: 'Please do not contact me again.' },
  nl: { yes: 'Ik ben geïnteresseerd – offerte ontvangen', no: 'Geen interesse', subjYes: 'Geïnteresseerd – offerteaanvraag', subjNo: 'STOP',
        intro: 'Goedendag,\n\nIk ben geïnteresseerd. Hier is mijn offerteaanvraag:', choose: 'Gewenste dienst(en) – houd de regel(s) die u interesseren:',
        info: 'Nuttige informatie (activiteit, teksten, kleuren, sociale media…):', when: 'Gewenste termijn:', phone: 'Telefoon (optioneel):', stopBody: 'Neem alstublieft geen contact meer met mij op.' },
  pt: { yes: 'Tenho interesse – receber orçamento', no: 'Sem interesse', subjYes: 'Interessado – pedido de orçamento', subjNo: 'STOP',
        intro: 'Olá,\n\nTenho interesse. Eis o meu pedido de orçamento:', choose: 'Serviço(s) pretendido(s) – mantenha a(s) linha(s) que lhe interessam:',
        info: 'Informações úteis (atividade, textos, cores, redes sociais…):', when: 'Prazo pretendido:', phone: 'Telefone (opcional):', stopBody: 'Por favor, não me contacte mais.' },
};

export function prospectCta(mailbox: string, lang: string, catalog: Catalog): Cta {
  const t = T[lang] ?? T.en;
  const body = `${t.intro}\n\n${t.choose}\n${catalogMenu(catalog, lang)}\n\n${t.info}\n\n\n${t.when}\n\n${t.phone}\n`;
  const mailto = (subject: string, b: string) => `mailto:${mailbox}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(b)}`;
  return { yes: { label: t.yes, href: mailto(t.subjYes, body) }, no: { label: t.no, href: mailto(t.subjNo, t.stopBody) } };
}

/** A reply whose subject comes from the "interested" button. */
export function isInterestedReply(subject: string): boolean {
  return /\b(intéress|interested|geïnteresseerd|geinteresseerd|interessad)/i.test(subject) && !/\bpas intéress|not interested|geen interesse|sem interesse/i.test(subject);
}

/** The offer at a glance, in the prospect's language (shown in a framed box above the buttons). */
const H: Record<string, { title: string; website: string[]; marketing: string[] }> = {
  fr: { title: 'Ce que nous pouvons faire pour vous',
        website: ['Un site vitrine moderne, rapide et adapté au mobile', 'Vos services, horaires, contact et plan d’accès au même endroit', 'Un aperçu avant toute décision — devis gratuit, sans engagement'],
        marketing: ['Des visuels prêts à publier sur vos réseaux sociaux', 'Flyers, menus ou tarifs mis en page en PDF', 'Un aperçu avant toute décision — devis gratuit, sans engagement'] },
  en: { title: 'What we can do for you',
        website: ['A modern, fast, mobile-friendly showcase website', 'Your services, opening hours, contact and map in one place', 'A preview before any decision — free quote, no obligation'],
        marketing: ['Ready-to-post visuals for your social media', 'Flyers, menus or price lists designed as PDF', 'A preview before any decision — free quote, no obligation'] },
  nl: { title: 'Wat wij voor u kunnen doen',
        website: ['Een moderne, snelle website die goed werkt op mobiel', 'Uw diensten, openingstijden, contact en route op één plek', 'Eerst een voorbeeld — gratis en vrijblijvende offerte'],
        marketing: ['Kant-en-klare visuals voor uw sociale media', 'Flyers, menu’s of prijslijsten als PDF', 'Eerst een voorbeeld — gratis en vrijblijvende offerte'] },
  pt: { title: 'O que podemos fazer por si',
        website: ['Um site moderno, rápido e adaptado ao telemóvel', 'Os seus serviços, horário, contacto e mapa num só lugar', 'Uma pré-visualização antes de decidir — orçamento grátis, sem compromisso'],
        marketing: ['Visuais prontos a publicar nas redes sociais', 'Folhetos, menus ou tabelas de preços em PDF', 'Uma pré-visualização antes de decidir — orçamento grátis, sem compromisso'] },
};
export function prospectHighlights(lang: string, need: string): Highlights {
  const h = H[lang] ?? H.en;
  return { title: h.title, items: need === 'website' ? h.website : h.marketing };
}
