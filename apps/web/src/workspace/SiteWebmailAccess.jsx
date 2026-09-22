import { useCallback, useEffect, useRef, useState } from 'react';
import { inspectMailWebmail } from './mail-client.js';
import { Badge, Button, EmptyState, ErrorNotice, Icon, Section } from './PanelKit.jsx';
import { webmailMappingUrl } from './ui/site-resource-model.js';

// Site managers open an existing mapping. Global Roundcube installation and
// certificate reassignment are intentionally not exposed from this component.
export default function SiteWebmailAccess({ domain }) {
  const [state, setState] = useState({ data: null, loading: true, error: null });
  const generation = useRef(0);
  const load = useCallback(async () => {
    const current = ++generation.current;
    setState((value) => ({ ...value, loading: true, error: null }));
    try {
      const data = await inspectMailWebmail(domain.id);
      if (current === generation.current) setState({ data, loading: false, error: null });
    } catch (failure) {
      if (current === generation.current && failure.name !== 'AbortError') setState({ data: null, loading: false, error: failure.message });
    }
  }, [domain.id]);
  useEffect(() => { void load(); return () => { generation.current++; }; }, [load]);
  const mapping = state.data?.mapping;
  const url = !state.error && !state.loading ? webmailMappingUrl(mapping) : null;
  return <Section title="Webmail" actions={<Button icon="refresh" onClick={load} disabled={state.loading}>Yenile</Button>}>
    <ErrorNotice error={state.error} />
    {state.loading ? <div className="ws-loading" role="status"><span className="ws-spinner" />Webmail bağlantısı kontrol ediliyor…</div> : url ? <div className="ys-webmail-access"><span className="ys-webmail-icon"><Icon name="mail" size={34} /></span><h3>Postanız hazır</h3><p>{mapping.hostname}</p><Badge state="active">Roundcube bağlantısı etkin</Badge><a className="ws-button ws-button-primary" href={url} target="_blank" rel="noopener noreferrer"><Icon name="external" />Webmail’i aç</a><small>Posta kutusu adresiniz ve parolanızla oturum açın.</small></div> : !state.error && <EmptyState icon="mail" title="Webmail bağlantısı henüz hazır değil" detail="Sunucu yöneticisi bu site için webmail yapılandırmasını tamamladığında bağlantı burada görünür. Posta kutularınızı E-posta bölümünden yönetmeye devam edebilirsiniz." />}
  </Section>;
}
