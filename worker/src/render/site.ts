import { z } from 'zod';
import type { Photo } from './photos.js';

/**
 * Professional page templates for mockups. The AI writes the texts only; layout, typography, colours and photos
 * come from these templates, so every preview looks like a real, modern website.
 */

export const SiteContentSchema = z.object({
  tagline: z.string().min(3).max(70),
  hero_title: z.string().min(5).max(80),
  hero_text: z.string().min(20).max(220),
  cta: z.string().min(3).max(32),
  services_title: z.string().min(3).max(60),
  services_intro: z.string().max(200),
  services: z.array(z.object({ title: z.string().min(2).max(45), text: z.string().min(10).max(170) })).min(3).max(6),
  about_title: z.string().min(3).max(70),
  about_text: z.string().min(80).max(700),
  highlights: z.array(z.object({ title: z.string().min(2).max(35), text: z.string().min(5).max(120) })).min(3).max(3),
  cta_title: z.string().min(5).max(80),
  cta_text: z.string().max(200),
  photo_keywords: z.array(z.string().min(3).max(50)).min(1).max(4),
});
export type SiteContent = z.infer<typeof SiteContentSchema>;

export const PostContentSchema = z.object({
  headline: z.string().min(5).max(60),
  text: z.string().min(10).max(150),
  bullets: z.array(z.string().min(3).max(45)).min(2).max(3),
  cta: z.string().min(3).max(32),
  photo_keywords: z.array(z.string().min(3).max(50)).min(1).max(4),
});
export type PostContent = z.infer<typeof PostContentSchema>;

/** Owner/client adjustments on top of the trade theme (exact colours, fonts, hidden sections). */
export type Style = { primary?: string; accent?: string; dark?: string; background?: string; text?: string; heading_font?: string; body_font?: string };
export type SiteSection = 'services' | 'about' | 'gallery' | 'info' | 'cta_band';
export const FONTS = ['Playfair Display', 'DM Serif Display', 'Cormorant Garamond', 'Fraunces', 'Lora', 'Merriweather', 'Libre Baskerville', 'Montserrat', 'Poppins',
  'Syne', 'Manrope', 'Inter', 'Raleway', 'Roboto', 'Open Sans', 'Lato', 'Nunito', 'Josefin Sans', 'Oswald', 'Bebas Neue', 'Pacifico', 'Great Vibes'];
function styled(t: Theme, s?: Style): Theme {
  if (!s) return t;
  const font = (f: string | undefined, d: string) => (f && FONTS.includes(f) ? f : d);
  return { ...t, primary: s.primary ?? t.primary, accent: s.accent ?? t.accent, dark: s.dark ?? t.dark, bg: s.background ?? t.bg, text: s.text ?? t.text,
    fonts: [font(s.heading_font, t.fonts[0]), font(s.body_font, t.fonts[1])] };
}
/** Where each photo of a site is used (photo index → place on the page). */
export function photoPlaces(n: number): string[] {
  return Array.from({ length: n }, (_, i) => i === 0 ? 'main photo at the top (hero)'
    : n - 1 >= 3 && i <= 3 ? `photo of service card ${i}` : i === (n - 1 >= 4 ? 4 : 1) ? 'photo of the "about" section'
    : (n - 1 >= 9 ? i >= 5 && i <= 9 : n >= 5 && i <= 4) ? 'gallery photo' : 'unused');
}

export type Facts = { name: string; city?: string | null; address?: string | null; hours?: string | null; email?: string | null; phone?: string | null };

