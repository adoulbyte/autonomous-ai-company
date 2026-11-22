import { q, supabase, type Row } from '../lib/supabase';
import { useData } from '../lib/hooks';
import { money, num, pct } from '../lib/format';
import { Badge, Card, ErrorBox, PageHead, Stat, Table } from '../components/ui';

export function Performance() {
  const { data, error } = useData(async () => {
    const [snap, sources, models, agents, decisions] = await Promise.all([
      q<Row[]>(supabase.from('metric_snapshots').select('*').eq('dimension', 'all').order('day', { ascending: false }).limit(400)),
      q<Row[]>(supabase.from('v_source_performance').select('*')),
      q<Row[]>(supabase.from('v_model_performance').select('*')),
      q<Row[]>(supabase.from('v_agent_performance').select('*')),
      q<Row[]>(supabase.from('opportunities').select('decision, score').not('score', 'is', null)),
    ]);
    const latestDay = snap[0]?.day; const m: Record<string, number> = {};
    for (const s of snap.filter((x) => x.day === latestDay)) m[s.metric] = Number(s.value);
    return { m, latestDay, sources, models, agents, decisions };
  }, [], 60000);
  const m = data?.m ?? {};
  return (
    <div className="stack">
      <PageHead title="Performance" subtitle={`Computed from real records by the Business Intelligence job${data?.latestDay ? ` · latest snapshot ${data.latestDay}` : ' · no snapshot yet'}`} />
      <ErrorBox error={error} />
      <div className="grid grid-4">
        <Stat label="Opportunity → selected" value={pct(m.selection_rate)} sub={`${num(m.opportunities_selected)} of ${num(m.opportunities_scored)} scored`} />
        <Stat label="Lead response rate" value={pct(m.response_rate)} sub={`${num(m.leads_responded)} of ${num(m.leads_contacted)} contacted`} />
        <Stat label="Win rate" value={pct(m.win_rate)} sub={`${num(m.leads_won)} won · ${num(m.leads_lost)} lost`} />
        <Stat label="Confirmed revenue" value={money(m.revenue_confirmed_minor)} />
      </div>
      <div className="grid grid-4">
        <Stat label="QA first-pass rate" value={pct(m.qa_first_pass_rate)} sub={`${num(m.revisions)} revisions`} />
        <Stat label="QA rejection rate" value={pct(m.qa_failure_rate)} sub={`${num(m.qa_reviews)} reviews`} />
        <Stat label="Avg. days to delivery" value={m.avg_days_to_delivery ? num(m.avg_days_to_delivery, 1) : '—'} />
        <Stat label="Avg. days to payment" value={m.avg_days_to_payment ? num(m.avg_days_to_payment, 1) : '—'} />
      </div>
      {(m.opportunities_scored ?? 0) < 15 && <div className="alert info">Little outcome data yet. The Executive Strategist will not propose scoring changes until there is enough evidence (≥15 scored opportunities), and any change requires your approval.</div>}
      <Card title="Source performance"><Table rows={data?.sources ?? null} cols={[{ key: 'name', label: 'Source' }, { key: 'health', label: 'Health', render: (r) => <Badge value={r.health} /> },
        { key: 'opportunities', label: 'Found', num: true }, { key: 'shortlisted_or_better', label: 'Selected', num: true }, { key: 'won', label: 'Won', num: true },
        { key: 'rate', label: 'Selection rate', num: true, render: (r) => r.opportunities ? pct(r.shortlisted_or_better / r.opportunities) : '—' }, { key: 'avg_score', label: 'Avg score', num: true }]} /></Card>
      <Card title="Agent performance"><Table rows={data?.agents ?? null} cols={[{ key: 'name', label: 'Agent' }, { key: 'tasks_succeeded', label: 'Succeeded', num: true }, { key: 'tasks_dead', label: 'Failed', num: true },
        { key: 'rate', label: 'Success rate', num: true, render: (r) => r.tasks_succeeded + r.tasks_dead ? pct(r.tasks_succeeded / (r.tasks_succeeded + r.tasks_dead)) : '—' }, { key: 'tokens_30d', label: 'Tokens 30d', num: true, render: (r) => num(r.tokens_30d) }]} /></Card>
      <Card title="Model performance (7 days)"><Table rows={data?.models ?? null} cols={[{ key: 'model', label: 'Model', render: (r) => <div>{r.model}<div className="small muted">{r.provider_key} · {r.tier}</div></div> },
        { key: 'enabled', label: 'State', render: (r) => !r.enabled ? <Badge value="disabled" tone="bad" /> : r.cooldown_until && new Date(r.cooldown_until) > new Date() ? <Badge value="cooling down" tone="warn" /> : <Badge value="available" tone="ok" /> },
        { key: 'calls_7d', label: 'Calls', num: true }, { key: 'ok', label: 'Success', num: true, render: (r) => r.calls_7d ? pct(r.ok_7d / r.calls_7d) : '—' },
        { key: 'avg_latency_ms_7d', label: 'Latency ms', num: true }, { key: 'last_error', label: 'Last error', render: (r) => <span className="small muted truncate">{r.last_error ?? ''}</span> }]} /></Card>
    </div>
  );
}
