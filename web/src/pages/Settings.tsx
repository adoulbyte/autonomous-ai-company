import { useEffect, useState } from 'react';
import { q, rpc, supabase, type Row } from '../lib/supabase';
import { useData } from '../lib/hooks';
import { dt } from '../lib/format';
import { ActionButton, Badge, Card, ErrorBox, PageHead } from '../components/ui';

type FieldType = 'text' | 'textarea' | 'number' | 'money' | 'toggle' | 'percent' | 'select' | 'image';
interface Field { path: string; label: string; type: FieldType; help?: string; placeholder?: string; options?: { value: string; label: string }[] }
interface Section { key: string; title: string; intro: string; fields: Field[] }

const SECTIONS: Section[] = [
  { key: 'business.mode', title: 'Mode commercial', intro: 'Mode lancement : les agents réalisent le travail gratuitement en échange d’un avis honnête, pour prouver la qualité et obtenir des références. Passe en mode payant quand les résultats sont concluants.', fields: [
    { path: 'mode', label: 'Mode', type: 'select', options: [{ value: 'free_pilot', label: 'Lancement — gratuit contre un avis' }, { value: 'paid', label: 'Payant — prix du marché + facture' }] },
    { path: 'max_active_pilots', label: 'Projets gratuits en cours au maximum', type: 'number' },
  ] },
  { key: 'business.identity', title: 'Identité de la société', intro: 'Utilisée dans tous les e-mails, propositions et factures envoyés aux clients.', fields: [
    { path: 'logo_data_url', label: 'Logo (affiché en haut de chaque e-mail)', type: 'image', help: 'PNG ou JPG. Il est réduit automatiquement ; il reste dans ta base, jamais dans le code.' },
    { path: 'company_name', label: 'Nom de la société', type: 'text' },
    { path: 'representative', label: 'Représentant', type: 'text' },
    { path: 'sender_name', label: "Nom d'expéditeur des e-mails", type: 'text' },
    { path: 'tagline', label: 'Slogan (en-tête des e-mails et factures)', type: 'text' },
    { path: 'website', label: 'Site web (facultatif)', type: 'text', placeholder: 'https://…' },
    { path: 'signature', label: 'Signature des e-mails', type: 'textarea' },
    { path: 'ai_disclosure', label: 'Mention de transparence IA (obligatoire, courte)', type: 'text' },
  ] },
  { key: 'finance.payment_instructions', title: 'Coordonnées de paiement (factures)', intro: 'Imprimées sur chaque facture. Tant que ce n’est pas activé, les factures restent prêtes mais ne sont pas envoyées.', fields: [
    { path: 'enabled', label: 'Activer l’envoi des factures avec ces coordonnées', type: 'toggle' },
    { path: 'beneficiary', label: 'Bénéficiaire', type: 'text' },
    { path: 'iban', label: 'IBAN', type: 'text' },
    { path: 'bic', label: 'BIC / SWIFT', type: 'text' },
    { path: 'bank', label: 'Banque', type: 'text' },
    { path: 'text', label: 'Instructions complémentaires', type: 'textarea' },
    { path: 'reference_hint', label: 'Consigne de référence de paiement', type: 'text' },
  ] },
  { key: 'comms.policy', title: 'Prospection et e-mails', intro: 'Volume d’envoi. Gmail limite un compte standard à environ 500 destinataires par jour : au-delà, Google suspend l’envoi.', fields: [
    { path: 'daily_send_cap', label: 'E-mails maximum par jour (tous types)', type: 'number' },
    { path: 'max_outreach_per_day', label: 'Premiers contacts maximum par jour', type: 'number' },
    { path: 'max_followups', label: 'Relances maximum par prospect', type: 'number' },
    { path: 'followup_after_days', label: 'Relancer après (jours sans réponse)', type: 'number' },
    { path: 'require_email_contact_for_outreach', label: 'Ne prospecter que les demandes avec une adresse e-mail publiée', type: 'toggle' },
  ] },
  { key: 'prospecting.policy', title: 'Prospection des entreprises', intro: 'Les agents contactent en continu des entreprises locales qui publient une adresse e-mail professionnelle (sites vitrines, visuels, scénarios publicitaires, documents PDF/Excel). Le volume augmente chaque jour pour protéger la réputation de la boîte Gmail.', fields: [
    { path: 'start_per_day', label: 'Nouveaux contacts par jour au démarrage', type: 'number' },
    { path: 'step_per_day', label: 'Augmentation chaque jour', type: 'number' },
    { path: 'max_per_day', label: 'Nouveaux contacts par jour au maximum', type: 'number' },
  ] },
  { key: 'pricing.catalog', title: 'Carte des prestations rapides (prix fixes)', intro: 'Proposée aux commerces prospectés : le client choisit dans le formulaire de devis du bouton « Je suis intéressé ». Les agents appliquent exactement ces prix.', fields: [
    { path: 'items.website.price_minor', label: 'Site vitrine une page', type: 'money' },
    { path: 'items.social_post.price_minor', label: 'Visuel pour réseaux sociaux', type: 'money' },
    { path: 'items.social_pack.price_minor', label: 'Pack de 3 visuels', type: 'money' },
    { path: 'items.flyer_pdf.price_minor', label: 'Flyer ou menu en PDF', type: 'money' },
    { path: 'items.ad_scripts.price_minor', label: '3 scénarios publicitaires', type: 'money' },
    { path: 'items.spreadsheet.price_minor', label: 'Tableau Excel sur mesure', type: 'money' },
  ] },
  { key: 'pricing.policy', title: 'Prix', intro: 'L’Analyste Prix étudie le marché pour chaque client. Ces planchers empêchent seulement de vendre à perte.', fields: [
    { path: 'min_price_minor', label: 'Prix minimum d’un projet', type: 'money' },
    { path: 'min_hourly_minor', label: 'Taux horaire minimum', type: 'money' },
    { path: 'never_exceed_stated_budget', label: 'Ne jamais dépasser le budget annoncé par le client', type: 'toggle' },
  ] },
  { key: 'deals.policy', title: 'Conclusion des deals', intro: 'Quand l’Agent de négociation peut accepter un projet seul, après accord écrit du client.', fields: [
    { path: 'auto_accept', label: 'Conclure automatiquement les deals acceptés par écrit', type: 'toggle' },
    { path: 'max_auto_accept_minor', label: 'Montant maximum conclu automatiquement', type: 'money' },
  ] },
  { key: 'qa.policy', title: 'Qualité', intro: 'Chaque livrable doit être validé par plusieurs contrôleurs indépendants avant d’être présenté au client.', fields: [
    { path: 'reviewers_required', label: 'Contrôles qualité indépendants requis', type: 'number' },
    { path: 'max_qa_cycles', label: 'Corrections maximum avant escalade', type: 'number' },
  ] },
];

