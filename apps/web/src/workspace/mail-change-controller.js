// One metadata mutation, then one durable native apply. Keep this controller
// until completion so an apply retry cannot recreate the mailbox or alias.
export function createMailChangeController({ domainId, getDomain, preview, apply, getRequest, waitForJob, requestId, desiredStatus = null }) {
  let saved = false;
  let value;
  let prepared = null;
  let job = null;
  let running = false;
  let completed = false;
  return Object.freeze({
    get saved() { return saved; },
    get completed() { return completed; },
    async run(mutate) {
      if (running) throw new Error('Posta işlemi devam ediyor');
      if (completed) return value;
      running = true;
      try {
        const initial = await getDomain(domainId);
        if (initial.managementMode !== 'local') throw new Error('Bu alan adı harici posta hizmeti kullanıyor');
        if (!saved) { value = await mutate(); saved = true; }
        if (!job && prepared) {
          try { job = await getRequest(domainId, requestId); }
          catch (error) { if (error.status !== 404 && error.code !== 'mail_configuration_request_not_found') throw error; }
        }
        if (!job) {
          if (!prepared) {
            const current = await getDomain(domainId);
            const status = desiredStatus ?? current.status;
            const evidence = await preview(domainId, { expectedRevision: current.revision, status });
            if (!evidence.readyToApply) throw new Error('Posta yapılandırması uygulanmaya hazır değil');
            prepared = { expectedRevision: current.revision, status, preview: evidence, requestId };
          }
          job = await apply(domainId, prepared);
        }
        const finished = await waitForJob(job.id);
        const result = finished.result;
        if (finished.status !== 'succeeded' || result?.version !== 3 || result.applied !== true || result.sideEffects !== true
          || result.mailDomainId !== domainId || result.previewDigest !== prepared.preview.previewDigest
          || result.configurationSha256 !== prepared.preview.configuration.sha256 || result.desiredStatus !== prepared.status) {
          throw new Error('Posta hizmeti sonucu doğrulanamadı');
        }
        const current = await getDomain(domainId);
        if (current.status !== result.desiredStatus || current.revision !== result.previousRevision
          + (result.previousStatus === result.desiredStatus ? 0 : 1)) throw new Error('Posta hizmeti durumu değişti; yeniden kontrol edin');
        completed = true;
        return value;
      } catch (error) {
        if (saved) {
          const failure = new Error(`Değişiklik kaydedildi, posta hizmetine uygulanması tamamlanmadı. ${error.message}`);
          failure.cause = error; failure.saved = true; failure.code = error.code; throw failure;
        }
        throw error;
      } finally { running = false; }
    },
  });
}
