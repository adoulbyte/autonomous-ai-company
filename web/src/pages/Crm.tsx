import { useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { q, rpc, supabase, type Row } from '../lib/supabase';
import { useData } from '../lib/hooks';
import { ago, dt, money, toMinor } from '../lib/format';
import { ActionButton, Badge, Card, Empty, ErrorBox, Loading, Modal, PageHead, Table, Tabs } from '../components/ui';
import { NotesPanel } from '../components/Notes';
import { Conversation } from './Communications';

const STAGES = ['new', 'qualified', 'contacted', 'engaged', 'proposal', 'negotiating', 'won', 'lost'];
const NEXT: Record<string, string[]> = {
  new: ['qualified', 'contacted', 'disqualified'], qualified: ['contacted', 'proposal', 'disqualified', 'lost'], contacted: ['engaged', 'proposal', 'lost'],
  engaged: ['proposal', 'negotiating', 'lost'], proposal: ['negotiating', 'won', 'lost'], negotiating: ['proposal', 'won', 'lost'],
};

export function Crm() {
  const [tab, setTab] = useState('pipeline'); const nav = useNavigate();
  const leads = useData(() => q<Row[]>(supabase.from('leads').select('*, companies(name), contacts(name,email,handle)').order('updated_at', { ascending: false })), [], 30000);
  const companies = useData(() => q<Row[]>(supabase.from('companies').select('*').is('deleted_at', null).order('created_at', { ascending: false })), [tab]);
  const contacts = useData(() => q<Row[]>(supabase.from('contacts').select('*, companies(name)').is('deleted_at', null).order('created_at', { ascending: false })), [tab]);
  const [addCompany, setAddCompany] = useState(false); const [addContact, setAddContact] = useState(false);
  const rows = leads.data ?? [];
  const contacted = rows.filter((l) => ['contacted', 'engaged', 'proposal', 'negotiating', 'won', 'lost'].includes(l.stage)).length;
  const responded = rows.filter((l) => ['engaged', 'proposal', 'negotiating', 'won'].includes(l.stage)).length;
  const won = rows.filter((l) => l.stage === 'won').length; const closed = rows.filter((l) => ['won', 'lost', 'disqualified'].includes(l.stage)).length;
  return (
    <div className="stack">
      <PageHead title="CRM" subtitle={`${rows.length} leads · response rate ${contacted ? Math.round((responded / contacted) * 100) + '%' : '—'} · win rate ${closed ? Math.round((won / closed) * 100) + '%' : '—'}`}
        actions={<><button className="btn" onClick={() => setAddCompany(true)}>Add company</button><button className="btn" onClick={() => setAddContact(true)}>Add contact</button></>} />
      <Tabs tabs={[{ key: 'pipeline', label: 'Pipeline' }, { key: 'leads', label: 'All leads' }, { key: 'companies', label: 'Companies' }, { key: 'contacts', label: 'Contacts' }]} value={tab} onChange={setTab} />
      <ErrorBox error={leads.error} />
      {tab === 'pipeline' && (rows.length === 0 ? <Card><Empty title="No leads yet">Leads are created when you approve pursuing an opportunity.</Empty></Card> :
        <div className="kanban">{STAGES.map((s) => { const col = rows.filter((l) => l.stage === s || (s === 'lost' && l.stage === 'disqualified')); return (
          <div key={s} className="kanban-col"><div className="spread"><h3>{s}</h3><span className="small muted">{col.length}</span></div>
            {col.map((l) => <Link key={l.id} to={`/crm/leads/${l.id}`} className="kanban-card"><div style={{ fontWeight: 550 }} className="truncate">{l.title}</div>
              <div className="small muted">{l.companies?.name ?? '—'} · {money(l.value_minor, l.currency)}</div>
              {l.next_follow_up_at && <div className="small" style={{ color: 'var(--warn)' }}>Follow up {ago(l.next_follow_up_at)}</div>}</Link>)}
          </div>); })}</div>)}
      {tab === 'leads' && <Card><Table rows={leads.data} onRow={(r) => nav(`/crm/leads/${r.id}`)} cols={[
        { key: 'title', label: 'Lead', render: (r) => <span className="truncate">{r.title}</span> }, { key: 'stage', label: 'Stage', render: (r) => <Badge value={r.stage} /> },
        { key: 'company', label: 'Company', render: (r) => r.companies?.name ?? '—' }, { key: 'source', label: 'Source' },
        { key: 'value', label: 'Value', num: true, render: (r) => money(r.value_minor, r.currency) }, { key: 'updated_at', label: 'Updated', render: (r) => ago(r.updated_at) }]} /></Card>}
      {tab === 'companies' && <Card><Table rows={companies.data} cols={[{ key: 'name', label: 'Name' }, { key: 'domain', label: 'Domain' }, { key: 'industry', label: 'Industry' }, { key: 'country', label: 'Country' }, { key: 'created_at', label: 'Added', render: (r) => ago(r.created_at) }]} /></Card>}
      {tab === 'contacts' && <Card><Table rows={contacts.data} cols={[{ key: 'name', label: 'Name' }, { key: 'email', label: 'Email / handle', render: (r) => r.email ?? r.handle ?? '—' },
        { key: 'company', label: 'Company', render: (r) => r.companies?.name ?? '—' }, { key: 'lawful_basis', label: 'Basis', render: (r) => <Badge value={r.lawful_basis} /> },
        { key: 'dnc', label: 'Contact', render: (r) => r.do_not_contact ? <Badge value="do not contact" tone="bad" /> : <ActionButton className="btn sm ghost" confirm="Mark as do-not-contact?" action={() => q(supabase.from('contacts').update({ do_not_contact: true }).eq('id', r.id))} onDone={contacts.reload}>Mark DNC</ActionButton> }]} /></Card>}
      {addCompany && <EntityForm title="Add company" fields={['name', 'domain', 'website', 'industry', 'country']} table="companies" onClose={() => { setAddCompany(false); companies.reload(); }} />}
      {addContact && <EntityForm title="Add contact" fields={['name', 'email', 'role', 'source']} table="contacts" extra={{ lawful_basis: 'inbound' }} onClose={() => { setAddContact(false); contacts.reload(); }} />}
    </div>
  );
}

function EntityForm({ title, fields, table, onClose, extra = {} }: { title: string; fields: string[]; table: string; onClose: () => void; extra?: Row }) {
  const [v, setV] = useState<Row>({});
  return <Modal title={title} onClose={onClose}><div className="stack">
    {fields.map((f) => <label key={f} className="field">{f}<input value={v[f] ?? ''} onChange={(e) => setV({ ...v, [f]: e.target.value })} /></label>)}
    <ActionButton className="btn primary" disabled={!v[fields[0]]} success="Saved" onDone={onClose}
      action={() => q(supabase.from(table).insert({ ...extra, ...Object.fromEntries(Object.entries(v).filter(([, x]) => x)) }))}>Save</ActionButton>
  </div></Modal>;
}

export function LeadDetail() {
  const { id } = useParams(); const nav = useNavigate();
  const [projectOpen, setProjectOpen] = useState(false);
  const { data, error, reload } = useData(async () => {
    const [lead, history, convs, projects] = await Promise.all([
      q<Row[]>(supabase.from('leads').select('*, companies(*), contacts(*), opportunities(id,title,url,score)').eq('id', id!)),
      q<Row[]>(supabase.from('lead_stage_history').select('*').eq('lead_id', id!).order('at')),
      q<Row[]>(supabase.from('conversations').select('id,subject,channel,status,created_at').eq('lead_id', id!).order('created_at')),
      q<Row[]>(supabase.from('projects').select('id,name,status').eq('lead_id', id!)),
    ]);
    return { lead: lead[0], history, convs, projects };
  }, [id]);
  if (!data) return error ? <ErrorBox error={error} /> : <Loading />;
  const l = data.lead; if (!l) return <Empty title="Lead not found" />;
  return (
    <div className="stack">
      <PageHead title={l.title} subtitle={<>{l.companies?.name ?? 'No company'} · source {l.source} · {money(l.value_minor, l.currency)}</>}
        actions={<><Badge value={l.stage} />
          {(NEXT[l.stage] ?? []).map((s) => <ActionButton key={s} className={`btn sm ${s === 'won' ? 'accent' : s === 'lost' || s === 'disqualified' ? 'danger' : ''}`}
            confirm={s === 'won' ? 'Mark as won? Only do this when the client has agreed to the work.' : undefined}
            action={async () => { const reason = ['lost', 'disqualified'].includes(s) ? window.prompt('Reason?') ?? undefined : undefined; await rpc('owner_transition', { p_entity: 'lead', p_id: l.id, p_to: s, p_reason: reason ?? null }); }}
            onDone={reload}>→ {s}</ActionButton>)}
          {l.stage === 'won' && !data.projects.length && <button className="btn primary" onClick={() => setProjectOpen(true)}>Create project</button>}
          <button className="btn ghost" onClick={() => nav(-1)}>Back</button></>} />
      <div className="grid grid-2">
        <Card title="Details" pad><dl className="kv">
          <dt>Opportunity</dt><dd>{l.opportunities ? <Link className="link" to={`/opportunities/${l.opportunities.id}`}>{l.opportunities.title}</Link> : '—'}</dd>
          <dt>Contact</dt><dd>{l.contacts ? `${l.contacts.name ?? ''} ${l.contacts.email ?? l.contacts.handle ?? ''}` : '—'} {l.contacts?.do_not_contact && <Badge value="do not contact" tone="bad" />}</dd>
          <dt>Lawful basis</dt><dd>{l.contacts?.lawful_basis ?? '—'}</dd>
          <dt>Score</dt><dd>{l.score ?? '—'}</dd>
          <dt>Next follow-up</dt><dd>{dt(l.next_follow_up_at)}</dd>
          <dt>Outcome</dt><dd>{l.outcome ?? '—'} {l.lost_reason && <span className="muted">({l.lost_reason})</span>}</dd>
          <dt>Projects</dt><dd>{data.projects.map((p) => <Link key={p.id} className="link" to={`/projects/${p.id}`}>{p.name} </Link>)}{!data.projects.length && '—'}</dd>
        </dl></Card>
        <Card title="Stage history"><Table rows={data.history} cols={[{ key: 'at', label: 'When', render: (r) => dt(r.at) }, { key: 'from_stage', label: 'From', render: (r) => <Badge value={r.from_stage} /> }, { key: 'to_stage', label: 'To', render: (r) => <Badge value={r.to_stage} /> }, { key: 'actor', label: 'By', render: (r) => r.actor.split(':')[0] }]} /></Card>
      </div>
      {data.convs.map((c) => <Conversation key={c.id} conversationId={c.id} title={c.subject} leadId={l.id} />)}
      {!data.convs.length && <Card pad><Empty title="No conversation yet">The Sales Agent drafts the first message after pursuit is approved.</Empty></Card>}
      <NotesPanel entityType="lead" entityId={l.id} />
      {projectOpen && <CreateProject lead={l} onClose={() => { setProjectOpen(false); reload(); }} />}
    </div>
  );
}

function CreateProject({ lead, onClose }: { lead: Row; onClose: () => void }) {
  const [name, setName] = useState(lead.title.slice(0, 80)); const [scope, setScope] = useState(''); const [amount, setAmount] = useState(lead.value_minor ? String(Number(lead.value_minor) / 100) : '');
  const [currency, setCurrency] = useState(lead.currency ?? 'USD'); const [deadline, setDeadline] = useState('');
  return <Modal title="Create project (commits the business to this work)" onClose={onClose}><div className="stack">
    <label className="field">Project name<input value={name} onChange={(e) => setName(e.target.value)} /></label>
    <label className="field">Agreed scope (exactly what the client agreed to — the Project Architect turns it into acceptance criteria)<textarea style={{ minHeight: 160 }} value={scope} onChange={(e) => setScope(e.target.value)} /></label>
    <div className="form-grid"><label className="field">Agreed price<input value={amount} onChange={(e) => setAmount(e.target.value)} /></label>
      <label className="field">Currency<input value={currency} onChange={(e) => setCurrency(e.target.value.toUpperCase())} /></label></div>
    <label className="field">Deadline (optional)<input type="date" value={deadline} onChange={(e) => setDeadline(e.target.value)} /></label>
    <ActionButton className="btn primary" disabled={!name || scope.length < 30} success="Project created; planning queued" onDone={onClose}
      action={() => rpc('owner_create_project', { p_lead_id: lead.id, p_name: name, p_scope: scope, p_budget_minor: amount ? toMinor(amount) : null, p_currency: currency, p_deadline_at: deadline ? new Date(deadline).toISOString() : null })}>Create project</ActionButton>
  </div></Modal>;
}
