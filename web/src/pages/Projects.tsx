import { useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { q, rpc, supabase, type Row } from '../lib/supabase';
import { useData } from '../lib/hooks';
import { ago, date, dt, money } from '../lib/format';
import { ActionButton, Badge, Card, Empty, ErrorBox, Loading, PageHead, Table } from '../components/ui';
import { NotesPanel } from '../components/Notes';
import { DeliverableView } from './Production';

const OWNER_MOVES: Record<string, string[]> = {
  planning: ['on_hold', 'cancelled'], in_progress: ['on_hold', 'cancelled'], in_qa: ['on_hold'], ready_for_delivery: ['delivered'],
  delivered: ['accepted', 'revision'], revision: ['in_progress'], accepted: ['closed'], on_hold: ['in_progress', 'planning', 'cancelled'],
};

export function Projects() {
  const nav = useNavigate();
  const { data, error } = useData(() => q<Row[]>(supabase.from('projects').select('*, clients(companies(name)), deliverables(id,status,version), milestones(id)').order('created_at', { ascending: false })), [], 30000);
  return (
    <div className="stack">
      <PageHead title="Projects" subtitle="Accepted work, planned into requirements with acceptance criteria and executed by agents with independent QA." />
      <ErrorBox error={error} />
      <Card><Table rows={data} onRow={(r) => nav(`/projects/${r.id}`)} cols={[
        { key: 'name', label: 'Project', render: (r) => <div><strong>{r.name}</strong><div className="small muted">{r.clients?.companies?.name ?? '—'}</div></div> },
        { key: 'status', label: 'Status', render: (r) => <Badge value={r.status} /> },
        { key: 'progress', label: 'Deliverables approved', render: (r) => { const items = r.plan?.work_items?.length ?? 0; const ok = new Set((r.deliverables as Row[]).filter((d) => ['approved', 'ready_for_delivery', 'delivered', 'accepted'].includes(d.status)).map((d) => d.id)).size; return items ? `${Math.min(ok, items)} / ${items}` : '—'; } },
        { key: 'budget', label: 'Price', num: true, render: (r) => money(r.budget_minor, r.currency) },
        { key: 'deadline_at', label: 'Deadline', render: (r) => date(r.deadline_at) },
        { key: 'updated_at', label: 'Updated', render: (r) => ago(r.updated_at) }]}
        empty={<Empty title="No projects yet">Create a project from a won lead in the CRM.</Empty>} /></Card>
    </div>
  );
}

export function ProjectDetail() {
  const { id } = useParams(); const nav = useNavigate(); const [openDel, setOpenDel] = useState<string | null>(null);
  const { data, error, reload } = useData(async () => {
    const [p, reqs, dels, tasks, prof, invoices] = await Promise.all([
      q<Row[]>(supabase.from('projects').select('*, clients(companies(name))').eq('id', id!)),
      q<Row[]>(supabase.from('requirements').select('*').eq('project_id', id!).order('position')),
      q<Row[]>(supabase.from('deliverables').select('id,work_item,version,title,status,format,produced_by_model,created_at, qa_reviews(verdict, created_at)').eq('project_id', id!).order('work_item').order('version')),
      q<Row[]>(supabase.from('tasks').select('id,type,status,title,attempts,updated_at,error').eq('entity_id', id!).order('created_at')),
      q<Row[]>(supabase.from('v_project_profitability').select('*').eq('project_id', id!)),
      q<Row[]>(supabase.from('invoices').select('id,number,status,amount_minor,currency').eq('project_id', id!)),
    ]);
    return { p: p[0], reqs, dels, tasks, prof: prof[0], invoices };
  }, [id], 20000);
  if (!data) return error ? <ErrorBox error={error} /> : <Loading />;
  const p = data.p; if (!p) return <Empty title="Project not found" />;
  return (
    <div className="stack">
      <PageHead title={p.name} subtitle={<>{p.clients?.companies?.name ?? 'No client'} · {money(p.budget_minor, p.currency)} · deadline {date(p.deadline_at)}</>}
        actions={<><Badge value={p.status} />
          {(OWNER_MOVES[p.status] ?? []).map((s) => <ActionButton key={s} className={`btn sm ${s === 'cancelled' ? 'danger' : ''}`} confirm={`Move project to “${s}”?`}
            action={() => rpc('owner_transition', { p_entity: 'project', p_id: p.id, p_to: s, p_reason: null })} onDone={reload}>→ {s.replace(/_/g, ' ')}</ActionButton>)}
          <Link className="btn sm" to="/finance">Invoice</Link><button className="btn ghost" onClick={() => nav(-1)}>Back</button></>} />
      <div className="grid grid-3">
        <Card title="Scope" pad><pre style={{ fontFamily: 'var(--font)' }}>{p.scope}</pre>{p.out_of_scope && <><h3 className="mt">Out of scope</h3><pre className="mt" style={{ fontFamily: 'var(--font)' }}>{p.out_of_scope}</pre></>}</Card>
        <Card title="Economics" pad><dl className="kv">
          <dt>Price</dt><dd>{money(p.budget_minor, p.currency)}</dd>
          <dt>Confirmed revenue</dt><dd>{money(data.prof?.revenue_minor, p.currency)}</dd>
          <dt>Expenses</dt><dd>{money(data.prof?.expenses_minor, p.currency)}</dd>
          <dt>AI calls used</dt><dd>{data.prof?.ai_calls ?? 0} / budget {p.ai_call_budget}</dd>
          <dt>Invoices</dt><dd>{data.invoices.map((i) => <div key={i.id}>{i.number} · {money(i.amount_minor, i.currency)} <Badge value={i.status} /></div>)}{!data.invoices.length && '—'}</dd>
        </dl></Card>
        <Card title="Plan" pad>{p.plan ? <><p style={{ marginTop: 0 }}>{p.summary}</p><div className="small muted">{p.plan.work_items.length} work items · planned by {p.plan.model}</div></> : <Empty title="Not planned yet">The Project Architect plans on the next worker run.</Empty>}</Card>
      </div>
      <Card title="Requirements & acceptance criteria"><Table rows={data.reqs} cols={[
        { key: 'position', label: '#', render: (r) => r.position + 1 }, { key: 'description', label: 'Requirement' },
        { key: 'acceptance_criteria', label: 'Acceptance criteria', render: (r) => <ul style={{ margin: 0, paddingLeft: 18 }}>{(r.acceptance_criteria as string[]).map((c, i) => <li key={i}>{c}</li>)}</ul> },
        { key: 'status', label: 'Status', render: (r) => <Badge value={r.status} /> }]} /></Card>
      <Card title="Deliverables (all versions)"><Table rows={data.dels} onRow={(r) => setOpenDel(r.id)} cols={[
        { key: 'title', label: 'Deliverable', render: (r) => <div><strong>{r.title}</strong><div className="small muted">{r.work_item} · {r.format}</div></div> },
        { key: 'version', label: 'Ver.', num: true }, { key: 'status', label: 'Status', render: (r) => <Badge value={r.status} /> },
        { key: 'qa', label: 'QA', render: (r) => (r.qa_reviews as Row[]).map((q, i) => <Badge key={i} value={q.verdict} />) },
        { key: 'model', label: 'Produced by', render: (r) => <span className="small muted">{r.produced_by_model}</span> }, { key: 'created_at', label: 'When', render: (r) => ago(r.created_at) }]} /></Card>
      {openDel && <DeliverableView id={openDel} onClose={() => setOpenDel(null)} />}
      <Card title="Execution tasks"><Table rows={data.tasks} cols={[{ key: 'title', label: 'Task', render: (r) => r.title ?? r.type }, { key: 'status', label: 'Status', render: (r) => <Badge value={r.status} /> },
        { key: 'attempts', label: 'Attempts', num: true }, { key: 'error', label: 'Last error', render: (r) => <span className="small muted truncate">{r.error ?? ''}</span> }, { key: 'updated_at', label: 'Updated', render: (r) => dt(r.updated_at) }]} /></Card>
      <NotesPanel entityType="project" entityId={p.id} />
    </div>
  );
}
