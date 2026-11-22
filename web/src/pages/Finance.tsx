import { useState } from 'react';
import { q, rpc, supabase, type Row } from '../lib/supabase';
import { useData } from '../lib/hooks';
import { date, dt, money, toMinor } from '../lib/format';
import { ActionButton, Badge, Card, Empty, ErrorBox, Modal, PageHead, Stat, Table, Tabs } from '../components/ui';

const EVIDENCE = [
  { key: 'statement_line', label: 'Bank / RedotPay statement line (reference)' },
  { key: 'provider_api_lookup', label: 'Payment provider dashboard/API transaction ID' },
  { key: 'owner_confirmed', label: 'Owner confirmation (describe what you verified)' },
];

export function Finance() {
  const [tab, setTab] = useState('invoices'); const [modal, setModal] = useState<null | 'invoice' | 'expense' | { pay: Row } | { confirm: Row }>(null);
  const { data, error, reload } = useData(async () => {
    const [summary, invoices, payments, expenses, projects, profit, ai] = await Promise.all([
      q<Row[]>(supabase.from('v_finance_by_currency').select('*')),
      q<Row[]>(supabase.from('invoices').select('*, projects(name), clients(companies(name))').order('created_at', { ascending: false })),
      q<Row[]>(supabase.from('payments').select('*, invoices(number)').order('created_at', { ascending: false })),
      q<Row[]>(supabase.from('expenses').select('*, projects(name)').order('incurred_on', { ascending: false })),
      q<Row[]>(supabase.from('projects').select('id,name,budget_minor,currency,status,lead_id, leads(value_minor, stage)').order('created_at', { ascending: false })),
      q<Row[]>(supabase.from('v_project_profitability').select('*')),
      q<Row[]>(supabase.from('ai_calls').select('cost_micros, prompt_tokens, completion_tokens').gte('at', new Date(Date.now() - 30 * 86400000).toISOString())),
    ]);
    return { summary, invoices, payments, expenses, projects, profit, ai };
  }, [], 30000);
  const pipeline = (data?.projects ?? []).filter((p) => ['planning', 'in_progress', 'in_qa', 'ready_for_delivery', 'delivered', 'revision'].includes(p.status));
  const openLeads = useData(() => q<Row[]>(supabase.from('leads').select('value_minor,currency,stage,score').not('stage', 'in', '(won,lost,disqualified)')));
  return (
    <div className="stack">
      <PageHead title="Finance" subtitle="Integer minor units with explicit currencies. Revenue counts only when a payment is confirmed with verifiable evidence."
        actions={<><button className="btn" onClick={() => setModal('expense')}>Record expense</button><button className="btn primary" onClick={() => setModal('invoice')}>New invoice</button></>} />
      <ErrorBox error={error} />
      {(data?.summary ?? []).map((s) => <div key={s.currency} className="grid grid-4">
        <Stat label={`Confirmed revenue (${s.currency})`} value={money(s.confirmed_revenue_minor, s.currency)} accent sub="evidence-backed payments only" />
        <Stat label="Receivable" value={money(s.receivable_minor, s.currency)} sub={`invoiced ${money(s.invoiced_minor, s.currency)}`} />
        <Stat label="Expenses" value={money(s.expenses_minor, s.currency)} />
        <Stat label="Net profit" value={money(s.net_profit_minor, s.currency)} />
      </div>)}
      {data && !data.summary.length && <Card pad><Empty title="No financial records yet">Revenue appears here only after an invoice is paid and the payment is confirmed with evidence.</Empty></Card>}
      <div className="grid grid-3">
        <Stat label="Contracted, not yet invoiced/paid (forecast)" value={pipeline.length ? pipeline.map((p) => money(p.budget_minor, p.currency)).join(' + ') : '—'} sub={`${pipeline.length} active projects — expected, not received`} />
        <Stat label="Open lead pipeline (forecast)" value={money((openLeads.data ?? []).reduce((s, l) => s + Number(l.value_minor ?? 0), 0))} sub={`${openLeads.data?.length ?? 0} leads, unweighted estimate`} />
        <Stat label="AI usage, last 30 days" value={money((data?.ai ?? []).reduce((s, r) => s + Number(r.cost_micros), 0) / 10000)} sub={`${(data?.ai ?? []).length} calls on free tiers · ${(data?.ai ?? []).reduce((s, r) => s + r.prompt_tokens + r.completion_tokens, 0).toLocaleString()} tokens`} />
      </div>
      <Tabs tabs={[{ key: 'invoices', label: 'Invoices' }, { key: 'payments', label: 'Payments' }, { key: 'expenses', label: 'Expenses' }, { key: 'profit', label: 'Project profitability' }]} value={tab} onChange={setTab} />
      {tab === 'invoices' && <Card><Table rows={data?.invoices ?? null} cols={[
        { key: 'number', label: 'Invoice' }, { key: 'project', label: 'Project', render: (r) => r.projects?.name ?? '—' }, { key: 'client', label: 'Client', render: (r) => r.clients?.companies?.name ?? '—' },
        { key: 'amount', label: 'Amount', num: true, render: (r) => money(r.amount_minor, r.currency) }, { key: 'status', label: 'Status', render: (r) => <Badge value={r.status} /> },
        { key: 'due_date', label: 'Due', render: (r) => date(r.due_date) },
        { key: 'actions', label: '', render: (r) => <div className="row">
          {r.status === 'draft' && <ActionButton className="btn sm" confirm="Mark invoice as issued (sent to the client)?" action={() => rpc('owner_transition', { p_entity: 'invoice', p_id: r.id, p_to: 'issued', p_reason: null })} onDone={reload}>Issue</ActionButton>}
          {['issued', 'partially_paid', 'overdue'].includes(r.status) && <button className="btn sm primary" onClick={() => setModal({ pay: r })}>Record payment</button>}
          {['draft', 'issued'].includes(r.status) && <ActionButton className="btn sm ghost" confirm="Void this invoice?" action={() => rpc('owner_transition', { p_entity: 'invoice', p_id: r.id, p_to: 'void', p_reason: window.prompt('Reason') ?? 'voided' })} onDone={reload}>Void</ActionButton>}
        </div> }]} empty={<Empty title="No invoices yet" />} /></Card>}
      {tab === 'payments' && <Card><Table rows={data?.payments ?? null} cols={[
        { key: 'created_at', label: 'Recorded', render: (r) => dt(r.created_at) }, { key: 'invoice', label: 'Invoice', render: (r) => r.invoices?.number ?? '—' },
        { key: 'amount', label: 'Amount', num: true, render: (r) => money(r.amount_minor, r.currency) }, { key: 'method', label: 'Method' }, { key: 'external_ref', label: 'Reference' },
        { key: 'status', label: 'Status', render: (r) => <Badge value={r.status} /> },
        { key: 'evidence', label: 'Evidence', render: (r) => r.evidence_type ? <span className="small">{r.evidence_type}: {r.evidence_ref}</span> : <span className="faint">none</span> },
        { key: 'a', label: '', render: (r) => r.status === 'pending' && <button className="btn sm primary" onClick={() => setModal({ confirm: r })}>Confirm with evidence</button> }]} empty={<Empty title="No payments recorded" />} /></Card>}
      {tab === 'expenses' && <Card><Table rows={data?.expenses ?? null} cols={[{ key: 'incurred_on', label: 'Date', render: (r) => date(r.incurred_on) }, { key: 'category', label: 'Category', render: (r) => <Badge value={r.category} /> },
        { key: 'description', label: 'Description' }, { key: 'project', label: 'Project', render: (r) => r.projects?.name ?? 'overhead' }, { key: 'amount', label: 'Amount', num: true, render: (r) => money(r.amount_minor, r.currency) }]} empty={<Empty title="No expenses recorded">Infrastructure and AI currently run on free tiers ($0).</Empty>} /></Card>}
      {tab === 'profit' && <Card><Table rows={data?.profit ?? null} cols={[{ key: 'name', label: 'Project' }, { key: 'status', label: 'Status', render: (r) => <Badge value={r.status} /> },
        { key: 'budget', label: 'Price', num: true, render: (r) => money(r.budget_minor, r.currency) }, { key: 'revenue', label: 'Confirmed revenue', num: true, render: (r) => money(r.revenue_minor, r.currency) },
        { key: 'expenses', label: 'Expenses', num: true, render: (r) => money(r.expenses_minor, r.currency) }, { key: 'ai_calls', label: 'AI calls', num: true },
        { key: 'margin', label: 'Gross margin', num: true, render: (r) => Number(r.revenue_minor) ? `${Math.round(((Number(r.revenue_minor) - Number(r.expenses_minor)) / Number(r.revenue_minor)) * 100)}%` : '—' }]} /></Card>}
      {modal === 'invoice' && <InvoiceForm projects={data?.projects ?? []} onClose={() => { setModal(null); reload(); }} />}
      {modal === 'expense' && <ExpenseForm projects={data?.projects ?? []} onClose={() => { setModal(null); reload(); }} />}
      {modal && typeof modal === 'object' && 'pay' in modal && <PaymentForm invoice={modal.pay} onClose={() => { setModal(null); reload(); }} />}
      {modal && typeof modal === 'object' && 'confirm' in modal && <ConfirmForm payment={modal.confirm} onClose={() => { setModal(null); reload(); }} />}
    </div>
  );
}