type Theme = { fonts: [string, string]; primary: string; dark: string; accent: string; bg: string; surface: string; text: string; muted: string; radius: number };
const THEMES: Record<string, Theme> = {
  warm:   { fonts: ['Playfair Display', 'Inter'], primary: '#8a4b20', dark: '#2a1a10', accent: '#d9a441', bg: '#fbf7f1', surface: '#ffffff', text: '#2b2118', muted: '#76675a', radius: 14 },
  food:   { fonts: ['DM Serif Display', 'Inter'], primary: '#1f4d3a', dark: '#14231c', accent: '#c8a45a', bg: '#f7f5ef', surface: '#ffffff', text: '#1d2420', muted: '#5f6b64', radius: 12 },
  beauty: { fonts: ['Cormorant Garamond', 'Montserrat'], primary: '#7a3e4f', dark: '#1f1418', accent: '#d8a7a0', bg: '#fbf6f4', surface: '#ffffff', text: '#2a1f22', muted: '#7c6b6f', radius: 18 },
  nature: { fonts: ['Fraunces', 'Inter'], primary: '#3f6b3a', dark: '#18261a', accent: '#e0b94f', bg: '#f6f8f1', surface: '#ffffff', text: '#1f2a1f', muted: '#5f6d5c', radius: 16 },
  craft:  { fonts: ['Montserrat', 'Inter'], primary: '#1d3557', dark: '#0f1b2d', accent: '#f08a24', bg: '#f4f6f9', surface: '#ffffff', text: '#18212f', muted: '#5a6577', radius: 10 },
  health: { fonts: ['Poppins', 'Inter'], primary: '#0f6e78', dark: '#0b2a2e', accent: '#5cc8b8', bg: '#f3f8f8', surface: '#ffffff', text: '#15282b', muted: '#5b7073', radius: 14 },
  stay:   { fonts: ['Cormorant Garamond', 'Inter'], primary: '#3a4a5c', dark: '#171d25', accent: '#c9a76a', bg: '#f7f6f3', surface: '#ffffff', text: '#20262e', muted: '#68707a', radius: 12 },
  retail: { fonts: ['Syne', 'Inter'], primary: '#222222', dark: '#111111', accent: '#e4572e', bg: '#f6f5f3', surface: '#ffffff', text: '#1b1b1b', muted: '#6b6b6b', radius: 12 },
  pro:    { fonts: ['Manrope', 'Inter'], primary: '#24467a', dark: '#111a2b', accent: '#3fb3a3', bg: '#f5f7fa', surface: '#ffffff', text: '#1a2230', muted: '#5f6a7a', radius: 12 },
};

const LABELS: Record<string, Record<string, string>> = {
  fr: { services: 'Services', about: 'À propos', gallery: 'Galerie', info: 'Infos pratiques', contact: 'Contact', address: 'Adresse', hours: 'Horaires', email: 'E-mail', phone: 'Téléphone', more: 'Découvrir', photos: 'Photos', moments: 'En images', visit: 'Venez nous rencontrer' },
  en: { services: 'Services', about: 'About', gallery: 'Gallery', info: 'Visit us', contact: 'Contact', address: 'Address', hours: 'Opening hours', email: 'Email', phone: 'Phone', more: 'Discover', photos: 'Photos', moments: 'In pictures', visit: 'Come and see us' },
  nl: { services: 'Diensten', about: 'Over ons', gallery: 'Galerij', info: 'Praktisch', contact: 'Contact', address: 'Adres', hours: 'Openingstijden', email: 'E-mail', phone: 'Telefoon', more: 'Ontdekken', photos: "Foto's", moments: 'In beeld', visit: 'Kom langs' },
  pt: { services: 'Serviços', about: 'Sobre nós', gallery: 'Galeria', info: 'Informações', contact: 'Contacto', address: 'Morada', hours: 'Horário', email: 'E-mail', phone: 'Telefone', more: 'Descobrir', photos: 'Fotos', moments: 'Em imagens', visit: 'Venha visitar-nos' },
};

const esc = (s: unknown) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const fontLink = (t: Theme) => `https://fonts.googleapis.com/css2?${[...new Set(t.fonts)].map((f) => `family=${f.replace(/ /g, '+')}:wght@400;500;600;700`).join('&')}&display=swap`;

const ICONS = [
  '<path d="M12 2l2.9 6.6 7.1.6-5.4 4.7 1.6 7L12 17.3 5.8 20.9l1.6-7L2 9.2l7.1-.6z"/>',
  '<path d="M12 21s-7.5-4.6-9.5-9.2C1.2 8.6 3.3 5 6.8 5c2.1 0 3.6 1.2 5.2 3 1.6-1.8 3.1-3 5.2-3 3.5 0 5.6 3.6 4.3 6.8C19.5 16.4 12 21 12 21z"/>',
  '<path d="M9 16.2l-3.5-3.5L4 14.2l5 5 11-11-1.5-1.5z"/>',
];
const icon = (i: number, color: string) => `<svg viewBox="0 0 24 24" width="22" height="22" fill="${color}" aria-hidden="true">${ICONS[i % ICONS.length]}</svg>`;

