const STEP_LABELS = Object.freeze({
  application_metadata: 'Uygulama kaydı',
  docker_workload_binding: 'Docker bağlantısı',
  website_metadata: 'Website kaydı',
  primary_domain_metadata: 'Ana alan adı kaydı',
  www_domain_metadata: 'www alan adı kaydı',
  unix_identity: 'Site kullanıcısı',
  runtime: 'Runtime',
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
  unix_identity: 'Site kullanıcısı, grup ve ana dizin durumunu kontrol edin. Eksik veya uyuşmayan dosya yolu varsa düzeltin; doğrulanmadan kullanıcı veya dizin silmeyin.',
  runtime: 'Web sunucusu ve uygulama çalışma ortamı paket durumunu, başlangıç dosyasını ve kullanıcı izinlerini kontrol edin. Sorun giderildikten sonra kuruluma devam edin.',
  nginx: 'Web sunucusu yapılandırma testini ve alan adı yönlendirme durumunu doğrulayın. Uyuşmazlığı giderdikten sonra tekrar deneyin, devam edin veya güvenli geri alma kullanın.',
  certificate: 'Sertifika ve DNS doğrulama önkoşullarını tamamlayın. Sertifika doğrulaması tamamlanmadan site hazır sayılmaz; önkoşul düzeldikten sonra kuruluma devam edin.',
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
    return 'Statik site çalışma ortamı kurulumu henüz tamamlanmamış. Web sitesi dizini doğrulanıp kurulum kanıtı oluşmadan bu adımı tamamlandı saymayın.';
  }
  return REMEDIATION_GUIDANCE[step.kind]
    ?? 'Sunucu durumunu ve kaynak kayıtlarını kontrol edin. Uyuşmazlıkları giderdikten sonra adımı tekrar deneyin; doğrulanmayan kaynakları silmeyin.';
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
  if ((operation.steps ?? []).some((step) => step.state === 'failed')) return 'Müdahale gerekli';
  if ((operation.steps ?? []).some((step) => step.state === 'blocked')) return 'Engel var';
  if ((operation.steps ?? []).some((step) => ['applying', 'compensating'].includes(step.state))) return 'İşleniyor';
  if ((operation.steps ?? []).some((step) => step.state === 'compensated')) return 'Geri alındı';
  return 'Hazırlanıyor';
}