function InvoiceForm({ projects, onClose }: { projects: Row[]; onClose: () => void }) {
  const [project, setProject] = useState(projects[0]?.id ?? ''); const p = projects.find((x) => x.id === project);
  const [amount, setAmount] = useState(''); const [days, setDays] = useState('14'); const [notes, setNotes] = useState('');
  return <Modal title="New invoice (draft)" onClose={onClose}><div className="stack">
    {!projects.length ? <Empty title="Create a project first" /> : <>
      <label className="field">Project<select value={project} onChange={(e) => setProject(e.target.value)}>{projects.map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}</select></label>
      <div className="form-grid"><label className="field">Amount ({p?.currency})<input value={amount} placeholder={p ? String(Number(p.budget_minor ?? 0) / 100) : ''} onChange={(e) => setAmount(e.target.value)} /></label>
        <label className="field">Due in days<input value={days} onChange={(e) => setDays(e.target.value)} /></label></div>
      <label className="field">Notes<textarea value={notes} onChange={(e) => setNotes(e.target.value)} /></label>
      <ActionButton className="btn primary" disabled={!amount} success="Invoice drafted" onDone={onClose}
        action={() => rpc('owner_create_invoice', { p_project_id: project, p_amount_minor: toMinor(amount), p_currency: p?.currency ?? 'USD', p_due_days: Number(days) || 14, p_milestone_id: null, p_notes: notes || null })}>Create draft invoice</ActionButton></>}
  </div></Modal>;
}

