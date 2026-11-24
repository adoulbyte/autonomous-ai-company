import { useState, type ReactNode } from 'react';
import { NavLink, useLocation } from 'react-router-dom';
import { q, supabase } from '../lib/supabase';
import { useData } from '../lib/hooks';

// Only what the owner needs to follow the business. Technical pages stay reachable by URL but are not shown.
const NAV: { section: string; items: { to: string; label: string; badge?: 'approvals' }[] }[] = [
  { section: 'Suivi', items: [{ to: '/', label: 'Tableau de bord' }, { to: '/approvals', label: 'Décisions à prendre', badge: 'approvals' }] },
  { section: 'Clients', items: [{ to: '/crm', label: 'Prospects' }, { to: '/communications', label: 'E-mails' }, { to: '/clients', label: 'Clients et avis' }] },
  { section: 'Travail', items: [{ to: '/projects', label: 'Projets' }, { to: '/finance', label: 'Finances' }] },
  { section: 'Réglages', items: [{ to: '/settings', label: 'Paramètres' }] },
];

export function Layout({ children }: { children: ReactNode }) {
  const [open, setOpen] = useState(false);
  const loc = useLocation();
  const { data } = useData(async () => {
    const [a, k] = await Promise.all([
      supabase.from('approvals').select('id', { count: 'exact', head: true }).eq('status', 'pending'),
      q<{ value: unknown }[]>(supabase.from('settings').select('value').eq('key', 'system.kill_switch')),
    ]);
    return { approvals: a.count ?? 0, kill: k[0]?.value === true };
  }, [loc.pathname], 30000);
  const toggleTheme = () => {
    const next = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
    document.documentElement.dataset.theme = next; localStorage.setItem('aic-theme', next);
  };
  return (
    <>
      {data?.kill && <div className="kill-on">Arrêt d'urgence activé : les agents sont à l'arrêt. Désactive-le dans Paramètres.</div>}
      <div className="mobile-bar"><strong>[company]</strong><button className="btn sm" onClick={() => setOpen(!open)}>Menu</button></div>
      <div className="app">
        <aside className={`sidebar ${open ? 'open' : ''}`} onClick={() => setOpen(false)}>
          <div className="brand"><div className="brand-mark">▲</div><div>[company]<div className="small muted" style={{ fontWeight: 400 }}>Centre de commande</div></div></div>
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
            <button className="btn sm" onClick={toggleTheme}>Thème</button>
            <button className="btn sm" onClick={() => supabase.auth.signOut()}>Déconnexion</button>
          </div>
        </aside>
        <main className="main">{children}</main>
      </div>
    </>
  );
}
