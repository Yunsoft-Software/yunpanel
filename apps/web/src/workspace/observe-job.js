import { jobActive, jobFromResponse } from './site-model.js';

// A fresh observer never trusts details cached before the dialog was reopened.
// The injected request is the existing session-aware panel client, not raw fetch.
export function observeJob({ id, request, onState, onJob, onDone, schedule = setTimeout, cancel = clearTimeout }) {
  const controller = new AbortController();
  let timer;
  let verified = null;
  onState({ job: null, error: null });
  async function poll() {
    try {
      const result = await request(`/jobs/${encodeURIComponent(id)}`, { signal: controller.signal });
      if (controller.signal.aborted) return;
      let next;
      try {
        next = jobFromResponse(result);
        if (next.id !== id) throw new Error('Mismatched job');
      } catch {
        const error = new Error('Invalid job response');
        error.code = 'invalid_job_response';
        throw error;
      }
      verified = next;
      onJob(next);
      onState({ job: next, error: null });
      if (jobActive(next)) timer = schedule(poll, 1500);
      else onDone();
    } catch (error) {
      if (controller.signal.aborted || error.name === 'AbortError') return;
      const inaccessible = [401, 403, 404].includes(error.status);
      const invalid = error.code === 'invalid_job_response';
      if (inaccessible || invalid) verified = null;
      onState({ job: verified, error: inaccessible
        ? 'Bu işlem kaydına artık erişilemiyor. İşler ekranından durumu yeniden kontrol edin.'
        : invalid ? 'API beklenen iş kaydını döndürmedi. Gösterim durduruldu.'
          : 'İşin güncel durumu alınamadı. Son doğrulanan kayıt gösteriliyor; iş sunucuda devam ediyor olabilir.' });
      if (!inaccessible && !invalid) timer = schedule(poll, 4000);
    }
  }
  poll();
  return () => { controller.abort(); cancel(timer); };
}
