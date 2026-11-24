import { PDFDocument, StandardFonts, rgb, type PDFFont } from 'pdf-lib';

/** Characters the standard PDF fonts can print (Latin-1); everything else is dropped. */
const printable = (s: string) => s.replace(/[’‘]/g, "'").replace(/[“”«»]/g, '"').replace(/[–—]/g, '-').replace(/€/g, 'EUR').replace(/[^\x20-\x7E\xA0-\xFF]/g, '');

function wrap(text: string, font: PDFFont, size: number, width: number): string[] {
  const out: string[] = []; let line = '';
  for (const word of text.split(/\s+/).filter(Boolean)) {
    const next = line ? `${line} ${word}` : word;
    if (font.widthOfTextAtSize(next, size) > width && line) { out.push(line); line = word; } else line = next;
  }
  if (line) out.push(line);
  return out.length ? out : [''];
}

/** Render simple Markdown (headings, paragraphs, bullets, tables) to a clean A4 PDF. */
export async function renderMarkdownPdf(markdown: string, footer: string): Promise<Buffer> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica); const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  const W = 595, H = 842, M = 56, width = W - 2 * M;
  let page = doc.addPage([W, H]); let y = H - M;
  const ink = rgb(0.1, 0.1, 0.12), muted = rgb(0.45, 0.45, 0.5), accent = rgb(0.6, 0.48, 0.24);
  const ensure = (h: number) => { if (y - h < M + 20) { page = doc.addPage([W, H]); y = H - M; } };
  const draw = (text: string, size: number, f: PDFFont, color = ink, indent = 0) => {
    for (const l of wrap(printable(text), f, size, width - indent)) { ensure(size * 1.5); page.drawText(l, { x: M + indent, y, size, font: f, color }); y -= size * 1.45; }
  };
  for (const raw of markdown.replace(/\r/g, '').split('\n')) {
    const line = raw.trimEnd();
    if (!line.trim()) { y -= 6; continue; }
    const strip = (s: string) => s.replace(/\*\*(.+?)\*\*/g, '$1').replace(/`([^`]+)`/g, '$1').replace(/\[([^\]]+)\]\([^)]+\)/g, '$1');
    if (/^#\s/.test(line)) { y -= 6; draw(strip(line.slice(2)), 22, bold); page.drawLine({ start: { x: M, y: y + 6 }, end: { x: M + 60, y: y + 6 }, thickness: 2, color: accent }); y -= 10; }
    else if (/^##\s/.test(line)) { y -= 8; draw(strip(line.slice(3)), 15, bold); y -= 2; }
    else if (/^###\s/.test(line)) { y -= 4; draw(strip(line.slice(4)), 12, bold); }
    else if (/^\s*[-*]\s/.test(line)) draw(`•  ${strip(line.replace(/^\s*[-*]\s/, ''))}`, 11, font, ink, 10);
    else if (/^\|/.test(line)) {
      if (/^\|[\s:|-]+\|?$/.test(line)) continue;   // separator row
      const cells = line.split('|').slice(1, -1).map((c) => printable(strip(c.trim())));
      ensure(18); const cw = width / Math.max(cells.length, 1);
      cells.forEach((c, i) => page.drawText(c.slice(0, Math.floor(cw / 5.5)), { x: M + i * cw, y, size: 10.5, font: i === 0 ? font : bold, color: ink }));
      y -= 16; page.drawLine({ start: { x: M, y: y + 11 }, end: { x: W - M, y: y + 11 }, thickness: 0.4, color: rgb(0.85, 0.85, 0.85) });
    } else draw(strip(line), 11, font);
  }
  for (const p of doc.getPages()) p.drawText(printable(footer).slice(0, 110), { x: M, y: 30, size: 8, font, color: muted });
  return Buffer.from(await doc.save());
}

/** CSV that opens correctly in Excel (UTF-8 BOM so accents display, semicolon separator kept as written). */
export function excelCsv(csv: string): Buffer { return Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(csv.replace(/\r?\n/g, '\r\n'), 'utf8')]); }
