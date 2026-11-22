import { useState } from 'react';
import { q, supabase, type Row } from '../lib/supabase';
import { useData } from '../lib/hooks';
import { ago, dt } from '../lib/format';
import { ActionButton, Card, Empty } from './ui';

/** Notes + reminders attached to any entity (real rows; reminders surface as alerts when due). */
export function NotesPanel({ entityType, entityId }: { entityType: string; entityId: string }) {
  const [body, setBody] = useState(''); const [rTitle, setRTitle] = useState(''); const [rDue, setRDue] = useState('');
  const { data, reload } = useData(async () => ({
    notes: await q<Row[]>(supabase.from('notes').select('*').eq('entity_type', entityType).eq('entity_id', entityId).order('created_at', { ascending: false })),
    reminders: await q<Row[]>(supabase.from('reminders').select('*').eq('entity_type', entityType).eq('entity_id', entityId).order('due_at')),
  }), [entityId]);
  return (
    <Card title="Notes & reminders" pad>
      <div className="stack">
        <textarea placeholder="Add a note…" value={body} onChange={(e) => setBody(e.target.value)} />
        <div><ActionButton className="btn sm" disabled={!body.trim()} success="Note added" onDone={() => { setBody(''); reload(); }}
          action={() => q(supabase.from('notes').insert({ entity_type: entityType, entity_id: entityId, body }))}>Add note</ActionButton></div>
        <div className="row"><input placeholder="Reminder" value={rTitle} onChange={(e) => setRTitle(e.target.value)} style={{ flex: 2 }} />
          <input type="datetime-local" value={rDue} onChange={(e) => setRDue(e.target.value)} style={{ flex: 1 }} />
          <ActionButton className="btn sm" disabled={!rTitle || !rDue} success="Reminder set" onDone={() => { setRTitle(''); setRDue(''); reload(); }}
            action={() => q(supabase.from('reminders').insert({ entity_type: entityType, entity_id: entityId, title: rTitle, due_at: new Date(rDue).toISOString() }))}>Remind</ActionButton></div>
        {data?.reminders.map((r) => <div key={r.id} className="spread small"><span>{r.done_at ? '✓ ' : '⏰ '}{r.title} — {dt(r.due_at)}</span>
          {!r.done_at && <ActionButton className="btn sm ghost" action={() => q(supabase.from('reminders').update({ done_at: new Date().toISOString() }).eq('id', r.id))} onDone={reload}>Done</ActionButton>}</div>)}
        {data && !data.notes.length && !data.reminders.length && <Empty title="No notes yet" />}
        {data?.notes.map((n) => <div key={n.id} style={{ borderTop: '1px solid var(--border)', paddingTop: 10 }}><div className="small muted">{n.created_by.split(':')[0]} · {ago(n.created_at)}</div><div style={{ whiteSpace: 'pre-wrap' }}>{n.body}</div></div>)}
      </div>
    </Card>
  );
}
