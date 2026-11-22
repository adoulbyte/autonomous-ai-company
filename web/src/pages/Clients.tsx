import { q, supabase, type Row } from '../lib/supabase';
import { useData } from '../lib/hooks';
import { date, money } from '../lib/format';
import { Badge, Card, Empty, ErrorBox, PageHead, Table } from '../components/ui';

export function Clients() {
  const { data, error } = useData(async () => {
    const clients = await q<Row[]>(supabase.from('clients').select('*, companies(name, domain, country), projects(id, status, budget_minor, currency)').order('since', { ascending: false }));
    const paid = await q<Row[]>(supabase.from('invoices').select('client_id, payments(amount_minor, currency, status)'));
    return clients.map((c): Row => {
      const pays = paid.filter((i) => i.client_id === c.id).flatMap((i) => i.payments).filter((p: Row) => p.status === 'confirmed');
      return { ...c, revenue: pays.reduce((s: number, p: Row) => s + Number(p.amount_minor), 0), currency: pays[0]?.currency ?? c.projects?.[0]?.currency ?? 'USD' };
    });
  });
  return (
    <div className="stack">
      <PageHead title="Clients" subtitle="Companies that agreed to paid work (created when you create a project from a won lead)." />
      <ErrorBox error={error} />
      <Card><Table rows={data} cols={[
        { key: 'name', label: 'Client', render: (r) => <div><strong>{r.companies?.name}</strong><div className="small muted">{r.companies?.domain ?? ''} {r.companies?.country ?? ''}</div></div> },
        { key: 'status', label: 'Status', render: (r) => <Badge value={r.status} /> },
        { key: 'since', label: 'Since', render: (r) => date(r.since) },
        { key: 'projects', label: 'Projects', num: true, render: (r) => r.projects?.length ?? 0 },
        { key: 'revenue', label: 'Confirmed revenue', num: true, render: (r) => money(r.revenue, r.currency) },
      ]} empty={<Empty title="No clients yet">A client is created when a won lead becomes a project.</Empty>} /></Card>
    </div>
  );
}
