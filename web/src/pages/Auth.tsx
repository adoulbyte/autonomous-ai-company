import { useEffect, useState } from 'react';
import { supabase } from '../lib/supabase';

export function Login() {
  const [email, setEmail] = useState(''); const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null); const [busy, setBusy] = useState(false);
  return (
    <div className="login">
      <form className="card card-pad stack" onSubmit={async (e) => {
        e.preventDefault(); setBusy(true); setError(null);
        const { error } = await supabase.auth.signInWithPassword({ email, password });
        if (error) setError(error.message); setBusy(false);
      }}>
        <div className="brand" style={{ padding: 0 }}><div className="brand-mark">▲</div><div><strong>Command Center</strong><div className="small muted">Private — owner access only</div></div></div>
        <label className="field">Email<input type="email" autoComplete="username" required value={email} onChange={(e) => setEmail(e.target.value)} /></label>
        <label className="field">Password<input type="password" autoComplete="current-password" required value={password} onChange={(e) => setPassword(e.target.value)} /></label>
        {error && <div className="alert bad">{error}</div>}
        <button className="btn primary" disabled={busy}>{busy ? 'Signing in…' : 'Sign in'}</button>
        <p className="small faint" style={{ margin: 0 }}>There is no public registration. The owner account is created in Supabase Auth.</p>
      </form>
    </div>
  );
}

export function MfaChallenge({ onDone }: { onDone: () => void }) {
  const [code, setCode] = useState(''); const [factorId, setFactorId] = useState<string | null>(null); const [error, setError] = useState<string | null>(null);
  useEffect(() => { supabase.auth.mfa.listFactors().then(({ data }) => setFactorId(data?.totp?.[0]?.id ?? null)); }, []);
  return (
    <div className="login">
      <form className="card card-pad stack" onSubmit={async (e) => {
        e.preventDefault(); if (!factorId) return; setError(null);
        const { error } = await supabase.auth.mfa.challengeAndVerify({ factorId, code });
        if (error) setError(error.message); else onDone();
      }}>
        <h1>Two-factor verification</h1>
        <label className="field">6-digit code from your authenticator<input inputMode="numeric" autoComplete="one-time-code" value={code} onChange={(e) => setCode(e.target.value)} /></label>
        {error && <div className="alert bad">{error}</div>}
        <button className="btn primary" disabled={!factorId}>Verify</button>
        <button type="button" className="btn ghost" onClick={() => supabase.auth.signOut()}>Sign out</button>
      </form>
    </div>
  );
}

export function NotAuthorized() {
  return (
    <div className="login"><div className="card card-pad stack">
      <h1>Not authorized</h1>
      <p className="muted">You are signed in, but this account is not registered as the owner of this system (or MFA is required). Every database read and action is refused for non-owners.</p>
      <button className="btn" onClick={() => supabase.auth.signOut()}>Sign out</button>
    </div></div>
  );
}
