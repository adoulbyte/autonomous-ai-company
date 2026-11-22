import { q, rpc, supabase, type Row } from '../lib/supabase';
import { useData } from '../lib/hooks';
import { ago, dt, num } from '../lib/format';
import { ActionButton, Badge, Card, Empty, ErrorBox, PageHead, Stat, Table } from '../components/ui';

export function Health() {
  const { data, error, reload } = useData(async () => {
    const [checks, workers, tasks, sizes, aiToday] = await Promise.all([
      q<Row[]>(supabase.from('health_checks').select('*').order('at', { ascending: false }).limit(200)),
      q<Row[]>(supabase.from('worker_heartbeats').select('*').order('last_seen_at', { ascending: false }).limit(20)),
      q<Row[]>(supabase.from('v_queue_stats').select('*')),
      Promise.all(['events', 'audit_log', 'ai_calls', 'evidence', 'opportunities', 'tasks'].map(async (t) => ({ t, n: (await supabase.from(t).select('*', { count: 'exact', head: true })).count ?? 0 }))),
      q<Row[]>(supabase.from('ai_calls').select('status').gte('at', new Date(new Date().setHours(0, 0, 0, 0)).toISOString())),
    ]);
    const latest = Object.values(Object.fromEntries([...checks].reverse().map((c) => [c.component, c]))) as Row[];
    return { checks, latest, workers, tasks, sizes, aiToday };
  }, [], 30000);
  const lastWorker = data?.workers[0];
  const dbStart = performance.now();
  return (
    <div className="stack">
      <PageHead title="System Health" subtitle="Components checked by the worker every 6 hours, plus live database and worker status."
        actions={<ActionButton className="btn" success="Health check queued" action={() => rpc('owner_enqueue', { p_type: 'system.health_check', p_input: {}, p_title: 'Health check (owner)' })} onDone={reload}>Run health check</ActionButton>} />
      <ErrorBox error={error} />
      <div className="grid grid-4">
        <Stat label="Database (from this browser)" value={error ? 'unreachable' : 'reachable'} sub={data ? `query ok · ${Math.round(performance.now() - dbStart)}ms render` : ''} />
        <Stat label="Last worker run" value={lastWorker ? ago(lastWorker.last_seen_at) : 'never'} sub={lastWorker?.note ?? 'scheduled via GitHub Actions'} />
        <Stat label="Dead-letter tasks" value={data?.tasks.find((t) => t.status === 'dead')?.count ?? 0} />
        <Stat label="AI calls today" value={data?.aiToday.length ?? '—'} sub={`${data?.aiToday.filter((c) => c.status !== 'ok').length ?? 0} rate-limited/failed`} />
      </div>
      <Card title="Components (latest check)"><Table rows={data?.latest ?? null} cols={[{ key: 'component', label: 'Component' }, { key: 'status', label: 'Status', render: (r) => <Badge value={r.status} /> },
        { key: 'detail', label: 'Detail', render: (r) => <span className="small">{r.detail}</span> }, { key: 'at', label: 'Checked', render: (r) => ago(r.at) }]} empty={<Empty title="No health checks recorded yet" />} /></Card>
      <Card title="Storage usage (row counts — Supabase free tier: 500 MB database)"><Table rows={data?.sizes ?? null} cols={[{ key: 't', label: 'Table' }, { key: 'n', label: 'Rows', num: true, render: (r) => num(r.n) }]} /></Card>
      <Card title="Recent worker runs"><Table rows={data?.workers ?? null} cols={[{ key: 'worker_id', label: 'Run' }, { key: 'status', label: 'Status', render: (r) => <Badge value={r.status} /> }, { key: 'started_at', label: 'Started', render: (r) => dt(r.started_at) },
        { key: 'tasks', label: 'OK / failed', render: (r) => `${r.tasks_succeeded} / ${r.tasks_failed}` }, { key: 'run_url', label: 'Log', render: (r) => r.run_url ? <a className="link" href={r.run_url} target="_blank" rel="noreferrer">GitHub</a> : '—' }]} /></Card>
    </div>
  );
}
