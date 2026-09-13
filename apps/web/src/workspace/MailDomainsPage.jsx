import { useCallback, useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import { getMailDomain, listMailAliases, listMailDomains, listMailboxes } from './mail-client.js';
import MailDomainCreateDialog from './MailDomainCreateDialog.jsx';
import { Badge, Button, EmptyState, KeyValues, LinkButton, PageHeading, Section } from './PanelKit.jsx';
import { formatDate } from './site-model.js';

function useAsyncResource(loader, dependencies = []) {
  const [state, setState] = useState({ status: 'loading', data: null, error: null });
  const [revision, setRevision] = useState(0);
  const refresh = useCallback(() => setRevision((value) => value + 1), []);
  useEffect(() => {
    const controller = new AbortController();
    setState((current) => ({ ...current, status: current.data ? 'stale' : 'loading', error: null }));
    Promise.resolve(loader(controller.signal))
      .then((data) => { if (!controller.signal.aborted) setState({ status: 'ready', data, error: null }); })
      .catch((error) => { if (!controller.signal.aborted) setState((current) => ({ status: current.data ? 'stale' : 'error', data: current.data, error })); });
    return () => controller.abort();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...dependencies, revision]);
  return { ...state, refresh };
}

function LoadNotice({ resource, label }) {
  if (resource.status === 'loading') return <div className="ws-loading" role="status"><span className="ws-spinner" />{label} yükleniyor…</div>;
  if (!resource.error) return null;
  return <div className="ws-notice ws-notice-warn" role="alert"><div><strong>{label}</strong><p>{resource.error.message ?? 'Veri alınamadı.'}</p></div><Button icon="refresh" onClick={resource.refresh}>Yeniden dene</Button></div>;
}

function mailState(domain) {
  if (domain.managementMode === 'external') {
    if (domain.status === 'ready') return 'active';
    if (domain.status === 'degraded') return 'warning';
    return 'unknown';
  }
  return domain.status === 'enabled' ? 'active' : 'offline';
}

function MailDomainList() {
  const navigate = useNavigate();
  const [creating, setCreating] = useState(false);
  const domains = useAsyncResource(() => listMailDomains(), []);
  const items = Array.isArray(domains.data) ? domains.data : [];
  return <><PageHeading title="Mail" description="Yerel Postfix/Dovecot/Rspamd mail domainleri ve external mail takibi." actions={<><Button icon="refresh" onClick={domains.refresh}>Yenile</Button><Button icon="plus" variant="primary" onClick={() => setCreating(true)}>Mail domain ekle</Button></>} /><LoadNotice resource={domains} label="Mail domainleri" /><Section title="Mail domainleri" description="Local kayıtlar host mail konfigürasyonuna bağlanır; external kayıtlar yalnız envanter olarak izlenir.">{items.length > 0 ? <div className="ws-table-scroll"><table className="ws-table"><thead><tr><th>Domain</th><th>Mod</th><th>Durum</th><th>Revizyon</th><th>Güncellendi</th><th /></tr></thead><tbody>{items.map((domain) => <tr key={domain.id}><td><strong>{domain.domainName}</strong><small>{domain.webDomainId ?? 'Web Domain bağlantısı yok'}</small></td><td>{domain.managementMode === 'local' ? 'Local' : 'External'}</td><td><Badge state={mailState(domain)}>{domain.status}</Badge></td><td>{domain.revision}</td><td>{formatDate(domain.updatedAt)}</td><td><LinkButton to={`/mail/${encodeURIComponent(domain.id)}`}>Yönet</LinkButton></td></tr>)}</tbody></table></div> : domains.status === 'ready' && <EmptyState icon="mail" title="Mail domain yok" detail="İlk local veya external mail domain kaydını ekleyin. Oluşturma tek başına host konfigürasyonunu değiştirmez." action={<Button variant="primary" icon="plus" onClick={() => setCreating(true)}>Mail domain ekle</Button>} />}</Section>{creating && <MailDomainCreateDialog onClose={() => setCreating(false)} onCreated={(created) => { domains.refresh(); navigate(`/mail/${encodeURIComponent(created.id)}`); }} />}</>;
}

function MailDomainDetail({ mailDomainId }) {
  const detail = useAsyncResource(async () => {
    const domain = await getMailDomain(mailDomainId);
    const [mailboxes, aliases] = await Promise.all([
      listMailboxes(mailDomainId),
      listMailAliases(mailDomainId),
    ]);
    return { domain, mailboxes, aliases };
  }, [mailDomainId]);
  const data = detail.data;
  const domain = data?.domain ?? null;
  return <><nav className="ws-breadcrumb"><Link to="/mail">Mail</Link><span>/ {domain?.domainName ?? mailDomainId}</span></nav><PageHeading title={domain?.domainName ?? 'Mail domain'} description="Mail domain identity, mailbox ve alias desired-state envanteri." actions={<Button icon="refresh" onClick={detail.refresh}>Yenile</Button>} /><LoadNotice resource={detail} label="Mail domain" />{domain && <><Section title="Domain durumu"><div className="ws-section-body"><KeyValues items={[
    ['Yönetim modu', domain.managementMode],
    ['Durum', <Badge key="status" state={mailState(domain)}>{domain.status}</Badge>],
    ['Revizyon', domain.revision],
    ['Web Domain', domain.webDomainId ?? '—'],
    ['Mailbox', data.mailboxes?.length ?? 0],
    ['Alias', data.aliases?.length ?? 0],
    ['Son gözlem', formatDate(domain.lastObservedAt)],
  ]} />{domain.managementMode === 'external' && <p className="ws-muted">External mail domain yalnız takip edilir; local mailbox, DKIM ve host configuration işlemleri bu kayda uygulanmaz.</p>}</div></Section><Section title="Mailbox envanteri">{data.mailboxes?.length ? <div className="ws-table-scroll"><table className="ws-table"><thead><tr><th>Adres</th><th>Durum</th><th>Revizyon</th><th>Parola</th></tr></thead><tbody>{data.mailboxes.map((mailbox) => <tr key={mailbox.id}><td><strong>{mailbox.address}</strong></td><td><Badge state={mailbox.enabled ? 'active' : 'offline'}>{mailbox.enabled ? 'enabled' : 'disabled'}</Badge></td><td>{mailbox.revision}</td><td>{mailbox.passwordConfigured ? `Configured · ${formatDate(mailbox.passwordUpdatedAt)}` : '—'}</td></tr>)}</tbody></table></div> : <EmptyState icon="mail" title="Mailbox yok" detail={domain.managementMode === 'local' ? 'Mailbox create ve policy yönetimi sonraki panel diliminde bu ekrana bağlanacak.' : 'External mail domain için local mailbox oluşturulmaz.'} />}</Section><Section title="Alias envanteri">{data.aliases?.length ? <div className="ws-table-scroll"><table className="ws-table"><thead><tr><th>Kaynak</th><th>Hedefler</th><th>Durum</th><th>Revizyon</th></tr></thead><tbody>{data.aliases.map((alias) => <tr key={alias.id}><td><strong>{alias.source}</strong></td><td>{alias.destinations?.join(', ')}</td><td><Badge state={alias.enabled ? 'active' : 'offline'}>{alias.enabled ? 'enabled' : 'disabled'}</Badge></td><td>{alias.revision}</td></tr>)}</tbody></table></div> : <EmptyState icon="mail" title="Alias yok" detail={domain.managementMode === 'local' ? 'Alias create ve update işlemleri sonraki panel diliminde bu ekrana bağlanacak.' : 'External mail domain için local alias policy tutulmaz.'} />}</Section></>}</>;
}

export default function MailDomainsPage() {
  const { mailDomainId } = useParams();
  return mailDomainId ? <MailDomainDetail mailDomainId={mailDomainId} /> : <MailDomainList />;
}

export const mailDomainsPageInternals = Object.freeze({ mailState });
