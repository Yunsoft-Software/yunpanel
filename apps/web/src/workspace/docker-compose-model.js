const ENV_KEY = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/;

export function parseDockerEnvironmentText(value) {
  if (typeof value !== 'string') throw new Error('Environment content is required');
  const variables = {};
  for (const [index, raw] of value.split(/\r?\n/).entries()) {
    if (!raw.trim()) continue;
    const separator = raw.indexOf('=');
    if (separator <= 0) throw new Error(`Satır ${index + 1}: KEY=value biçimi gerekli.`);
    const key = raw.slice(0, separator).trim();
    const variableValue = raw.slice(separator + 1);
    if (!ENV_KEY.test(key)) throw new Error(`Satır ${index + 1}: geçersiz environment anahtarı.`);
    if (Object.hasOwn(variables, key)) throw new Error(`Satır ${index + 1}: ${key} birden fazla tanımlandı.`);
    variables[key] = variableValue;
  }
  return variables;
}

// Rows for the removal preview. Deletable volumes are kept unless the confirmed
// preview opted in; the others always stay and carry the server's reason.
export function dockerRemovalVolumes(preview) {
  const volumes = Array.isArray(preview?.volumes) ? preview.volumes : [];
  const deleteVolumes = preview?.deleteVolumes === true;
  const rows = volumes.filter((volume) => volume && typeof volume.volumeName === 'string').map((volume) => {
    const deletable = volume.deletable === true;
    const deleted = deletable && deleteVolumes;
    return Object.freeze({
      volumeKey: volume.volumeKey,
      volumeName: volume.volumeName,
      deletable,
      deleted,
      status: deletable ? (deleted ? 'Silinecek' : 'Korunacak') : (volume.blockReason || 'Korunacak'),
    });
  });
  return { rows, canDelete: rows.some((row) => row.deletable), deleteVolumes };
}

export function dockerRemovalMessage(projectName, summary) {
  const deleted = summary.rows.filter((row) => row.deleted).length;
  const volumes = deleted > 0
    ? `${deleted} volume ve içindeki veriler kalıcı olarak silinir; diğer volume'lar korunur.`
    : "Adlı volume'lar sunucuda korunur.";
  return `${projectName} projesinin konteynerleri ve ağları kaldırılacak, kayıtlı yapılandırma ve erişim sırları silinecek. ${volumes} İmajlar korunur. Bağlı siteler varken kaldırma engellenir.`;
}

export const dockerComposeModelInternals = Object.freeze({ environmentKeyPattern: ENV_KEY });
