import assert from 'node:assert/strict';
import test from 'node:test';
import { jobRunningMailDkimRecoveryRuntimeInternals } from '../src/job-running-mail-dkim-recovery-runtime.js';

test('DKIM recovery resolves the canonical production mail-DKIM state root', () => {
  const paths = jobRunningMailDkimRecoveryRuntimeInternals.resolveMailDkimRecoveryPaths({
    env: {
      YUNPANEL_SERVER_STORE: '/var/lib/yunpanel/control-plane/server-registry.json',
      YUNPANEL_DOMAIN_STORE: '/var/lib/yunpanel/control-plane/domain-registry.json',
      YUNPANEL_JOB_STORE: '/var/lib/yunpanel/control-plane/job-registry.json',
      YUNPANEL_CERTIFICATE_STORE: '/var/lib/yunpanel/control-plane/certificate-registry.json',
      YUNPANEL_APPLICATION_STORE: '/var/lib/yunpanel/control-plane/application-registry.json',
      YUNPANEL_MAIL_DOMAIN_STORE: '/var/lib/yunpanel/control-plane/mail-domain-registry.json',
      YUNPANEL_MAIL_DKIM_ROOT: '/var/lib/yunpanel/control-plane/mail-dkim',
    },
    packaged: true,
    cwd: '/usr/lib/yunpanel',
  });
  assert.equal(paths.mailDomainStore, '/var/lib/yunpanel/control-plane/mail-domain-registry.json');
  assert.equal(paths.mailDkimKeyRoot, '/var/lib/yunpanel/control-plane/mail-dkim');
  assert.equal(paths.jobStore, '/var/lib/yunpanel/control-plane/job-registry.json');
});

test('DKIM recovery uses the same development default as the API when no override is present', () => {
  const paths = jobRunningMailDkimRecoveryRuntimeInternals.resolveMailDkimRecoveryPaths({
    env: {},
    packaged: false,
    cwd: '/workspace/yunpanel',
  });
  assert.equal(paths.mailDkimKeyRoot, '/workspace/yunpanel/.data/mail-dkim');
  assert.equal(paths.mailDomainStore, '/workspace/yunpanel/.data/mail-domain-registry.json');
});
