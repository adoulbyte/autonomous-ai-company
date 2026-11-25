import { useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { q, rpc, supabase, type Row } from '../lib/supabase';
import { useData } from '../lib/hooks';
import { ago, dt, money, toMinor } from '../lib/format';
import { ActionButton, Badge, Card, Empty, ErrorBox, Loading, Modal, PageHead, Table, Tabs } from '../components/ui';
import { NotesPanel } from '../components/Notes';
import { Conversation } from './Communications';

const STAGES = ['new', 'qualified', 'contacted', 'engaged', 'proposal', 'negotiating', 'won', 'lost'];
export const STAGE_FR: Record<string, string> = { new: 'Nouveau', qualified: 'À contacter', contacted: 'Contacté', engaged: 'A répondu', proposal: 'Maquette envoyée',
  negotiating: 'En discussion', won: 'Gagné', lost: 'Perdu', disqualified: 'Écarté' };
const STAGE_HINT: Record<string, string> = { qualified: 'Premier e-mail en préparation', contacted: 'Premier e-mail envoyé, relances automatiques', engaged: 'Le prospect a répondu',
  proposal: 'Maquette + offre envoyées, rappels automatiques', negotiating: 'Questions / accord en cours', won: 'Réalisation demandée', lost: 'Pas intéressé, désinscrit ou adresse invalide' };
const StageBadge = ({ s }: { s: string }) => <Badge value={STAGE_FR[s] ?? s} tone={s === 'won' ? 'ok' : s === 'lost' || s === 'disqualified' ? 'bad' : s === 'proposal' || s === 'negotiating' || s === 'engaged' ? 'accent' : ''} />;
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
      <PageHead title="Prospects" subtitle={`${rows.length} prospects · taux de réponse ${contacted ? Math.round((responded / contacted) * 100) + ' %' : '—'} · taux de conversion ${closed ? Math.round((won / closed) * 100) + ' %' : '—'}`}
        actions={<><button className="btn" onClick={() => setAddCompany(true)}>Ajouter une entreprise</button><button className="btn" onClick={() => setAddContact(true)}>Ajouter un contact</button></>} />
      <Tabs tabs={[{ key: 'pipeline', label: 'Pipeline' }, { key: 'leads', label: 'Tous les prospects' }, { key: 'companies', label: 'Entreprises' }, { key: 'contacts', label: 'Contacts' }]} value={tab} onChange={setTab} />
      <ErrorBox error={leads.error} />
      {tab === 'pipeline' && (rows.length === 0 ? <Card><Empty title="Aucun prospect pour l’instant">Les agents ajoutent les entreprises trouvées à chaque cycle.</Empty></Card> :
        <div className="kanban">{STAGES.map((s) => { const col = rows.filter((l) => l.stage === s || (s === 'lost' && l.stage === 'disqualified')); if (!col.length && (s === 'new' || s === 'qualified')) return null; return (
          <div key={s} className="kanban-col"><div className="spread"><h3>{STAGE_FR[s]}</h3><span className="badge">{col.length}</span></div>
            {STAGE_HINT[s] && <div className="small muted">{STAGE_HINT[s]}</div>}
            {col.slice(0, 60).map((l) => <Link key={l.id} to={`/crm/leads/${l.id}`} className="kanban-card"><div style={{ fontWeight: 550 }} className="wrap2">{l.title}</div>
              <div className="small muted">{l.contacts?.email ?? l.companies?.name ?? '—'}{l.value_minor ? ` · ${money(l.value_minor, l.currency)}` : ''}</div>
              {l.next_follow_up_at && ['contacted', 'proposal'].includes(l.stage) && <div className="small" style={{ color: 'var(--warn)' }}>Relance {ago(l.next_follow_up_at)}</div>}</Link>)}
            {col.length > 60 && <div className="small muted mt">+ {col.length - 60} autres (onglet « Tous les prospects »)</div>}
          </div>); })}</div>)}
      {tab === 'leads' && <Card><Table rows={leads.data} onRow={(r) => nav(`/crm/leads/${r.id}`)} cols={[
        { key: 'title', label: 'Prospect', render: (r) => <span className="wrap2">{r.title}</span> }, { key: 'stage', label: 'Étape', render: (r) => <StageBadge s={r.stage} /> },
        { key: 'email', label: 'E-mail', render: (r) => <span className="small">{r.contacts?.email ?? '—'}</span> },
        { key: 'value', label: 'Valeur', num: true, render: (r) => r.value_minor ? money(r.value_minor, r.currency) : '—' },
        { key: 'next', label: 'Prochaine relance', render: (r) => r.next_follow_up_at && ['contacted', 'proposal'].includes(r.stage) ? <span className="small">{ago(r.next_follow_up_at)}</span> : '—' },
        { key: 'updated_at', label: 'Mis à jour', render: (r) => <span className="small muted">{ago(r.updated_at)}</span> }]} /></Card>}
      {tab === 'companies' && <Card><Table rows={companies.data} cols={[{ key: 'name', label: 'Nom' }, { key: 'domain', label: 'Domaine' }, { key: 'industry', label: 'Activité' }, { key: 'country', label: 'Pays' }, { key: 'created_at', label: 'Ajoutée', render: (r) => ago(r.created_at) }]} /></Card>}
      {tab === 'contacts' && <Card><Table rows={contacts.data} cols={[{ key: 'name', label: 'Nom' }, { key: 'email', label: 'E-mail', render: (r) => r.email ?? r.handle ?? '—' },
        { key: 'company', label: 'Entreprise', render: (r) => r.companies?.name ?? '—' },
        { key: 'dnc', label: 'Statut', render: (r) => r.do_not_contact ? <Badge value="ne plus contacter" tone="bad" /> : <ActionButton className="btn sm ghost" confirm="Ne plus jamais contacter cette adresse ?" action={() => q(supabase.from('contacts').update({ do_not_contact: true }).eq('id', r.id))} onDone={contacts.reload}>Ne plus contacter</ActionButton> }]} /></Card>}
      {addCompany && <EntityForm title="Ajouter une entreprise" fields={['name', 'domain', 'website', 'industry', 'country']} table="companies" onClose={() => { setAddCompany(false); companies.reload(); }} />}
      {addContact && <EntityForm title="Ajouter un contact" fields={['name', 'email', 'role', 'source']} table="contacts" extra={{ lawful_basis: 'inbound' }} onClose={() => { setAddContact(false); contacts.reload(); }} />}
    </div>
  );
}

