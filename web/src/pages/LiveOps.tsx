import { useEffect, useState } from 'react';
import { q, supabase, type Row } from '../lib/supabase';
import { ago, dt } from '../lib/format';
import { Badge, Card, Empty, ErrorBox, PageHead, Tabs } from '../components/ui';

export function LiveOps() {
  const [events, setEvents] = useState<Row[] | null>(null); const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState('all'); const [live, setLive] = useState(false);
  useEffect(() => {
    let b = supabase.from('events').select('*').order('id', { ascending: false }).limit(200);
    if (filter === 'problems') b = b.in('severity', ['warning', 'error', 'critical']);
    if (filter === 'agents') b = b.eq('actor_type', 'agent');
    if (filter === 'owner') b = b.eq('actor_type', 'owner');
    q<Row[]>(b).then(setEvents).catch((e) => setError(e.message));
    const ch = supabase.channel('events-live').on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'events' }, (p) => {
      setEvents((cur) => [p.new as Row, ...(cur ?? [])].slice(0, 300));
    }).subscribe((s) => setLive(s === 'SUBSCRIBED'));
    const poll = setInterval(async () => {
      if (document.visibilityState !== 'visible') return;
      try { const latest = await q<Row[]>(supabase.from('events').select('*').order('id', { ascending: false }).limit(50));
        setEvents((cur) => { const ids = new Set((cur ?? []).map((e) => e.id)); return [...latest.filter((e) => !ids.has(e.id)), ...(cur ?? [])].sort((a, b) => b.id - a.id).slice(0, 300); }); } catch { /* shown on next load */ }
    }, 15000);
    return () => { supabase.removeChannel(ch); clearInterval(poll); };
  }, [filter]);
  const shown = (events ?? []).filter((e) => filter === 'all' || (filter === 'problems' ? ['warning', 'error', 'critical'].includes(e.severity) : e.actor_type === (filter === 'agents' ? 'agent' : 'owner')));
  return (
    <div className="stack">
      <PageHead title="Live Operations" subtitle="Append-only event stream written in the same transaction as each state change." actions={<Badge value={live ? 'realtime connected' : 'polling every 15s'} tone={live ? 'ok' : 'warn'} />} />
      <Tabs tabs={[{ key: 'all', label: 'All' }, { key: 'agents', label: 'Agents' }, { key: 'owner', label: 'Owner' }, { key: 'problems', label: 'Warnings & errors' }]} value={filter} onChange={setFilter} />
      <ErrorBox error={error} />
      <Card>{events && !shown.length ? <Empty title="No events yet" /> : shown.map((e) => (
        <div key={e.id} className="feed-item"><div className="small muted" title={dt(e.occurred_at)}>{ago(e.occurred_at)}</div>
          <div><div className="row"><Badge value={e.severity} /><span className="small muted">{e.actor_type}{e.actor_id && !e.actor_id.match(/^[0-9a-f-]{36}$/) ? `:${e.actor_id}` : ''} · {e.entity_type} · {e.event_type}</span></div>
            <div style={{ marginTop: 3 }}>{e.message}</div></div></div>))}</Card>
    </div>
  );
}
