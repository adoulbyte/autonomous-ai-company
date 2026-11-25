import { z } from 'zod';
import type { AiGateway } from '../ai/gateway.js';
import { untrusted } from '../sanitize.js';
import { findPhotos, type Photo } from './photos.js';
import { FONTS, photoPlaces, PostContentSchema, renderPost, renderSite, SiteContentSchema, type Facts, type SiteSection, type Style } from './site.js';

/**
 * Precise edits of a designed creation (mockup, website, social visual).
 * The AI never redraws the creation: it receives the exact current design (every text, colour, font, photo, fact) and returns
 * a short list of targeted operations. The program applies them; everything else stays byte-for-byte identical.
 * A second, independent model then checks that the result does exactly what was asked — nothing more, nothing less.
 */
export type Design = { kind: 'site' | 'post'; content: Record<string, unknown>; facts: Facts; photos: Photo[]; theme: string; lang: string; style?: Style; hidden?: SiteSection[] };

export function renderDesign(d: Design): string {
  return d.kind === 'site'
    ? renderSite(d.content as never, d.facts, d.photos, d.theme, d.lang, { style: d.style, hidden: d.hidden })
    : renderPost(d.content as never, d.facts, d.photos, d.theme, d.lang, { style: d.style });
}

const LISTS = ['services', 'highlights', 'bullets'] as const;
const SECTIONS = ['services', 'about', 'gallery', 'info', 'cta_band'] as const;
const Op = z.discriminatedUnion('op', [
  z.object({ op: z.literal('set_text'), path: z.string().max(60), value: z.string().max(700) }),
  z.object({ op: z.literal('add_item'), list: z.enum(LISTS), value: z.union([z.string().max(170), z.object({ title: z.string().max(45), text: z.string().max(170) })]), position: z.number().int().min(0).max(10).nullable().optional() }),
  z.object({ op: z.literal('remove_item'), list: z.enum(LISTS), index: z.number().int().min(0).max(10) }),
  z.object({ op: z.literal('move_item'), list: z.enum(LISTS), from: z.number().int().min(0).max(10), to: z.number().int().min(0).max(10) }),
  z.object({ op: z.literal('set_fact'), field: z.enum(['name', 'phone', 'hours', 'address', 'email', 'city']), value: z.string().max(200).nullable() }),
  z.object({ op: z.literal('set_color'), role: z.enum(['primary', 'accent', 'dark', 'background', 'text']), value: z.string().regex(/^#[0-9a-fA-F]{6}$/) }),
  z.object({ op: z.literal('set_font'), role: z.enum(['heading', 'body']), value: z.string().max(40) }),
  z.object({ op: z.literal('replace_photo'), index: z.number().int().min(0).max(12), search: z.string().min(3).max(80) }),
  z.object({ op: z.literal('remove_photo'), index: z.number().int().min(0).max(12) }),
  z.object({ op: z.literal('hide_section'), section: z.enum(SECTIONS) }),
  z.object({ op: z.literal('show_section'), section: z.enum(SECTIONS) }),
]);
export type EditOp = z.infer<typeof Op>;
const EditSchema = z.object({
  is_change_request: z.boolean(),
  operations: z.array(Op).max(25),
  changes_for_client: z.array(z.string().max(240)).max(25),
  unclear_question: z.string().max(600).nullable(),
  other_message: z.string().max(1500).nullable(),
});
const VerifySchema = z.object({ exact: z.boolean(), missing: z.array(z.string().max(300)).max(10), unwanted: z.array(z.string().max(300)).max(10) });

const clone = <T>(x: T): T => JSON.parse(JSON.stringify(x)) as T;
const TEXT_PATH = /^([a-z_]+)(?:\[(\d+)\](?:\.(title|text))?)?$/;

/** Every editable value of the design, one per line, with its exact path (what the AI may change). */
export function describeDesign(d: Design): string {
  const lines: string[] = [];
  for (const [k, v] of Object.entries(d.content)) {
    if (k === 'photo_keywords') continue;
    if (typeof v === 'string') lines.push(`${k} = ${JSON.stringify(v)}`);
    else if (Array.isArray(v)) v.forEach((it, i) => {
      if (typeof it === 'string') lines.push(`${k}[${i}] = ${JSON.stringify(it)}`);
      else for (const [kk, vv] of Object.entries(it as Record<string, unknown>)) lines.push(`${k}[${i}].${kk} = ${JSON.stringify(vv)}`);
    });
  }
  for (const [k, v] of Object.entries(d.facts)) lines.push(`fact ${k} = ${JSON.stringify(v ?? null)}`);
  lines.push(`colours (current overrides; empty = theme default "${d.theme}") = ${JSON.stringify(d.style ?? {})}`);
  const places = d.kind === 'site' ? photoPlaces(d.photos.length) : d.photos.map(() => 'background photo');
  d.photos.forEach((p, i) => lines.push(`photo[${i}] (${places[i]}) = ${p.url.startsWith('data:') ? 'generated image' : p.url}`));
  if (d.kind === 'site') lines.push(`hidden sections = ${JSON.stringify(d.hidden ?? [])}`);
  return lines.join('\n');
}

/** Applies the operations to a copy of the design. Unknown paths or invalid values are reported, never guessed. */
export async function applyOps(d: Design, ops: EditOp[], env: NodeJS.ProcessEnv, fetchFn?: typeof fetch): Promise<{ design: Design; errors: string[] }> {
  const out = clone(d); const errors: string[] = []; const c = out.content as Record<string, unknown>;
  for (const op of ops) {
    if (op.op === 'set_text') {
      const m = op.path.match(TEXT_PATH);
      if (!m || m[1] === 'photo_keywords' || !(m[1] in c)) { errors.push(`unknown field "${op.path}"`); continue; }
      const [, key, idx, sub] = m;
      if (idx == null) { if (typeof c[key] !== 'string') errors.push(`"${op.path}" is not a text`); else c[key] = op.value; continue; }
      const list = c[key] as unknown[]; const i = Number(idx);
      if (!Array.isArray(list) || i >= list.length) { errors.push(`"${op.path}" does not exist`); continue; }
      if (sub) { const it = list[i] as Record<string, unknown>; if (typeof it?.[sub] !== 'string') errors.push(`"${op.path}" is not a text`); else it[sub] = op.value; }
      else if (typeof list[i] === 'string') list[i] = op.value; else errors.push(`"${op.path}" needs .title or .text`);
    } else if (op.op === 'add_item' || op.op === 'remove_item' || op.op === 'move_item') {
      const list = c[op.list] as unknown[];
      if (!Array.isArray(list)) { errors.push(`this creation has no list "${op.list}"`); continue; }
      if (op.op === 'add_item') {
        const isText = typeof list[0] === 'string';
        if (isText !== (typeof op.value === 'string')) { errors.push(`items of "${op.list}" must be ${isText ? 'texts' : '{title, text}'}`); continue; }
        list.splice(op.position ?? list.length, 0, op.value);
      } else if (op.op === 'remove_item') { if (op.index >= list.length) errors.push(`${op.list}[${op.index}] does not exist`); else list.splice(op.index, 1); }
      else { if (op.from >= list.length || op.to >= list.length) errors.push(`cannot move ${op.list}[${op.from}]`); else list.splice(op.to, 0, ...list.splice(op.from, 1)); }
    } else if (op.op === 'set_fact') { (out.facts as Record<string, unknown>)[op.field] = op.value; }
    else if (op.op === 'set_color') { out.style = { ...(out.style ?? {}), [op.role]: op.value.toLowerCase() }; }
    else if (op.op === 'set_font') {
      const f = FONTS.find((x) => x.toLowerCase() === op.value.toLowerCase());
      if (!f) { errors.push(`font "${op.value}" is not available (choose one of: ${FONTS.join(', ')})`); continue; }
      out.style = { ...(out.style ?? {}), [op.role === 'heading' ? 'heading_font' : 'body_font']: f };
    } else if (op.op === 'replace_photo') {
      if (op.index >= Math.max(out.photos.length, 1)) { errors.push(`photo[${op.index}] does not exist`); continue; }
      const used = new Set(out.photos.map((p) => p.url));
      const found = (await findPhotos([op.search], 4, env, fetchFn)).find((p) => !used.has(p.url));
      if (!found) { errors.push(`no suitable photo found for "${op.search}"`); continue; }
      if (out.photos.length) out.photos[op.index] = found; else out.photos.push(found);
    } else if (op.op === 'remove_photo') { if (op.index >= out.photos.length) errors.push(`photo[${op.index}] does not exist`); else out.photos.splice(op.index, 1); }
    else if (op.op === 'hide_section' || op.op === 'show_section') {
      if (out.kind !== 'site') { errors.push('sections exist only on a website'); continue; }
      const h = new Set(out.hidden ?? []); if (op.op === 'hide_section') h.add(op.section); else h.delete(op.section); out.hidden = [...h];
    }
  }
  const schema = out.kind === 'site' ? SiteContentSchema : PostContentSchema;
  const valid = schema.safeParse(out.content);
  if (!valid.success) errors.push(...valid.error.issues.slice(0, 5).map((i) => `${i.path.join('.')}: ${i.message}`));
  return { design: out, errors };
}

/** Exact list of what differs between two designs (used for the verification and for the message to the client). */
export function diffDesign(a: Design, b: Design): string[] {
  const out: string[] = [];
  const flat = (d: Design) => Object.fromEntries(describeDesign(d).split('\n').map((l) => { const i = l.indexOf(' = '); return [l.slice(0, i), l.slice(i + 3)]; }));
  const fa = flat(a), fb = flat(b);
  for (const k of new Set([...Object.keys(fa), ...Object.keys(fb)])) {
    if (fa[k] === fb[k]) continue;
    out.push(k in fa && k in fb ? `${k}: ${fa[k]} → ${fb[k]}` : k in fb ? `added ${k} = ${fb[k]}` : `removed ${k} (was ${fa[k]})`);
  }
  return out;
}

const LANG: Record<string, string> = { fr: 'French', en: 'English', nl: 'Dutch', pt: 'Portuguese' };
export type EditResult =
  | { kind: 'not_change'; other_message: string | null }
  | { kind: 'question'; question: string }
  | { kind: 'done'; design: Design; html: string; changes: string[]; diff: string[]; other_message: string | null; model: string };

/**
 * Turns a change request (from the client, or from the QA reviewer) into precise operations on the design.
 * `label` tells which creation this is when several exist (e.g. "visual 2 of 4"): a request about another one returns not_change.
 */
export async function editDesign(o: { ai: Pick<AiGateway, 'generate'>; taskId?: string; env: NodeJS.ProcessEnv; fetchFn?: typeof fetch;
  design: Design; request: string; from: 'client' | 'qa'; label?: string; thread?: string }): Promise<EditResult> {
  const lang = LANG[o.design.lang] ?? 'English';
  let feedback: string[] = [];
  for (let round = 0; round < 3; round++) {
    const res = await o.ai.generate({ roleKey: 'specialist_worker', taskId: o.taskId, tier: 'strong', allowDowngrade: true, schema: EditSchema, maxTokens: 2500, temperature: 0,
      messages: [{ role: 'user', content: `You edit an existing ${o.design.kind === 'site' ? 'one-page website' : 'social-media visual'} with PRECISE, MINIMAL changes.
${o.label ? `This creation is: ${o.label}. If the request is clearly about another creation, return is_change_request=false and no operations.\n` : ''}Below is the EXACT current design: every editable value with its path. You must NOT redesign or rewrite anything:
return only the operations needed to do exactly what is asked. Every value you do not touch stays identical.
Rules:
- Use the exact wording given by the ${o.from === 'client' ? 'client' : 'reviewer'} when they give a text; keep the language (${lang}) and the tone of the rest.
- A colour request becomes set_color with a hex value that matches it (e.g. "bleu marine" → #1f3a5f). Fonts: only one of ${FONTS.join(', ')}.
- New phone, hours, address or email → set_fact. A different photo → replace_photo with an English stock-photo search.
- Remove/hide a part of the page → hide_section (services, about, gallery, info, cta_band) or remove_item for one item of a list.
- Text paths look like "hero_title", "services[1].text", "bullets[0]". Lists: ${o.design.kind === 'site' ? 'services, highlights' : 'bullets'}.
- If the request is ambiguous (you cannot know exactly what to change or to what), return no operations and a short, precise unclear_question in ${lang}.
- If the message is not a change request at all (question, thanks, order…), return is_change_request=false.
- changes_for_client: one short line per change, in ${lang}, as the client would say it (e.g. "Titre remplacé par « … »").
- other_message: anything else in the message that needs an answer (a question, a price…), else null.
${feedback.length ? `\nYour previous attempt was wrong — fix it:\n${feedback.map((f) => `- ${f}`).join('\n')}\n` : ''}
Current design:
${describeDesign(o.design)}

${untrusted(o.from === 'client' ? 'client-request' : 'reviewer-request', o.request, 4000)}
${o.thread ? untrusted('earlier-messages', o.thread, 3000) : ''}` }] });
    const e = res.data;
    if (!e.is_change_request && !e.operations.length) return { kind: 'not_change', other_message: e.other_message };
    if (!e.operations.length) return e.unclear_question ? { kind: 'question', question: e.unclear_question } : { kind: 'not_change', other_message: e.other_message };
    const applied = await applyOps(o.design, e.operations, o.env, o.fetchFn);
    if (applied.errors.length) { feedback = applied.errors; continue; }
    const diff = diffDesign(o.design, applied.design);
    if (!diff.length) { feedback = ['your operations changed nothing']; continue; }
    // Independent check: exactly what was asked, nothing more, nothing less.
    const v = await o.ai.generate({ roleKey: 'qa_reviewer', taskId: o.taskId, tier: 'standard', allowDowngrade: true, schema: VerifySchema, maxTokens: 700, temperature: 0, avoidModel: res.model,
      messages: [{ role: 'user', content: `Check a modification of a ${o.design.kind === 'site' ? 'website' : 'visual'} against the request, strictly.
exact = true only if the changes below do EVERYTHING that was requested and NOTHING that was not requested. List what is missing and what is unwanted.
${untrusted('request', o.request, 4000)}
Changes actually made (before → after):
${diff.join('\n')}` }] });
    if (v.data.exact) return { kind: 'done', design: applied.design, html: renderDesign(applied.design), changes: e.changes_for_client.length ? e.changes_for_client : diff, diff, other_message: e.other_message, model: res.model };
    feedback = [...v.data.missing.map((m) => `missing: ${m}`), ...v.data.unwanted.map((u) => `not requested, do not do it: ${u}`)];
  }
  return { kind: 'question', question: QUESTION[o.design.lang] ?? QUESTION.en };
}

const QUESTION: Record<string, string> = {
  fr: 'Pour être certains de modifier exactement ce que vous souhaitez, pourriez-vous nous préciser l’élément à changer (titre, texte, couleur, photo…) et le résultat attendu ?',
  en: 'To be sure we change exactly what you want, could you tell us which element to change (title, text, colour, photo…) and the result you expect?',
  nl: 'Om zeker te zijn dat we precies aanpassen wat u wilt: welk onderdeel moet veranderen (titel, tekst, kleur, foto…) en wat is het gewenste resultaat?',
  pt: 'Para termos a certeza de alterar exatamente o que deseja, pode indicar o elemento a mudar (título, texto, cor, foto…) e o resultado esperado?',
};
