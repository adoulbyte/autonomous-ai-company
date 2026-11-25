import { useState } from 'react';
import { Link } from 'react-router-dom';
import { q, rpc, supabase, type Row } from '../lib/supabase';
import { useData } from '../lib/hooks';
import { ago, dt } from '../lib/format';
import { ActionButton, Badge, Card, Empty, ErrorBox, PageHead, Table, Tabs } from '../components/ui';

const STATUS_FR: Record<string, string> = { draft: 'Brouillon', awaiting_approval: 'En validation', approved: 'Envoi au prochain cycle', sent: 'Envoyé', received: 'Reçu',
  rejected: 'Refusé', failed: 'Échec d’envoi', cancelled: 'Annulé' };
const statusTone = (s: string) => (s === 'sent' ? 'ok' : s === 'failed' || s === 'rejected' ? 'bad' : s === 'received' ? 'info' : '');
const isAuto = (m: Row) => !!m.classification?.automated;
const autoLabel = (m: Row) => (m.classification?.automated === 'bounce' ? 'Adresse introuvable (rebond)' : 'Réponse automatique');

/** A conversation thread. Opening it marks its received messages as read. */
export function Conversation({ conversationId, title, onRead }: { conversationId: string; title: string; leadId?: string; onRead?: () => void }) {
  const { data, reload } = useData(async () => {
    const rows = await q<Row[]>(supabase.from('messages').select('*').eq('conversation_id', conversationId).order('created_at'));
    const unread = rows.filter((m) => m.direction === 'inbound' && !m.read_at).map((m) => m.id);
    if (unread.length) { await rpc('owner_mark_inbound_read', { p_ids: unread }).catch(() => undefined); onRead?.(); }
    return rows;
  }, [conversationId], 30000);
  const [editing, setEditing] = useState<string | null>(null); const [draft, setDraft] = useState('');
  return (
    <Card title={`Échange : ${title}`}>
      {!data ? null : data.map((m) => (
        <div key={m.id} className="card-pad" style={{ borderBottom: '1px solid var(--border)', background: m.direction === 'inbound' ? 'var(--surface-2)' : undefined }}>
          <div className="spread"><div className="row">
            <Badge value={m.direction === 'inbound' ? (isAuto(m) ? autoLabel(m) : 'Réponse reçue') : 'Envoyé par les agents'} tone={m.direction === 'inbound' && !isAuto(m) ? 'info' : ''} />
            {m.direction === 'outbound' && <Badge value={STATUS_FR[m.status] ?? m.status} tone={statusTone(m.status)} />}
            {m.injection_suspected && <Badge value="contenu suspect" tone="bad" />}
            <span className="small muted">{m.direction === 'inbound' ? `de ${m.from_addr ?? '—'}` : `à ${m.to_addr ?? '—'}`}</span></div>
            <span className="small muted">{dt(m.sent_at ?? m.created_at)}</span></div>
          {m.subject && <div className="mt" style={{ fontWeight: 600 }}>{m.subject}</div>}
          {editing === m.id ? <><textarea className="mt" style={{ minHeight: 200 }} value={draft} onChange={(e) => setDraft(e.target.value)} />
            <div className="row mt"><ActionButton className="btn sm primary" success="Brouillon enregistré" onDone={() => { setEditing(null); reload(); }}
              action={() => q(supabase.from('messages').update({ body: draft }).eq('id', m.id))}>Enregistrer</ActionButton><button className="btn sm" onClick={() => setEditing(null)}>Annuler</button></div></>
            : <pre className="mt" style={{ fontFamily: 'var(--font)', fontSize: 13.5 }}>{m.body}</pre>}
          {Array.isArray(m.attachments) && m.attachments.length > 0 && <div className="small muted mt">Pièces jointes : {m.attachments.map((a: Row) => a.filename).join(', ')}</div>}
          {m.classification?.summary && !isAuto(m) && m.direction === 'inbound' && <div className="small muted mt">Analyse de l’agent : {m.classification.summary}</div>}
          <div className="row mt">
            {m.status === 'draft' && m.direction === 'outbound' && <><button className="btn sm" onClick={() => { setEditing(m.id); setDraft(m.body); }}>Modifier</button>
              <ActionButton className="btn sm primary" success="Envoyé en validation" action={() => rpc('owner_submit_message', { p_message_id: m.id })} onDone={reload}>Valider</ActionButton></>}
            {m.status === 'awaiting_approval' && <Link className="btn sm" to="/approvals">Voir dans Validations</Link>}
            {m.status === 'approved' && !m.to_addr?.includes('@') && <><button className="btn sm" onClick={() => navigator.clipboard.writeText(`${m.subject ?? ''}\n\n${m.body}`)}>Copier le texte</button>
              <ActionButton className="btn sm primary" confirm="Confirmez-vous avoir envoyé ce message vous-même ?" success="Marqué comme envoyé"
                action={() => rpc('owner_mark_message_sent', { p_message_id: m.id, p_reference: null })} onDone={reload}>Marquer comme envoyé</ActionButton></>}
          </div>
        </div>))}
    </Card>
  );
}

