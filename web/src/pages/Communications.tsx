import { useState } from 'react';
import { Link } from 'react-router-dom';
import { q, rpc, supabase, type Row } from '../lib/supabase';
import { useData } from '../lib/hooks';
import { ago, dt } from '../lib/format';
import { ActionButton, Badge, Card, Empty, ErrorBox, PageHead, Table, Tabs } from '../components/ui';

/** A conversation thread with the full send lifecycle: draft → approval → approved → (you send) → sent. */
export function Conversation({ conversationId, title, leadId }: { conversationId: string; title: string; leadId?: string }) {
  const { data, reload } = useData(() => q<Row[]>(supabase.from('messages').select('*').eq('conversation_id', conversationId).order('created_at')), [conversationId], 30000);
  const [editing, setEditing] = useState<string | null>(null); const [draft, setDraft] = useState('');
  const [inbound, setInbound] = useState('');
  return (
    <Card title={`Conversation: ${title}`}>
      {!data ? null : data.map((m) => (
        <div key={m.id} className="card-pad" style={{ borderBottom: '1px solid var(--border)', background: m.direction === 'inbound' ? 'var(--surface-2)' : undefined }}>
          <div className="spread"><div className="row"><Badge value={m.direction} tone={m.direction === 'inbound' ? 'info' : ''} /><Badge value={m.status} />
            {m.injection_suspected && <Badge value="prompt-injection suspected" tone="bad" />}{m.priority && <Badge value={m.priority} />}
            <span className="small muted">{m.direction === 'inbound' ? `from ${m.from_addr ?? '—'}` : `to ${m.to_addr ?? '—'}`}</span></div>
            <span className="small muted">{dt(m.sent_at ?? m.created_at)}</span></div>
          {m.subject && <div className="mt" style={{ fontWeight: 600 }}>{m.subject}</div>}
          {editing === m.id ? <><textarea className="mt" style={{ minHeight: 200 }} value={draft} onChange={(e) => setDraft(e.target.value)} />
            <div className="row mt"><ActionButton className="btn sm primary" success="Draft saved" onDone={() => { setEditing(null); reload(); }}
              action={() => q(supabase.from('messages').update({ body: draft }).eq('id', m.id))}>Save draft</ActionButton><button className="btn sm" onClick={() => setEditing(null)}>Cancel</button></div></>
            : <pre className="mt" style={{ fontFamily: 'var(--font)', fontSize: 13.5 }}>{m.body}</pre>}
          {m.classification?.summary && <div className="small muted mt">Triage: {m.classification.category} · {m.classification.intent} — {m.classification.summary}</div>}
          <div className="row mt">
            {m.status === 'draft' && m.direction === 'outbound' && <><button className="btn sm" onClick={() => { setEditing(m.id); setDraft(m.body); }}>Edit</button>
              <ActionButton className="btn sm primary" success="Submitted for approval" action={() => rpc('owner_submit_message', { p_message_id: m.id })} onDone={reload}>Submit for approval</ActionButton></>}
            {m.status === 'awaiting_approval' && <Link className="btn sm" to="/approvals">Review in Approvals</Link>}
            {m.status === 'approved' && <><button className="btn sm" onClick={() => navigator.clipboard.writeText(`${m.subject ?? ''}\n\n${m.body}`)}>Copy text</button>
              {m.to_addr?.includes('@') && <a className="btn sm" href={`mailto:${m.to_addr}?subject=${encodeURIComponent(m.subject ?? '')}&body=${encodeURIComponent(m.body)}`}>Open in email client</a>}
              <ActionButton className="btn sm primary" confirm="Confirm you have actually sent this message?" success="Marked as sent"
                action={() => rpc('owner_mark_message_sent', { p_message_id: m.id, p_reference: window.prompt('Reference (e.g. sent from Gmail, platform message link) — optional') || null })} onDone={reload}>Mark sent</ActionButton></>}
          </div>
        </div>))}
      <div className="card-pad"><div className="small muted">Log a reply you received (it is classified by the Communication Agent; contents are treated as untrusted):</div>
        <textarea className="mt" value={inbound} onChange={(e) => setInbound(e.target.value)} placeholder="Paste the inbound message…" />
        <div className="mt"><ActionButton className="btn sm" disabled={inbound.trim().length < 2} success="Logged; triage queued" onDone={() => { setInbound(''); reload(); }}
          action={() => rpc('owner_log_inbound', { p_conversation_id: conversationId, p_lead_id: leadId ?? null, p_subject: `Re: ${title}`, p_body: inbound, p_from: null })}>Log inbound reply</ActionButton></div></div>
    </Card>
  );
}

export function Communications() {
  const [tab, setTab] = useState('attention');
  const { data, error } = useData(async () => {
    let b = supabase.from('messages').select('*, conversations(id, subject, lead_id, project_id)').order('created_at', { ascending: false }).limit(200);
    if (tab === 'attention') b = b.in('status', ['draft', 'awaiting_approval', 'approved']);
    if (tab === 'inbound') b = b.eq('direction', 'inbound');
    if (tab === 'sent') b = b.eq('status', 'sent');
    return q<Row[]>(b);
  }, [tab], 30000);
  const [open, setOpen] = useState<Row | null>(null);
  return (
    <div className="stack">
      <PageHead title="Communications" subtitle="Every external message is drafted by an agent and needs your approval. Sending is done by you; nothing is sent automatically." />
      <div className="alert info">Outbound email is not connected (no free sending service is configured). Approved messages can be copied or opened in your email client, then marked as sent.</div>
      <Tabs tabs={[{ key: 'attention', label: 'Needs action' }, { key: 'inbound', label: 'Inbound' }, { key: 'sent', label: 'Sent' }, { key: 'all', label: 'All' }]} value={tab} onChange={setTab} />
      <ErrorBox error={error} />
      <Card><Table rows={data} onRow={setOpen} cols={[
        { key: 'subject', label: 'Subject', render: (r) => <span className="truncate">{r.subject ?? r.conversations?.subject}</span> },
        { key: 'direction', label: 'Dir.', render: (r) => <Badge value={r.direction} /> }, { key: 'status', label: 'Status', render: (r) => <Badge value={r.status} /> },
        { key: 'priority', label: 'Priority', render: (r) => <Badge value={r.priority} /> },
        { key: 'link', label: 'Linked', render: (r) => r.conversations?.lead_id ? <Link className="link" to={`/crm/leads/${r.conversations.lead_id}`} onClick={(e) => e.stopPropagation()}>lead</Link> : r.conversations?.project_id ? <Link className="link" to={`/projects/${r.conversations.project_id}`} onClick={(e) => e.stopPropagation()}>project</Link> : '—' },
        { key: 'created_at', label: 'When', render: (r) => ago(r.created_at) }]} empty={<Empty title="No messages in this view" />} /></Card>
      {open && <Conversation conversationId={open.conversation_id} title={open.conversations?.subject ?? open.subject ?? ''} leadId={open.conversations?.lead_id} />}
    </div>
  );
}
