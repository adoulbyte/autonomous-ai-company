import type { Cta, Highlights } from './template.js';
import type { Catalog } from '../agents/pricing.js';

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

const M: Record<string, { yesSite: string; yesPost: string; subj: string; body: string }> = {
  fr: { yesSite: 'Oui, je veux voir la maquette gratuite', yesPost: 'Oui, je veux voir un exemple gratuit', subj: 'Intéressé – maquette gratuite',
        body: 'Bonjour,\n\nOui, je souhaite voir la maquette gratuite.\n\nInformations utiles (facultatif : ce que vous voulez mettre en avant, couleurs, horaires…) :\n\n' },
  en: { yesSite: 'Yes, show me the free mockup', yesPost: 'Yes, show me a free sample', subj: 'Interested – free mockup',
        body: 'Hello,\n\nYes, I would like to see the free mockup.\n\nUseful information (optional: what to highlight, colours, opening hours…):\n\n' },
  nl: { yesSite: 'Ja, toon mij het gratis voorbeeld', yesPost: 'Ja, toon mij een gratis voorbeeld', subj: 'Geïnteresseerd – gratis voorbeeld',
        body: 'Goedendag,\n\nJa, ik wil graag het gratis voorbeeld zien.\n\nNuttige informatie (optioneel: wat u wilt benadrukken, kleuren, openingstijden…):\n\n' },
  pt: { yesSite: 'Sim, quero ver a maquete grátis', yesPost: 'Sim, quero ver um exemplo grátis', subj: 'Interessado – maquete grátis',
        body: 'Olá,\n\nSim, gostaria de ver a maquete grátis.\n\nInformações úteis (opcional: o que destacar, cores, horário…):\n\n' },
};

