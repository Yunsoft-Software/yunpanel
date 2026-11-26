export async function reloadCertificateNginx(nginxManager) {
  try {
    if (typeof nginxManager?.reloadConfiguration !== 'function') throw new Error('reload unavailable');
    const outcome = await nginxManager.reloadConfiguration();
    if (outcome?.service !== 'nginx' || outcome.status !== 'succeeded' || outcome.stage !== 'reload') throw new Error('reload unverified');
    return { service: 'nginx', status: 'succeeded', stage: 'reload' };
  } catch {
    // The renewed material remains valid. Keep the native reload failure visible
    // as a partial outcome while existing workers continue serving their cert.
    return { service: 'nginx', status: 'failed', stage: 'reload', error: 'certificate_nginx_reload_failed' };
  }
}
