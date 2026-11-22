import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';
import type { Identity } from './template.js';

export interface PaymentInstructions { enabled: boolean; text: string; beneficiary: string; iban: string; bic: string; bank: string; reference_hint: string }
export interface InvoiceData { number: string; issue_date: string; due_date: string; amount_minor: number; currency: string;
  client_name: string; client_email: string | null; project_name: string; lines: { description: string; amount_minor: number }[] }

const money = (minor: number, cur: string) => `${(minor / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} ${cur}`;

/** Professional single-page PDF invoice (pure JS, no browser). */
export async function renderInvoicePdf(inv: InvoiceData, id: Identity, pay: PaymentInstructions): Promise<Buffer> {
  const doc = await PDFDocument.create();
  const page = doc.addPage([595, 842]);   // A4
  const font = await doc.embedFont(StandardFonts.Helvetica); const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  const ink = rgb(0.09, 0.09, 0.11), muted = rgb(0.42, 0.43, 0.47), gold = rgb(0.6, 0.48, 0.24), line = rgb(0.9, 0.89, 0.86);
  const t = (s: string, x: number, y: number, o: { size?: number; f?: typeof font; c?: ReturnType<typeof rgb> } = {}) =>
    page.drawText(s.replace(/[^\x20-\x7E -ÿ]/g, ''), { x, y, size: o.size ?? 10, font: o.f ?? font, color: o.c ?? ink });
  page.drawRectangle({ x: 0, y: 792, width: 595, height: 50, color: rgb(0.07, 0.09, 0.15) });
  t(id.company_name, 40, 810, { size: 16, f: bold, c: rgb(0.83, 0.69, 0.42) });
  t(id.tagline.slice(0, 90), 40, 797, { size: 8, c: rgb(0.8, 0.8, 0.82) });
  t('INVOICE', 40, 750, { size: 22, f: bold });
  t(`No. ${inv.number}`, 40, 730, { c: muted });
  t(`Issue date: ${inv.issue_date}`, 360, 750, { c: muted }); t(`Due date: ${inv.due_date}`, 360, 735, { f: bold });
  t('Billed to', 40, 690, { size: 9, c: muted }); t(inv.client_name.slice(0, 60), 40, 676, { f: bold });
  if (inv.client_email) t(inv.client_email, 40, 662, { c: muted });
  t('Project', 360, 690, { size: 9, c: muted }); t(inv.project_name.slice(0, 40), 360, 676, { f: bold });
  let y = 620;
  page.drawLine({ start: { x: 40, y: y + 14 }, end: { x: 555, y: y + 14 }, thickness: 1, color: line });
  t('Description', 40, y, { size: 9, f: bold, c: muted }); t('Amount', 480, y, { size: 9, f: bold, c: muted }); y -= 22;
  for (const l of inv.lines) { t(l.description.slice(0, 80), 40, y); t(money(l.amount_minor, inv.currency), 470, y); y -= 18; }
  page.drawLine({ start: { x: 40, y: y + 6 }, end: { x: 555, y: y + 6 }, thickness: 1, color: line });
  t('Total due', 360, y - 14, { f: bold }); t(money(inv.amount_minor, inv.currency), 470, y - 14, { f: bold, size: 12, c: gold });
  y -= 70;
  t('Payment details', 40, y, { f: bold, size: 11 }); y -= 18;
  const payLines = pay.enabled
    ? [pay.beneficiary && `Beneficiary: ${pay.beneficiary}`, pay.iban && `IBAN: ${pay.iban}`, pay.bic && `BIC/SWIFT: ${pay.bic}`, pay.bank && `Bank: ${pay.bank}`,
       pay.text, `Reference: ${inv.number}. ${pay.reference_hint}`].filter(Boolean) as string[]
    : [pay.text || 'Payment details will be provided separately.'];
  for (const l of payLines) { t(l.slice(0, 95), 40, y); y -= 15; }
  y -= 20;
  t('Deliverables are released as soon as payment is received.', 40, y, { size: 9, c: muted });
  t(`${id.company_name} — ${id.ai_disclosure}`, 40, 40, { size: 8, c: muted });
  return Buffer.from(await doc.save());
}