export function prospectCta(mailbox: string, lang: string, catalog: Catalog, need = 'website'): Cta {
  const t = T[lang] ?? T.en; const m = M[lang] ?? M.en;
  void catalog;
  const mailto = (subject: string, b: string) => `mailto:${mailbox}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(b)}`;
  return { yes: { label: need === 'website' ? m.yesSite : m.yesPost, href: mailto(m.subj, m.body) }, no: { label: t.no, href: mailto(t.subjNo, t.stopBody) } };
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

/** Buttons under the proposal (mockup + offer): start the work, or later; reminders add "not interested". */
const P: Record<string, { goSite: string; goPost: string; later: string; subjGo: string; subjLater: string; bodyGo: string; bodyLater: string }> = {
  fr: { goSite: 'Je veux la réalisation de mon site', goPost: 'Je veux la réalisation', later: 'Peut-être plus tard', subjGo: 'Oui – je lance la réalisation', subjLater: 'Peut-être plus tard',
        bodyGo: 'Bonjour,\n\nJe souhaite lancer la réalisation selon votre proposition.\n\nInformations utiles (textes, photos, horaires, couleurs…) :\n\n',
        bodyLater: 'Bonjour,\n\nMerci pour la maquette. Ce n’est pas le bon moment pour moi, vous pouvez me recontacter plus tard.\n' },
  en: { goSite: 'Yes, build my website', goPost: 'Yes, go ahead', later: 'Maybe later', subjGo: 'Yes – go ahead with the work', subjLater: 'Maybe later',
        bodyGo: 'Hello,\n\nI would like you to go ahead with the work as proposed.\n\nUseful information (texts, photos, opening hours, colours…):\n\n',
        bodyLater: 'Hello,\n\nThank you for the mockup. It is not the right time for me; you may contact me again later.\n' },
  nl: { goSite: 'Ja, maak mijn website', goPost: 'Ja, ga van start', later: 'Misschien later', subjGo: 'Ja – start de realisatie', subjLater: 'Misschien later',
        bodyGo: 'Goedendag,\n\nIk wil graag dat u van start gaat volgens uw voorstel.\n\nNuttige informatie (teksten, foto’s, openingstijden, kleuren…):\n\n',
        bodyLater: 'Goedendag,\n\nBedankt voor het voorbeeld. Het is nu niet het juiste moment; u mag later opnieuw contact opnemen.\n' },
  pt: { goSite: 'Sim, quero o meu site', goPost: 'Sim, avançar', later: 'Talvez mais tarde', subjGo: 'Sim – avançar com a realização', subjLater: 'Talvez mais tarde',
        bodyGo: 'Olá,\n\nGostaria de avançar com a realização conforme a vossa proposta.\n\nInformações úteis (textos, fotos, horário, cores…):\n\n',
        bodyLater: 'Olá,\n\nObrigado pela maquete. Não é o momento certo; podem voltar a contactar-me mais tarde.\n' },
};

const O: Record<string, { site: (p: string) => string; online: (p: string) => string; subj: string; body: string }> = {
  fr: { site: (p) => `Je veux mon site – ${p}`, online: (p) => `En ligne avec mon nom de domaine – ${p}`, subj: 'Oui – site en ligne avec nom de domaine',
        body: 'Bonjour,\n\nJe souhaite lancer la réalisation de mon site, mis en ligne avec mon propre nom de domaine, selon votre proposition.\n\nInformations utiles (textes, photos, horaires, couleurs, nom de domaine souhaité…) :\n\n' },
  en: { site: (p) => `I want my website – ${p}`, online: (p) => `Online with my own domain – ${p}`, subj: 'Yes – website online with domain name',
        body: 'Hello,\n\nI would like you to build my website and put it online with my own domain name, as proposed.\n\nUseful information (texts, photos, opening hours, colours, preferred domain name…):\n\n' },
  nl: { site: (p) => `Ik wil mijn website – ${p}`, online: (p) => `Online met mijn eigen domein – ${p}`, subj: 'Ja – website online met domeinnaam',
        body: 'Goedendag,\n\nIk wil graag mijn website, online gezet met mijn eigen domeinnaam, volgens uw voorstel.\n\nNuttige informatie (teksten, foto’s, openingstijden, kleuren, gewenste domeinnaam…):\n\n' },
  pt: { site: (p) => `Quero o meu site – ${p}`, online: (p) => `Online com o meu domínio – ${p}`, subj: 'Sim – site online com nome de domínio',
        body: 'Olá,\n\nGostaria de avançar com o meu site, publicado online com o meu próprio nome de domínio, conforme a proposta.\n\nInformações úteis (textos, fotos, horário, cores, domínio pretendido…):\n\n' },
};

/** With `online` (prices of both formulas), two order buttons: the website, or the website online with its own domain name. */
export function proposalCta(mailbox: string, lang: string, need = 'website', withNo = false, online?: { site: string; online: string }): Cta {
  const p = P[lang] ?? P.en; const t = T[lang] ?? T.en; const o = O[lang] ?? O.en;
  const mailto = (subject: string, b: string) => `mailto:${mailbox}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(b)}`;
  return { yes: { label: online ? o.site(online.site) : need === 'website' ? p.goSite : p.goPost, href: mailto(p.subjGo, p.bodyGo) },
    ...(online ? { alt: { label: o.online(online.online), href: mailto(o.subj, o.body) } } : {}),
    later: { label: p.later, href: mailto(p.subjLater, p.bodyLater) },
    ...(withNo ? { no: { label: t.no, href: mailto(t.subjNo, t.stopBody) } } : {}) };
}

/** A reply from the "start the work" button. */
export function isGoReply(subject: string): boolean {
  return /je lance la réalisation|go ahead with the work|start de realisatie|avançar com a realização/i.test(subject) || isGoOnline(subject);
}
/** A reply from the "online with my own domain name" button. */
export const isGoOnline = (subject: string) => /site en ligne avec nom de domaine|website online with domain name|website online met domeinnaam|site online com nome de domínio/i.test(subject);
/** A reply from the "maybe later" button (or a short "not now" answer). */
export function isLaterReply(subject: string, body = ''): boolean {
  return /^\s*(re:\s*)?(peut-être plus tard|maybe later|misschien later|talvez mais tarde)\b/i.test(subject)
    || (body.trim().length < 300 && /\b(plus tard|pas le bon moment|pas maintenant|not now|later on|maybe later|niet nu|mais tarde)\b/i.test(body) && !/\b(stop|pas intéress|not interested)\b/i.test(body));
}

/** Buttons under the monthly-pack offer; the "stop" reply is accepted at any time. */
const S: Record<string, { yes: (price: string) => string; no: string; subjYes: string; subjNo: string; bodyYes: string; bodyNo: string }> = {
  fr: { yes: (p) => `Je m’abonne – ${p} par mois`, no: 'Non merci', subjYes: 'Abonnement – je m’abonne', subjNo: 'Abonnement – non merci',
        bodyYes: 'Bonjour,\n\nJe souhaite m’abonner au pack visuels mensuel.\n\nMes souhaits (facultatif : thèmes, produits à mettre en avant, couleurs…) :\n\n', bodyNo: 'Bonjour,\n\nMerci, pas pour le moment.\n' },
  en: { yes: (p) => `Subscribe – ${p} a month`, no: 'No thanks', subjYes: 'Subscription – subscribe', subjNo: 'Subscription – no thanks',
        bodyYes: 'Hello,\n\nI would like to subscribe to the monthly visuals pack.\n\nMy wishes (optional: themes, products to highlight, colours…):\n\n', bodyNo: 'Hello,\n\nThank you, not for now.\n' },
  nl: { yes: (p) => `Ik neem het abonnement – ${p} per maand`, no: 'Nee, bedankt', subjYes: 'Abonnement – ik neem het', subjNo: 'Abonnement – nee bedankt',
        bodyYes: 'Goedendag,\n\nIk neem graag het maandelijkse visualpakket.\n\nMijn wensen (optioneel):\n\n', bodyNo: 'Goedendag,\n\nBedankt, nu niet.\n' },
  pt: { yes: (p) => `Quero assinar – ${p} por mês`, no: 'Não, obrigado', subjYes: 'Assinatura – quero assinar', subjNo: 'Assinatura – não obrigado',
        bodyYes: 'Olá,\n\nGostaria de assinar o pack mensal de visuais.\n\nOs meus desejos (opcional):\n\n', bodyNo: 'Olá,\n\nObrigado, por agora não.\n' },
};
export function subscriptionCta(mailbox: string, lang: string, price: string): Cta {
  const s = S[lang] ?? S.en;
  const mailto = (subject: string, b: string) => `mailto:${mailbox}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(b)}`;
  return { yes: { label: s.yes(price), href: mailto(s.subjYes, s.bodyYes) }, no: { label: s.no, href: mailto(s.subjNo, s.bodyNo) } };
}
export const isSubscribeReply = (subject: string) => /abonnement – je m’abonne|abonnement - je m'abonne|subscription – subscribe|abonnement – ik neem het|assinatura – quero assinar/i.test(subject.replace(/'/g, '’').replace(/ - /g, ' – '));
export const isSubscriptionDecline = (subject: string) => /abonnement – non merci|subscription – no thanks|abonnement – nee bedankt|assinatura – não obrigado/i.test(subject.replace(/ - /g, ' – '));
/** "Stop my subscription": the subject of the button in the monthly emails, or a short message saying so. */
export function isSubscriptionStop(subject: string, body = ''): boolean {
  const re = /arr[êe]ter (l[’']|mon )abonnement|r[ée]silier|stop (the |my )?subscription|cancel (the |my )?subscription|abonnement stoppen|opzeggen|cancelar a assinatura/i;
  return re.test(subject) || (body.trim().length < 400 && re.test(body));
}
