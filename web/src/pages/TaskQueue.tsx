import { useState } from 'react';
import { q, rpc, supabase, type Row } from '../lib/supabase';
import { useData } from '../lib/hooks';
import { ago, dt } from '../lib/format';
import { ActionButton, Badge, Card, Empty, ErrorBox, Json, Modal, PageHead, Stat, Table, Tabs } from '../components/ui';

const VIEWS: Record<string, string[]> = { active: ['pending', 'running', 'retry_wait', 'blocked', 'awaiting_approval'], dead: ['dead'], done: ['succeeded'], cancelled: ['cancelled'] };

export function TaskQueue() {
  const [tab, setTab] = useState('active'); const [open, setOpen] = useState<Row | null>(null);
  const stats = useData(() => q<Row[]>(supabase.from('v_queue_stats').select('*')), [], 15000);
  const { data, error, reload } = useData(() => q<Row[]>(supabase.from('tasks').select('*').in('status', VIEWS[tab]).order('updated_at', { ascending: false }).limit(200)), [tab], 15000);
  const s = Object.fromEntries((stats.data ?? []).map((r) => [r.status, r.count]));
  const runs = useData<Row[]>(async () => (open ? q<Row[]>(supabase.from('task_runs').select('*').eq('task_id', open.id).order('attempt')) : []), [open?.id]);
  const calls = useData<Row[]>(async () => (open ? q<Row[]>(supabase.from('ai_calls').select('*').eq('task_id', open.id).order('id')) : []), [open?.id]);
  const workers = useData(() => q<Row[]>(supabase.from('worker_heartbeats').select('*').order('last_seen_at', { ascending: false }).limit(10)), [], 30000);
  return (
    <div className="stack">
      <PageHead title="Task Queue" subtitle="Durable Postgres queue: leases, retries with backoff, dependencies, approval gates and a dead-letter queue." />
      <div className="grid grid-4">
        <Stat label="Queued" value={(s.pending ?? 0) + (s.retry_wait ?? 0)} sub={`${s.retry_wait ?? 0} waiting to retry`} />
        <Stat label="Running" value={s.running ?? 0} />
        <Stat label="Blocked / approval" value={`${s.blocked ?? 0} / ${s.awaiting_approval ?? 0}`} />
        <Stat label="Dead-letter" value={s.dead ?? 0} sub="needs your attention" />
      </div>
      <Tabs tabs={[{ key: 'active', label: 'Active' }, { key: 'dead', label: `Dead-letter (${s.dead ?? 0})` }, { key: 'done', label: 'Succeeded' }, { key: 'cancelled', label: 'Cancelled' }]} value={tab} onChange={setTab} />
      <ErrorBox error={error} />
      <Card><Table rows={data} onRow={setOpen} cols={[
        { key: 'title', label: 'Task', render: (r) => <div><div className="truncate">{r.title ?? r.type}</div><div className="small muted">{r.type} · {r.role_key ?? 'system'}</div></div> },
        { key: 'status', label: 'Status', render: (r) => <Badge value={r.status} /> }, { key: 'priority', label: 'Prio', num: true },
        { key: 'attempts', label: 'Attempts', num: true, render: (r) => `${r.attempts}/${r.max_attempts}${r.deferrals ? ` (+${r.deferrals} deferred)` : ''}` },
        { key: 'run_after', label: 'Runs', render: (r) => r.status === 'retry_wait' || r.status === 'pending' ? ago(r.run_after) : '—' },
        { key: 'error', label: 'Last error', render: (r) => <span className="small muted truncate" style={{ maxWidth: 280, display: 'inline-block' }}>{r.error ?? ''}</span> },
        { key: 'updated_at', label: 'Updated', render: (r) => ago(r.updated_at) }]} empty={<Empty title="Queue is empty in this view" />} /></Card>
      <Card title="Worker runs (GitHub Actions)"><Table rows={workers.data} cols={[{ key: 'worker_id', label: 'Worker' }, { key: 'status', label: 'Status', render: (r) => <Badge value={r.status} /> },
        { key: 'started_at', label: 'Started', render: (r) => dt(r.started_at) }, { key: 'note', label: 'Result' }, { key: 'run_url', label: 'Log', render: (r) => r.run_url ? <a className="link" href={r.run_url} target="_blank" rel="noreferrer">open</a> : '—' }]}
        empty={<Empty title="No worker has run yet" />} /></Card>
      {open && <Modal title={open.title ?? open.type} onClose={() => setOpen(null)}><div className="stack">
        <div className="row"><Badge value={open.status} /><span className="small muted">{open.id}</span>
          {['pending', 'blocked', 'retry_wait', 'awaiting_approval', 'running'].includes(open.status) && <ActionButton className="btn sm danger" confirm="Cancel this task?" action={() => rpc('owner_task_action', { p_task_id: open.id, p_action: 'cancel' })} onDone={() => { setOpen(null); reload(); }}>Cancel</ActionButton>}
          {['dead', 'cancelled'].includes(open.status) && <ActionButton className="btn sm primary" action={() => rpc('owner_task_action', { p_task_id: open.id, p_action: 'retry' })} onDone={() => { setOpen(null); reload(); }}>Retry</ActionButton>}</div>
        {open.error && <div className="alert bad small">{open.error}</div>}
        <dl className="kv"><dt>Idempotency key</dt><dd className="mono">{open.idempotency_key}</dd><dt>Lease</dt><dd>{open.lease_owner ?? '—'} {open.lease_expires_at && `until ${dt(open.lease_expires_at)}`}</dd>
          <dt>Created</dt><dd>{dt(open.created_at)} by {open.created_by}</dd><dt>Timeout</dt><dd>{open.timeout_seconds}s</dd></dl>
        <h3>Attempts</h3><Table rows={runs.data} cols={[{ key: 'attempt', label: '#' }, { key: 'worker_id', label: 'Worker' }, { key: 'status', label: 'Result', render: (r) => <Badge value={r.status} /> }, { key: 'duration_ms', label: 'ms', num: true }, { key: 'error', label: 'Error', render: (r) => <span className="small">{r.error}</span> }]} />
        <h3>AI calls</h3><Table rows={calls.data} cols={[{ key: 'model', label: 'Model' }, { key: 'status', label: 'Status', render: (r) => <Badge value={r.status} /> }, { key: 'tokens', label: 'Tokens', num: true, render: (r) => r.prompt_tokens + r.completion_tokens }, { key: 'latency_ms', label: 'ms', num: true }]} empty={<div className="small muted">No AI calls</div>} />
        <h3>Input</h3><Json value={open.input} />{open.output && <><h3>Output</h3><Json value={open.output} /></>}
      </div></Modal>}
    </div>
  );
}
