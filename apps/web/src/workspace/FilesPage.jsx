import { Navigate, useSearchParams } from 'react-router';
import { useWorkspace } from './WorkspaceContext.jsx';
import { CollectionNotice, EmptyState, LinkButton, PageHeading, Section } from './PanelKit.jsx';
import { resolveFilesEntry } from './files-entry-model.js';

export default function FilesPage() {
  const { websites, domains, canManage } = useWorkspace();
  const [params] = useSearchParams();
  const entry = resolveFilesEntry({
    websites, domains, canManage,
    requestedSiteId: params.has('site') ? params.get('site') : null,
  });
  // Keep the existing site route, FilesPanel, API and Website-user isolation.
  if (entry.state === 'ready') return <Navigate to={entry.target.href} replace />;
  return <>
    <PageHeading title="Dosyalar" description="Dosya yöneticisini açmak için web sitesini seçin." />
    {entry.state === 'unavailable' && <>
      <CollectionNotice resource={websites} label="Web siteleri" />
      <CollectionNotice resource={domains} label="Alan adları" />
    </>}
    {entry.state === 'forbidden' && <EmptyState icon="shield" title="Dosya erişimi yetkiniz yok" detail="Bu hesap için dosya yönetimi açılmamış. Erişim yetkisini yöneticinizle kontrol edin." />}
    {entry.state === 'not_found' && <EmptyState icon="folder" title="İstenen siteye erişilemiyor" detail="Site kaldırılmış veya erişim yetkiniz değişmiş olabilir. Başka bir sitenin dosyaları otomatik açılmaz." action={<LinkButton to="/files">Site seçimine dön</LinkButton>} />}
    {entry.state === 'empty' && <EmptyState icon="folder" title="Henüz erişilebilir site yok" detail="Dosyalar, web sitesinin çalışma alanında yönetilir." action={<LinkButton to="/websites">Web sitelerine git</LinkButton>} />}
    {['choose', 'unsupported', 'unbound'].includes(entry.state) && <Section title="Web siteleri">
      <div className="ws-table-scroll"><table className="ws-table">
        <thead><tr><th scope="col">Web sitesi</th><th scope="col">Dosya erişimi</th></tr></thead>
        <tbody>{(entry.target ? [entry.target] : entry.targets).map((target) => <tr key={target.websiteId}>
          <td><strong>{target.label}</strong></td>
          <td>{target.href ? <LinkButton to={target.href} icon="folder">Dosya Yöneticisi</LinkButton> : <>
            <p>{target.reason === 'unbound' ? 'Site ile alan adı bağlantısı doğrulanamadı.' : 'Bu çalışma türü için dosya erişimi henüz desteklenmiyor.'}</p>
            <LinkButton to={target.domainId ? `/websites/${encodeURIComponent(target.domainId)}/overview` : '/websites'}>Siteyi incele</LinkButton>
          </>}</td>
        </tr>)}</tbody>
      </table></div>
      {entry.target && <div className="ws-section-body"><LinkButton to="/websites">Web sitelerine dön</LinkButton></div>}
    </Section>}
  </>;
}