/** "Mo-Fr 08:00-19:00; Sa 08:00-13:00" → readable lines in the page language. */
export function readableHours(h: string | null | undefined, lang: string): string[] {
  if (!h) return [];
  const days: Record<string, Record<string, string>> = {
    fr: { Mo: 'Lun', Tu: 'Mar', We: 'Mer', Th: 'Jeu', Fr: 'Ven', Sa: 'Sam', Su: 'Dim', off: 'fermé', PH: 'Jours fériés' },
    nl: { Mo: 'Ma', Tu: 'Di', We: 'Wo', Th: 'Do', Fr: 'Vr', Sa: 'Za', Su: 'Zo', off: 'gesloten', PH: 'Feestdagen' },
    pt: { Mo: 'Seg', Tu: 'Ter', We: 'Qua', Th: 'Qui', Fr: 'Sex', Sa: 'Sáb', Su: 'Dom', off: 'fechado', PH: 'Feriados' },
  };
  const d = days[lang];
  return h.split(';').map((s) => s.trim()).filter(Boolean).slice(0, 7)
    .map((s) => (d ? s.replace(/\b(Mo|Tu|We|Th|Fr|Sa|Su|PH|off)\b/g, (m) => d[m] ?? m) : s).replace(/-/g, ' – ').replace(/,/g, ', '));
}

