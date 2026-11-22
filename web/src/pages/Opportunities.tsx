import { useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { q, rpc, supabase, type Row } from '../lib/supabase';
import { useData } from '../lib/hooks';
import { ago, date, dt, money, num, pct } from '../lib/format';
import { ActionButton, Badge, Bar, Card, Empty, ErrorBox, Json, Loading, Modal, PageHead, Table, Tabs } from '../components/ui';

const FILTERS = [
  { key: 'active', label: 'Active', statuses: ['discovered', 'analyzing', 'scored', 'shortlisted', 'monitoring', 'pursuing'] },
  { key: 'shortlisted', label: 'Selected', statuses: ['shortlisted', 'pursuing', 'won'] },
  { key: 'evaluating', label: 'Under evaluation', statuses: ['discovered', 'analyzing'] },
  { key: 'monitoring', label: 'Monitoring', statuses: ['monitoring'] },
  { key: 'rejected', label: 'Rejected', statuses: ['rejected', 'expired', 'lost'] },
  { key: 'all', label: 'All', statuses: [] as string[] },
];

export function Opportunities() {
  const [tab, setTab] = useState('active'); const [search, setSearch] = useState(''); const [adding, setAdding] = useState(false);
  const nav = useNavigate();
  const { data, error, reload } = useData(async () => {
    const f = FILTERS.find((x) => x.key === tab)!;
    let b = supabase.from('opportunities').select('id,title,status,score,decision,source_key,buyer_name,est_revenue_minor,currency,skill_fit,risk,discovered_at,posted_at,business_model')
      .is('deleted_at', null).order('score', { ascending: false, nullsFirst: false }).order('discovered_at', { ascending: false }).limit(300);
    if (f.statuses.length) b = b.in('status', f.statuses);
    if (search.trim()) b = b.ilike('title', `%${search.trim()}%`);
    return q<Row[]>(b);
  }, [tab, search], 30000);
  const sources = useData(() => q<Row[]>(supabase.from('sources').select('key,name,enabled,health,last_run_at,next_run_at,items_found_total').order('key')));

  return (
    <div className="stack">
      <PageHead title="Opportunities" subtitle="Discovered from registered sources with preserved evidence, analysed and scored with explainable rules."
        actions={<><button className="btn" onClick={() => setAdding(true)}>Add manually</button>
          <ActionButton className="btn primary" success="Discovery queued for all enabled sources; the next worker run executes it." action={async () => {
            for (const s of sources.data ?? []) if (s.enabled && s.key !== 'manual') await rpc('owner_enqueue', { p_type: 'discovery.run_source', p_input: { source_key: s.key }, p_entity_type: 'source', p_entity_id: s.key, p_title: `Discover: ${s.name}` });
          }}>Run discovery now</ActionButton></>} />
      <div className="grid grid-3">
        {(sources.data ?? []).filter((s) => s.key !== 'manual').map((s) => (
          <div key={s.key} className="card card-pad"><div className="spread"><strong>{s.name}</strong><Badge value={s.enabled ? s.health : 'disabled'} /></div>
            <div className="small muted mt">Last run {ago(s.last_run_at)} · next {ago(s.next_run_at)} · {num(s.items_found_total)} found</div></div>
        ))}
      </div>
      <Card>
        <div className="card-pad" style={{ paddingBottom: 0 }}>
          <Tabs tabs={FILTERS.map((f) => ({ key: f.key, label: f.label }))} value={tab} onChange={setTab} />
          <input placeholder="Search titles…" value={search} onChange={(e) => setSearch(e.target.value)} style={{ maxWidth: 320, marginBottom: 12 }} />
        </div>
        <ErrorBox error={error} />
        <Table rows={data} onRow={(r) => nav(`/opportunities/${r.id}`)} cols={[
          { key: 'title', label: 'Opportunity', render: (r) => <div><div className="truncate" style={{ fontWeight: 550 }}>{r.title}</div><div className="small muted">{r.buyer_name ?? '—'} · {r.source_key}</div></div> },
          { key: 'status', label: 'Status', render: (r) => <Badge value={r.status} /> },
          { key: 'score', label: 'Score', num: true, render: (r) => r.score == null ? <span className="faint">—</span> : <strong>{num(r.score, 1)}</strong> },
          { key: 'value', label: 'Est. value', num: true, render: (r) => money(r.est_revenue_minor, r.currency) },
          { key: 'skill_fit', label: 'Fit', num: true, render: (r) => pct(r.skill_fit) },
          { key: 'risk', label: 'Risk', num: true, render: (r) => pct(r.risk) },
          { key: 'discovered_at', label: 'Found', render: (r) => <span className="muted">{ago(r.discovered_at)}</span> },
        ]} empty={<Empty title="No opportunities in this view">Discovery runs on the worker schedule; use “Run discovery now” to queue it.</Empty>} />
      </Card>
      {adding && <AddManual onClose={() => { setAdding(false); reload(); }} />}
    </div>
  );
}

function AddManual({ onClose }: { onClose: () => void }) {
  const [title, setTitle] = useState(''); const [url, setUrl] = useState(''); const [text, setText] = useState(''); const [buyer, setBuyer] = useState('');
  return (
    <Modal title="Add opportunity manually" onClose={onClose}>
      <div className="stack">
        <p className="small muted" style={{ margin: 0 }}>Use for referrals or requests you received directly. The text you paste is stored as evidence and analysed like any other source.</p>
        <label className="field">Title<input value={title} onChange={(e) => setTitle(e.target.value)} /></label>
        <label className="field">Buyer / company<input value={buyer} onChange={(e) => setBuyer(e.target.value)} /></label>
        <label className="field">Source URL (or reference)<input value={url} onChange={(e) => setUrl(e.target.value)} /></label>
        <label className="field">Request text (evidence)<textarea value={text} onChange={(e) => setText(e.target.value)} /></label>
        <ActionButton className="btn primary" disabled={!title || !url || text.length < 20} success="Opportunity saved and queued for analysis" onDone={onClose} action={async () => {
          await rpc('owner_add_opportunity', { p_title: title, p_url: url, p_text: text, p_buyer: buyer || null });
        }}>Save & analyse</ActionButton>
      </div>
    </Modal>
  );
}

export function OpportunityDetail() {
  const { id } = useParams(); const nav = useNavigate();
  const { data, error, reload } = useData(async () => {
    const [opp, evidence, decisions, lead, approval] = await Promise.all([
      q<Row[]>(supabase.from('opportunities').select('*').eq('id', id!)),
      q<Row[]>(supabase.from('opportunity_evidence').select('evidence(*)').eq('opportunity_id', id!)),
      q<Row[]>(supabase.from('opportunity_decisions').select('*').eq('opportunity_id', id!).order('at', { ascending: false })),
      q<Row[]>(supabase.from('leads').select('id,stage').eq('opportunity_id', id!)),
      q<Row[]>(supabase.from('approvals').select('id,status').eq('entity_id', id!).eq('action_type', 'opportunity.pursue')),
    ]);
    return { opp: opp[0], evidence: evidence.map((e) => e.evidence), decisions, lead: lead[0], approval: approval[0] };
  }, [id]);
  if (!data) return error ? <ErrorBox error={error} /> : <Loading />;
  const o = data.opp; if (!o) return <Empty title="Opportunity not found" />;
  const b = o.score_breakdown as Row | null; const a = o.analysis as Row | null;
  return (
    <div className="stack">
      <PageHead title={o.title} subtitle={<>{o.buyer_name ?? 'Unknown buyer'} · <a className="link" href={o.url} target="_blank" rel="noreferrer noopener">source</a> · posted {date(o.posted_at)}</>}
        actions={<>
          <Badge value={o.status} />
          {data.lead ? <Link className="btn" to={`/crm/leads/${data.lead.id}`}>Open lead</Link> :
            ['scored', 'shortlisted', 'monitoring', 'rejected'].includes(o.status) && <ActionButton className="btn primary" confirm="Create a lead and have the Sales Agent draft a first message (which still needs your approval to send)?"
              success="Lead created; outreach draft queued" action={() => rpc('owner_pursue_opportunity', { p_opportunity_id: o.id })} onDone={reload}>Pursue</ActionButton>}
          {['scored', 'shortlisted', 'monitoring'].includes(o.status) && <ActionButton className="btn danger" success="Rejected" action={() => rpc('owner_transition', { p_entity: 'opportunity', p_id: o.id, p_to: 'rejected', p_reason: 'owner decision' })} onDone={reload}>Reject</ActionButton>}
          {['discovered', 'monitoring', 'scored'].includes(o.status) && <ActionButton className="btn" success="Re-analysis queued" action={() => rpc('owner_enqueue', { p_type: 'opportunity.analyze', p_input: { opportunity_id: o.id }, p_entity_type: 'opportunity', p_entity_id: o.id, p_title: 'Re-analyze' })}>Re-analyse</ActionButton>}
          <button className="btn ghost" onClick={() => nav(-1)}>Back</button>
        </>} />
      <div className="grid grid-2">
        <Card title={`Score ${o.score == null ? '—' : num(o.score, 1)} / 100`} pad>
          {!b ? <Empty title="Not scored yet">Scoring runs after the Research Analyst completes its analysis.</Empty> : <div className="stack">
            <div className="stack" style={{ gap: 6 }}>{(o.decision_reasons as string[]).map((r, i) => <div key={i} className="small">• {r}</div>)}</div>
            <table><thead><tr><th>Factor</th><th className="num">Weight</th><th>Value</th><th className="num">Points</th></tr></thead><tbody>
              {(b.components as Row[]).map((c) => <tr key={c.key}><td>{c.label}<div className="small muted">{c.explanation}</div></td><td className="num">{pct(c.weight)}</td><td style={{ minWidth: 90 }}><Bar value={c.normalized} /></td><td className="num">{num(c.points, 1)}</td></tr>)}
            </tbody></table>
            <div className="small muted">Hard constraints: {(b.hard_constraints as Row[]).map((h) => `${h.passed ? '✓' : '✗'} ${h.detail}`).join(' · ')}</div>
            <div className="small faint">Weights version {o.score_version} · expected value {money(b.expected_value_minor, o.currency)}</div>
          </div>}
        </Card>
        <Card title="Analysis" pad>
          {!a ? <Empty title="Not analysed yet" /> : <dl className="kv">
            <dt>Real request?</dt><dd>{a.is_real_request ? 'Yes' : 'No'}</dd>
            <dt>Business model</dt><dd>{o.business_model} · {o.revenue_mechanism}</dd>
            <dt>Estimated value</dt><dd>{money(o.est_revenue_minor, o.currency)} {a.stated_budget_usd ? <span className="badge ok">budget stated</span> : <span className="badge">estimate</span>}</dd>
            <dt>Effort</dt><dd>{o.est_hours == null ? '—' : `${num(o.est_hours, 1)} h`} · difficulty {pct(o.difficulty)}</dd>
            <dt>P(win) / P(paid)</dt><dd>{pct(o.p_win)} / {pct(o.p_paid)}</dd>
            <dt>Competition / risk</dt><dd>{pct(o.competition)} / {pct(o.risk)}</dd>
            <dt>Skills</dt><dd>{(o.skills as string[]).join(', ') || '—'}</dd>
            <dt>Risk flags</dt><dd>{(o.risk_flags as string[]).map((f) => <Badge key={f} value={f} tone="warn" />)}{!(o.risk_flags as string[]).length && 'none'}</dd>
            <dt>Unknowns</dt><dd>{(a.unknowns as string[] | undefined)?.join('; ') || '—'}</dd>
            <dt>Rationale</dt><dd>{a.rationale}</dd>
            <dt>Model</dt><dd className="muted">{a.provider}/{a.model} · confidence {pct(o.confidence)}</dd>
          </dl>}
        </Card>
      </div>
      <Card title={`Evidence (${data.evidence.length})`}>
        {data.evidence.map((e: Row) => <div key={e.id} className="card-pad" style={{ borderBottom: '1px solid var(--border)' }}>
          <div className="spread small muted"><a className="link" href={e.url} target="_blank" rel="noreferrer noopener">{e.url}</a><span>fetched {dt(e.fetched_at)} · sha256 {String(e.content_hash).slice(0, 12)}…</span></div>
          <pre className="mt">{e.excerpt}</pre></div>)}
      </Card>
      <Card title="Decision history">
        <Table rows={data.decisions} cols={[{ key: 'at', label: 'When', render: (r) => dt(r.at) }, { key: 'decision', label: 'Decision', render: (r) => <Badge value={r.decision} /> },
          { key: 'score', label: 'Score', num: true, render: (r) => num(r.score, 1) }, { key: 'decided_by', label: 'By' }, { key: 'reasons', label: 'Reasons', render: (r) => (r.reasons as string[]).join(' · ') }]} />
      </Card>
      {a && <details><summary className="small muted">Raw analyst output</summary><Json value={a} /></details>}
    </div>
  );
}
