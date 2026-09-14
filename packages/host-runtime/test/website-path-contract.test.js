import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createWebsitePathContract,
  WebsitePathContractError,
  websitePathContractInternals,
} from '../src/website-path-contract.js';

const websiteId = 'F73CC6AC-07E8-4D22-B29A-741154687D20';
const applicationId = '6DCB8908-3F3E-43DA-9452-15FD6B51AC76';

test('Website path contract preserves current managed roots and separates ownership authorities', () => {
  const contract = createWebsitePathContract({ websiteId, applicationId });

  assert.equal(contract.websiteId, websiteId.toLowerCase());
  assert.equal(contract.applicationId, applicationId.toLowerCase());

  assert.deepEqual(contract.workspace, {
    authority: 'site_user',
    homeDirectory: `/var/lib/yunpanel/data/${applicationId.toLowerCase()}`,
    homeMode: 0o750,
    persistentDataDirectory: `/var/lib/yunpanel/data/${applicationId.toLowerCase()}`,
    persistentDataMode: 0o750,
    temporaryDirectory: `/var/lib/yunpanel/data/${applicationId.toLowerCase()}/tmp`,
    temporaryMode: 0o700,
    logDirectory: `/var/lib/yunpanel/data/${applicationId.toLowerCase()}/logs`,
    logMode: 0o750,
    sftpRoot: `/var/lib/yunpanel/data/${applicationId.toLowerCase()}`,
  });

  assert.deepEqual(contract.runtime, {
    containerAuthority: 'control_plane',
    releaseAuthority: 'site_user',
    applicationRoot: `/var/lib/yunpanel/apps/${applicationId.toLowerCase()}`,
    releasesDirectory: `/var/lib/yunpanel/apps/${applicationId.toLowerCase()}/releases`,
    currentRelease: `/var/lib/yunpanel/apps/${applicationId.toLowerCase()}/current`,
  });

  assert.deepEqual(contract.static, {
    buildAuthority: 'site_user',
    buildRoot: `/var/lib/yunpanel/build/${applicationId.toLowerCase()}`,
    publishRoot: `/var/www/yunpanel/apps/${applicationId.toLowerCase()}`,
  });

  assert.deepEqual(contract.backup, {
    authority: 'control_plane',
    artifactRoot: '/var/lib/yunpanel/backups/resources',
    artifactRootMode: 0o700,
    scopeKey: `website:${websiteId.toLowerCase()}`,
  });

  assert.equal(Object.isFrozen(contract), true);
  assert.equal(Object.isFrozen(contract.workspace), true);
  assert.equal(Object.isFrozen(contract.runtime), true);
  assert.equal(Object.isFrozen(contract.backup), true);
});

test('Website path contract rejects malformed identities instead of normalizing paths heuristically', () => {
  for (const input of [
    { websiteId: '../etc', applicationId },
    { websiteId, applicationId: '../etc' },
    { websiteId: 'not-a-uuid', applicationId },
    { websiteId, applicationId: 'not-a-uuid' },
    { websiteId: null, applicationId },
    { websiteId, applicationId: null },
  ]) {
    assert.throws(
      () => createWebsitePathContract(input),
      (error) => error instanceof WebsitePathContractError
        && error.code === 'website_path_identity_invalid',
    );
  }
});

test('managed direct-child helper rejects any non-child result', () => {
  assert.throws(
    () => websitePathContractInternals.directChild('/var/lib/yunpanel/data', '../escape'),
    (error) => error instanceof WebsitePathContractError
      && error.code === 'website_path_escape_rejected',
  );
});
