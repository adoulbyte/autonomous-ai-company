export interface Identity { company_name: string; sender_name: string; tagline: string; website: string; signature: string; ai_disclosure: string; logo_data_url?: string }

/** The logo travels as an inline attachment (cid:), which Gmail and Outlook display; data: URLs are blocked by most mail clients. */
export const LOGO_CID = 'company-logo';
export function logoAttachment(id: Identity) {
  const m = /^data:(image\/(?:png|jpeg|gif));base64,([A-Za-z0-9+/=]+)$/.exec(id.logo_data_url ?? '');
  return m ? { filename: `logo.${m[1].split('/')[1].replace('jpeg', 'jpg')}`, content: Buffer.from(m[2], 'base64'), contentType: m[1], cid: LOGO_CID } : null;
}

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** Strip an AI-disclosure/signature the model may already have appended, so we add exactly one. */
export function cleanBody(body: string, id: Identity): string {
  let b = body.trim();
  for (const line of [id.ai_disclosure, 'This message was prepared by an AI-assisted business system and reviewed by its owner.', 'This message was prepared by an AI-assisted business system.']) {
    if (line) b = b.split(line).join('').trim();
  }
  return b;
}

/** Plain-text email with signature + disclosure. */
export function renderText(body: string, id: Identity): string {
  return `${cleanBody(body, id)}\n\n—\n${id.signature}${id.website ? `\n${id.website}` : ''}\n\n${id.ai_disclosure}`;
}

/** Reply buttons (mailto) and the offer highlights shown in prospecting emails. */
export interface Cta { yes: { label: string; href: string }; no: { label: string; href: string } }
export interface Highlights { title: string; items: string[] }

const GOLD = '#c9a35b', INK = '#16181d', NAVY = '#111827', MUTED = '#6b6f78', LINE = '#ece8df', CREAM = '#faf7f0';

const ctaHtml = (c: Cta) => `<table role="presentation" cellpadding="0" cellspacing="0" align="center" style="margin:22px auto 6px"><tr>
<td style="background:${NAVY};border-radius:8px"><a href="${esc(c.yes.href)}" style="display:inline-block;padding:13px 22px;color:#ffffff;text-decoration:none;font-weight:600;font-size:15px">${esc(c.yes.label)}</a></td>
<td style="width:12px"></td>
<td style="border:1px solid #d9d5cc;border-radius:8px"><a href="${esc(c.no.href)}" style="display:inline-block;padding:12px 18px;color:${MUTED};text-decoration:none;font-size:14px">${esc(c.no.label)}</a></td>
</tr></table>`;

const highlightsHtml = (h: Highlights) => `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:8px 0 6px;background:${CREAM};border:1px solid ${LINE};border-radius:10px">
<tr><td style="padding:16px 18px">
<div style="font-size:12px;letter-spacing:.08em;text-transform:uppercase;color:${GOLD};font-weight:700;margin-bottom:10px">${esc(h.title)}</div>
${h.items.map((i) => `<table role="presentation" cellpadding="0" cellspacing="0" style="margin:0 0 8px"><tr>
<td valign="top" style="width:22px;color:${GOLD};font-weight:700;font-size:15px">✓</td><td style="font-size:14.5px;color:${INK};line-height:1.5">${esc(i)}</td></tr></table>`).join('')}
</td></tr></table>`;

/** Branded, email-client-safe HTML (inline styles, table layout, mobile friendly): header with logo, organised body,
 *  offer highlights and reply buttons when given, signature block, discreet footer with the opt-out sentence. */
