const RUNTIME_LABELS = Object.freeze({
  static: 'Statik',
  node: 'Node.js / Passenger',
  php: 'PHP-FPM',
  docker: 'Docker / proxy',
  proxy: 'External proxy',
});

const STEP_LABELS = Object.freeze({
  unix_identity: 'Unix kimliği',
  runtime: 'Runtime izolasyonu',
  php_runtime: 'PHP-FPM izolasyonu',
  sftp: 'SFTP izolasyonu',
});

const MIGRATION_STATUSES = Object.freeze({
  pending: Object.freeze({ badge: 'pending', label: 'Bekliyor' }),
  applying: Object.freeze({ badge: 'running', label: 'Uygulanıyor / inceleme gerekli' }),
  succeeded: Object.freeze({ badge: 'succeeded', label: 'Uygulandı' }),
  failed: Object.freeze({ badge: 'failed', label: 'Başarısız' }),
  compensating: Object.freeze({ badge: 'running', label: 'Geri alınıyor / inceleme gerekli' }),
  compensated: Object.freeze({ badge: 'off', label: 'Geri alındı' }),
  compensation_failed: Object.freeze({ badge: 'failed', label: 'Geri alma başarısız' }),
});

export function isolationStatusPresentation(audit) {
  if (audit?.status === 'isolated') return Object.freeze({ badge: 'succeeded', label: 'İzole' });
  if (audit?.status === 'migration_required') return Object.freeze({ badge: 'warning', label: 'Migration gerekli' });
  if (audit?.status === 'not_applicable') return Object.freeze({ badge: 'off', label: 'Uygulanamaz' });
  return Object.freeze({ badge: 'unknown', label: 'Bilinmiyor' });
}

export function isolationRuntimeLabel(runtimeType) {
  return RUNTIME_LABELS[runtimeType] ?? runtimeType ?? 'Bilinmiyor';
}

export function isolationStepPresentation(step) {
  const state = step?.satisfied === true
    ? Object.freeze({ badge: 'succeeded', label: 'Sağlandı' })
    : step?.satisfied === false
      ? Object.freeze({ badge: 'failed', label: 'Sağlanmadı' })
      : Object.freeze({ badge: 'unknown', label: 'Doğrulanamadı' });
  return Object.freeze({
    name: STEP_LABELS[step?.stepId] ?? step?.stepId ?? 'Bilinmeyen adım',
    ...state,
  });
}

export function isolationFindingPresentation(finding) {
  if (finding?.severity === 'critical') return Object.freeze({ badge: 'failed', label: 'Kritik' });
  if (finding?.severity === 'action_required') return Object.freeze({ badge: 'warning', label: 'İşlem gerekli' });
  return Object.freeze({ badge: 'unknown', label: 'İnceleme gerekli' });
}

export function isolationMigrationStatusPresentation(operation) {
  return MIGRATION_STATUSES[operation?.status] ?? Object.freeze({ badge: 'unknown', label: 'Bilinmiyor' });
}
