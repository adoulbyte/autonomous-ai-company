import { Link } from 'react-router-dom';
import { q, supabase, type Row } from '../lib/supabase';
import { useData } from '../lib/hooks';
import { ago, money, num } from '../lib/format';
import { Badge, Card, Empty, ErrorBox, Loading, PageHead, Stat, Table } from '../components/ui';
import { NextActions } from '../components/NextActions';
import { ProspectingStatus } from '../components/ProspectingStatus';
import { Funnel } from '../components/Funnel';

async function load() {
  const count = async (table: string, f?: (b: any) => any) => {
    let b = supabase.from(table).select('*', { count: 'exact', head: true });
    if (f) b = f(b);
    const { count, error } = await b; if (error) throw new Error(error.message); return count ?? 0;
  };
  const today = new Date(new Date().setHours(0, 0, 0, 0)).toISOString();
  const [fin, found, foundToday, sentTotal, sentToday, replies, activeProjects, delivered, sent, worker, base, mode, reviews] = await Promise.all([
    q<Row[]>(supabase.from('v_finance_by_currency').select('*')),
    count('opportunities'),
    count('opportunities', (b) => b.gte('discovered_at', today)),
    count('messages', (b) => b.eq('direction', 'outbound').eq('status', 'sent').like('to_addr', '%@%')),
    count('messages', (b) => b.eq('direction', 'outbound').eq('status', 'sent').like('to_addr', '%@%').gte('sent_at', today)),
    // Only real replies to our prospecting (inbound emails in a conversation with a prospect), not Google/vendor notifications.
    (async () => { const { count, error } = await supabase.from('messages').select('id, conversations!inner(lead_id)', { count: 'exact', head: true })
      .eq('direction', 'inbound').not('conversations.lead_id', 'is', null).is('classification->>automated', null); if (error) throw new Error(error.message); return count ?? 0; })(),
    count('projects', (b) => b.in('status', ['planning', 'in_progress', 'in_qa', 'revision', 'ready_for_delivery'])),
    count('projects', (b) => b.in('status', ['delivered', 'accepted', 'closed'])),
    q<Row[]>(supabase.from('messages').select('id,to_addr,subject,sent_at').eq('direction', 'outbound').eq('status', 'sent').like('to_addr', '%@%').order('sent_at', { ascending: false }).limit(8)),
    q<Row[]>(supabase.from('worker_heartbeats').select('*').order('last_seen_at', { ascending: false }).limit(1)),
    q<Row[]>(supabase.from('settings').select('value').eq('key', 'finance.base_currency')),
    q<Row[]>(supabase.from('settings').select('value').eq('key', 'business.mode')),
    q<Row[]>(supabase.from('client_feedback').select('rating').not('rating', 'is', null)),
  ]);
  return { fin, found, foundToday, sentTotal, sentToday, replies, activeProjects, delivered, sent, worker: worker[0], reviews,
    base: (base[0]?.value as string) ?? 'EUR', pilot: (mode[0]?.value as Row | undefined)?.mode === 'free_pilot' };
}

export function CommandCenter() {
  const { data, error, loading } = useData(load, [], 20000);
  if (loading && !data) return <Loading />;
  if (!data) return <ErrorBox error={error} />;
  const f = data.fin.find((r) => r.currency === data.base) ?? { confirmed_revenue_minor: 0, receivable_minor: 0 };
  const workerAge = data.worker ? (Date.now() - new Date(data.worker.last_seen_at).getTime()) / 3600000 : Infinity;
  const avg = data.reviews.length ? (data.reviews.reduce((a, r) => a + r.rating, 0) / data.reviews.length).toFixed(1) : null;

  return (
    <div className="stack">
      <PageHead title="Tableau de bord" subtitle={data.worker ? `Dernier passage des agents : ${ago(data.worker.last_seen_at)}` : 'Les agents n’ont pas encore tourné'}
        actions={data.pilot ? <Badge value="Mode lancement — travail offert contre un avis" tone="accent" /> : <Badge value="Mode payant" tone="ok" />} />
      <ErrorBox error={error} />
      {workerAge > 6 && <div className="alert warn">Les agents n’ont pas tourné depuis {data.worker ? `${Math.floor(workerAge)} h` : 'le début'}. Ils reprendront au prochain cycle automatique.</div>}
      <NextActions />
      <div className="grid grid-4" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(190px, 1fr))' }}>
        <Stat label="Entreprises trouvées" value={num(data.found)} sub={`${data.foundToday} aujourd’hui`} />
        <Stat label="E-mails envoyés" value={num(data.sentTotal)} sub={`${data.sentToday} aujourd’hui`} accent />
        <Stat label="Réponses de prospects" value={num(data.replies)} />
        <Stat label="Projets" value={num(data.activeProjects)} sub={`${data.delivered} livrés`} />
        <Stat label="Avis clients" value={avg ? `${avg} / 5` : '—'} sub={`${data.reviews.length} avis`} />
        <Stat label="Encaissé" value={money(f.confirmed_revenue_minor, data.base)} sub={`${money(f.receivable_minor, data.base)} en attente`} />
      </div>
      <ProspectingStatus />
      <Funnel />
      <Card title="Derniers e-mails envoyés" actions={<Link className="btn sm" to="/communications">Tous les e-mails</Link>}>
        <Table rows={data.sent} cols={[
          { key: 'sent_at', label: 'Quand', render: (r) => <span className="muted">{ago(r.sent_at)}</span> },
          { key: 'to_addr', label: 'À', render: (r) => r.to_addr },
          { key: 'subject', label: 'Objet', render: (r) => r.subject },
        ]} empty={<Empty title="Aucun e-mail envoyé pour l’instant">Les agents envoient automatiquement depuis la boîte Gmail à chaque cycle.</Empty>} />
      </Card>
    </div>
  );
}
