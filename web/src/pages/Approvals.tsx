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
          <dt>What</dt><dd><code>{a.action_type}</code>{a.entity_type && <span className="muted"> on {a.entity_type} {String(a.entity_id ?? '').slice(0, 8)}</span>}</dd>
          <dt>Requested by</dt><dd>{a.requested_by}</dd>
          <dt>Why</dt><dd>{a.reason}</dd>
          <dt>Expected benefit</dt><dd>{a.expected_benefit ?? '—'}</dd>
          <dt>Risk</dt><dd>{a.risk ?? '—'}</dd>
          <dt>Cost</dt><dd>{Number(a.cost_minor) ? money(a.cost_minor, a.currency) : 'No direct cost'}</dd>
          <dt>If approved</dt><dd>{a.if_approved}</dd>
          <dt>If rejected</dt><dd>{a.if_rejected}</dd>
          <dt>Expires</dt><dd>{dt(a.expires_at)}</dd>
          {a.decided_at && <><dt>Decision</dt><dd>{a.status} by {String(a.decided_by).split(':')[0]} {ago(a.decided_at)} {a.decision_note && `— “${a.decision_note}”`}</dd></>}
        </dl>
        {a.message && <div><h3>Message to be sent{a.message.to_addr ? ` to ${a.message.to_addr}` : ''}</h3><pre className="mt" style={{ fontFamily: 'var(--font)', fontSize: 13.5 }}><strong>{a.message.subject}</strong>{'\n\n'}{a.message.body}</pre></div>}
        <details><summary className="small muted">Evidence & payload</summary><div className="grid grid-2 mt"><Json value={a.evidence} /><Json value={a.payload} /></div></details>
        {a.status === 'pending' && <><input placeholder="Optional note" value={note} onChange={(e) => setNote(e.target.value)} />
          <div className="row">
            <ActionButton className="btn accent" success="Approved" onDone={onDone} action={() => rpc('decide_approval', { p_id: a.id, p_approve: true, p_note: note || null })}>Approve</ActionButton>
            <ActionButton className="btn danger" success="Rejected" onDone={onDone} action={() => rpc('decide_approval', { p_id: a.id, p_approve: false, p_note: note || null })}>Reject</ActionButton>
          </div></>}
        {a.execution_result && <div className="small muted">Execution: {JSON.stringify(a.execution_result)}</div>}
      </div>
    </Card>
  );
}
