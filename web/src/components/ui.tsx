import { createContext, useContext, useState, type ReactNode } from 'react';

const TONES: Record<string, string> = {
  // generic
  healthy: 'ok', ok: 'ok', succeeded: 'ok', approved: 'ok', executed: 'ok', pass: 'ok', confirmed: 'ok', paid: 'ok', won: 'ok', accepted: 'ok',
  sent: 'ok', active: 'ok', met: 'ok', closed: 'ok', delivered: 'ok', shortlisted: 'accent', pursuing: 'accent', ready_for_delivery: 'accent',
  pending: 'warn', awaiting_approval: 'warn', retry_wait: 'warn', degraded: 'warn', monitoring: 'info', analyzing: 'info', running: 'info',
  in_progress: 'info', in_qa: 'info', planning: 'info', scored: 'info', discovered: 'info', qualified: 'info', contacted: 'info', engaged: 'info',
  proposal: 'accent', negotiating: 'accent', issued: 'info', partially_paid: 'warn', overdue: 'bad', draft: '', blocked: '', received: 'info',
  failed: 'bad', dead: 'bad', down: 'bad', rejected: 'bad', fail: 'bad', lost: 'bad', cancelled: '', expired: '', void: '', disqualified: 'bad',
  changes_requested: 'warn', on_hold: 'warn', revision: 'warn', superseded: '', critical: 'bad', error: 'bad', warning: 'warn', info: 'info',
  high: 'bad', urgent: 'bad', medium: 'warn', low: '', normal: '', pursue: 'accent', monitor: 'info', reject: 'bad', investigate: 'warn',
};
export function Badge({ value, tone }: { value: string | null | undefined; tone?: string }) {
  if (value == null) return <span className="faint">—</span>;
  const t = tone ?? TONES[value] ?? '';
  return <span className={`badge ${t}`}>{String(value).replace(/_/g, ' ')}</span>;
}

export function Stat({ label, value, sub, accent }: { label: string; value: ReactNode; sub?: ReactNode; accent?: boolean }) {
  return <div className="card stat"><div className="stat-label">{label}</div><div className={`stat-value ${accent ? 'accent' : ''}`}>{value}</div>{sub && <div className="stat-sub">{sub}</div>}</div>;
}

export function Card({ title, actions, children, pad = false }: { title?: ReactNode; actions?: ReactNode; children: ReactNode; pad?: boolean }) {
  return <div className="card">{(title || actions) && <div className="card-head"><h2>{title}</h2><div className="row">{actions}</div></div>}<div className={pad ? 'card-pad' : ''}>{children}</div></div>;
}

export function PageHead({ title, subtitle, actions }: { title: string; subtitle?: ReactNode; actions?: ReactNode }) {
  return <div className="page-head"><div><h1>{title}</h1>{subtitle && <p>{subtitle}</p>}</div><div className="row">{actions}</div></div>;
}

export function Empty({ title, children }: { title: string; children?: ReactNode }) {
  return <div className="empty"><strong>{title}</strong>{children}</div>;
}
export function ErrorBox({ error }: { error: string | null }) { return error ? <div className="alert bad">Failed to load: {error}</div> : null; }
export function Loading() { return <div className="empty">Loading…</div>; }

export interface Col<T> { key: string; label: string; render?: (r: T) => ReactNode; num?: boolean; className?: string }
export function Table<T extends Record<string, any>>({ rows, cols, onRow, empty }: { rows: T[] | null; cols: Col<T>[]; onRow?: (r: T) => void; empty?: ReactNode }) {
  if (!rows) return <Loading />;
  if (!rows.length) return <>{empty ?? <Empty title="Nothing here yet" />}</>;
  return <div className="table-wrap"><table><thead><tr>{cols.map((c) => <th key={c.key} className={c.num ? 'num' : ''}>{c.label}</th>)}</tr></thead>
    <tbody>{rows.map((r, i) => <tr key={r.id ?? r.key ?? i} className={onRow ? 'clickable' : ''} onClick={onRow ? () => onRow(r) : undefined}>
      {cols.map((c) => <td key={c.key} className={`${c.num ? 'num' : ''} ${c.className ?? ''}`}>{c.render ? c.render(r) : (r[c.key] ?? '—')}</td>)}</tr>)}</tbody></table></div>;
}

export function Tabs({ tabs, value, onChange }: { tabs: { key: string; label: ReactNode }[]; value: string; onChange: (k: string) => void }) {
  return <div className="tabs">{tabs.map((t) => <button key={t.key} className={`tab ${value === t.key ? 'active' : ''}`} onClick={() => onChange(t.key)}>{t.label}</button>)}</div>;
}

export function Modal({ title, onClose, children }: { title: string; onClose: () => void; children: ReactNode }) {
  return <div className="modal-back" onClick={onClose}><div className="card modal" onClick={(e) => e.stopPropagation()}>
    <div className="card-head"><h2>{title}</h2><button className="btn ghost sm" onClick={onClose}>Close</button></div><div className="card-pad">{children}</div></div></div>;
}

type Toast = { kind: 'ok' | 'bad' | 'info'; text: string } | null;
const ToastCtx = createContext<(t: Toast) => void>(() => {});
export function ToastProvider({ children }: { children: ReactNode }) {
  const [toast, setToast] = useState<Toast>(null);
  const show = (t: Toast) => { setToast(t); if (t) setTimeout(() => setToast((c) => (c === t ? null : c)), t.kind === 'bad' ? 8000 : 4000); };
  return <ToastCtx.Provider value={show}>{children}{toast && <div className={`toast alert ${toast.kind}`} role="status">{toast.text}</div>}</ToastCtx.Provider>;
}
export const useToast = () => useContext(ToastCtx);

/** Button that runs an async action, shows real success/failure, and prevents double submission. */
export function ActionButton({ action, children, className = 'btn', confirm, onDone, disabled, success }: {
  action: () => Promise<unknown>; children: ReactNode; className?: string; confirm?: string; onDone?: () => void; disabled?: boolean; success?: string }) {
  const [busy, setBusy] = useState(false); const toast = useToast();
  return <button className={className} disabled={busy || disabled} onClick={async (e) => {
    e.stopPropagation();
    if (confirm && !window.confirm(confirm)) return;
    setBusy(true);
    try { await action(); toast({ kind: 'ok', text: success ?? 'Done' }); onDone?.(); }
    catch (err) { toast({ kind: 'bad', text: (err as Error).message }); }
    finally { setBusy(false); }
  }}>{busy ? 'Working…' : children}</button>;
}

export function Json({ value }: { value: unknown }) { return <pre>{JSON.stringify(value, null, 2)}</pre>; }
export function Bar({ value }: { value: number }) { return <div className="bar"><span style={{ width: `${Math.max(0, Math.min(100, value * 100))}%` }} /></div>; }