const CSS = (t: Theme) => `
*{box-sizing:border-box}html{scroll-behavior:smooth}body{margin:0;font-family:'${t.fonts[1]}',system-ui,-apple-system,Segoe UI,Arial,sans-serif;color:${t.text};background:${t.bg};line-height:1.6;-webkit-font-smoothing:antialiased}
h1,h2,h3{font-family:'${t.fonts[0]}',Georgia,serif;line-height:1.15;margin:0 0 .5em;color:${t.dark}}
a{color:inherit}img{display:block;max-width:100%}
.wrap{max-width:1160px;margin:0 auto;padding:0 28px}
.nav{position:absolute;top:0;left:0;right:0;z-index:5;color:#fff}
.nav .wrap{display:flex;align-items:center;justify-content:space-between;height:84px}
.brand{font-family:'${t.fonts[0]}',Georgia,serif;font-size:24px;font-weight:700;letter-spacing:.2px;color:#fff;text-decoration:none}
.links{display:flex;gap:30px;font-size:14px;font-weight:500;align-items:center}.links a{text-decoration:none;opacity:.92}
.btn{display:inline-block;background:${t.accent};color:${t.dark};padding:14px 28px;border-radius:999px;text-decoration:none;font-weight:600;font-size:15px;box-shadow:0 10px 24px rgba(0,0,0,.18)}
.btn.ghost{background:transparent;color:#fff;border:1.5px solid rgba(255,255,255,.7);box-shadow:none}
.links .btn{padding:10px 20px;font-size:14px}
.hero{position:relative;min-height:640px;display:flex;align-items:center;color:#fff;background:${t.dark} center/cover no-repeat}
.hero:before{content:"";position:absolute;inset:0;background:linear-gradient(100deg,rgba(0,0,0,.72) 0%,rgba(0,0,0,.45) 55%,rgba(0,0,0,.15) 100%)}
.hero .wrap{position:relative;padding-top:120px;padding-bottom:90px;width:100%}
.eyebrow{display:inline-block;font-size:13px;letter-spacing:2.5px;text-transform:uppercase;font-weight:600;color:${t.accent};margin-bottom:18px}
.hero h1{color:#fff;font-size:60px;max-width:760px;margin-bottom:20px}
.hero p{font-size:19px;max-width:580px;opacity:.93;margin:0 0 34px}
.hero .actions{display:flex;gap:14px;flex-wrap:wrap}
.chips{display:flex;gap:12px;flex-wrap:wrap;margin-top:44px}.chip{background:rgba(255,255,255,.14);backdrop-filter:blur(6px);border:1px solid rgba(255,255,255,.22);padding:9px 16px;border-radius:999px;font-size:13.5px}
section{padding:96px 0}
.head{max-width:640px;margin:0 auto 52px;text-align:center}.head h2{font-size:42px}.head p{color:${t.muted};font-size:17px;margin:0}
.kicker{font-size:12.5px;letter-spacing:2.5px;text-transform:uppercase;color:${t.primary};font-weight:700;margin-bottom:12px;display:block}
.grid{display:grid;grid-template-columns:repeat(3,1fr);gap:26px}
.card{background:${t.surface};border-radius:${t.radius}px;overflow:hidden;box-shadow:0 1px 2px rgba(0,0,0,.04),0 12px 32px rgba(20,20,40,.07)}
.card .ph{height:210px;background:${t.primary} center/cover no-repeat}
.card .body{padding:26px 26px 30px}.card h3{font-size:22px;margin-bottom:8px}.card p{color:${t.muted};margin:0;font-size:15.5px}
.card .num{width:46px;height:46px;border-radius:50%;background:${t.bg};display:flex;align-items:center;justify-content:center;color:${t.primary};font-weight:700;margin-bottom:16px}
.about{background:${t.surface}}.split{display:grid;grid-template-columns:1.05fr 1fr;gap:64px;align-items:center}
.split .img{border-radius:${t.radius + 6}px;min-height:470px;background:${t.primary} center/cover no-repeat;box-shadow:0 24px 60px rgba(0,0,0,.16)}
.split h2{font-size:40px}.split p{color:${t.muted};font-size:16.5px}
.hl{display:flex;gap:16px;margin-top:22px}.hl .ic{flex:none;width:48px;height:48px;border-radius:14px;background:${t.bg};display:flex;align-items:center;justify-content:center}
.hl h3{font-size:18px;margin:2px 0 2px;font-family:'${t.fonts[1]}',system-ui,sans-serif;font-weight:700}.hl p{margin:0;font-size:15px}
.gallery{display:grid;grid-template-columns:2fr 1fr 1fr;grid-template-rows:240px 240px;gap:16px}
.gallery div{border-radius:${t.radius}px;background:${t.primary} center/cover no-repeat}.gallery div:first-child{grid-row:span 2}
.info{display:grid;grid-template-columns:repeat(3,1fr);gap:22px}
.info .card{padding:30px}.info h3{font-size:14px;letter-spacing:1.8px;text-transform:uppercase;color:${t.primary};font-family:'${t.fonts[1]}',system-ui,sans-serif;font-weight:700}
.info p{margin:0;color:${t.text};font-size:16px}
.band{background:linear-gradient(120deg,${t.primary},${t.dark});color:#fff;text-align:center;border-radius:${t.radius + 8}px;padding:70px 40px}
.band h2{color:#fff;font-size:40px}.band p{opacity:.88;font-size:17px;max-width:620px;margin:0 auto 30px}
footer{background:${t.dark};color:rgba(255,255,255,.75);padding:44px 0;font-size:14px}
footer .wrap{display:flex;justify-content:space-between;gap:20px;flex-wrap:wrap}footer .brand{font-size:20px}
.credit{font-size:11.5px;opacity:.6;margin-top:6px}
@media(max-width:820px){.links{display:none}.hero{min-height:600px}.hero h1{font-size:38px}.hero p{font-size:17px}
section{padding:64px 0}.head h2,.split h2,.band h2{font-size:30px}.grid,.info{grid-template-columns:1fr}.split{grid-template-columns:1fr;gap:34px}
.split .img{min-height:280px}.gallery{grid-template-columns:1fr 1fr;grid-template-rows:180px 180px 180px}.gallery div:first-child{grid-column:span 2;grid-row:auto}
.wrap{padding:0 20px}.brand{font-size:20px}.band{padding:48px 24px}}
`;