function EntityForm({ title, fields, table, onClose, extra = {} }: { title: string; fields: string[]; table: string; onClose: () => void; extra?: Row }) {
  const [v, setV] = useState<Row>({});
  return <Modal title={title} onClose={onClose}><div className="stack">
    {fields.map((f) => <label key={f} className="field">{f}<input value={v[f] ?? ''} onChange={(e) => setV({ ...v, [f]: e.target.value })} /></label>)}
    <ActionButton className="btn primary" disabled={!v[fields[0]]} success="Enregistré" onDone={onClose}
      action={() => q(supabase.from(table).insert({ ...extra, ...Object.fromEntries(Object.entries(v).filter(([, x]) => x)) }))}>Enregistrer</ActionButton>
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
  const l = data.lead; if (!l) return <Empty title="Prospect introuvable" />;
  return (
    <div className="stack">
      <PageHead title={l.title} subtitle={<>{l.contacts?.email ?? l.companies?.name ?? '—'}{l.value_minor ? ` · ${money(l.value_minor, l.currency)}` : ''}</>}
        actions={<><StageBadge s={l.stage} />
          {(NEXT[l.stage] ?? []).map((s) => <ActionButton key={s} className={`btn sm ${s === 'won' ? 'accent' : s === 'lost' || s === 'disqualified' ? 'danger' : ''}`}
            confirm={s === 'won' ? 'Marquer comme gagné ? Seulement si le client a accepté la réalisation.' : undefined}
            action={async () => { const reason = ['lost', 'disqualified'].includes(s) ? window.prompt('Raison ?') ?? undefined : undefined; await rpc('owner_transition', { p_entity: 'lead', p_id: l.id, p_to: s, p_reason: reason ?? null }); }}
            onDone={reload}>→ {STAGE_FR[s] ?? s}</ActionButton>)}
          {l.stage === 'won' && !data.projects.length && <button className="btn primary" onClick={() => setProjectOpen(true)}>Créer le projet</button>}
          <button className="btn ghost" onClick={() => nav(-1)}>Retour</button></>} />
      <div className="grid grid-2">
        <Card title="Détails" pad><dl className="kv">
          <dt>Fiche d’origine</dt><dd>{l.opportunities ? <Link className="link" to={`/opportunities/${l.opportunities.id}`}>{l.opportunities.title}</Link> : '—'}</dd>
          <dt>Contact</dt><dd>{l.contacts ? `${l.contacts.name ?? ''} ${l.contacts.email ?? l.contacts.handle ?? ''}` : '—'} {l.contacts?.do_not_contact && <Badge value="ne plus contacter" tone="bad" />}</dd>
          <dt>Score</dt><dd>{l.score ?? '—'}</dd>
          <dt>Prochaine relance</dt><dd>{dt(l.next_follow_up_at)}</dd>
          <dt>Résultat</dt><dd>{l.outcome ?? '—'} {l.lost_reason && <span className="muted">({l.lost_reason})</span>}</dd>
          <dt>Projets</dt><dd>{data.projects.map((p) => <Link key={p.id} className="link" to={`/projects/${p.id}`}>{p.name} </Link>)}{!data.projects.length && '—'}</dd>
        </dl></Card>
        <Card title="Historique"><Table rows={data.history} cols={[{ key: 'at', label: 'Quand', render: (r) => dt(r.at) }, { key: 'from_stage', label: 'De', render: (r) => r.from_stage ? <StageBadge s={r.from_stage} /> : '—' }, { key: 'to_stage', label: 'Vers', render: (r) => <StageBadge s={r.to_stage} /> }, { key: 'actor', label: 'Par', render: (r) => r.actor.startsWith('owner') ? 'vous' : 'agents' }]} /></Card>
      </div>
      {data.convs.map((c) => <Conversation key={c.id} conversationId={c.id} title={c.subject} leadId={l.id} />)}
      {!data.convs.length && <Card pad><Empty title="Pas encore d’échange">Le premier e-mail est rédigé et envoyé automatiquement au prochain cycle.</Empty></Card>}
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
