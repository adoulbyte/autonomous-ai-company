import { q, supabase, type Row } from '../lib/supabase';
import { useData } from '../lib/hooks';
import { Card } from './ui';

const pct = (a: number, b: number) => (b ? `${Math.round((a / b) * 100)} %` : '—');

/** Prospecting funnel from real records: emails sent → replies → interested → orders → paid. */
export function Funnel() {
  const { data } = useData(async () => {
    const c = async (b: any) => { const { count, error } = await b; if (error) throw new Error(error.message); return count ?? 0; };
    const [sent, replies, interested, won, stopped, bounced, paid, strategy] = await Promise.all([
      c(supabase.from('messages').select('id', { count: 'exact', head: true }).eq('direction', 'outbound').eq('status', 'sent').like('idempotency_key', 'outreach:%')),
      c(supabase.from('messages').select('id, conversations!inner(lead_id)', { count: 'exact', head: true }).eq('direction', 'inbound').not('conversations.lead_id', 'is', null).is('classification->>automated', null)),
      c(supabase.from('leads').select('id', { count: 'exact', head: true }).in('stage', ['engaged', 'proposal', 'negotiating', 'won'])),
      c(supabase.from('leads').select('id', { count: 'exact', head: true }).eq('stage', 'won')),
      c(supabase.from('leads').select('id', { count: 'exact', head: true }).eq('lost_reason', 'unsubscribed')),
      c(supabase.from('leads').select('id', { count: 'exact', head: true }).eq('lost_reason', 'email bounced')),
      c(supabase.from('invoices').select('id', { count: 'exact', head: true }).eq('status', 'paid')),
      q<Row[]>(supabase.from('settings').select('value').eq('key', 'marketing.strategy')),
    ]);
    return { sent, replies, interested, won, stopped, bounced, paid, strategy: strategy[0]?.value as Row | undefined };
  }, [], 60000);
  if (!data) return null;
  const steps = [
    { label: 'E-mails de prospection envoyés', n: data.sent, rate: '' },
    { label: 'Réponses', n: data.replies, rate: pct(data.replies, data.sent) },
    { label: 'Intéressés / demandes de devis', n: data.interested, rate: pct(data.interested, data.sent) },
    { label: 'Commandes confirmées', n: data.won, rate: pct(data.won, data.interested) },
    { label: 'Factures payées', n: data.paid, rate: pct(data.paid, data.won) },
  ];
  const max = Math.max(1, data.sent);
  return (
    <div className="grid grid-3" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(320px, 1fr))' }}>
      <Card title="Statistiques de prospection" pad>
        <div className="stack">
          {steps.map((s) => (
            <div key={s.label}>
              <div className="spread small"><span>{s.label}</span><span><strong>{s.n}</strong>{s.rate && <span className="muted"> · {s.rate}</span>}</span></div>
              <div className="bar"><span style={{ width: `${Math.max(2, (s.n / max) * 100)}%` }} /></div>
            </div>))}
          <div className="small muted">Désinscriptions (STOP) : {data.stopped} · Adresses invalides : {data.bounced}</div>
        </div>
      </Card>
      <Card title="Stratégie marketing (agent dédié)" pad>
        <p className="small" style={{ marginTop: 0 }}>{String(data.strategy?.summary ?? 'En attente des premiers résultats.')}</p>
        {data.strategy?.country_weights ? <div className="small"><strong>Plan géographique :</strong>{' '}
          {Object.entries(data.strategy.country_weights as Record<string, number>).sort((a, b) => b[1] - a[1]).map(([c, n]) => `${COUNTRY[c] ?? c} ×${n}`).join(' · ')}
          {' '}— {String(data.strategy.zones_per_city ?? 5)} zone(s) par ville{data.strategy.geo_reason ? <div className="muted">{String(data.strategy.geo_reason)}</div> : null}</div> : null}
        {(data.strategy?.focus_categories as string[] | undefined)?.length ? <div className="small"><strong>Cibles prioritaires :</strong> {(data.strategy!.focus_categories as string[]).join(', ')}</div> : null}
        {(data.strategy?.writing_tips as string[] | undefined)?.length ? <ul className="small">{(data.strategy!.writing_tips as string[]).map((t) => <li key={t}>{t}</li>)}</ul> : null}
        {data.strategy?.updated_at ? <div className="small muted">Mise à jour : {new Date(String(data.strategy.updated_at)).toLocaleString('fr-FR')}</div> : null}
      </Card>
    </div>
  );
}

const COUNTRY: Record<string, string> = { FR: 'France', BE: 'Belgique', LU: 'Luxembourg', MC: 'Monaco', GB: 'Royaume-Uni', IE: 'Irlande', NL: 'Pays-Bas', PT: 'Portugal',
  MA: 'Maroc', TN: 'Tunisie', SN: 'Sénégal', CI: 'Côte d’Ivoire', CA: 'Canada', AU: 'Australie', NZ: 'Nouvelle-Zélande', US: 'États-Unis' };