function PaymentForm({ invoice, onClose }: { invoice: Row; onClose: () => void }) {
  const [amount, setAmount] = useState(String(Number(invoice.amount_minor) / 100)); const [method, setMethod] = useState('redotpay'); const [ref, setRef] = useState('');
  const [confirm, setConfirm] = useState(false); const [ev, setEv] = useState('statement_line'); const [evRef, setEvRef] = useState(''); const [note, setNote] = useState('');
  return <Modal title={`Record payment for ${invoice.number}`} onClose={onClose}><div className="stack">
    <div className="alert info small">A client saying “I paid” is not evidence. Record the payment as pending until you have verified it in your bank/RedotPay statement or provider dashboard.</div>
    <div className="form-grid"><label className="field">Amount ({invoice.currency})<input value={amount} onChange={(e) => setAmount(e.target.value)} /></label>
      <label className="field">Method<select value={method} onChange={(e) => setMethod(e.target.value)}>{['redotpay', 'bank_transfer', 'card_processor', 'crypto', 'marketplace', 'other'].map((m) => <option key={m}>{m}</option>)}</select></label></div>
    <label className="field">Transaction reference (from the provider)<input value={ref} onChange={(e) => setRef(e.target.value)} /></label>
    <label className="row small"><input type="checkbox" style={{ width: 'auto' }} checked={confirm} onChange={(e) => setConfirm(e.target.checked)} /> I have verified this payment arrived</label>
    {confirm && <EvidenceFields ev={ev} setEv={setEv} evRef={evRef} setEvRef={setEvRef} note={note} setNote={setNote} />}
    <ActionButton className="btn primary" disabled={!amount || !ref || (confirm && evRef.length < 3)} success={confirm ? 'Payment confirmed' : 'Recorded as pending'} onDone={onClose}
      action={() => rpc('owner_record_payment', { p_invoice_id: invoice.id, p_amount_minor: toMinor(amount), p_currency: invoice.currency, p_method: method, p_external_ref: ref, p_confirm: confirm,
        p_evidence_type: confirm ? ev : null, p_evidence_ref: confirm ? evRef : null, p_evidence_note: note || null, p_received_at: null })}>Save</ActionButton>
  </div></Modal>;
}

