import { useState } from 'react';
import { q, rpc, supabase, type Row } from '../lib/supabase';
import { useData } from '../lib/hooks';
import { ago } from '../lib/format';
import { ActionButton, Badge, Card, ErrorBox, Json, Modal, PageHead, Table, Tabs } from '../components/ui';

export function Tools() {
  const [tab, setTab] = useState('sources'); const [edit, setEdit] = useState<Row | null>(null);
  const { data, error, reload } = useData(async () => ({
    tools: await q<Row[]>(supabase.from('tools').select('*').order('key')),
    providers: await q<Row[]>(supabase.from('ai_providers').select('*').order('priority')),
    models: await q<Row[]>(supabase.from('ai_models').select('*').order('provider_key').order('tier')),
    sources: await q<Row[]>(supabase.from('sources').select('*').order('key')),
  }), [], 30000);
  const toggle = (table: string, keyCol: string, row: Row) => q(supabase.from(table).update({ enabled: !row.enabled }).eq(keyCol, row[keyCol]));
  return (
    <div className="stack">
      <PageHead title="Tools & Integrations" subtitle="Registry of sources, AI providers/models and agent tools, with permissions, limits and health." />
      <Tabs tabs={[{ key: 'sources', label: 'Opportunity sources' }, { key: 'ai', label: 'AI providers & models' }, { key: 'tools', label: 'Agent tools' }]} value={tab} onChange={setTab} />
      <ErrorBox error={error} />
      {tab === 'sources' && <Card><Table rows={data?.sources ?? null} onRow={setEdit} cols={[
        { key: 'name', label: 'Source', render: (r) => <div><strong>{r.name}</strong><div className="small muted">{r.connector} · every {r.interval_minutes} min · max {r.max_items_per_run}/run</div></div> },
        { key: 'health', label: 'Health', render: (r) => <Badge value={r.enabled ? r.health : 'disabled'} /> }, { key: 'last_run_at', label: 'Last run', render: (r) => ago(r.last_run_at) },
        { key: 'items_found_total', label: 'Found', num: true }, { key: 'last_error', label: 'Last error', render: (r) => <span className="small muted truncate">{r.last_error ?? ''}</span> },
        { key: 'x', label: '', render: (r) => <div className="row">{r.kind === 'api' && <ActionButton className="btn sm" success="Queued" action={() => rpc('owner_enqueue', { p_type: 'discovery.run_source', p_input: { source_key: r.key }, p_entity_type: 'source', p_entity_id: r.key, p_title: `Discover: ${r.name}` })}>Run now</ActionButton>}
          <ActionButton className="btn sm ghost" action={() => toggle('sources', 'key', r)} onDone={reload}>{r.enabled ? 'Disable' : 'Enable'}</ActionButton></div> }]} /></Card>}
      {tab === 'ai' && <><Card title="Providers"><Table rows={data?.providers ?? null} cols={[{ key: 'name', label: 'Provider', render: (r) => <div><strong>{r.name}</strong><div className="small muted">{r.notes}</div></div> },
        { key: 'api_key_env', label: 'Key (GitHub secret name)', render: (r) => <code>{r.api_key_env}</code> }, { key: 'priority', label: 'Priority', num: true },
        { key: 'data_policy', label: 'Data policy', render: (r) => <span className="small">{r.data_policy}</span> },
        { key: 'enabled', label: '', render: (r) => <ActionButton className="btn sm ghost" action={() => toggle('ai_providers', 'key', r)} onDone={reload}>{r.enabled ? 'Disable' : 'Enable'}</ActionButton> }]} /></Card>
        <Card title="Model registry"><Table rows={data?.models ?? null} cols={[{ key: 'model', label: 'Model', render: (r) => <div>{r.display_name ?? r.model}<div className="small muted mono">{r.provider_key}/{r.model}</div></div> },
          { key: 'tier', label: 'Tier', render: (r) => <Badge value={r.tier} tone="info" /> },
          { key: 'state', label: 'State', render: (r) => !r.enabled ? <Badge value="disabled" tone="bad" /> : r.cooldown_until && new Date(r.cooldown_until) > new Date() ? <Badge value={`cooldown ${ago(r.cooldown_until)}`} tone="warn" /> : <Badge value="available" tone="ok" /> },
          { key: 'last_success_at', label: 'Last success', render: (r) => ago(r.last_success_at) }, { key: 'last_error', label: 'Last error', render: (r) => <span className="small muted truncate">{r.last_error ?? ''}</span> },
          { key: 'x', label: '', render: (r) => <ActionButton className="btn sm ghost" action={() => q(supabase.from('ai_models').update({ enabled: !r.enabled, cooldown_until: null, consecutive_failures: 0 }).eq('id', r.id))} onDone={reload}>{r.enabled ? 'Disable' : 'Enable'}</ActionButton> }]} /></Card></>}
      {tab === 'tools' && <Card><Table rows={data?.tools ?? null} cols={[{ key: 'name', label: 'Tool', render: (r) => <div><strong>{r.name}</strong><div className="small muted">{r.description}</div></div> },
        { key: 'security_class', label: 'Class', render: (r) => <Badge value={r.security_class} tone={r.security_class.startsWith('write_external') || r.security_class === 'financial' ? 'warn' : ''} /> },
        { key: 'allowed_roles', label: 'Allowed agents', render: (r) => <span className="small">{(r.allowed_roles as string[]).join(', ') || 'none'}</span> },
        { key: 'requires_approval', label: 'Approval', render: (r) => r.requires_approval ? 'required' : 'no' }, { key: 'cost_model', label: 'Cost' },
        { key: 'health', label: 'Health', render: (r) => <Badge value={r.enabled ? r.health : 'disabled'} /> }]} /></Card>}
      {edit && <SourceEditor source={edit} onClose={() => { setEdit(null); reload(); }} />}
    </div>
  );
}

function SourceEditor({ source, onClose }: { source: Row; onClose: () => void }) {
  const [interval, setInterval_] = useState(String(source.interval_minutes)); const [max, setMax] = useState(String(source.max_items_per_run)); const [config, setConfig] = useState(JSON.stringify(source.config, null, 2));
  return <Modal title={source.name} onClose={onClose}><div className="stack">
    <p className="small muted" style={{ margin: 0 }}>{source.description}</p><div className="alert info small">{source.terms_notes}</div>
    <div className="form-grid"><label className="field">Interval (minutes, ≥15)<input value={interval} onChange={(e) => setInterval_(e.target.value)} /></label>
      <label className="field">Max items per run<input value={max} onChange={(e) => setMax(e.target.value)} /></label></div>
    <label className="field">Config (JSON)<textarea className="mono" value={config} onChange={(e) => setConfig(e.target.value)} /></label>
    <ActionButton className="btn primary" success="Source updated" onDone={onClose} action={() => q(supabase.from('sources').update({ interval_minutes: Number(interval), max_items_per_run: Number(max), config: JSON.parse(config) }).eq('key', source.key))}>Save</ActionButton>
    <details><summary className="small muted">Raw</summary><Json value={source} /></details>
  </div></Modal>;
}
