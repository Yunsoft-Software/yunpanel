import { useCallback, useEffect, useRef, useState } from 'react';
import { Badge, Button, EmptyState, ErrorNotice, KeyValues, Section } from './PanelKit.jsx';
import { getWebsiteIsolationAudit } from './website-isolation-client.js';
import {
  isolationFindingPresentation,
  isolationRuntimeLabel,
  isolationStatusPresentation,
  isolationStepPresentation,
} from './website-isolation-model.js';

export default function WebsiteIsolationPanel({ websiteId }) {
  const [audit, setAudit] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const generation = useRef(0);

  const load = useCallback(async ({ signal, showLoading = true } = {}) => {
    if (!websiteId) return;
    const current = ++generation.current;
    if (showLoading) setLoading(true);
    setError(null);
    try {
      const result = await getWebsiteIsolationAudit(websiteId, { signal });
      if (current === generation.current) setAudit(result);
    } catch (failure) {
      if (failure.name !== 'AbortError' && current === generation.current) setError(failure.message);
    } finally {
      if (current === generation.current) setLoading(false);
    }
  }, [websiteId]);

  useEffect(() => {
    if (!websiteId) {
      setAudit(null);
      setLoading(false);
      return undefined;
    }
    const controller = new AbortController();
    load({ signal: controller.signal });
    return () => {
      generation.current += 1;
      controller.abort();
    };
  }, [websiteId, load]);

  if (!websiteId) return null;
  const status = isolationStatusPresentation(audit);

  return <Section
    title="Website izolasyon denetimi"
    description="Canonical Unix kimliği, runtime yolları ve provisioning kanıtının canlı, salt okunur kontrolü."
    actions={<div className="ws-actions">
      {audit && <Badge state={status.badge}>{status.label}</Badge>}
      <Button icon="refresh" disabled={loading} onClick={() => load({ showLoading: false })}>{loading ? 'Denetleniyor…' : 'Yeniden denetle'}</Button>
    </div>}
  >
    <div className="ws-section-body"><ErrorNotice error={error} />
      {loading && !audit && <div className="ws-loading" role="status"><span className="ws-spinner" />Website izolasyonu denetleniyor…</div>}
      {audit?.applicable === false && <p className="ws-muted">{isolationRuntimeLabel(audit.runtimeType)} runtime için dedicated Unix identity izolasyon denetimi uygulanmaz.</p>}
      {audit?.applicable && <KeyValues items={[
        ['Runtime', isolationRuntimeLabel(audit.runtimeType)],
        ['Beklenen Unix kullanıcısı', audit.expected?.unixUser],
        ['Beklenen HOME', audit.expected?.homeDirectory],
        ['Beklenen document root', audit.expected?.documentRoot],
        ['Beklenen geçici alan', audit.expected?.temporaryDirectory],
        ['Beklenen log alanı', audit.expected?.logDirectory],
      ]} />}
    </div>
    {audit?.inspectedSteps?.length > 0 && <div className="ws-table-scroll"><table className="ws-table">
      <thead><tr><th>İzolasyon adımı</th><th>Durum</th><th>Kanıt sonucu</th></tr></thead>
      <tbody>{audit.inspectedSteps.map((step) => {
        const presentation = isolationStepPresentation(step);
        return <tr key={step.stepId}><td><strong>{presentation.name}</strong><div className="ws-muted"><code>{step.stepId}</code></div></td><td><Badge state={presentation.badge}>{presentation.label}</Badge></td><td><code>{step.reason ?? 'satisfied'}</code></td></tr>;
      })}</tbody>
    </table></div>}
    {audit?.findings?.length > 0 && <div className="ws-table-scroll"><table className="ws-table">
      <thead><tr><th>Bulgu</th><th>Önem</th><th>Güvenli sonraki adım</th></tr></thead>
      <tbody>{audit.findings.map((finding) => {
        const presentation = isolationFindingPresentation(finding);
        return <tr key={finding.code}><td><strong>{finding.message}</strong><div className="ws-muted"><code>{finding.code}</code></div></td><td><Badge state={presentation.badge}>{presentation.label}</Badge></td><td>{finding.action}</td></tr>;
      })}</tbody>
    </table></div>}
    {audit?.applicable && audit.findings?.length === 0 && <EmptyState icon="check" title="İzolasyon doğrulandı" detail="Canonical Website kimliği ve denetlenebilen host izolasyon adımları mevcut desired state ile uyumlu." />}
    {audit?.migrationRequired && <div className="ws-section-body"><div className="ws-notice ws-notice-warn"><div><strong>Migration apply henüz kapalı</strong><p>Bu denetim host durumunu değiştirmez. Exact değişiklik preview’sı ve operation-owned rollback olmadan kullanıcı, dosya sahipliği veya runtime üzerinde otomatik işlem yapılmaz.</p></div></div></div>}
  </Section>;
}
