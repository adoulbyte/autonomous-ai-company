import { Link } from 'react-router-dom';
import { q, supabase, type Row } from '../lib/supabase';
import { useData } from '../lib/hooks';
import { ago, money, num, pct } from '../lib/format';
import { Badge, Card, Empty, ErrorBox, Loading, PageHead, Stat, Table } from '../components/ui';
import { NextActions } from '../components/NextActions';

async function load() {
  const count = async (table: string, f?: (b: any) => any) => {
    let b = supabase.from(table).select('*', { count: 'exact', head: true });
    if (f) b = f(b);
    const { count, error } = await b; if (error) throw new Error(error.message); return count ?? 0;
  };
  const since = new Date(Date.now() - 86400000).toISOString();
  const [fin, queue, oppTotal, oppEval, oppShort, leads, leadsWon, leadsClosed, clients, activeProjects, delivered, approvals, events, workers, health, aiToday, base] = await Promise.all([
    q(supabase.from('v_finance_by_currency').select('*')),
    q(supabase.from('v_queue_stats').select('*')),
    count('opportunities'),
    count('opportunities', (b) => b.in('status', ['discovered', 'analyzing'])),
    count('opportunities', (b) => b.in('status', ['shortlisted', 'pursuing'])),
    count('leads', (b) => b.not('stage', 'in', '(won,lost,disqualified)')),
    count('leads', (b) => b.eq('stage', 'won')),
    count('leads', (b) => b.in('stage', ['won', 'lost', 'disqualified'])),
    count('clients'),
    count('projects', (b) => b.in('status', ['planning', 'in_progress', 'in_qa', 'revision', 'ready_for_delivery'])),
    count('projects', (b) => b.in('status', ['delivered', 'accepted', 'closed'])),
    q(supabase.from('approvals').select('id,title,requested_by,risk_level,created_at').eq('status', 'pending').order('created_at', { ascending: false }).limit(6)),
    q(supabase.from('events').select('*').in('severity', ['warning', 'error', 'critical']).gte('occurred_at', since).order('occurred_at', { ascending: false }).limit(8)),
    q(supabase.from('worker_heartbeats').select('*').order('last_seen_at', { ascending: false }).limit(1)),
    q(supabase.from('health_checks').select('component,status,at').order('at', { ascending: false }).limit(40)),
    q(supabase.from('ai_calls').select('status,prompt_tokens,completion_tokens').gte('at', new Date(new Date().setHours(0, 0, 0, 0)).toISOString())),
    q(supabase.from('settings').select('value').eq('key', 'finance.base_currency')),
  ]);
  const [mode] = await q<Row[]>(supabase.from('settings').select('value').eq('key', 'business.mode'));
  const reviews = await q<Row[]>(supabase.from('client_feedback').select('rating').not('rating', 'is', null));
  const running = await count('tasks', (b) => b.eq('status', 'running'));
  return { fin: fin as Row[], queue: queue as Row[], oppTotal, oppEval, oppShort, leads, leadsWon, leadsClosed, clients, activeProjects, delivered,
    approvals: approvals as Row[], events: events as Row[], worker: (workers as Row[])[0], health: health as Row[], ai: aiToday as Row[], running,
    base: ((base as Row[])[0]?.value as string) ?? 'USD', pilot: (mode?.value as Row | undefined)?.mode === 'free_pilot', reviews };
}

