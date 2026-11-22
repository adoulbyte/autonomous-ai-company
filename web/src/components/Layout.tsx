import { useState, type ReactNode } from 'react';
import { NavLink, useLocation } from 'react-router-dom';
import { q, supabase } from '../lib/supabase';
import { useData } from '../lib/hooks';

const NAV: { section: string; items: { to: string; label: string; badge?: 'approvals' | 'dead' }[] }[] = [
  { section: 'Overview', items: [{ to: '/', label: 'Command Center' }, { to: '/approvals', label: 'Approvals', badge: 'approvals' }, { to: '/live', label: 'Live Operations' }] },
  { section: 'Revenue', items: [{ to: '/opportunities', label: 'Opportunities' }, { to: '/crm', label: 'CRM' }, { to: '/clients', label: 'Clients' }, { to: '/communications', label: 'Communications' }] },
  { section: 'Delivery', items: [{ to: '/projects', label: 'Projects' }, { to: '/production', label: 'Production & QA' }] },
  { section: 'Operations', items: [{ to: '/workforce', label: 'AI Workforce' }, { to: '/queue', label: 'Task Queue', badge: 'dead' }, { to: '/tools', label: 'Tools & Integrations' }, { to: '/health', label: 'System Health' }] },
  { section: 'Insight', items: [{ to: '/finance', label: 'Finance' }, { to: '/performance', label: 'Performance' }, { to: '/reports', label: 'Reports' }, { to: '/settings', label: 'Settings' }] },
];

export function Layout({ children }: { children: ReactNode }) {
  const [open, setOpen] = useState(false);
  const loc = useLocation();
  const { data } = useData(async () => {
    const [a, d, k] = await Promise.all([
      supabase.from('approvals').select('id', { count: 'exact', head: true }).eq('status', 'pending'),
      supabase.from('tasks').select('id', { count: 'exact', head: true }).eq('status', 'dead'),
      q<{ value: unknown }[]>(supabase.from('settings').select('value').eq('key', 'system.kill_switch')),
    ]);
    return { approvals: a.count ?? 0, dead: d.count ?? 0, kill: k[0]?.value === true };
  }, [loc.pathname], 30000);
  const toggleTheme = () => {
    const next = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
    document.documentElement.dataset.theme = next; localStorage.setItem('aic-theme', next);
  };
  return (
    <>
      {data?.kill && <div className="kill-on">Kill switch is ON — workers are not claiming tasks. Turn it off in Settings.</div>}
      <div className="mobile-bar"><strong>Command Center</strong><button className="btn sm" onClick={() => setOpen(!open)}>Menu</button></div>
      <div className="app">
        <aside className={`sidebar ${open ? 'open' : ''}`} onClick={() => setOpen(false)}>
          <div className="brand"><div className="brand-mark">▲</div><div>Command Center<div className="small muted" style={{ fontWeight: 400 }}>AI-operated business</div></div></div>
          {NAV.map((s) => (
            <div key={s.section}>
              <div className="nav-section">{s.section}</div>
              {s.items.map((i) => (
                <NavLink key={i.to} to={i.to} end={i.to === '/'} className={({ isActive }) => `nav-link ${isActive ? 'active' : ''}`}>
                  <span>{i.label}</span>
                  {i.badge && data && data[i.badge] > 0 && <span className="nav-count">{data[i.badge]}</span>}
                </NavLink>
              ))}
            </div>
          ))}
          <div className="sidebar-foot">
            <button className="btn sm" onClick={toggleTheme}>Toggle theme</button>
            <button className="btn sm" onClick={() => supabase.auth.signOut()}>Sign out</button>
          </div>
        </aside>
        <main className="main">{children}</main>
      </div>
    </>
  );
}
