import { useEffect, useState } from 'react';
import { Navigate, Route, Routes } from 'react-router-dom';
import type { Session } from '@supabase/supabase-js';
import { configured, rpc, supabase } from './lib/supabase';
import { Layout } from './components/Layout';
import { Login, MfaChallenge, NotAuthorized } from './pages/Auth';
import { CommandCenter } from './pages/CommandCenter';
import { Opportunities, OpportunityDetail } from './pages/Opportunities';
import { Crm, LeadDetail } from './pages/Crm';
import { Clients } from './pages/Clients';
import { Projects, ProjectDetail } from './pages/Projects';
import { Production } from './pages/Production';
import { Workforce } from './pages/Workforce';
import { LiveOps } from './pages/LiveOps';
import { TaskQueue } from './pages/TaskQueue';
import { Approvals } from './pages/Approvals';
import { Communications } from './pages/Communications';
import { Finance } from './pages/Finance';
import { Performance } from './pages/Performance';
import { Reports } from './pages/Reports';
import { Tools } from './pages/Tools';
import { Settings } from './pages/Settings';
import { Health } from './pages/Health';

type AuthState = 'loading' | 'signed_out' | 'needs_mfa' | 'not_owner' | 'owner';

export function App() {
  const [session, setSession] = useState<Session | null>(null);
  const [state, setState] = useState<AuthState>('loading');

  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => setSession(data.session));
    const { data: sub } = supabase.auth.onAuthStateChange((_e, s) => setSession(s));
    return () => sub.subscription.unsubscribe();
  }, []);

  useEffect(() => {
    (async () => {
      if (!session) { setState('signed_out'); return; }
      const { data: aal } = await supabase.auth.mfa.getAuthenticatorAssuranceLevel();
      if (aal && aal.nextLevel === 'aal2' && aal.currentLevel !== 'aal2') { setState('needs_mfa'); return; }
      try { setState((await rpc<boolean>('is_owner')) ? 'owner' : 'not_owner'); } catch { setState('not_owner'); }
    })();
  }, [session]);

  if (!configured) return <div className="login"><div className="card card-pad"><h1>Not configured</h1><p className="muted">This build has no Supabase URL/key. Set VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY at build time.</p></div></div>;
  if (state === 'loading') return <div className="login"><div className="muted">Loading…</div></div>;
  if (state === 'signed_out') return <Login />;
  if (state === 'needs_mfa') return <MfaChallenge onDone={() => supabase.auth.refreshSession()} />;
  if (state === 'not_owner') return <NotAuthorized />;

  return (
    <Layout>
      <Routes>
        <Route path="/" element={<CommandCenter />} />
        <Route path="/opportunities" element={<Opportunities />} />
        <Route path="/opportunities/:id" element={<OpportunityDetail />} />
        <Route path="/crm" element={<Crm />} />
        <Route path="/crm/leads/:id" element={<LeadDetail />} />
        <Route path="/clients" element={<Clients />} />
        <Route path="/projects" element={<Projects />} />
        <Route path="/projects/:id" element={<ProjectDetail />} />
        <Route path="/production" element={<Production />} />
        <Route path="/workforce" element={<Workforce />} />
        <Route path="/live" element={<LiveOps />} />
        <Route path="/queue" element={<TaskQueue />} />
        <Route path="/approvals" element={<Approvals />} />
        <Route path="/communications" element={<Communications />} />
        <Route path="/finance" element={<Finance />} />
        <Route path="/performance" element={<Performance />} />
        <Route path="/reports" element={<Reports />} />
        <Route path="/tools" element={<Tools />} />
        <Route path="/settings" element={<Settings />} />
        <Route path="/health" element={<Health />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </Layout>
  );
}
