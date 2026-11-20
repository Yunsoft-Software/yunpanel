import { OPERATIONS } from '@yunpanel/protocol';

const RESULT_FIELDS = Object.freeze([
  'version',
  'projectId',
  'projectName',
  'projectRevision',
  'composeSha256',
  'volumeKey',
  'volumeName',
  'volumeFingerprint',
  'previewDigest',
  'deleted',
  'sideEffects',
]);

export function sanitizeDockerVolumeJobResult(job, result) {
  const payload = job?.payload;
  if (!job || job.operation !== OPERATIONS.DOCKER_VOLUME_DELETE || !payload || typeof payload !== 'object'
    || !result || typeof result !== 'object' || Array.isArray(result)
    || Object.keys(result).length !== RESULT_FIELDS.length
    || RESULT_FIELDS.some((key) => !Object.hasOwn(result, key))
    || result.version !== 1
    || result.projectId !== payload.projectId
    || result.projectName !== payload.projectName
    || result.projectRevision !== payload.expectedProjectRevision
    || result.composeSha256 !== payload.expectedComposeSha256
    || result.volumeKey !== payload.volumeKey
    || result.volumeName !== payload.volumeName
    || result.volumeFingerprint !== payload.volumeFingerprint
    || result.previewDigest !== payload.previewDigest
    || result.deleted !== true
    || result.sideEffects !== true) {
    throw new Error('Docker volume deletion job result does not match the queued operation');
  }
  return Object.freeze({
    version: 1,
    projectId: result.projectId,
    projectName: result.projectName,
    projectRevision: result.projectRevision,
    composeSha256: result.composeSha256,
    volumeKey: result.volumeKey,
    volumeName: result.volumeName,
    volumeFingerprint: result.volumeFingerprint,
    previewDigest: result.previewDigest,
    deleted: true,
    sideEffects: true,
  });
}

export const dockerVolumeJobResultInternals = Object.freeze({
  resultFields: RESULT_FIELDS,
});
