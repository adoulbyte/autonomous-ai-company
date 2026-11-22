export const money = (minor: number | string | null | undefined, currency = 'USD') => {
  if (minor == null || minor === '') return '—';
  const n = Number(minor) / 100;
  try { return new Intl.NumberFormat('en-US', { style: 'currency', currency, maximumFractionDigits: n % 1 === 0 ? 0 : 2 }).format(n); }
  catch { return `${n.toFixed(2)} ${currency}`; }
};
export const num = (v: number | string | null | undefined, digits = 0) => (v == null ? '—' : Number(v).toLocaleString('en-US', { maximumFractionDigits: digits }));
export const pct = (v: number | string | null | undefined) => (v == null ? '—' : `${Math.round(Number(v) * 100)}%`);
export const dt = (v: string | null | undefined) => (v ? new Date(v).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }) : '—');
export const date = (v: string | null | undefined) => (v ? new Date(v).toLocaleDateString(undefined, { dateStyle: 'medium' }) : '—');
export function ago(v: string | null | undefined): string {
  if (!v) return '—';
  const s = (Date.now() - new Date(v).getTime()) / 1000;
  const a = Math.abs(s);
  const t = a < 60 ? `${Math.floor(a)}s` : a < 3600 ? `${Math.floor(a / 60)}m` : a < 86400 ? `${Math.floor(a / 3600)}h` : `${Math.floor(a / 86400)}d`;
  return s < 0 ? `in ${t}` : `${t} ago`;
}
export const short = (id: string | null | undefined) => (id ? String(id).slice(0, 8) : '—');
/** Parse a user-entered decimal amount into integer minor units; rejects ambiguous input. */
export function toMinor(input: string): number {
  const t = input.trim().replace(/,/g, '');
  if (!/^\d+(\.\d{1,2})?$/.test(t)) throw new Error('Enter an amount like 1250 or 1250.50');
  const [i, f = ''] = t.split('.');
  return Number(i) * 100 + Number((f + '00').slice(0, 2));
}
