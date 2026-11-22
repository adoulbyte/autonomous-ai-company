import { useState } from 'react';
import { q, supabase, type Row } from '../lib/supabase';
import { useData } from '../lib/hooks';
import { ago, num } from '../lib/format';
import { ActionButton, Badge, Card, ErrorBox, Modal, PageHead, Table } from '../components/ui';

export function Workforce() {
  const [open, setOpen] = useState<Row | null>(null);
  const { data, error, reload } = useData(async () => {
    const [perf, roles] = await Promise.all([q<Row[]>(supabase.from('v_agent_performance').select('*')), q<Row[]>(supabase.from('agent_roles').select('*'))]);
    return perf.map((p): Row => ({ ...p, role: roles.find((r) => r.key === p.role_key) })).sort((a, b) => a.department.localeCompare(b.department));
  }, [], 15000);
  return (
    <div className="stack">
      <PageHead title="AI Workforce" subtitle="Every role is a real worker bound to task types, tools, permissions and budgets. Deterministic roles use no AI." />
      <ErrorBox error={error} />
      <Card><Table rows={data} onRow={setOpen} cols={[
        { key: 'name', label: 'Agent', render: (r) => <div><strong>{r.name}</strong><div className="small muted">{r.department} · reports to {r.role?.supervisor}</div></div> },
        { key: 'status', label: 'Status', render: (r) => !r.enabled ? <Badge value="disabled" tone="" /> : r.tasks_running ? <Badge value="working" tone="info" /> : r.tasks_queued ? <Badge value="queued work" tone="warn" /> : <Badge value="idle" tone="" /> },
        { key: 'current_task', label: 'Current task', render: (r) => <span className="small truncate">{r.current_task ?? '—'}</span> },
        { key: 'model_tier', label: 'Model tier', render: (r) => r.role?.is_ai ? r.model_tier : 'deterministic' },
        { key: 'tasks_succeeded', label: 'Done', num: true }, { key: 'tasks_dead', label: 'Failed', num: true, render: (r) => r.tasks_dead ? <Badge value={String(r.tasks_dead)} tone="bad" /> : 0 },
        { key: 'ai_calls_24h', label: 'AI calls 24h', num: true, render: (r) => `${r.ai_calls_24h} / ${r.role?.daily_call_budget ?? 0}` },
        { key: 'tokens_30d', label: 'Tokens 30d', num: true, render: (r) => num(r.tokens_30d) },
        { key: 'last_activity_at', label: 'Last activity', render: (r) => ago(r.last_activity_at) }]} /></Card>
      {open && <Modal title={open.name} onClose={() => setOpen(null)}><div className="stack">
        <p style={{ margin: 0 }}>{open.role.objective}</p>
        <dl className="kv">
          <dt>Task types</dt><dd>{open.role.task_types.join(', ') || '—'}</dd>
          <dt>Tools</dt><dd>{open.role.allowed_tools.join(', ')}</dd>
          <dt>Permissions</dt><dd>{open.role.permissions.join(', ') || '—'}</dd>
          <dt>Input schema</dt><dd><code>{JSON.stringify(open.role.input_schema)}</code></dd>
          <dt>Output schema</dt><dd><code>{JSON.stringify(open.role.output_schema)}</code></dd>
          <dt>Quality rules</dt><dd>{open.role.quality_rules.join(' · ') || '—'}</dd>
          <dt>Budget</dt><dd>{open.role.daily_call_budget} AI calls/day · {open.role.max_output_tokens} max output tokens</dd>
          <dt>Retry / timeout</dt><dd>{open.role.retry_max} attempts · {open.role.timeout_seconds}s</dd>
          <dt>Supervisor</dt><dd>{open.role.supervisor}</dd>
        </dl>
        <div className="row">
          <ActionButton className={`btn ${open.enabled ? 'danger' : 'primary'}`} success="Updated" onDone={() => { setOpen(null); reload(); }}
            action={() => q(supabase.from('agent_roles').update({ enabled: !open.enabled }).eq('key', open.role_key))}>{open.enabled ? 'Disable agent' : 'Enable agent'}</ActionButton>
          {open.role.is_ai && ['fast', 'standard', 'strong'].map((t) => <ActionButton key={t} className="btn sm" disabled={open.model_tier === t} onDone={() => { setOpen(null); reload(); }}
            action={() => q(supabase.from('agent_roles').update({ model_tier: t }).eq('key', open.role_key))}>Tier: {t}</ActionButton>)}
        </div>
        <p className="small muted" style={{ margin: 0 }}>Model tier is recorded configuration; agents with quality-critical work (planning, QA) request their tier in code and never silently downgrade.</p>
      </div></Modal>}
    </div>
  );
}
