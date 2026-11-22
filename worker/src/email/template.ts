export interface Identity { company_name: string; sender_name: string; tagline: string; website: string; signature: string; ai_disclosure: string }

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

/** Clean, professional, email-client-safe HTML (inline styles, table layout). */
export function renderHtml(body: string, id: Identity, opts: { preheader?: string; blocks?: string } = {}): string {
  const paras = cleanBody(body, id).split(/\n{2,}/).map((p) =>
    p.startsWith('- ') || p.includes('\n- ')
      ? `<ul style="margin:0 0 16px 18px;padding:0">${p.split('\n').map((l) => `<li style="margin:0 0 6px">${esc(l.replace(/^-\s*/, ''))}</li>`).join('')}</ul>`
      : `<p style="margin:0 0 16px">${esc(p).replace(/\n/g, '<br>')}</p>`).join('');
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"></head>
<body style="margin:0;padding:0;background:#f6f5f2;font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;color:#16181d">
<span style="display:none;max-height:0;overflow:hidden">${esc(opts.preheader ?? '')}</span>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f6f5f2;padding:28px 12px"><tr><td align="center">
<table role="presentation" width="600" cellpadding="0" cellspacing="0" style="max-width:600px;width:100%;background:#ffffff;border:1px solid #e7e4dd;border-radius:12px">
<tr><td style="padding:22px 28px;border-bottom:1px solid #e7e4dd">
  <table role="presentation" cellpadding="0" cellspacing="0"><tr>
  <td style="width:34px;height:34px;background:#111827;border-radius:8px;color:#d4af6a;font-weight:700;text-align:center;font-size:16px">${esc(id.company_name.charAt(0))}</td>
  <td style="padding-left:12px"><div style="font-weight:650;font-size:15px">${esc(id.company_name)}</div><div style="font-size:12px;color:#6b6f78">${esc(id.tagline)}</div></td>
  </tr></table></td></tr>
<tr><td style="padding:26px 28px;font-size:14.5px;line-height:1.6">${paras}${opts.blocks ?? ''}</td></tr>
<tr><td style="padding:18px 28px;border-top:1px solid #e7e4dd;font-size:12.5px;color:#6b6f78;line-height:1.5">
  ${esc(id.signature).replace(/\n/g, '<br>')}${id.website ? `<br><a href="${esc(id.website)}" style="color:#9a7b3c">${esc(id.website)}</a>` : ''}
  <div style="margin-top:10px;color:#9a9da5">${esc(id.ai_disclosure)}</div></td></tr>
</table></td></tr></table></body></html>`;
}

export function previewBlock(title: string, excerpt: string, note: string): string {
  return `<div style="margin:18px 0;border:1px solid #e7e4dd;border-radius:10px;overflow:hidden">
<div style="background:#faf9f7;padding:10px 14px;font-weight:600;font-size:13px">${esc(title)} <span style="color:#9a7b3c;font-weight:500">— preview</span></div>
<pre style="margin:0;padding:14px;font-family:SFMono-Regular,Menlo,Consolas,monospace;font-size:12px;white-space:pre-wrap;color:#33363d">${esc(excerpt)}</pre>
<div style="padding:8px 14px;font-size:12px;color:#6b6f78;border-top:1px solid #e7e4dd">${esc(note)}</div></div>`;
}
