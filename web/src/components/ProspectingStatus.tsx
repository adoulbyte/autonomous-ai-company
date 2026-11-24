import { q, supabase, type Row } from '../lib/supabase';
import { useData } from '../lib/hooks';
import { ago } from '../lib/format';
import { Badge, Card } from './ui';

/** Live proof that prospecting never stops: last/next cycle, area being explored, today's contacts vs the daily allowance, follow-ups. */
export function ProspectingStatus() {
  const { data } = useData(async () => {
    const today = new Date(new Date().setHours(0, 0, 0, 0)).toISOString();
    const count = async (b: any) => { const { count, error } = await b; if (error) throw new Error(error.message); return count ?? 0; };
    const [src, policy, kill, worker, contactedToday, followUps, waiting, sentToday] = await Promise.all([
      q<Row[]>(supabase.from('sources').select('config,last_run_at,health,enabled').eq('key', 'osm_businesses')),
      q<Row[]>(supabase.from('settings').select('value').eq('key', 'prospecting.policy')),
      q<Row[]>(supabase.from('settings').select('value').eq('key', 'system.kill_switch')),
      q<Row[]>(supabase.from('worker_heartbeats').select('last_seen_at,status').order('last_seen_at', { ascending: false }).limit(1)),
      count(supabase.from('leads').select('id', { count: 'exact', head: true }).eq('source', 'osm_businesses').gte('created_at', today)),
      count(supabase.from('leads').select('id', { count: 'exact', head: true }).eq('stage', 'contacted').not('next_follow_up_at', 'is', null)),
      count(supabase.from('opportunities').select('id', { count: 'exact', head: true }).eq('source_key', 'osm_businesses').eq('status', 'monitoring')),
      count(supabase.from('messages').select('id', { count: 'exact', head: true }).eq('direction', 'outbound').eq('status', 'sent').like('to_addr', '%@%').gte('sent_at', today)),
    ]);
    return { src: src[0], policy: policy[0]?.value as Row | undefined, kill: kill[0]?.value === true, worker: worker[0], contactedToday, followUps, waiting, sentToday };
  }, [], 30000);
  if (!data) return null;
  const cfg = (data.src?.config ?? {}) as Row;
  const p = data.policy;
  const days = p ? Math.max(0, Math.floor((Date.now() - new Date(p.started_at).getTime()) / 86400000)) : 0;
  const cap = p ? Math.min(p.max_per_day, p.start_per_day + days * p.step_per_day) : null;
  const active = !data.kill && data.src?.enabled !== false;
  const covered = cfg.areas_total ? Math.min(100, Math.round(((Number(cfg.cursor ?? 0) % cfg.areas_total) / cfg.areas_total) * 100)) : null;
  return (
    <Card title="Prospection en continu" actions={active ? <Badge value="Active — 24 h/24, 7 j/7" tone="ok" /> : <Badge value="En pause (arrêt d’urgence)" tone="bad" />} pad>
      <dl className="kv">
        <dt>Dernier passage des agents</dt><dd>{data.worker ? ago(data.worker.last_seen_at) : '—'} · les agents repassent automatiquement plusieurs fois par jour</dd>
        <dt>Dernière zone explorée</dt><dd>{cfg.last_city ?? '—'}{data.src?.last_run_at ? ` (${ago(data.src.last_run_at)})` : ''}</dd>
        <dt>Prochaine zone</dt><dd>{cfg.next_city ?? '—'}</dd>
        <dt>Couverture du tour</dt><dd>{covered != null ? `${covered} % des ${cfg.areas_total} zones (${cfg.cities_total} villes) — puis le tour recommence` : '—'}</dd>
        <dt>Nouveaux contacts aujourd’hui</dt><dd>{data.contactedToday}{cap != null ? ` / ${cap} autorisés (augmente chaque jour jusqu’à ${p!.max_per_day})` : ''}</dd>
        <dt>E-mails envoyés aujourd’hui</dt><dd>{data.sentToday} (premiers contacts, relances et réponses)</dd>
        <dt>Relances programmées</dt><dd>{data.followUps} prospect{data.followUps > 1 ? 's' : ''} sans réponse seront relancés automatiquement</dd>
        <dt>Entreprises en réserve</dt><dd>{data.waiting} déjà trouvées, contactées dans les prochains jours</dd>
      </dl>
    </Card>
  );
}
