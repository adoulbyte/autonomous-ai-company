import { q, rpc, supabase, type Row } from '../lib/supabase';
import { useData } from '../lib/hooks';
import { dt } from '../lib/format';
import { ActionButton, Card, Empty, ErrorBox, Json, PageHead, Table } from '../components/ui';

function toCsv(rows: Row[]): string {
  if (!rows.length) return '';
  const cols = Object.keys(rows[0]);
  const esc = (v: unknown) => { const s = v == null ? '' : typeof v === 'object' ? JSON.stringify(v) : String(v); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
  return [cols.join(','), ...rows.map((r) => cols.map((c) => esc(r[c])).join(','))].join('\n');
}
async function exportTable(table: string) {
  const rows = await q<Row[]>(supabase.from(table).select('*').limit(10000));
  const url = URL.createObjectURL(new Blob([toCsv(rows)], { type: 'text/csv' }));
  const a = document.createElement('a'); a.href = url; a.download = `${table}-${new Date().toISOString().slice(0, 10)}.csv`; a.click(); URL.revokeObjectURL(url);
}

export function Reports() {
  const { data, error, reload } = useData(() => q<Row[]>(supabase.from('strategy_reviews').select('*').order('created_at', { ascending: false }).limit(20)));
  return (
    <div className="stack">
      <PageHead title="Reports" subtitle="Weekly strategy reviews from the Executive Strategist, and CSV exports of your data."
        actions={<ActionButton className="btn primary" success="Strategy review queued for the next worker run" action={() => rpc('owner_enqueue', { p_type: 'strategy.review', p_input: {}, p_title: 'Strategy review (owner request)' })} onDone={reload}>Request strategy review</ActionButton>} />
      <ErrorBox error={error} />
      {data && !data.length && <Card pad><Empty title="No strategy reviews yet">Generated weekly by the worker.</Empty></Card>}
      {data?.map((r) => <Card key={r.id} title={`Strategy review · ${dt(r.created_at)}`} pad><div className="stack">
        <p style={{ margin: 0 }}>{r.summary}</p>
        {(r.recommendations as string[]).length > 0 && <ul>{(r.recommendations as string[]).map((x, i) => <li key={i}>{x}</li>)}</ul>}
        {r.proposed_settings && <div className="alert warn small">Proposed scoring weights are waiting in Approvals.</div>}
        <details><summary className="small muted">Metrics used</summary><Json value={r.metrics} /></details></div></Card>)}
      <Card title="Exports (CSV)" pad><div className="row">
        {['opportunities', 'leads', 'companies', 'contacts', 'projects', 'deliverables', 'invoices', 'payments', 'expenses', 'events', 'audit_log', 'metric_snapshots', 'ai_calls'].map((t) =>
          <ActionButton key={t} className="btn sm" success={`${t} exported`} action={() => exportTable(t)}>{t}</ActionButton>)}
      </div></Card>
      <AuditTrail />
    </div>
  );
}

function AuditTrail() {
  const { data } = useData(() => q<Row[]>(supabase.from('audit_log').select('id,at,actor_type,actor_id,action,entity_type,entity_id').order('id', { ascending: false }).limit(100)));
  return <Card title="Audit trail (latest 100 changes)"><Table rows={data} cols={[{ key: 'at', label: 'When', render: (r) => dt(r.at) }, { key: 'actor', label: 'Actor', render: (r) => `${r.actor_type}${r.actor_id && r.actor_type !== 'owner' ? ':' + r.actor_id : ''}` },
    { key: 'action', label: 'Action' }, { key: 'entity_type', label: 'Entity' }, { key: 'entity_id', label: 'ID', render: (r) => <span className="mono small">{String(r.entity_id ?? '').slice(0, 24)}</span> }]} /></Card>;
}
