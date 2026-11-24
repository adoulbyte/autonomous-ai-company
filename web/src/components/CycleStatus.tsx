import { q, supabase, type Row } from '../lib/supabase';
import { useData } from '../lib/hooks';
import { useEffect, useState } from 'react';
import { Badge, Card } from './ui';

const hm = (d: Date) => d.toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' });
const dur = (ms: number) => { const m = Math.max(0, Math.round(ms / 60000)); return m < 60 ? `${m} min` : `${Math.floor(m / 60)} h ${String(m % 60).padStart(2, '0')}`; };

/** Next scheduled start: every `interval` minutes from `offset` past the hour (GitHub may start it a few minutes late). */
function nextStart(now: Date, interval: number, offset: number): Date {
  const d = new Date(now); d.setSeconds(0, 0);
  for (let i = 0; i < 24 * 60; i++) {
    d.setMinutes(d.getMinutes() + 1);
    const minutesOfDay = d.getHours() * 60 + d.getMinutes();
    if (interval >= 60 ? (d.getMinutes() === offset && d.getUTCHours() % (interval / 60) === 0) : (minutesOfDay - offset) % interval === 0) return d;
  }
  return d;
}

/** Agent cycles: running now or not, when the last one ended, when the next one starts. */
export function CycleStatus() {
  const [now, setNow] = useState(new Date());
  useEffect(() => { const t = setInterval(() => setNow(new Date()), 30000); return () => clearInterval(t); }, []);
  const { data } = useData(async () => {
    const [hb, rt] = await Promise.all([
      q<Row[]>(supabase.from('worker_heartbeats').select('status,started_at,last_seen_at,note,tasks_succeeded').order('last_seen_at', { ascending: false }).limit(1)),
      q<Row[]>(supabase.from('settings').select('value').eq('key', 'worker.runtime')),
    ]);
    return { hb: hb[0], rt: (rt[0]?.value ?? {}) as Row };
  }, [], 30000);
  if (!data) return null;
  const running = data.hb?.status === 'running' && now.getTime() - new Date(data.hb.last_seen_at).getTime() < 15 * 60000;
  const interval = Number(data.rt.interval_minutes ?? 120); const offset = Number(data.rt.minute_offset ?? 23);
  const next = nextStart(now, interval, offset);
  const last = data.hb ? new Date(data.hb.last_seen_at) : null;
  return (
    <Card title="Cycles des agents" actions={running ? <Badge value="Cycle en cours" tone="ok" /> : <Badge value="En attente du prochain cycle" />} pad>
      <dl className="kv">
        <dt>{running ? 'Cycle démarré à' : 'Dernier cycle terminé à'}</dt>
        <dd>{last ? `${hm(running ? new Date(data.hb.started_at ?? data.hb.last_seen_at) : last)} (il y a ${dur(now.getTime() - (running ? new Date(data.hb.started_at ?? data.hb.last_seen_at) : last).getTime())})` : '—'}
          {!running && data.hb?.note ? <span className="muted"> · {String(data.hb.note).replace(/^ran (\d+) tasks in (\d+)s$/, '$1 tâches en $2 s')}</span> : null}</dd>
        <dt>Prochain cycle</dt>
        <dd>{running ? 'juste après celui-ci si du travail attend' : `vers ${hm(next)} (dans ${dur(next.getTime() - now.getTime())})`}</dd>
        <dt>Rythme</dt>
        <dd>{interval < 60 ? `toutes les ${interval} minutes` : `toutes les ${interval / 60} heures`}, et en continu tant que du travail attend · GitHub peut décaler un départ de quelques minutes</dd>
      </dl>
    </Card>
  );
}
