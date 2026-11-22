/** Extract the first JSON object from a model response (tolerates code fences / prose). */
export function extractJson(text: string): { ok: true; value: unknown } | { ok: false; error: string } {
  if (!text || !text.trim()) return { ok: false, error: 'empty response' };
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = fenced ? fenced[1] : text;
  try { return { ok: true, value: JSON.parse(candidate) }; } catch { /* fall through */ }
  const start = candidate.indexOf('{');
  if (start === -1) return { ok: false, error: 'no JSON object found' };
  let depth = 0; let inStr = false; let esc = false;
  for (let i = start; i < candidate.length; i++) {
    const ch = candidate[i];
    if (inStr) { if (esc) esc = false; else if (ch === '\\') esc = true; else if (ch === '"') inStr = false; continue; }
    if (ch === '"') inStr = true;
    else if (ch === '{') depth++;
    else if (ch === '}') { depth--; if (depth === 0) {
      try { return { ok: true, value: JSON.parse(candidate.slice(start, i + 1)) }; }
      catch (e) { return { ok: false, error: `invalid JSON: ${(e as Error).message}` }; }
    } }
  }
  return { ok: false, error: 'unterminated JSON object' };
}