export function renderSite(c: SiteContent, f: Facts, photos: Photo[], themeKey: string, lang: string, opts: { style?: Style; hidden?: SiteSection[] } = {}): string {
  const t = styled(THEMES[themeKey] ?? THEMES.pro, opts.style); const L = LABELS[lang] ?? LABELS.en;
  const show = (k: SiteSection) => !(opts.hidden ?? []).includes(k);
  const bg = (p?: Photo, thumb = false) => (p ? ` style="background-image:url('${esc(thumb ? p.thumb : p.url)}')"` : '');
  const [hero, ...rest] = photos;
  const cardPhotos = rest.length >= 3 ? rest.slice(0, 3) : [];
  const aboutPhoto = rest[3] ?? rest[0];
  const gallery = !show('gallery') ? [] : rest.length >= 9 ? rest.slice(4, 9) : photos.length >= 5 ? photos.slice(0, 5) : [];
  const hours = readableHours(f.hours, lang);
  const info = [
    f.address ? `<div class="card"><h3>${L.address}</h3><p>${esc(f.address)}</p></div>` : '',
    hours.length ? `<div class="card"><h3>${L.hours}</h3><p>${hours.map(esc).join('<br>')}</p></div>` : '',
    f.phone ? `<div class="card"><h3>${L.phone}</h3><p>${esc(f.phone)}</p></div>` : '',
    f.email ? `<div class="card"><h3>${L.email}</h3><p>${esc(f.email)}</p></div>` : '',
  ].filter(Boolean).slice(0, 3);
  const credits = [...new Set(photos.map((p) => p.credit).filter(Boolean))];
  const chips = [f.city, hours[0]].filter(Boolean).map((x) => `<span class="chip">${esc(x)}</span>`).join('');
  return `<!doctype html>
<html lang="${esc(lang)}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(f.name)}${f.city ? ` – ${esc(f.city)}` : ''}</title><meta name="description" content="${esc(c.hero_text)}">
<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin><link rel="stylesheet" href="${fontLink(t)}">
<style>${CSS(t)}</style></head>
<body>
<header class="nav"><div class="wrap"><a class="brand" href="#">${esc(f.name)}</a>
<nav class="links">${show('services') ? `<a href="#services">${L.services}</a>` : ''}${show('about') ? `<a href="#about">${L.about}</a>` : ''}${gallery.length ? `<a href="#gallery">${L.gallery}</a>` : ''}<a href="#contact">${L.contact}</a><a class="btn" href="#contact">${esc(c.cta)}</a></nav></div></header>
<div class="hero"${bg(hero)}><div class="wrap">
<span class="eyebrow">${esc(c.tagline)}</span><h1>${esc(c.hero_title)}</h1><p>${esc(c.hero_text)}</p>
<div class="actions"><a class="btn" href="#contact">${esc(c.cta)}</a><a class="btn ghost" href="#services">${L.more}</a></div>
${chips ? `<div class="chips">${chips}</div>` : ''}</div></div>
${show('services') ? `<section id="services"><div class="wrap">
<div class="head"><span class="kicker">${L.services}</span><h2>${esc(c.services_title)}</h2>${c.services_intro ? `<p>${esc(c.services_intro)}</p>` : ''}</div>
<div class="grid">${c.services.map((s, i) => `<div class="card">${cardPhotos[i] ? `<div class="ph"${bg(cardPhotos[i], true)}></div>` : ''}<div class="body">${cardPhotos[i] ? '' : `<div class="num">${String(i + 1).padStart(2, '0')}</div>`}<h3>${esc(s.title)}</h3><p>${esc(s.text)}</p></div></div>`).join('')}</div>
</div></section>
` : ''}${show('about') ? `<section id="about" class="about"><div class="wrap split">
<div class="img"${bg(aboutPhoto)}></div>
<div><span class="kicker">${L.about}</span><h2>${esc(c.about_title)}</h2>${c.about_text.split(/\n+/).map((p) => `<p>${esc(p)}</p>`).join('')}
${c.highlights.map((h, i) => `<div class="hl"><div class="ic">${icon(i, t.primary)}</div><div><h3>${esc(h.title)}</h3><p>${esc(h.text)}</p></div></div>`).join('')}</div>
</div></section>
` : ''}${gallery.length ? `<section id="gallery"><div class="wrap"><div class="head"><span class="kicker">${L.gallery}</span><h2>${L.moments}</h2></div>
<div class="gallery">${gallery.map((p) => `<div${bg(p, true)}></div>`).join('')}</div></div></section>` : ''}
<section id="contact" style="padding-top:${gallery.length ? 0 : 96}px"><div class="wrap">
${info.length && show('info') ? `<div class="head"><span class="kicker">${L.info}</span><h2>${L.visit}</h2></div><div class="info" style="margin-bottom:56px">${info.join('')}</div>` : ''}
${show('cta_band') ? `<div class="band"><h2>${esc(c.cta_title)}</h2>${c.cta_text ? `<p>${esc(c.cta_text)}</p>` : ''}<a class="btn" href="${f.email ? `mailto:${esc(f.email)}` : '#'}">${esc(c.cta)}</a></div>` : ''}
</div></section>
<footer><div class="wrap"><div><div class="brand">${esc(f.name)}</div><div>${esc([f.address, f.email].filter(Boolean).join(' · '))}</div></div>
<div style="text-align:right"><div>© ${new Date().getFullYear()} ${esc(f.name)}</div>${credits.length ? `<div class="credit">${L.photos} : ${credits.map(esc).join(', ')}</div>` : ''}</div></div></footer>
</body></html>`;
}