/** Resize an uploaded logo to at most 240 px (keeps emails light) and return it as a PNG data URL.
 *  Uses FileReader → data: URL (allowed by the site's security policy; blob: URLs are not). */
async function shrinkImage(file: File): Promise<string> {
  if (!/^image\/(png|jpeg)$/.test(file.type)) throw new Error('Format non pris en charge : choisis une image PNG ou JPG.');
  const dataUrl = await new Promise<string>((ok, ko) => { const r = new FileReader(); r.onload = () => ok(String(r.result)); r.onerror = () => ko(new Error('Lecture du fichier impossible.')); r.readAsDataURL(file); });
  const img = await new Promise<HTMLImageElement>((ok, ko) => { const i = new Image(); i.onload = () => ok(i); i.onerror = () => ko(new Error('Image illisible.')); i.src = dataUrl; });
  const k = Math.min(1, 240 / Math.max(img.width, img.height));
  const c = document.createElement('canvas'); c.width = Math.round(img.width * k); c.height = Math.round(img.height * k);
  c.getContext('2d')!.drawImage(img, 0, 0, c.width, c.height);
  return c.toDataURL('image/png');
}

const get = (o: Row, p: string) => p.split('.').reduce((a: any, k) => (a == null ? a : a[k]), o);
const set = (o: Row, p: string, v: unknown) => { const c = structuredClone(o); const ks = p.split('.'); let t: any = c; ks.slice(0, -1).forEach((k) => (t = t[k] ??= {})); t[ks.at(-1)!] = v; return c; };

