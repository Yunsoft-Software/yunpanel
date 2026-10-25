import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router';
import {
  createDockerProject,
  generateDockerComposeFromImage,
  getDockerCatalog,
  prepareOneClickApp,
  validateDockerProject,
} from './docker-compose-client.js';
import { useWorkspace } from './WorkspaceContext.jsx';
import {
  Badge,
  Button,
  DEFAULT_DOCKER_STACK_TEMPLATES,
  DockerHubCatalogPicker,
  ErrorNotice,
  KeyValues,
  Modal,
} from './PanelKit.jsx';

export default function DockerProjectCreateDialog({ onClose, initialTemplate = null }) {
  const { servers, domains, setNotice } = useWorkspace();
  const navigate = useNavigate();
  const server = servers.items.length === 1 ? servers.items[0] : null;
  const startPreset = initialTemplate || DEFAULT_DOCKER_STACK_TEMPLATES[0];
  const initialGenerated = initialTemplate
    ? generateDockerComposeFromImage({
        image: initialTemplate.image,
        targetPort: initialTemplate.targetPort ?? initialTemplate.innerPort ?? 80,
        publishedPort: initialTemplate.publishedPort ?? initialTemplate.outerPort ?? 18080,
      })
    : null;
  const [projectName, setProjectName] = useState(
    initialTemplate?.projectName || (initialGenerated ? `${initialGenerated.serviceName}_stack` : ''),
  );
  const [targetDomain, setTargetDomain] = useState(() => {
    const firstRoot = domains?.items?.find((d) => !d.parentDomainId)?.primaryDomain || 'webrich.news';
    return initialTemplate?.id ? `${initialTemplate.id}.${firstRoot}` : '';
  });
  const [autoSsl, setAutoSsl] = useState(true);
  const [document, setDocument] = useState(
    initialTemplate?.defaultComposeDocument
      || (initialGenerated ? initialGenerated.document : 'services:\n  web:\n    image: nginx:latest\n'),
  );
  const [selectedImage, setSelectedImage] = useState(startPreset.image);
  const [targetPort, setTargetPort] = useState(startPreset.targetPort ?? startPreset.innerPort ?? 80);
  const [publishedPort, setPublishedPort] = useState(startPreset.publishedPort ?? startPreset.outerPort ?? 18080);
  const [generatedSecretsCount, setGeneratedSecretsCount] = useState(initialTemplate?.generatedSecretsCount ?? 0);
  const [proxyPreview, setProxyPreview] = useState(initialTemplate?.proxyPreview ?? null);
  const [hubSearchQuery, setHubSearchQuery] = useState('');
  const [hubCatalog, setHubCatalog] = useState(DEFAULT_DOCKER_STACK_TEMPLATES);
  const [hubSearching, setHubSearching] = useState(false);
  const [validation, setValidation] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const pending = useRef(false);

  async function refreshOneClickSecrets() {
    if (!initialTemplate?.id) return;
    setError(null);
    try {
      const prepared = await prepareOneClickApp({
        templateId: initialTemplate.id,
        projectName: projectName || undefined,
        hostname: targetDomain.trim() || undefined,
        innerPort: targetPort,
        outerPort: publishedPort,
      });
      if (prepared?.document) setDocument(prepared.document);
      if (!projectName && prepared?.projectName) setProjectName(prepared.projectName);
      setGeneratedSecretsCount(prepared?.generatedSecretsCount ?? 0);
      setProxyPreview(prepared?.proxyPreview ?? null);
      setValidation(null);
    } catch (failure) {
      setError(failure.message);
    }
  }

  useEffect(() => {
    const controller = new AbortController();
    const timer = setTimeout(() => {
      setHubSearching(true);
      getDockerCatalog(hubSearchQuery, { live: true, signal: controller.signal })
        .then((items) => {
          if (controller.signal.aborted) return;
          const list = Array.isArray(items) && items.length > 0 ? items : DEFAULT_DOCKER_STACK_TEMPLATES;
          setHubCatalog(list);
          if (hubSearchQuery.trim() && list[0]) {
            setSelectedImage(list[0].image);
            setTargetPort(list[0].targetPort ?? list[0].innerPort ?? 80);
            setPublishedPort(list[0].publishedPort ?? list[0].outerPort ?? 18080);
          }
        })
        .catch(() => {
          if (!controller.signal.aborted) setHubCatalog(DEFAULT_DOCKER_STACK_TEMPLATES);
        })
        .finally(() => {
          if (!controller.signal.aborted) setHubSearching(false);
        });
    }, hubSearchQuery.trim() ? 250 : 0);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [hubSearchQuery]);

  function handleSelectImage(image) {
    setSelectedImage(image);
    const preset = hubCatalog.find((item) => item.image === image)
      || DEFAULT_DOCKER_STACK_TEMPLATES.find((item) => item.image === image);
    if (preset) {
      setTargetPort(preset.targetPort ?? preset.innerPort ?? 80);
      setPublishedPort(preset.publishedPort ?? preset.outerPort ?? 18080);
    }
  }

  function applyQuickTemplate({ image, targetPort: inner, publishedPort: outer }) {
    setError(null);
    try {
      const generated = generateDockerComposeFromImage({
        image,
        targetPort: inner,
        publishedPort: outer,
      });
      setDocument(generated.document);
      if (!projectName) {
        setProjectName(`${generated.serviceName}_stack`);
      }
      setValidation(null);
    } catch (failure) {
      setError(failure.message);
    }
  }

  async function handleYamlFileUpload(event) {
    const file = event.target.files?.[0];
    if (!file) return;
    setError(null);
    try {
      const content = await file.text();
      setDocument(content);
      setValidation(null);
      if (!projectName && file.name) {
        const stem = file.name.replace(/\.(ya?ml)$/i, '').toLowerCase().replace(/[^a-z0-9_-]/g, '_');
        if (/^[a-z0-9][a-z0-9_-]{0,62}$/.test(stem) && stem !== 'docker-compose' && stem !== 'compose') {
          setProjectName(stem);
        }
      }
    } catch (failure) {
      setError(failure.message ?? 'YAML dosyası okunamadı.');
    }
  }

  async function validate() {
    if (pending.current || !server) return;
    pending.current = true; setBusy(true); setError(null); setValidation(null);
    try {
      setValidation(await validateDockerProject({ serverId: server.id, projectName, document, environment: {} }));
    } catch (failure) {
      if (failure.name !== 'AbortError') setError(failure.message);
    } finally { pending.current = false; setBusy(false); }
  }

  async function create(event) {
    event.preventDefault();
    if (pending.current || !server) return;
    pending.current = true; setBusy(true); setError(null);
    try {
      const result = await createDockerProject({ serverId: server.id, projectName, document });
      setNotice(`${result.project.projectName} Compose projesi kaydedildi.`);
      navigate(`/docker/${encodeURIComponent(result.project.id)}`);
    } catch (failure) {
      if (failure.name !== 'AbortError') setError(failure.message);
    } finally { pending.current = false; setBusy(false); }
  }

  const modalTitle = initialTemplate?.oneClick
    ? `${initialTemplate.title || initialTemplate.name || 'Uygulama'} — Tek Tıkla Kurulum`
    : 'Docker Compose projesi ekle';

  return <Modal title={modalTitle} onClose={onClose} busy={busy} wide><form onSubmit={create} className="ws-form"><ErrorNotice error={error} />{!server && <div className="ws-notice ws-notice-warn" role="alert">Yerel sunucu kimliği hazır olmadan Compose projesi oluşturulamaz.</div>}<fieldset disabled={busy || !server}>{initialTemplate?.oneClick ? <>
    <div className="ws-notice" style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', justifyContent: 'space-between', gap: '8px', marginBottom: '12px' }}><div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: '8px' }}><Badge state="active">Tek Tıkla Kur (Easypanel)</Badge><span className="yp-port-mapping-badge">Otomatik Secret & Volume ({generatedSecretsCount} secret üretildi)</span>{proxyPreview?.upstreamUrl && <span className="yp-port-mapping-badge">Proxy Hedefi: {proxyPreview.upstreamUrl}</span>}</div><Button onClick={refreshOneClickSecrets} disabled={busy}>Secret'ları Yeniden Üret</Button></div>
    <div className="ws-form-grid">
      <label>Proje / Servis Adı<input value={projectName} onChange={(event) => { setProjectName(event.target.value); setValidation(null); }} pattern="[a-z0-9][a-z0-9_-]{0,62}" required autoComplete="off" spellCheck={false} placeholder="shop_app" /></label>
      <label>Yayınlanacak Alan Adı / Alt Alan Adı<input value={targetDomain} onChange={(event) => setTargetDomain(event.target.value)} autoComplete="off" spellCheck={false} placeholder="n8n.webrich.news" /></label>
    </div>
    <label style={{ display: 'flex', alignItems: 'center', gap: '8px', margin: '8px 0 12px' }}>
      <input type="checkbox" checked={autoSsl} onChange={(event) => setAutoSsl(event.target.checked)} />
      <span>{`Otomatik Let's Encrypt SSL & Nginx Reverse Proxy (${targetDomain || 'alan adı'} → 127.0.0.1:${publishedPort} → :${targetPort})`}</span>
    </label>
    <details className="ws-disclosure" style={{ marginBottom: '12px' }}>
      <summary>Gelişmiş Port, İmaj ve Compose YAML Ayarları</summary>
      <div style={{ marginTop: '12px', display: 'grid', gap: '12px' }}>
        <DockerHubCatalogPicker catalog={hubCatalog} selectedImage={selectedImage} targetPort={targetPort} publishedPort={publishedPort} searchQuery={hubSearchQuery} searching={hubSearching} onSearchQueryChange={setHubSearchQuery} onSelectImage={handleSelectImage} onChangeTargetPort={setTargetPort} onChangePublishedPort={setPublishedPort} onApplyTemplate={applyQuickTemplate} disabled={busy || !server} />
        <label>.yml Dosyası Seç / Yükle<input type="file" accept=".yml,.yaml" aria-label=".yml Dosyası Seç / Yükle" onChange={handleYamlFileUpload} /></label>
        <label>Compose document<textarea rows={12} value={document} onChange={(event) => { setDocument(event.target.value); setValidation(null); }} required spellCheck={false} /></label>
      </div>
    </details>
  </> : <>
    <DockerHubCatalogPicker catalog={hubCatalog} selectedImage={selectedImage} targetPort={targetPort} publishedPort={publishedPort} searchQuery={hubSearchQuery} searching={hubSearching} onSearchQueryChange={setHubSearchQuery} onSelectImage={handleSelectImage} onChangeTargetPort={setTargetPort} onChangePublishedPort={setPublishedPort} onApplyTemplate={applyQuickTemplate} disabled={busy || !server} />
    <div className="ws-form-grid"><label>Proje adı<input value={projectName} onChange={(event) => { setProjectName(event.target.value); setValidation(null); }} pattern="[a-z0-9][a-z0-9_-]{0,62}" required autoComplete="off" spellCheck={false} placeholder="shop_app" /></label><label>.yml Dosyası Seç / Yükle<input type="file" accept=".yml,.yaml" aria-label=".yml Dosyası Seç / Yükle" onChange={handleYamlFileUpload} /></label></div>
    <label>Compose document<textarea rows={18} value={document} onChange={(event) => { setDocument(event.target.value); setValidation(null); }} required spellCheck={false} /></label>
  </>}{validation && <KeyValues items={[
    ['Servis', validation.serviceCount], ['Network', validation.networks?.length ?? 0], ['Volume', validation.volumes?.length ?? 0], ['Secret', validation.secretCount], ['Config', validation.configCount], ['Yan etki', validation.sideEffects === false ? 'Yok' : 'Bilinmiyor'],
  ]} />}<footer className="ws-modal-footer"><Button disabled={busy} onClick={onClose}>Vazgeç</Button><Button disabled={busy || !server || !projectName || !document} onClick={validate}>Validate</Button><Button variant="primary" type="submit" disabled={busy || !server || !projectName || !document}>{busy ? 'İşleniyor…' : (initialTemplate?.oneClick ? '⚡ Uygulamayı Kur ve Yayınla' : 'Projeyi kaydet')}</Button></footer></fieldset></form></Modal>;
}
