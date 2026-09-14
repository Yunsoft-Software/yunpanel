import assert from 'node:assert/strict';
import test from 'node:test';
import {
  applicationUnixUser,
  createApplicationIdentity,
  ApplicationIdentityError,
} from '../src/application-identity.js';

const applicationId = '6DCB8908-3F3E-43DA-9452-15FD6B51AC76';

test('Application identity derives the stable yunapp user and canonical paths from one identity', () => {
  const identity = createApplicationIdentity(applicationId);

  assert.equal(identity.applicationId, applicationId.toLowerCase());
  assert.equal(identity.unixUser, applicationUnixUser(applicationId));
  assert.match(identity.unixUser, /^yunapp-[a-f0-9]{12}$/);
  assert.equal(identity.paths.workspace.homeDirectory, `/var/lib/yunpanel/data/${applicationId.toLowerCase()}`);
  assert.equal(identity.paths.runtime.currentRelease, `/var/lib/yunpanel/apps/${applicationId.toLowerCase()}/current`);
  assert.equal(identity.paths.static.buildRoot, `/var/lib/yunpanel/build/${applicationId.toLowerCase()}`);
  assert.equal(identity.paths.static.publishRoot, `/var/www/yunpanel/apps/${applicationId.toLowerCase()}`);
});

test('Application identity keeps the same Unix user when custom filesystem roots are injected', () => {
  const identity = createApplicationIdentity(applicationId, {
    applicationRoot: '/apps',
    dataRoot: '/data',
    staticBuildRoot: '/build',
    staticPublishRoot: '/www',
  });

  assert.equal(identity.unixUser, applicationUnixUser(applicationId));
  assert.equal(identity.paths.workspace.homeDirectory, `/data/${applicationId.toLowerCase()}`);
  assert.equal(identity.paths.runtime.applicationRoot, `/apps/${applicationId.toLowerCase()}`);
  assert.equal(identity.paths.static.buildRoot, `/build/${applicationId.toLowerCase()}`);
  assert.equal(identity.paths.static.publishRoot, `/www/${applicationId.toLowerCase()}`);
});

test('Application identity rejects malformed ids before deriving host state', () => {
  for (const value of ['../etc', 'not-a-uuid', '', null]) {
    assert.throws(
      () => createApplicationIdentity(value),
      (error) => error instanceof ApplicationIdentityError
        && error.code === 'application_identity_invalid',
    );
  }
});