function SettingForm({ section, setting, onSaved }: { section: Section; setting: Row | undefined; onSaved: () => void }) {
  const [v, setV] = useState<Row>(setting?.value ?? {});
  const [note, setNote] = useState('');
  useEffect(() => setV(setting?.value ?? {}), [setting?.value]);
  if (!setting) return null;
  const dirty = JSON.stringify(v) !== JSON.stringify(setting.value);
  return (
    <Card title={section.title} actions={<span className="small muted">modifié {dt(setting.updated_at)}</span>} pad>
      <p className="small muted" style={{ marginTop: 0 }}>{section.intro}</p>
      <div className="form-grid">
        {section.fields.map((f) => {
          const val = get(v, f.path);
          if (f.type === 'select') return (
            <label key={f.path} className="field">{f.label}
              <select value={val ?? ''} onChange={(e) => setV(set(v, f.path, e.target.value))}>{f.options!.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}</select>
            </label>);
          if (f.type === 'image') return (
            <label key={f.path} className="field" style={{ gridColumn: '1 / -1' }}>{f.label}
              <div className="row">
                {val ? <img src={val} alt="logo" style={{ height: 72, width: 'auto', borderRadius: 8, background: '#fff', border: '1px solid var(--border)' }} /> : <span className="faint">Aucun logo</span>}
                <input type="file" accept="image/png,image/jpeg" style={{ width: 'auto' }} onChange={async (e) => {
                  const file = e.target.files?.[0]; if (!file) return;
                  try { setV(set(v, f.path, await shrinkImage(file))); setNote('Logo chargé ✔ — clique sur « Enregistrer » en bas de cette section.'); }
                  catch (err) { setNote((err as Error).message); } }} />
                {val && <button type="button" className="btn sm ghost" onClick={() => { setV(set(v, f.path, '')); setNote('Logo retiré — clique sur « Enregistrer ».'); }}>Retirer</button>}
              </div>
              {note && <span className="small" style={{ fontWeight: 600 }}>{note}</span>}
              {f.help && <span className="faint">{f.help}</span>}
            </label>);
          if (f.type === 'toggle') return (
            <label key={f.path} className="row" style={{ gridColumn: '1 / -1', fontSize: 13 }}>
              <input type="checkbox" style={{ width: 'auto' }} checked={!!val} onChange={(e) => setV(set(v, f.path, e.target.checked))} /> {f.label}
            </label>);
          return (
            <label key={f.path} className="field" style={f.type === 'textarea' ? { gridColumn: '1 / -1' } : undefined}>{f.label}
              {f.type === 'textarea'
                ? <textarea value={val ?? ''} onChange={(e) => setV(set(v, f.path, e.target.value))} />
                : <input type={f.type === 'text' ? 'text' : 'number'} placeholder={f.placeholder} min={0}
                    value={val == null ? '' : f.type === 'money' ? Number(val) / 100 : val}
                    onChange={(e) => setV(set(v, f.path, f.type === 'text' ? e.target.value : f.type === 'money' ? Math.round(Number(e.target.value) * 100) : Number(e.target.value)))} />}
              {f.help && <span className="faint">{f.help}</span>}
            </label>);
        })}
      </div>
      <div className="row mt">
        <ActionButton className="btn primary" disabled={!dirty} success="Enregistré" onDone={onSaved}
          action={() => rpc('owner_set_setting', { p_key: section.key, p_value: v })}>Enregistrer</ActionButton>
        {dirty && <button className="btn ghost" onClick={() => setV(setting.value)}>Annuler</button>}
      </div>
    </Card>
  );
}