export function renderHtml(body: string, id: Identity, opts: { preheader?: string; blocks?: string; cta?: Cta; highlights?: Highlights; personal?: boolean; noImages?: boolean } = {}): string {
  const all = cleanBody(body, id).split(/\n{2,}/).map((p) => p.trim()).filter(Boolean);
  // The opt-out sentence goes to the footer, where readers expect it.
  const optOutIdx = all.findIndex((p) => /\bSTOP\b/.test(p) && p.length < 220);
  const optOut = optOutIdx >= 0 ? all.splice(optOutIdx, 1)[0] : '';
  const paras = all.map((p, i) =>
    p.startsWith('- ') || p.includes('\n- ')
      ? `<ul style="margin:0 0 16px 18px;padding:0">${p.split('\n').map((l) => `<li style="margin:0 0 6px">${esc(l.replace(/^-\s*/, ''))}</li>`).join('')}</ul>`
      : `<p style="margin:0 0 16px;${i === 0 ? 'font-size:16px;color:' + INK + ';' : ''}">${esc(p).replace(/\n/g, '<br>')}</p>`).join('');
  // First contacts carry no image at all (an image in a cold email raises the spam score): a drawn monogram replaces the logo.
  const logo = !opts.noImages && logoAttachment(id)
    ? `<img src="cid:${LOGO_CID}" alt="${esc(id.company_name)}" width="56" height="56" style="display:block;width:56px;height:56px;border:0;border-radius:50%">`
    : `<div style="width:48px;height:48px;line-height:48px;background:${GOLD};border-radius:50%;color:${NAVY};font-weight:800;text-align:center;font-size:20px">${esc(id.company_name.charAt(0))}</div>`;
  const [sigName, ...sigRest] = id.signature.split('\n');
  return `<!doctype html><html lang="fr"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="color-scheme" content="light"></head>
<body style="margin:0;padding:0;background:#f3f1ec;font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;color:#2b2e35">
<span style="display:none;max-height:0;overflow:hidden;opacity:0">${esc(opts.preheader ?? '')}</span>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f3f1ec;padding:24px 10px"><tr><td align="center">
<table role="presentation" width="600" cellpadding="0" cellspacing="0" style="max-width:600px;width:100%;background:#ffffff;border-radius:14px;overflow:hidden;border:1px solid ${LINE}">
<tr><td style="background:${NAVY};padding:20px 26px">
  <table role="presentation" cellpadding="0" cellspacing="0"><tr>
  <td valign="middle">${logo}</td>
  <td valign="middle" style="padding-left:14px"><div style="font-weight:700;font-size:17px;color:${GOLD};letter-spacing:.02em">${esc(id.company_name)}</div>
  <div style="font-size:12px;color:#c8cbd2;margin-top:2px">${esc(id.tagline)}</div></td>
  </tr></table></td></tr>
<tr><td style="height:4px;background:${GOLD};font-size:0;line-height:0">&nbsp;</td></tr>
<tr><td style="padding:28px 28px 8px;font-size:15px;line-height:1.65">${paras}
${opts.highlights ? highlightsHtml(opts.highlights) : ''}${opts.cta ? ctaHtml(opts.cta) : ''}${opts.blocks ?? ''}</td></tr>
<tr><td style="padding:18px 28px 24px">
  <table role="presentation" cellpadding="0" cellspacing="0"><tr><td style="border-left:3px solid ${GOLD};padding-left:12px">
  <div style="font-weight:700;font-size:14.5px;color:${INK}">${esc(sigName ?? '')}</div>
  ${sigRest.length ? `<div style="font-size:13px;color:${MUTED};line-height:1.5">${sigRest.map(esc).join('<br>')}</div>` : ''}
  ${id.website ? `<div style="font-size:13px;margin-top:2px"><a href="${esc(id.website)}" style="color:${GOLD};text-decoration:none">${esc(id.website)}</a></div>` : ''}
  </td></tr></table></td></tr>
<tr><td style="background:#faf9f6;border-top:1px solid ${LINE};padding:14px 28px;font-size:11.5px;color:#9a9da5;line-height:1.5">
  ${esc(id.ai_disclosure)}${optOut ? `<br>${esc(optOut)}` : ''}</td></tr>
</table></td></tr></table></body></html>`;
}

export function previewBlock(title: string, excerpt: string, note: string): string {
  return `<div style="margin:18px 0;border:1px solid #e7e4dd;border-radius:10px;overflow:hidden">
<div style="background:#faf9f7;padding:10px 14px;font-weight:600;font-size:13px">${esc(title)} <span style="color:#9a7b3c;font-weight:500">— preview</span></div>
<pre style="margin:0;padding:14px;font-family:SFMono-Regular,Menlo,Consolas,monospace;font-size:12px;white-space:pre-wrap;color:#33363d">${esc(excerpt)}</pre>
<div style="padding:8px 14px;font-size:12px;color:#6b6f78;border-top:1px solid #e7e4dd">${esc(note)}</div></div>`;
}