function EvidenceFields({ ev, setEv, evRef, setEvRef, note, setNote }: { ev: string; setEv: (v: string) => void; evRef: string; setEvRef: (v: string) => void; note: string; setNote: (v: string) => void }) {
  return <>
    <label className="field">Evidence type<select value={ev} onChange={(e) => setEv(e.target.value)}>{EVIDENCE.map((e) => <option key={e.key} value={e.key}>{e.label}</option>)}</select></label>
    <label className="field">Evidence reference (statement line / transaction ID / what you checked)<input value={evRef} onChange={(e) => setEvRef(e.target.value)} /></label>
    <label className="field">Note<input value={note} onChange={(e) => setNote(e.target.value)} /></label></>;
}

function ConfirmForm({ payment, onClose }: { payment: Row; onClose: () => void }) {
  const [ev, setEv] = useState('statement_line'); const [evRef, setEvRef] = useState(''); const [note, setNote] = useState('');
  return <Modal title={`Confirm payment ${money(payment.amount_minor, payment.currency)}`} onClose={onClose}><div className="stack">
    <EvidenceFields ev={ev} setEv={setEv} evRef={evRef} setEvRef={setEvRef} note={note} setNote={setNote} />
    <ActionButton className="btn primary" disabled={evRef.length < 3} success="Payment confirmed" onDone={onClose}
      action={() => rpc('owner_confirm_payment', { p_payment_id: payment.id, p_evidence_type: ev, p_evidence_ref: evRef, p_evidence_note: note || null })}>Confirm</ActionButton>
  </div></Modal>;
}

function ExpenseForm({ projects, onClose }: { projects: Row[]; onClose: () => void }) {
  const [v, setV] = useState({ category: 'tools', description: '', amount: '', currency: 'USD', project_id: '' });
  return <Modal title="Record expense" onClose={onClose}><div className="stack">
    <div className="form-grid"><label className="field">Category<select value={v.category} onChange={(e) => setV({ ...v, category: e.target.value })}>{['ai', 'infrastructure', 'tools', 'marketplace_fees', 'payment_fees', 'marketing', 'contractor', 'other'].map((c) => <option key={c}>{c}</option>)}</select></label>
      <label className="field">Project<select value={v.project_id} onChange={(e) => setV({ ...v, project_id: e.target.value })}><option value="">Overhead</option>{projects.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</select></label></div>
    <label className="field">Description<input value={v.description} onChange={(e) => setV({ ...v, description: e.target.value })} /></label>
    <div className="form-grid"><label className="field">Amount<input value={v.amount} onChange={(e) => setV({ ...v, amount: e.target.value })} /></label>
      <label className="field">Currency<input value={v.currency} onChange={(e) => setV({ ...v, currency: e.target.value.toUpperCase() })} /></label></div>
    <ActionButton className="btn primary" disabled={!v.description || !v.amount} success="Expense recorded" onDone={onClose}
      action={() => q(supabase.from('expenses').insert({ category: v.category, description: v.description, amount_minor: toMinor(v.amount), currency: v.currency, project_id: v.project_id || null }))}>Save</ActionButton>
  </div></Modal>;
}