export function Communications() {
  const [tab, setTab] = useState('replies');
  const [nonce, setNonce] = useState(0);
  const { data, error, reload } = useData(async () => {
    let b = supabase.from('messages').select('*, conversations!inner(id, subject, lead_id, project_id)').order('created_at', { ascending: false }).limit(200);
    if (tab === 'replies') b = b.eq('direction', 'inbound').not('conversations.lead_id', 'is', null).not('classification', 'is', null).is('classification->>automated', null);
    if (tab === 'sent') b = b.eq('direction', 'outbound').eq('status', 'sent');
    if (tab === 'queue') b = b.eq('direction', 'outbound').in('status', ['draft', 'awaiting_approval', 'approved']);
    return q<Row[]>(b);
  }, [tab, nonce], 30000);
  const [open, setOpen] = useState<Row | null>(null);
  const unread = tab === 'replies' ? (data ?? []).filter((m) => !m.read_at).length : 0;
  return (
    <div className="stack">
      <PageHead title="E-mails" subtitle="Les agents rédigent, relisent et envoient les e-mails automatiquement depuis votre boîte Gmail, puis lisent et traitent les réponses. Vous n’avez rien à envoyer vous-même."
        actions={unread ? <ActionButton className="btn sm" success="Réponses marquées comme lues" action={() => rpc('owner_mark_inbound_read', { p_ids: null })} onDone={() => { setNonce((n) => n + 1); reload(); }}>Tout marquer comme lu</ActionButton> : undefined} />
      <Tabs tabs={[{ key: 'replies', label: 'Réponses de prospects' }, { key: 'sent', label: 'Envoyés' }, { key: 'queue', label: 'En file d’envoi' }, { key: 'all', label: 'Tout' }]} value={tab} onChange={(k) => { setTab(k); setOpen(null); }} />
      <ErrorBox error={error} />
      <Card><Table rows={data} onRow={(r) => { setOpen(r); }} cols={[
        { key: 'subject', label: 'Objet', render: (r) => <span className="wrap2" style={{ fontWeight: r.direction === 'inbound' && !r.read_at ? 700 : 400 }}>{r.subject ?? r.conversations?.subject}</span> },
        { key: 'who', label: 'De / À', render: (r) => <span className="small">{r.direction === 'inbound' ? r.from_addr : r.to_addr}</span> },
        { key: 'status', label: 'Statut', render: (r) => r.direction === 'inbound'
          ? (isAuto(r) ? <Badge value={autoLabel(r)} /> : r.read_at ? <Badge value="Lu" /> : <Badge value="Nouveau" tone="accent" />)
          : <Badge value={STATUS_FR[r.status] ?? r.status} tone={statusTone(r.status)} /> },
        { key: 'link', label: 'Fiche', render: (r) => r.conversations?.lead_id ? <Link className="link" to={`/crm/leads/${r.conversations.lead_id}`} onClick={(e) => e.stopPropagation()}>prospect</Link> : r.conversations?.project_id ? <Link className="link" to={`/projects/${r.conversations.project_id}`} onClick={(e) => e.stopPropagation()}>projet</Link> : '—' },
        { key: 'created_at', label: 'Quand', render: (r) => <span className="small muted">{ago(r.sent_at ?? r.created_at)}</span> }]}
        empty={<Empty title={tab === 'replies' ? 'Aucune réponse de prospect pour l’instant' : tab === 'queue' ? 'Rien en attente : tout est parti' : 'Aucun message'}>
          {tab === 'replies' ? 'Les rebonds (adresse introuvable) et les réponses automatiques ne sont pas comptés.' : null}</Empty>} /></Card>
      {open && <Conversation key={open.conversation_id} conversationId={open.conversation_id} title={open.conversations?.subject ?? open.subject ?? ''} leadId={open.conversations?.lead_id} onRead={() => setNonce((n) => n + 1)} />}
    </div>
  );
}
