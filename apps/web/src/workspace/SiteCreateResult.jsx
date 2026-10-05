import { useEffect, useRef } from 'react';
import { EmptyState, ErrorNotice, KeyValues, LinkButton, Section } from './PanelKit.jsx';
import { siteHref } from './site-model.js';
import { siteSubmissionBusy } from './site-create-submission.js';
import { siteAdminMessage } from './site-admin-result.js';

const STEP_LABELS = Object.freeze({
  application: 'Uygulama kaydı', website: 'Site kaydı', primary_domain: 'Alan adı kaydı',
  unix_identity: 'Site kullanıcısı', website_paths: 'Site dosya alanı',
  dns_zone: 'DNS bölgesi', nginx: 'Web sunucusu yapılandırması',
  mail_domain: 'Posta alan adı', mail_domain_metadata: 'Posta alan adı kaydı',
  mail_config: 'Posta yapılandırması', mail_dkim_key: 'DKIM anahtarı',
  mail_dns_reapply: 'Posta DNS kayıtları', roundcube_mapping: 'Webmail bağlantısı',
  webmail_certificate: 'Webmail sertifikası',
});
const STATE_LABELS = Object.freeze({
  pending: 'Bekliyor', saving: 'Kaydediliyor', applying: 'İşleniyor', verifying: 'Doğrulanıyor',
  succeeded: 'Tamamlandı', partial: 'Kısmi başarılı',
  failed: 'Başarısız', blocked: 'Engel var', interrupted: 'Kesintiye uğradı', compensating: 'Geri alınıyor', compensated: 'Geri alındı',
});
export function SiteCreateProgress({ state }) {
  if (state.phase === 'idle' || state.phase === 'error') return null;
  const busy = siteSubmissionBusy(state);
  return <div className="ws-section-body" aria-label="Site kurulum durumu">
    {busy && <p role="status"><span className="ws-spinner" /> {state.phase === 'previewing'
      ? 'Site yapılandırması doğrulanıyor…' : state.phase === 'creating'
        ? 'Site kaydı kaydediliyor…' : state.phase === 'verifying'
          ? 'Kurulum doğrulanıyor…' : 'Kayıt oluşturuldu; kurulum adımları işleniyor…'}</p>}
    {state.steps.length > 0 && <><h3>Kurulum adımları</h3><KeyValues items={state.steps.map((step) => [
      STEP_LABELS[step.id] ?? step.id,
      `${STATE_LABELS[step.state] ?? 'Bilinmiyor'}${step.required ? '' : ' · İsteğe bağlı'}`,
    ])} /></>}
    {!busy && state.created && <p role="status">{state.phase === 'ready'
      ? 'Kurulum planındaki zorunlu adımlar tamamlandı. Yayın, SSL ve posta durumunu ilgili site araçlarından doğrulayın.'
      : state.phase === 'partial'
        ? 'Kayıt oluşturuldu, bazı adımlar kısmi başarıyla tamamlandı. Detayları Genel Bakış bölümünden inceleyin.'
        : 'Site kaydı korundu. Tamamlanmayan veya doğrulanamayan adımları Genel Bakış bölümünden inceleyin.'}</p>}
  </div>;
}
export default function SiteCreateResult({ state }) {
  const domain = state.created;
  const resultRef = useRef(null);

  useEffect(() => {
    resultRef.current?.focus();
  }, []);

  return <div ref={resultRef} tabIndex={-1} aria-live="polite" aria-atomic="true" className="ws-site-create-result" style={{ outline: 'none' }}>
    <Section title={domain ? 'Site kaydı oluşturuldu' : 'Oluşturma sonucu kontrol edilmeli'}>
    <EmptyState icon={domain ? 'globe' : 'clock'} title={domain?.primaryDomain ?? 'Sunucudaki sonuç henüz doğrulanamadı'}
      detail={domain ? 'Kayıt oluşturma ile servislerin çalışır duruma gelmesi ayrı aşamalardır.'
        : 'Aynı formdan otomatik veya tekrarlı oluşturma yapılmayacak. Önce mevcut siteleri kontrol edin.'} />
    <div className="ws-section-body"><ErrorNotice error={state.error} />
      {domain && state.siteAdmin && state.siteAdmin.status !== 'not_requested' && <div
        className={state.siteAdmin.status === 'attention' ? 'ws-notice ws-notice-warn' : 'ws-notice'} role="status" aria-live="polite">
        <div><strong>{state.siteAdmin.status === 'created' ? 'Yönetici hesabı oluşturuldu' : 'Yönetici hesabı kontrol edilmeli'}</strong>
          <p>{siteAdminMessage(state.siteAdmin)}</p>
          {state.siteAdmin.status === 'attention' && <LinkButton to="/settings/users">Kullanıcıları kontrol et</LinkButton>}
        </div>
      </div>}
      <div className="ws-actions">{domain ? <>
        <LinkButton variant="primary" icon="arrow" to={siteHref(domain.id, 'overview')}>Site genel bakışı</LinkButton>
        <LinkButton icon="folder" to={siteHref(domain.id, 'files')}>Dosyaları aç</LinkButton>
      </> : <LinkButton variant="primary" to="/websites">Web sitelerini kontrol et</LinkButton>}</div>
      <p className="ws-muted">Bu sayfadan ayrılmak sunucuda başlamış işlemleri geri almaz.</p>
    </div>
    <SiteCreateProgress state={state} />
    <details className="ws-section ws-disclosure"><summary>Kurulum teknik ayrıntıları</summary><KeyValues items={[
      ['İşlem kimliği', state.operationId ?? domain?.operationId ?? '—'],
      ['Alan adı kimliği', domain?.id ?? '—'],
      ['Web sitesi kimliği', domain?.websiteId ?? '—'],
      ['Aşama (phase)', state.phase],
    ]} /></details>
  </Section>
  </div>;
}
