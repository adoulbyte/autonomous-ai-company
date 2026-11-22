import { Link } from 'react-router-dom';
import { q, supabase, type Row } from '../lib/supabase';
import { useData } from '../lib/hooks';
import { money } from '../lib/format';

interface Action { key: string; icon: string; title: string; detail: string; to: string; cta: string; count: number }

/** Plain-language list of what the owner must do now, computed from real records. */
export function NextActions() {
  const { data } = useData(async () => {
    const [paySetting] = await q<Row[]>(supabase.from('settings').select('value').eq('key', 'finance.payment_instructions'));
    const [approvals, readyProjects, deliveredNoInvoice, draftInvoices, openInvoices, approvedMsgs, pendingPayments] = await Promise.all([
      q<Row[]>(supabase.from('approvals').select('id,title').eq('status', 'pending')),
      q<Row[]>(supabase.from('projects').select('id,name').eq('status', 'ready_for_delivery')),
      q<Row[]>(supabase.from('projects').select('id,name,budget_minor,currency,invoices(id,status)').in('status', ['delivered', 'accepted'])),
      q<Row[]>(supabase.from('invoices').select('id,number,amount_minor,currency').eq('status', 'draft')),
      q<Row[]>(supabase.from('invoices').select('id,number,amount_minor,currency,due_date,status').in('status', ['issued', 'partially_paid', 'overdue'])),
      q<Row[]>(supabase.from('messages').select('id,subject').eq('status', 'approved')),
      q<Row[]>(supabase.from('payments').select('id').eq('status', 'pending')),
    ]);
    const noInvoice = deliveredNoInvoice.filter((p) => !(p.invoices as Row[]).some((i) => i.status !== 'void'));
    const payMissing = !(paySetting?.value as Row | undefined)?.enabled;
    const actions: Action[] = [
      { key: 'paydetails', icon: '🏦', title: 'Coordonnées de paiement à renseigner', count: payMissing && (readyProjects.length + openInvoices.length) > 0 ? 1 : 0, to: '/settings', cta: 'Ouvrir Settings',
        detail: 'Des factures sont prêtes mais ne peuvent pas partir sans tes coordonnées de paiement. Settings → finance.payment_instructions : renseigne l\'IBAN puis mets "enabled": true.' },
      { key: 'approvals', icon: '✅', title: 'Décisions à prendre', count: approvals.length, to: '/approvals', cta: 'Voir les approbations',
        detail: approvals.length ? `Ex. : « ${approvals[0].title} ». Les agents attendent ton accord avant d'agir.` : '' },
      { key: 'messages', icon: '✉️', title: 'Messages approuvés à envoyer', count: approvedMsgs.length, to: '/communications', cta: 'Ouvrir Communications',
        detail: 'Copie le message (ou « Open in email client »), envoie-le, puis clique « Mark sent ».' },
      { key: 'deliver', icon: '⏳', title: 'Travail terminé — en attente du paiement client', count: readyProjects.length, to: readyProjects[0] ? `/projects/${readyProjects[0].id}` : '/projects', cta: 'Voir le projet',
        detail: readyProjects.length ? `« ${readyProjects[0].name} » a passé deux contrôles qualité indépendants. La facture a été émise ; les livrables seront envoyés automatiquement dès que le paiement est confirmé.` : '' },
      { key: 'noinvoice', icon: '🧾', title: 'Projet livré sans facture', count: noInvoice.length, to: '/finance', cta: 'Créer la facture',
        detail: noInvoice.length ? `« ${noInvoice[0].name} » — Finance → New invoice.` : '' },
      { key: 'draft', icon: '📤', title: 'Factures prêtes à envoyer', count: draftInvoices.length, to: '/finance', cta: 'Voir les factures',
        detail: draftInvoices.length ? `${draftInvoices[0].number} (${money(draftInvoices[0].amount_minor, draftInvoices[0].currency)}) : vérifie-la, envoie-la au client, puis clique « Issue ».` : '' },
      { key: 'unpaid', icon: '💰', title: 'Factures en attente de paiement', count: openInvoices.length, to: '/finance', cta: 'Voir les factures',
        detail: openInvoices.length ? `${openInvoices[0].number} : quand l'argent arrive sur ton compte, Finance → « Record payment » avec la référence. La livraison partira toute seule. (Ce sera automatique une fois le moyen de paiement branché.)` : '' },
      { key: 'pendingpay', icon: '🔎', title: 'Paiements à confirmer avec une preuve', count: pendingPayments.length, to: '/finance', cta: 'Confirmer',
        detail: 'Vérifie le paiement sur ton relevé, puis Finance → Payments → « Confirm with evidence ».' },
    ];
    return actions.filter((a) => a.count > 0);
  }, [], 30000);

  return (
    <div className="card">
      <div className="card-head"><h2>À faire maintenant</h2><span className="small muted">calculé depuis tes données réelles</span></div>
      {!data ? <div className="empty">Chargement…</div> : data.length === 0 ? (
        <div className="empty"><strong>Rien à faire pour l'instant 👍</strong>Les agents travaillent. Tu seras prévenu ici dès qu'une décision, une livraison ou une facture t'attend.</div>
      ) : data.map((a) => (
        <div key={a.key} className="card-pad spread" style={{ borderBottom: '1px solid var(--border)', alignItems: 'flex-start' }}>
          <div style={{ display: 'flex', gap: 12 }}>
            <div style={{ fontSize: 22, lineHeight: 1 }}>{a.icon}</div>
            <div><div style={{ fontWeight: 600 }}>{a.title} <span className="badge warn">{a.count}</span></div>
              <div className="small muted" style={{ marginTop: 3, maxWidth: 720 }}>{a.detail}</div></div>
          </div>
          <Link className="btn sm primary" to={a.to}>{a.cta}</Link>
        </div>
      ))}
    </div>
  );
}