export function CommandCenter() {
  const { data, error, loading } = useData(load, [], 20000);
  if (loading && !data) return <Loading />;
  if (!data) return <ErrorBox error={error} />;
  const f = data.fin.find((r) => r.currency === data.base) ?? { confirmed_revenue_minor: 0, receivable_minor: 0, expenses_minor: 0, net_profit_minor: 0, unconfirmed_payments_minor: 0 };
  const qs = Object.fromEntries(data.queue.map((r) => [r.status, r.count]));
  const latestHealth = Object.values(Object.fromEntries([...data.health].reverse().map((h) => [h.component, h]))) as Row[];
  const unhealthy = latestHealth.filter((h) => h.status !== 'healthy');
  const tokens = data.ai.reduce((s, r) => s + r.prompt_tokens + r.completion_tokens, 0);
  const workerAge = data.worker ? (Date.now() - new Date(data.worker.last_seen_at).getTime()) / 3600000 : Infinity;
  const otherCurrencies = data.fin.filter((r) => r.currency !== data.base);

  return (
    <div className="stack">
      <PageHead title="Command Center" subtitle={`Live view of the business from database records · ${new Date().toLocaleString()}`}
        actions={data.pilot ? <Badge value="Mode lancement — travail gratuit contre avis" tone="accent" /> : <Badge value="Mode payant" tone="ok" />} />
      <ErrorBox error={error} />
      <NextActions />
      <div className="grid grid-4">
        <Stat label="Confirmed revenue" value={money(f.confirmed_revenue_minor, data.base)} sub="payments with verified evidence" accent />
        <Stat label="Pending receivables" value={money(f.receivable_minor, data.base)} sub={`${money(f.unconfirmed_payments_minor, data.base)} awaiting confirmation`} />
        <Stat label="Expenses" value={money(f.expenses_minor, data.base)} sub="recorded expenses (AI runs on free tiers)" />
        <Stat label="Net profit" value={money(f.net_profit_minor, data.base)} sub="confirmed revenue − expenses" />
      </div>
      {otherCurrencies.length > 0 && <div className="small muted">Other currencies: {otherCurrencies.map((r) => `${money(r.confirmed_revenue_minor, r.currency)} confirmed`).join(' · ')}</div>}
      <div className="grid grid-4" style={{ gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))" }}>
        <Stat label="Opportunities discovered" value={num(data.oppTotal)} sub={`${data.oppEval} under evaluation · ${data.oppShort} selected`} />
        <Stat label="Open leads" value={num(data.leads)} sub={`win rate ${data.leadsClosed ? pct(data.leadsWon / data.leadsClosed) : '—'} (${data.leadsWon}/${data.leadsClosed} closed)`} />
        <Stat label="Active projects" value={num(data.activeProjects)} sub={`${data.delivered} delivered · ${data.clients} clients`} />
        <Stat label="Avis clients" value={data.reviews.length ? `${(data.reviews.reduce((a, r) => a + r.rating, 0) / data.reviews.length).toFixed(1)} / 5` : '—'} sub={`${data.reviews.length} avis reçus`} />
        <Stat label="AI usage today" value={`${num(data.ai.length)} calls`} sub={`${num(tokens)} tokens · ${data.ai.filter((r) => r.status !== 'ok').length} failed/limited`} />
      </div>
      <div className="grid grid-3">
        <Card title="Work queue" actions={<Link className="btn sm" to="/queue">Open</Link>} pad>
          <dl className="kv">
            <dt>Running</dt><dd>{data.running}</dd>
            <dt>Queued</dt><dd>{(qs.pending ?? 0) + (qs.retry_wait ?? 0)} <span className="faint">({qs.retry_wait ?? 0} retrying)</span></dd>
            <dt>Blocked / awaiting approval</dt><dd>{qs.blocked ?? 0} / {qs.awaiting_approval ?? 0}</dd>
            <dt>Failed (dead-letter)</dt><dd>{qs.dead ? <Badge value={`${qs.dead} dead`} tone="bad" /> : 0}</dd>
            <dt>Last worker run</dt><dd>{data.worker ? <>{ago(data.worker.last_seen_at)} · {data.worker.note ?? data.worker.status}</> : <span className="faint">never</span>}</dd>
          </dl>
          {workerAge > 3 && <div className="alert warn mt">No worker activity in {data.worker ? `${Math.floor(workerAge)}h` : 'ever'}. Check the GitHub Actions “Worker” workflow.</div>}
        </Card>
        <Card title="Needs your approval" actions={<Link className="btn sm" to="/approvals">All</Link>}>
          <Table rows={data.approvals} cols={[{ key: 'title', label: 'Request', render: (r) => <span>{r.title}</span> }, { key: 'risk_level', label: 'Risk', render: (r) => <Badge value={r.risk_level} /> }]}
            empty={<Empty title="Nothing waiting">Agents will ask here before anything sensitive happens.</Empty>} />
        </Card>
        <Card title="System health" actions={<Link className="btn sm" to="/health">Details</Link>} pad>
          {latestHealth.length === 0 ? <Empty title="No health checks yet">The worker records checks every 6 hours.</Empty> :
            unhealthy.length === 0 ? <div className="alert ok">All {latestHealth.length} components healthy.</div> :
              <div className="stack">{unhealthy.map((h) => <div key={h.component} className="spread"><span>{h.component}</span><Badge value={h.status} /></div>)}</div>}
        </Card>
      </div>
      <Card title="Alerts (last 24h)" actions={<Link className="btn sm" to="/live">Live feed</Link>}>
        <Table rows={data.events} cols={[
          { key: 'occurred_at', label: 'When', render: (r) => <span className="muted">{ago(r.occurred_at)}</span> },
          { key: 'severity', label: 'Severity', render: (r) => <Badge value={r.severity} /> },
          { key: 'message', label: 'Event', render: (r) => r.message ?? r.event_type },
        ]} empty={<Empty title="No warnings or errors in the last 24 hours" />} />
      </Card>
    </div>
  );
}
