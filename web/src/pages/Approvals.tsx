import { useState } from 'react';
import { q, rpc, supabase, type Row } from '../lib/supabase';
import { useData } from '../lib/hooks';
import { ago, dt, money } from '../lib/format';
import { ActionButton, Badge, Card, Empty, ErrorBox, Json, PageHead, Tabs } from '../components/ui';

export function Approvals() {
  const [tab, setTab] = useState('pending');
  const { data, error, reload } = useData(async () => {
    let b = supabase.from('approvals').select('*').order('created_at', { ascending: false }).limit(100);
    b = tab === 'pending' ? b.eq('status', 'pending') : b.neq('status', 'pending');
    const rows = await q<Row[]>(b);
    const msgIds = rows.map((r) => r.payload?.message_id).filter(Boolean);
    const msgs = msgIds.length ? await q<Row[]>(supabase.from('messages').select('id, subject, body, to_addr').in('id', msgIds)) : [];
    return rows.map((r): Row => ({ ...r, message: msgs.find((m) => m.id === r.payload?.message_id) }));
  }, [tab], 20000);
  return (
    <div className="stack">
      <PageHead title="Approvals" subtitle="Sensitive actions wait here. Decisions are enforced by the database: nothing proceeds without an owner decision." />
      <Tabs tabs={[{ key: 'pending', label: 'Pending' }, { key: 'decided', label: 'History' }]} value={tab} onChange={setTab} />
      <ErrorBox error={error} />
      {data && !data.length && <Card><Empty title={tab === 'pending' ? 'No pending approvals' : 'No decisions yet'} /></Card>}
      {data?.map((a) => <ApprovalCard key={a.id} a={a} onDone={reload} />)}
    </div>
  );
}

function ApprovalCard({ a, onDone }: { a: Row; onDone: () => void }) {
  const [note, setNote] = useState('');
  return (
    <Card title={<span className="row"><span>{a.title}</span><Badge value={a.status} /></span>} actions={<><Badge value={`${a.risk_level} risk`} tone={a.risk_level === 'high' || a.risk_level === 'critical' ? 'bad' : a.risk_level === 'medium' ? 'warn' : ''} /><span className="small muted">{ago(a.created_at)}</span></>}>
      <div className="card-pad stack">
        <dl className="kv">
          <dt>Action</dt><dd><code>{a.action_type}</code>{a.entity_type && <span className="muted"> on {a.entity_type} {String(a.entity_id ?? '').slice(0, 8)}</span>}</dd>
          <dt>Demandé par</dt><dd>{a.requested_by}</dd>
          <dt>Pourquoi</dt><dd>{a.reason}</dd>
          <dt>Bénéfice attendu</dt><dd>{a.expected_benefit ?? '—'}</dd>
          <dt>Risque</dt><dd>{a.risk ?? '—'}</dd>
          <dt>Coût</dt><dd>{Number(a.cost_minor) ? money(a.cost_minor, a.currency) : 'Aucun coût direct'}</dd>
          <dt>Si vous validez</dt><dd>{a.if_approved}</dd>
          <dt>Si vous refusez</dt><dd>{a.if_rejected}</dd>
          <dt>Expire</dt><dd>{dt(a.expires_at)}</dd>
          {a.decided_at && <><dt>Décision</dt><dd>{a.status} by {String(a.decided_by).split(':')[0]} {ago(a.decided_at)} {a.decision_note && `— “${a.decision_note}”`}</dd></>}
        </dl>
        {a.message && <div><h3>Message qui sera envoyé{a.message.to_addr ? ` à ${a.message.to_addr}` : ''}</h3><pre className="mt" style={{ fontFamily: 'var(--font)', fontSize: 13.5 }}><strong>{a.message.subject}</strong>{'\n\n'}{a.message.body}</pre></div>}
        {a.action_type === 'domain.purchase' && Array.isArray(a.evidence) && <div className="alert info"><strong>À faire (environ 5 minutes) :</strong>
          <ol style={{ margin: '8px 0 0', paddingLeft: 18 }}>{(a.evidence as Row[]).map((e, i) => <li key={i}>{String(Object.values(e)[0])}</li>)}</ol></div>}
        <details><summary className="small muted">Détails techniques</summary><div className="grid grid-2 mt"><Json value={a.evidence} /><Json value={a.payload} /></div></details>
        {a.status === 'pending' && <><input placeholder={a.action_type === 'domain.purchase' ? 'Nom de domaine acheté, si différent (ex. : salon-belle.fr)' : 'Note (facultatif)'} value={note} onChange={(e) => setNote(e.target.value)} />
          <div className="row">
            <ActionButton className="btn accent" success="Validé" onDone={onDone} action={() => rpc('decide_approval', { p_id: a.id, p_approve: true, p_note: note || null })}>{a.action_type === 'domain.purchase' ? 'Domaine acheté et configuré' : 'Valider'}</ActionButton>
            <ActionButton className="btn danger" success="Refusé" onDone={onDone} action={() => rpc('decide_approval', { p_id: a.id, p_approve: false, p_note: note || null })}>Refuser</ActionButton>
          </div></>}
        {a.execution_result && <div className="small muted">Exécution : {JSON.stringify(a.execution_result)}</div>}
      </div>
    </Card>
  );
}
