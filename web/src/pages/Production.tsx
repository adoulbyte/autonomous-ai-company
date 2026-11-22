import { useState } from 'react';
import { Link } from 'react-router-dom';
import { q, rpc, supabase, type Row } from '../lib/supabase';
import { useData } from '../lib/hooks';
import { ago, dt, pct } from '../lib/format';
import { ActionButton, Badge, Card, Empty, ErrorBox, Loading, Modal, PageHead, Stat, Table, Tabs } from '../components/ui';

export function DeliverableView({ id, onClose }: { id: string; onClose: () => void }) {
  const { data, reload } = useData(async () => {
    const [d, reviews] = await Promise.all([q<Row[]>(supabase.from('deliverables').select('*').eq('id', id)), q<Row[]>(supabase.from('qa_reviews').select('*').eq('deliverable_id', id).order('created_at'))]);
    return { d: d[0], reviews };
  }, [id]);
  const download = () => {
    const d = data!.d; const ext = { markdown: 'md', code: 'txt', json: 'json', text: 'txt', html: 'html', csv: 'csv' }[d.format as string] ?? 'txt';
    const url = URL.createObjectURL(new Blob([d.content], { type: 'text/plain' }));
    const a = document.createElement('a'); a.href = url; a.download = `${d.work_item}-v${d.version}.${ext}`; a.click(); URL.revokeObjectURL(url);
  };
  return <Modal title={data?.d ? `${data.d.title} · v${data.d.version}` : 'Deliverable'} onClose={onClose}>
    {!data ? <Loading /> : <div className="stack">
      <div className="row"><Badge value={data.d.status} /><span className="small muted">by {data.d.produced_by_role} ({data.d.produced_by_model}) · sha256 {String(data.d.content_hash).slice(0, 12)}…</span>
        <button className="btn sm" onClick={download}>Download</button>
        {data.d.status === 'delivered' && <ActionButton className="btn sm accent" action={() => rpc('owner_transition', { p_entity: 'deliverable', p_id: id, p_to: 'accepted', p_reason: 'client accepted' })} onDone={reload}>Client accepted</ActionButton>}
        {data.d.status === 'ready_for_delivery' && <ActionButton className="btn sm" confirm="Mark this deliverable as delivered to the client?" action={() => rpc('owner_transition', { p_entity: 'deliverable', p_id: id, p_to: 'delivered', p_reason: null })} onDone={reload}>Mark delivered</ActionButton>}</div>
      {data.d.producer_notes && <div className="alert info small" style={{ whiteSpace: 'pre-wrap' }}>{data.d.producer_notes}</div>}
      <pre>{data.d.content}</pre>
      <h3>Independent QA reviews</h3>
      {!data.reviews.length && <Empty title="Not reviewed yet" />}
      {data.reviews.map((r) => <div key={r.id} className="card card-pad"><div className="spread"><Badge value={r.verdict} /><span className="small muted">{r.reviewer_role} · {r.model} · {dt(r.created_at)}</span></div>
        <p>{r.summary}</p>
        <table><tbody>{(r.criteria_results as Row[]).map((c, i) => <tr key={i}><td>{c.met ? '✓' : '✗'}</td><td>{c.criterion}<div className="small muted">{c.evidence}</div></td></tr>)}</tbody></table>
        {(r.issues as string[]).length > 0 && <ul className="small">{(r.issues as string[]).map((x, i) => <li key={i}>{x}</li>)}</ul>}</div>)}
    </div>}
  </Modal>;
}

export function Production() {
  const [tab, setTab] = useState('qa'); const [open, setOpen] = useState<string | null>(null);
  const { data, error } = useData(async () => {
    const [dels, reviews] = await Promise.all([
      q<Row[]>(supabase.from('deliverables').select('id,title,work_item,version,status,format,created_at,project_id,produced_by_model,projects(name)').order('created_at', { ascending: false }).limit(200)),
      q<Row[]>(supabase.from('qa_reviews').select('id,verdict,created_at,deliverable_id,summary,model,deliverables(title,version)').order('created_at', { ascending: false }).limit(200)),
    ]);
    return { dels, reviews };
  }, [], 20000);
  const reviews = data?.reviews ?? []; const fails = reviews.filter((r) => r.verdict === 'fail').length;
  const firstVersions = (data?.dels ?? []).filter((d) => d.version === 1);
  return (
    <div className="stack">
      <PageHead title="Production & QA" subtitle="Producing agents never approve their own work: every deliverable is reviewed by the independent QA agent against acceptance criteria." />
      <ErrorBox error={error} />
      <div className="grid grid-4">
        <Stat label="Deliverables (all versions)" value={data?.dels.length ?? '—'} />
        <Stat label="QA reviews" value={reviews.length} sub={`${fails} rejected`} />
        <Stat label="QA rejection rate" value={reviews.length ? pct(fails / reviews.length) : '—'} />
        <Stat label="Revisions" value={(data?.dels ?? []).filter((d) => d.version > 1).length} sub={`${firstVersions.length} first versions`} />
      </div>
      <Tabs tabs={[{ key: 'qa', label: 'QA activity' }, { key: 'deliverables', label: 'Deliverables' }]} value={tab} onChange={setTab} />
      {tab === 'qa' ? <Card><Table rows={data?.reviews ?? null} onRow={(r) => setOpen(r.deliverable_id)} cols={[
        { key: 'created_at', label: 'When', render: (r) => ago(r.created_at) }, { key: 'verdict', label: 'Verdict', render: (r) => <Badge value={r.verdict} /> },
        { key: 'del', label: 'Deliverable', render: (r) => `${r.deliverables?.title} v${r.deliverables?.version}` }, { key: 'summary', label: 'Summary', render: (r) => <span className="truncate">{r.summary}</span> },
        { key: 'model', label: 'Reviewer model', render: (r) => <span className="small muted">{r.model}</span> }]} empty={<Empty title="No QA reviews yet" />} /></Card>
        : <Card><Table rows={data?.dels ?? null} onRow={(r) => setOpen(r.id)} cols={[
          { key: 'title', label: 'Deliverable', render: (r) => <div><strong>{r.title}</strong><div className="small muted"><Link className="link" to={`/projects/${r.project_id}`} onClick={(e) => e.stopPropagation()}>{r.projects?.name}</Link></div></div> },
          { key: 'version', label: 'Ver.', num: true }, { key: 'status', label: 'Status', render: (r) => <Badge value={r.status} /> }, { key: 'format', label: 'Format' },
          { key: 'created_at', label: 'When', render: (r) => ago(r.created_at) }]} empty={<Empty title="No deliverables yet" />} /></Card>}
      {open && <DeliverableView id={open} onClose={() => setOpen(null)} />}
    </div>
  );
}
