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

/** Reply buttons (mailto) shown in prospecting emails. */
export interface Cta { yes: { label: string; href: string }; alt?: { label: string; href: string }; later?: { label: string; href: string }; no?: { label: string; href: string } }
export interface Highlights { title: string; items: string[] }

// Inline buttons (they wrap on phones): main action in black, "later" outlined, "not interested" discreet.
const ctaHtml = (c: Cta) => `<p style="margin:8px 0 18px">`
  + `<a href="${esc(c.yes.href)}" style="display:inline-block;margin:0 8px 8px 0;padding:11px 18px;background:#111827;color:#ffffff;text-decoration:none;border-radius:6px;font-weight:600;font-size:14px">${esc(c.yes.label)}</a>`
  + (c.alt ? `<a href="${esc(c.alt.href)}" style="display:inline-block;margin:0 8px 8px 0;padding:11px 18px;background:#111827;color:#ffffff;text-decoration:none;border-radius:6px;font-weight:600;font-size:14px">${esc(c.alt.label)}</a>` : '')
  + (c.later ? `<a href="${esc(c.later.href)}" style="display:inline-block;margin:0 8px 8px 0;padding:10px 16px;border:1px solid #111827;color:#111827;text-decoration:none;border-radius:6px;font-size:14px">${esc(c.later.label)}</a>` : '')
  + (c.no ? `<a href="${esc(c.no.href)}" style="display:inline-block;margin:0 0 8px 0;padding:10px 14px;border:1px solid #e0ddd6;color:#6b6f78;text-decoration:none;border-radius:6px;font-size:13px">${esc(c.no.label)}</a>` : '')
  + `</p>`;

/** The original email design (light header with the company name, body, grey signature) — the one whose first emails
 *  reached the inbox. Cold emails (first contact, follow-ups) carry no image: a small monogram replaces the logo. */
/** Cold emails (first contact, follow-ups): a simple personal message with two small quick-reply buttons — no header,
 *  no image, no hidden text, no table (the variant that reached the Gmail inbox in tests). */
export function renderPersonal(body: string, id: Identity, cta?: Cta): string {
  const ps = cleanBody(body, id).split(/\n{2,}/).map((p) => p.trim()).filter(Boolean);
  const optIdx = ps.findIndex((p) => /\bSTOP\b/.test(p) && p.length < 220);
  const opt = optIdx >= 0 ? ps.splice(optIdx, 1)[0] : '';
  const buttons = cta ? `<p style="margin:18px 0"><a href="${esc(cta.yes.href)}" style="display:inline-block;margin:0 6px 6px 0;padding:6px 12px;background:#111827;color:#ffffff;text-decoration:none;border-radius:5px;font-size:13px;font-weight:bold">${esc(cta.yes.label)}</a> ${cta.no ? `<a href="${esc(cta.no.href)}" style="display:inline-block;margin:0 0 6px 0;padding:5px 11px;border:1px solid #cccccc;color:#555555;text-decoration:none;border-radius:5px;font-size:13px">${esc(cta.no.label)}</a>` : ''}</p>` : '';
  return `<div style="font-family:Arial,sans-serif;font-size:14px;line-height:1.5;color:#202124">${ps.map((p) => `<p>${esc(p).replace(/\n/g, '<br>')}</p>`).join('')}${buttons}<p>${esc(id.signature).replace(/\n/g, '<br>')}</p><p style="font-size:12px;color:#80868b">${esc(id.ai_disclosure)}${opt ? `<br>${esc(opt)}` : ''}</p></div>`;
}

export function renderHtml(body: string, id: Identity, opts: { preheader?: string; blocks?: string; cta?: Cta; highlights?: Highlights; personal?: boolean; noImages?: boolean } = {}): string {
  if (opts.personal) return renderPersonal(body, id, opts.cta);
  const paras = cleanBody(body, id).split(/\n{2,}/).map((p) =>
    p.startsWith('- ') || p.includes('\n- ')
      ? `<ul style="margin:0 0 16px 18px;padding:0">${p.split('\n').map((l) => `<li style="margin:0 0 6px">${esc(l.replace(/^-\s*/, ''))}</li>`).join('')}</ul>`
      : `<p style="margin:0 0 16px">${esc(p).replace(/\n/g, '<br>')}</p>`).join('');
  const showLogo = !opts.noImages && logoAttachment(id);
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"></head>
<body style="margin:0;padding:0;background:#f6f5f2;font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;color:#16181d">
<span style="display:none;max-height:0;overflow:hidden">${esc(opts.preheader ?? '')}</span>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f6f5f2;padding:28px 12px"><tr><td align="center">
<table role="presentation" width="600" cellpadding="0" cellspacing="0" style="max-width:600px;width:100%;background:#ffffff;border:1px solid #e7e4dd;border-radius:12px">
<tr><td style="padding:22px 28px;border-bottom:1px solid #e7e4dd">
  <table role="presentation" cellpadding="0" cellspacing="0"><tr>
  ${showLogo ? `<td><img src="cid:${LOGO_CID}" alt="${esc(id.company_name)}" height="64" style="display:block;height:64px;width:auto;border:0;border-radius:50%"></td>`
    : `<td style="width:34px;height:34px;background:#111827;border-radius:8px;color:#ffffff;font-weight:700;text-align:center;font-size:16px">${esc(id.company_name.charAt(0))}</td>`}
  <td style="padding-left:12px"><div style="font-weight:650;font-size:15px">${esc(id.company_name)}</div><div style="font-size:12px;color:#6b6f78">${esc(id.tagline)}</div></td>
  </tr></table></td></tr>
<tr><td style="padding:26px 28px;font-size:14.5px;line-height:1.6">${paras}${opts.blocks ?? ''}${opts.cta ? ctaHtml(opts.cta) : ''}</td></tr>
<tr><td style="padding:18px 28px;border-top:1px solid #e7e4dd;font-size:12.5px;color:#6b6f78;line-height:1.5">
  ${esc(id.signature).replace(/\n/g, '<br>')}${id.website ? `<br><a href="${esc(id.website)}" style="color:#6b6f78">${esc(id.website)}</a>` : ''}
  <div style="margin-top:10px;color:#9a9da5">${esc(id.ai_disclosure)}</div></td></tr>
</table></td></tr></table></body></html>`;
}

export function previewBlock(title: string, excerpt: string, note: string): string {
  return `<div style="margin:18px 0;border:1px solid #e7e4dd;border-radius:10px;overflow:hidden">
<div style="background:#faf9f7;padding:10px 14px;font-weight:600;font-size:13px">${esc(title)} <span style="color:#9a7b3c;font-weight:500">— preview</span></div>
<pre style="margin:0;padding:14px;font-family:SFMono-Regular,Menlo,Consolas,monospace;font-size:12px;white-space:pre-wrap;color:#33363d">${esc(excerpt)}</pre>
<div style="padding:8px 14px;font-size:12px;color:#6b6f78;border-top:1px solid #e7e4dd">${esc(note)}</div></div>`;
}
