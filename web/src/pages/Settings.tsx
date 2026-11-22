import { useState } from 'react';
import { q, rpc, supabase, type Row } from '../lib/supabase';
import { useData } from '../lib/hooks';
import { dt } from '../lib/format';
import { ActionButton, Badge, Card, ErrorBox, PageHead } from '../components/ui';

export function Settings() {
  const { data, error, reload } = useData(() => q<Row[]>(supabase.from('settings').select('*').order('key')));
  const kill = data?.find((s) => s.key === 'system.kill_switch')?.value === true;
  return (
    <div className="stack">
      <PageHead title="Settings" subtitle="Business rules, limits and security. Every change is versioned in the audit log. Critical rules proposed by agents require your approval." />
      <ErrorBox error={error} />
      <Card title="Emergency kill switch" pad>
        <div className="spread"><div>{kill ? <Badge value="ON — all work stopped" tone="bad" /> : <Badge value="off — system operating" tone="ok" />}
          <p className="small muted">When on, workers claim no tasks and nothing is processed. Takes effect at the next claim (within one worker cycle).</p></div>
          <ActionButton className={`btn ${kill ? 'primary' : 'danger solid'}`} confirm={kill ? 'Resume operations?' : 'Stop all autonomous work now?'} onDone={reload}
            action={() => rpc('owner_set_setting', { p_key: 'system.kill_switch', p_value: !kill })}>{kill ? 'Resume operations' : 'Activate kill switch'}</ActionButton></div>
      </Card>
      <MfaCard />
      {data?.filter((s) => s.key !== 'system.kill_switch').map((s) => <SettingEditor key={s.key} s={s} onSaved={reload} />)}
    </div>
  );
}

function SettingEditor({ s, onSaved }: { s: Row; onSaved: () => void }) {
  const [text, setText] = useState(JSON.stringify(s.value, null, 2));
  const dirty = text !== JSON.stringify(s.value, null, 2);
  return <Card title={<span className="row"><code>{s.key}</code>{s.critical && <Badge value="critical rule" tone="warn" />}</span>} actions={<span className="small muted">v{s.version} · {dt(s.updated_at)}</span>} pad>
    <p className="small muted" style={{ marginTop: 0 }}>{s.description}</p>
    <textarea className="mono" style={{ minHeight: Math.min(320, 40 + text.split('\n').length * 18) }} value={text} onChange={(e) => setText(e.target.value)} />
    <div className="row mt"><ActionButton className="btn sm primary" disabled={!dirty} success="Saved (audited)" onDone={onSaved}
      confirm={s.critical ? 'This is a critical business rule. Save the change?' : undefined}
      action={async () => { let v: unknown; try { v = JSON.parse(text); } catch { throw new Error('Invalid JSON'); } await rpc('owner_set_setting', { p_key: s.key, p_value: v }); }}>Save</ActionButton>
      {dirty && <button className="btn sm ghost" onClick={() => setText(JSON.stringify(s.value, null, 2))}>Reset</button>}</div>
  </Card>;
}

function MfaCard() {
  const { data, reload } = useData(async () => (await supabase.auth.mfa.listFactors()).data);
  const [enroll, setEnroll] = useState<{ id: string; qr: string; secret: string } | null>(null); const [code, setCode] = useState('');
  const verified = data?.totp?.filter((f) => f.status === 'verified') ?? [];
  return <Card title="Two-factor authentication (TOTP)" pad><div className="stack">
    <div>{verified.length ? <Badge value="enrolled" tone="ok" /> : <Badge value="not enrolled" tone="warn" />}
      <span className="small muted"> After enrolling, set <code>security.require_mfa</code> to <code>true</code> below so the database refuses owner access without a second factor.</span></div>
    {!verified.length && !enroll && <ActionButton className="btn" action={async () => {
      const { data, error } = await supabase.auth.mfa.enroll({ factorType: 'totp' }); if (error) throw error;
      setEnroll({ id: data.id, qr: data.totp.qr_code, secret: data.totp.secret }); }}>Enroll authenticator</ActionButton>}
    {enroll && <><img src={enroll.qr} alt="TOTP QR code" width={180} height={180} style={{ background: '#fff', borderRadius: 8 }} /><code className="small">{enroll.secret}</code>
      <input placeholder="6-digit code" value={code} onChange={(e) => setCode(e.target.value)} style={{ maxWidth: 200 }} />
      <ActionButton className="btn primary" success="MFA enrolled" onDone={() => { setEnroll(null); reload(); }} action={async () => {
        const { error } = await supabase.auth.mfa.challengeAndVerify({ factorId: enroll.id, code }); if (error) throw error; }}>Verify & enable</ActionButton></>}
  </div></Card>;
}
