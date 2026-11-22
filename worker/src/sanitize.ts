import { createHash } from 'node:crypto';

export const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');

/** Strip HTML tags/entities from untrusted text. */
export function htmlToText(html: string): string {
  return html
    .replace(/<p>/gi, '\n\n').replace(/<br\s*\/?>/gi, '\n')
    .replace(/<a [^>]*href="([^"]+)"[^>]*>(.*?)<\/a>/gi, '$2 ($1)')
    .replace(/<[^>]+>/g, '')
    .replace(/&#x2F;/g, '/').replace(/&#x27;|&#39;/g, "'").replace(/&quot;/g, '"')
    .replace(/&gt;/g, '>').replace(/&lt;/g, '<').replace(/&amp;/g, '&')
    .replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
}

const INJECTION_PATTERNS = [
  /ignore (all |any )?(previous|prior|above) (instructions|prompts?)/i,
  /disregard (the )?(system|previous) (prompt|instructions)/i,
  /you are now (a|an|the) /i,
  /system prompt/i,
  /reveal (your|the) (instructions|prompt|secrets?|api key)/i,
  /(api[_ -]?key|password|secret|token)\s*[:=]/i,
  /<\/?untrusted_data/i,
  /\bact as\b.*\b(admin|developer mode|jailbreak)/i,
];

export function detectInjection(text: string): boolean {
  return INJECTION_PATTERNS.some((p) => p.test(text));
}

/**
 * Wrap external content so the model treats it as data. Delimiters inside the content are neutralised,
 * so content cannot "close" the block and smuggle instructions.
 */
export function untrusted(label: string, text: string, maxChars = 12000): string {
  const clean = text.replace(/<\/?untrusted_data[^>]*>/gi, '[removed-tag]').slice(0, maxChars);
  return `<untrusted_data source="${label.replace(/"/g, '')}">\n${clean}\n</untrusted_data>`;
}

const SECRET_PATTERNS = [
  /gh[pousr]_[A-Za-z0-9]{20,}/g, /github_pat_[A-Za-z0-9_]{20,}/g, /sk-[A-Za-z0-9_-]{20,}/g,
  /AIza[0-9A-Za-z_-]{30,}/g, /eyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{10,}/g,
  /postgres(ql)?:\/\/[^\s'"]+/g, /gsk_[A-Za-z0-9]{20,}/g,
];
/** Remove anything that looks like a credential before logging/storing. */
export function scrubSecrets(text: string): string {
  return SECRET_PATTERNS.reduce((acc, p) => acc.replace(p, '[REDACTED]'), text);
}

export function normalizeForFingerprint(s: string): string {
  return s.toLowerCase().replace(/https?:\/\/\S+/g, '').replace(/[^a-z0-9]+/g, ' ').trim().slice(0, 400);
}

export const clamp01 = (n: unknown, fallback = 0.5): number => {
  const v = typeof n === 'number' && Number.isFinite(n) ? n : Number(n);
  if (!Number.isFinite(v)) return fallback;
  return Math.min(1, Math.max(0, v));
};