/** A 1080×1080 social-media post: photo background, strong headline, three benefits, call to action. */
export function renderPost(c: PostContent, f: Facts, photos: Photo[], themeKey: string, lang: string, opts: { style?: Style } = {}): string {
  const t = styled(THEMES[themeKey] ?? THEMES.pro, opts.style); const p = photos[0];
  return `<!doctype html>
<html lang="${esc(lang)}"><head><meta charset="utf-8"><meta name="viewport" content="width=1080"><title>${esc(f.name)}</title>
<link rel="stylesheet" href="${fontLink(t)}">
<style>*{box-sizing:border-box}body{margin:0;width:1080px;height:1080px;font-family:'${t.fonts[1]}',system-ui,sans-serif}
.post{position:relative;width:1080px;height:1080px;overflow:hidden;color:#fff;background:${t.dark} center/cover no-repeat;display:flex;flex-direction:column;justify-content:flex-end;padding:84px}
.post:before{content:"";position:absolute;inset:0;background:linear-gradient(180deg,rgba(0,0,0,.05) 0%,rgba(0,0,0,.35) 40%,rgba(0,0,0,.85) 100%)}
.post>*{position:relative}.top{position:absolute;top:70px;left:84px;right:84px;display:flex;justify-content:space-between;align-items:center}
.name{font-family:'${t.fonts[0]}',Georgia,serif;font-size:38px;font-weight:700}.city{background:rgba(255,255,255,.16);border:1px solid rgba(255,255,255,.3);border-radius:999px;padding:10px 22px;font-size:22px}
h1{font-family:'${t.fonts[0]}',Georgia,serif;font-size:84px;line-height:1.02;margin:0 0 24px}p{font-size:30px;line-height:1.4;margin:0 0 34px;opacity:.94;max-width:860px}
ul{list-style:none;padding:0;margin:0 0 44px;display:flex;gap:14px;flex-wrap:wrap}li{background:rgba(255,255,255,.14);border:1px solid rgba(255,255,255,.28);border-radius:999px;padding:12px 24px;font-size:24px}
.cta{display:inline-block;align-self:flex-start;background:${t.accent};color:${t.dark};font-weight:700;font-size:28px;padding:22px 44px;border-radius:999px}
.bar{position:absolute;left:0;right:0;bottom:0;height:14px;background:${t.accent}}</style></head>
<body><div class="post"${p ? ` style="background-image:url('${esc(p.url)}')"` : ''}>
<div class="top"><span class="name">${esc(f.name)}</span>${f.city ? `<span class="city">${esc(f.city)}</span>` : ''}</div>
<h1>${esc(c.headline)}</h1><p>${esc(c.text)}</p><ul>${c.bullets.map((b) => `<li>${esc(b)}</li>`).join('')}</ul><span class="cta">${esc(c.cta)}</span><div class="bar"></div>
</div></body></html>`;
}

/** Facts printed on the listing ("Adresse : …", "Horaires : …", "E-mail professionnel publié : …"). */
export function factsFromListing(listing: string, name: string, city: string | null | undefined, email: string | null | undefined): Facts {
  const line = (re: RegExp) => listing.match(re)?.[1]?.trim() || null;
  return { name, city: city ?? line(/^Ville\s*:\s*(.+)$/m), address: line(/^Adresse\s*:\s*(.+)$/m), hours: line(/^Horaires\s*:\s*(.+)$/m),
    email: line(/^E-mail professionnel publié\s*:\s*(\S+)$/m) ?? email ?? null, phone: line(/^Téléphone\s*:\s*(.+)$/m) };
}
