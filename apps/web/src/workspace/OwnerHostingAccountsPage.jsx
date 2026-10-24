import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router';
import { panelRequest } from '../api.js';
import { sessionGeneration, setSession } from '../session-client.js';
import { Badge, Button, EmptyState, ErrorNotice, Modal, PageHeading, Section } from './PanelKit.jsx';
import { HostingProfileDialog } from './HostingAccountsPanel.jsx';
import { createHostingAccountClient, hostingAccountMessage } from './hosting-account-client.js';
import { useUnsavedChanges } from './UnsavedChanges.jsx';

const LIMIT = 25;
export default function OwnerHostingAccountsPage({ kind }) {
  return <AccountsWorkspace key={kind} kind={kind} />;
}
function AccountsWorkspace({ kind }) {
  const client = useRef(null), [page, setPage] = useState(null), [error, setError] = useState(null);
  const [loading, setLoading] = useState(true), [offset, setOffset] = useState(0), [revision, setRevision] = useState(0);
  const [dialog, setDialog] = useState(null), [notice, setNotice] = useState(null);
  const label = kind === 'reseller' ? 'Bayi' : 'Müşteri';
  function accessLost() { setDialog(null); setSession(null); window.dispatchEvent(new Event('yunpanel:session-expired')); }
  useEffect(() => {
    const instance = createHostingAccountClient({ request: panelRequest, generation: sessionGeneration, onAccessLost: accessLost });
    client.current = instance;
    return () => { instance.dispose(); client.current = null; };
  }, []);
  useEffect(() => {
    let active = true; setLoading(true); setError(null);
    client.current.list({ kind, offset, limit: LIMIT }).then(result => {
      if (!active) return;
      if (offset && offset >= result.total) { setOffset(Math.max(0, Math.ceil(result.total / LIMIT) - 1) * LIMIT); return; }
      setPage(result);
    }).catch(failure => { if (active && failure.name !== 'AbortError') setError(hostingAccountMessage(failure)); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [kind, offset, revision]);
  const refresh = () => setRevision(value => value + 1);
  const close = () => { setDialog(null); refresh(); };
  const saved = message => { setNotice(message); close(); };
  return <>
    <PageHeading title={kind === 'reseller' ? 'Bayiler' : 'Müşteriler'} description={kind === 'reseller' ? 'Bayilerinizin müşterilerini, site sınırlarını ve panel erişimini yönetin.' : 'Müşteri hesaplarını ve onlara ait web sitelerini yönetin.'}
      actions={<><Button icon="refresh" disabled={loading || Boolean(dialog)} onClick={refresh}>Yenile</Button><Button variant="primary" icon="plus" disabled={loading || Boolean(dialog)} onClick={() => setDialog({ type: 'create' })}>{label} ekle</Button></>} />
    {notice && <p className="ws-notice" role="status">{notice}</p>}
    <Section title={`${label} hesapları`}>
      <div className="ws-section-body"><ErrorNotice error={error} />{loading && <p role="status">Hesaplar yükleniyor…</p>}</div>
      {!loading && !error && page && (page.accounts.length ? <div className="ws-table-wrap"><table className="ws-table">
        <thead><tr><th scope="col">Hesap</th><th scope="col">Durum</th><th scope="col">Web siteleri</th>{kind === 'reseller' && <th scope="col">Müşteriler</th>}<th scope="col">İşlemler</th></tr></thead>
        <tbody>{page.accounts.map(account => <tr key={account.id}><th scope="row">{account.username}</th><td><Badge state={account.active ? 'active' : 'off'}>{account.active ? 'Etkin' : 'Giriş kapalı'}</Badge></td>
          <td>{account.usage?.websites ?? 'Ölçülmedi'}{kind === 'reseller' && account.limits.maxWebsites !== null ? ` / ${account.limits.maxWebsites}` : ''}</td>
          {kind === 'reseller' && <td>{account.usage.customers}{account.limits.maxCustomers !== null ? ` / ${account.limits.maxCustomers}` : ''}</td>}
          <td><div className="ws-actions"><Button disabled={Boolean(dialog)} onClick={() => setDialog({ type: 'profile', account })}>Hesabı yönet</Button>
            {kind === 'customer' && <><Link className="ws-button" to={`/websites?customer=${encodeURIComponent(account.id)}`}>Web siteleri</Link>{account.active && <Link className="ws-button" to={`/websites/new?customer=${encodeURIComponent(account.id)}`}>Site ekle</Link>}</>}</div></td>
        </tr>)}</tbody></table></div> : <EmptyState title={`Henüz ${label.toLocaleLowerCase('tr')} yok`} detail="Yeni hesabı oluşturduktan sonra site ekleyebilirsiniz." icon="user" />)}
      <footer className="ws-pagination"><span>{page ? `${page.total} hesap` : 'Hesap sayısı bekleniyor'}</span><div className="ws-actions">
        <Button disabled={loading || Boolean(dialog) || offset === 0} onClick={() => setOffset(value => Math.max(0, value - LIMIT))}>Önceki</Button>
        <span>Sayfa {Math.floor(offset / LIMIT) + 1}</span><Button disabled={loading || Boolean(dialog) || !page || offset + LIMIT >= page.total} onClick={() => setOffset(value => value + LIMIT)}>Sonraki</Button>
      </div></footer>
    </Section>
    {dialog?.type === 'create' && <AccountCreateDialog kind={kind} client={client} onClose={close} onSaved={saved} />}
    {dialog?.type === 'profile' && <HostingProfileDialog accountId={dialog.account.id} onClose={close} onSaved={saved} onAccessLost={accessLost} />}
  </>;
}

function AccountCreateDialog({ kind, client, onClose, onSaved }) {
  const [form, setForm] = useState({ kind, username: '', password: '', resellerId: '', maxCustomers: '10', maxWebsites: '25' });
  const [parents, setParents] = useState([]), [busy, setBusy] = useState(false), [error, setError] = useState(null);
  const mounted = useRef(true), pending = useRef(false);
  useUnsavedChanges(Boolean(form.username || form.password));
  useEffect(() => {
    mounted.current = true;
    if (kind === 'customer') client.current.list({ kind: 'reseller', limit: 100 }, 'create-parent').then(page => {
      if (mounted.current) setParents(page.accounts.filter(account => account.active));
    }).catch(failure => { if (mounted.current) setError(failure); });
    return () => { mounted.current = false; };
  }, [kind]);
  function change(key, value) { setForm(previous => ({ ...previous, [key]: value })); if (!error?.reconcile) setError(null); }
  async function submit(event) {
    event.preventDefault(); if (pending.current || error?.reconcile) return;
    pending.current = true; setBusy(true); setError(null);
    try {
      const account = await client.current.createLogin(form);
      if (mounted.current) { setForm(previous => ({ ...previous, password: '' })); onSaved(`${account.username} hesabı oluşturuldu.`); }
    } catch (failure) { if (mounted.current && failure.name !== 'AbortError') setError(failure); }
    finally { pending.current = false; if (mounted.current) setBusy(false); }
  }
  return <Modal title={kind === 'reseller' ? 'Bayi ekle' : 'Müşteri ekle'} busy={busy} onClose={onClose}>
    <form className="ws-form" onSubmit={submit}><ErrorNotice error={error ? hostingAccountMessage(error) : null} />
      {error?.reconcile && <p role="alert">Sonuç alınamadı. Yeni hesap açmadan önce pencereyi kapatıp listeyi yenileyin.</p>}
      <fieldset disabled={busy || Boolean(error?.reconcile)}>
        <label>Kullanıcı adı<input required value={form.username} onChange={event => change('username', event.target.value)} minLength={3} maxLength={128} autoComplete="off" autoCapitalize="none" spellCheck={false} /></label>
        <label>İlk parola<input type="password" required value={form.password} onChange={event => change('password', event.target.value)} minLength={12} autoComplete="new-password" /></label>
        {kind === 'customer' && <label>Bağlı bayi<select value={form.resellerId} onChange={event => change('resellerId', event.target.value)}><option value="">Doğrudan yönetim</option>{parents.map(parent => <option key={parent.id} value={parent.id}>{parent.username}</option>)}</select></label>}
        {kind === 'reseller' && <div className="ws-form-grid"><label>En fazla müşteri<input type="number" min="0" required value={form.maxCustomers} onChange={event => change('maxCustomers', event.target.value)} /></label><label>En fazla web sitesi<input type="number" min="0" required value={form.maxWebsites} onChange={event => change('maxWebsites', event.target.value)} /></label></div>}
      </fieldset>
      <footer className="ws-modal-footer"><Button onClick={onClose} disabled={busy}>Vazgeç</Button><Button type="submit" variant="primary" disabled={busy || Boolean(error?.reconcile)}>{busy ? 'Hesap oluşturuluyor…' : 'Hesabı oluştur'}</Button></footer>
    </form>
  </Modal>;
}
