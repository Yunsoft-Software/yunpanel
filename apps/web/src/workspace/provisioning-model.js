const STEP_LABELS = Object.freeze({
  application_metadata: 'Uygulama kaydı',
  docker_workload_binding: 'Docker bağlantısı',
  website_metadata: 'Site kaydı',
  primary_domain_metadata: 'Ana alan adı kaydı',
  www_domain_metadata: 'www alan adı kaydı',
  unix_identity: 'Site kullanıcısı',
  runtime: 'Çalışma ortamı',
  nginx: 'Nginx',
  certificate: 'SSL sertifikası',
});

const STEP_STATE_LABELS = Object.freeze({
  pending: 'Bekliyor',
  applying: 'Uygulanıyor',
  blocked: 'Müdahale gerekli',
  succeeded: 'Tamamlandı',
  failed: 'Başarısız',
  compensating: 'Geri alınıyor',
  compensated: 'Geri alındı',
});

const REMEDIATION_GUIDANCE = Object.freeze({
  unix_identity: 'Site kullanıcısını, grubunu ve ana dizinini kayıtlı UID/GID bilgisiyle karşılaştırın. Uyuşmazlık varsa elle düzeltin; sahiplik doğrulanmadan kullanıcı, grup veya dizin silmeyin.',
  runtime: 'Passenger ve Nginx paketlerini, Node.js yolunu, uygulama dizinini, başlangıç dosyasını ve site kullanıcısı eşleşmesini kontrol edin. Sorunu giderdikten sonra kuruluma devam edin; ortak Passenger kurulumu geri alma sırasında kaldırılmaz.',
  nginx: 'Nginx site yapılandırmasını ve yapılandırma testini kontrol edin. Sahipliği doğrulanmayan veya elle değiştirilmiş yapılandırmayı silmeyin ya da üzerine yazmayın; sorunu giderdikten sonra yeniden deneyin, devam edin veya güvenli şekilde geri alın.',
  certificate: 'Sertifika ve DNS doğrulama ön koşullarını tamamlayın. Sertifika kaydı oluşmadan siteyi hazır saymayın; ön koşullar düzeldikten sonra kuruluma devam edin.',
});

export function provisioningStepLabel(step) {
  return STEP_LABELS[step?.id] ?? STEP_LABELS[step?.kind] ?? step?.id ?? step?.kind ?? 'Kurulum adımı';
}

export function provisioningStepStateLabel(step) {
  return STEP_STATE_LABELS[step?.state] ?? step?.state ?? 'Bilinmiyor';
}

export function provisioningBadgeState(step) {
  if (step?.state === 'succeeded') return 'succeeded';
  if (step?.state === 'failed') return 'failed';
  if (step?.state === 'pending') return 'pending';
  if (['applying', 'compensating'].includes(step?.state)) return 'running';
  if (['blocked', 'compensated'].includes(step?.state)) return 'warning';
  return 'unknown';
}

export function provisioningRemediation(step) {
  if (!step || ['pending', 'succeeded'].includes(step.state)) return null;
  if (step.kind === 'runtime' && step.error === 'static_runtime_provisioning_pending') {
    return 'Statik site kurulumu henüz tamamlanmadı. Site dizini doğrulanana kadar bu adımı başarılı saymayın.';
  }
  return REMEDIATION_GUIDANCE[step.kind]
    ?? 'Sunucudaki durumu kayıtlı sahiplik bilgisiyle karşılaştırın. Uyuşmazlığı elle giderin; aynı işlemi körlemesine tekrar etmeyin ve sahipliği doğrulanmayan kaynağı silmeyin.';
}

export function canContinueProvisioning(operation) {
  if (!operation || operation.ready === true) return false;
  const required = (operation.steps ?? []).filter((step) => step.required !== false);
  if (required.some((step) => ['failed', 'compensated'].includes(step.state))) return false;
  return required.some((step) => ['pending', 'blocked', 'applying', 'compensating'].includes(step.state));
}

export function provisioningOperationLabel(operation) {
  if (!operation) return 'Kurulum kaydı yok';
  if (operation.ready) return 'Hazır';
  if ((operation.steps ?? []).some((step) => step.state === 'failed')) return 'Başarısız';
  if ((operation.steps ?? []).some((step) => step.state === 'blocked')) return 'Bloke';
  if ((operation.steps ?? []).some((step) => ['applying', 'compensating'].includes(step.state))) return 'İşleniyor';
  if ((operation.steps ?? []).some((step) => step.state === 'compensated')) return 'Geri alındı';
  return 'Hazırlanıyor';
}
