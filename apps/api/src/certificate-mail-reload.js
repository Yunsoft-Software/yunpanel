const FAILED = Object.freeze({ service: 'mail', status: 'failed', stage: 'reload', error: 'certificate_mail_reload_failed' });

export async function reloadCertificateMail({ mailServiceIdentityRegistry, certificateRegistry, domainRegistry,
  reload, serverId, certificateId, result } = {}) {
  try {
    const binding = await mailServiceIdentityRegistry.getForServer(serverId);
    if (!binding) return null;
    const certificate = await certificateRegistry.getCertificate(certificateId);
    if (!certificate || certificate.serverId !== serverId) return { ...FAILED };
    const covers = binding.webDomainId === certificate.domainId || binding.hostname === certificate.certName
      || certificate.domains?.includes(binding.hostname);
    if (!covers) return null;
    const domain = await domainRegistry.getDomain(binding.webDomainId);
    if (binding.serverId !== serverId || binding.certificateId !== certificateId
      || domain?.serverId !== serverId || domain?.certificateId !== certificateId
      || domain.primaryDomain !== binding.hostname || certificate.source !== 'acme' || certificate.staging !== false
      || !['renewing', 'active'].includes(certificate.state) || certificate.certName !== result.certName
      || result.fullchainPath !== certificate.fullchainPath || result.privateKeyPath !== certificate.privateKeyPath
      || !mailServiceIdentityRegistryInternals.certificateCoversHostname(certificate, binding.hostname)
      || typeof reload !== 'function') return { ...FAILED };
    const proof = await reload({ hostname: binding.hostname, certName: certificate.certName,
      fullchainPath: certificate.fullchainPath, privateKeyPath: certificate.privateKeyPath,
      fingerprint256: result.fingerprint256 });
    const current = await mailServiceIdentityRegistry.getForServer(serverId);
    if (current?.revision !== binding.revision || current.webDomainId !== binding.webDomainId
      || current.certificateId !== certificateId || proof?.service !== 'mail' || proof.stage !== 'reload'
      || proof.status !== 'succeeded' || proof.imapFingerprintVerified !== true || proof.smtpFingerprintVerified !== true) return { ...FAILED };
    return { service: 'mail', status: 'succeeded', stage: 'reload', imapFingerprintVerified: true, smtpFingerprintVerified: true };
  } catch { return { ...FAILED }; }
}

export function canonicalMailReloadOutcome(value) {
  if (!value || value.service !== 'mail' || value.stage !== 'reload' || !['succeeded', 'failed'].includes(value.status)) return null;
  if (value.status === 'failed') return { ...FAILED };
  if (value.imapFingerprintVerified !== true || value.smtpFingerprintVerified !== true) return null;
  return { service: 'mail', status: 'succeeded', stage: 'reload', imapFingerprintVerified: true, smtpFingerprintVerified: true };
}
import { mailServiceIdentityRegistryInternals } from './mail-service-identity-registry.js';

