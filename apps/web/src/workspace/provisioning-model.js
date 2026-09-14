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

export function provisioningStepLabel(step) {
  return STEP_LABELS[step?.id] ?? STEP_LABELS[step?.kind] ?? step?.id ?? step?.kind ?? 'Provisioning adımı';
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

export function canContinueProvisioning(operation) {
  if (!operation || operation.ready === true) return false;
  const required = (operation.steps ?? []).filter((step) => step.required !== false);
  if (required.some((step) => ['failed', 'compensated'].includes(step.state))) return false;
  return required.some((step) => ['pending', 'blocked', 'applying', 'compensating'].includes(step.state));
}

export function provisioningOperationLabel(operation) {
  if (!operation) return 'Provisioning kaydı yok';
  if (operation.ready) return 'Hazır';
  if ((operation.steps ?? []).some((step) => step.state === 'failed')) return 'Müdahale gerekli';
  if ((operation.steps ?? []).some((step) => step.state === 'blocked')) return 'Bloke';
  if ((operation.steps ?? []).some((step) => ['applying', 'compensating'].includes(step.state))) return 'Devam eden işlem';
  if ((operation.steps ?? []).some((step) => step.state === 'compensated')) return 'Geri alma sonrası müdahale gerekli';
  return 'Hazırlanıyor';
}