export function Settings() {
  const { data, error, reload } = useData(() => q<Row[]>(supabase.from('settings').select('*').order('key')));
  const byKey = Object.fromEntries((data ?? []).map((s) => [s.key, s]));
  const kill = byKey['system.kill_switch']?.value === true;
  const known = new Set([...SECTIONS.map((s) => s.key), 'system.kill_switch']);
  return (
    <div className="stack">
      <PageHead title="Paramètres" subtitle="Tout se règle ici avec des formulaires simples. Chaque modification est enregistrée dans l’historique." />
      <ErrorBox error={error} />
      <Card title="Arrêt d’urgence" pad>
        <div className="spread"><div>{kill ? <Badge value="ACTIVÉ — tout est à l’arrêt" tone="bad" /> : <Badge value="désactivé — la société fonctionne" tone="ok" />}
          <p className="small muted">Activé, les agents ne prennent plus aucune tâche et n’envoient plus rien, dès le cycle suivant.</p></div>
          <ActionButton className={`btn ${kill ? 'primary' : 'danger solid'}`} confirm={kill ? 'Relancer la société ?' : 'Arrêter immédiatement tout le travail autonome ?'} onDone={reload}
            action={() => rpc('owner_set_setting', { p_key: 'system.kill_switch', p_value: !kill })}>{kill ? 'Relancer' : 'Tout arrêter'}</ActionButton></div>
      </Card>
      {SECTIONS.map((s) => <SettingForm key={s.key} section={s} setting={byKey[s.key]} onSaved={reload} />)}
      <MfaCard requireMfa={byKey['security.require_mfa']?.value === true} onChanged={reload} />
      <details className="card card-pad"><summary className="small muted">Paramètres techniques (mode expert)</summary>
        <div className="stack mt">{(data ?? []).filter((s) => !known.has(s.key) && s.key !== 'security.require_mfa').map((s) => <ExpertSetting key={s.key} s={s} onSaved={reload} />)}</div>
      </details>
    </div>
  );
}

function ExpertSetting({ s, onSaved }: { s: Row; onSaved: () => void }) {
  const [text, setText] = useState(JSON.stringify(s.value, null, 2));
  return <div><div className="small" style={{ fontWeight: 600 }}>{s.description ?? s.key}</div>
    <textarea className="mono" value={text} onChange={(e) => setText(e.target.value)} />
    <ActionButton className="btn sm" success="Enregistré" onDone={onSaved} disabled={text === JSON.stringify(s.value, null, 2)}
      action={async () => { let v: unknown; try { v = JSON.parse(text); } catch { throw new Error('Format invalide'); } await rpc('owner_set_setting', { p_key: s.key, p_value: v }); }}>Enregistrer</ActionButton></div>;
}

function MfaCard({ requireMfa, onChanged }: { requireMfa: boolean; onChanged: () => void }) {
  const { data, reload } = useData(async () => (await supabase.auth.mfa.listFactors()).data);
  const [enroll, setEnroll] = useState<{ id: string; qr: string; secret: string } | null>(null); const [code, setCode] = useState('');
  const verified = data?.totp?.filter((f) => f.status === 'verified') ?? [];
  return <Card title="Sécurité du compte (double authentification)" pad><div className="stack">
    <div>{verified.length ? <Badge value="application d’authentification activée" tone="ok" /> : <Badge value="non activée" tone="warn" />}</div>
    {!verified.length && !enroll && <ActionButton className="btn" action={async () => {
      const { data, error } = await supabase.auth.mfa.enroll({ factorType: 'totp' }); if (error) throw error;
      setEnroll({ id: data.id, qr: data.totp.qr_code, secret: data.totp.secret }); }}>Activer avec une application (Google Authenticator…)</ActionButton>}
    {enroll && <><img src={enroll.qr} alt="QR code" width={180} height={180} style={{ background: '#fff', borderRadius: 8 }} />
      <input placeholder="Code à 6 chiffres" value={code} onChange={(e) => setCode(e.target.value)} style={{ maxWidth: 200 }} />
      <ActionButton className="btn primary" success="Double authentification activée" onDone={() => { setEnroll(null); reload(); }} action={async () => {
        const { error } = await supabase.auth.mfa.challengeAndVerify({ factorId: enroll.id, code }); if (error) throw error; }}>Vérifier</ActionButton></>}
    {verified.length > 0 && <label className="row small"><input type="checkbox" style={{ width: 'auto' }} checked={requireMfa}
      onChange={async (e) => { await rpc('owner_set_setting', { p_key: 'security.require_mfa', p_value: e.target.checked }); onChanged(); }} /> Exiger la double authentification pour accéder au centre de commande</label>}
  </div></Card>;
}
