import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const webUnitUrl = new URL('../../../packaging/systemd/yunpanel-web.service', import.meta.url);

test('web gateway cannot inherit privileged API secrets or read control-plane state', async () => {
  const unit = await readFile(webUnitUrl, 'utf8');
  assert.match(unit, /^User=yunpanel$/m);
  assert.match(unit, /^NoNewPrivileges=true$/m);
  assert.match(unit, /^ProtectSystem=strict$/m);
  assert.doesNotMatch(unit, /^EnvironmentFile=\/etc\/yunpanel\/control-plane\/api\.env$/m);
  assert.doesNotMatch(unit, /^EnvironmentFile=\/etc\/yunpanel\/control-plane\/proxy\.env$/m);
  assert.match(unit, /^EnvironmentFile=\/etc\/yunpanel\/web\/web\.env$/m);
  assert.match(unit, /^LoadCredential=yunpanel-internal-proxy-token:\/etc\/yunpanel\/control-plane\/proxy\.token$/m);
  const unset = unit.match(/^UnsetEnvironment=(.+)$/m)?.[1] ?? '';
  for (const name of [
    'YUNPANEL_SECRET_MASTER_KEY',
    'YUNPANEL_AUTH_DB',
    'YUNPANEL_SERVER_STORE',
    'YUNPANEL_DOMAIN_STORE',
    'YUNPANEL_JOB_STORE',
    'YUNPANEL_CERTIFICATE_STORE',
    'YUNPANEL_APPLICATION_STORE',
    'YUNPANEL_WEBSITE_STORE',
    'YUNPANEL_WEBSITE_MIGRATION_POLICY_STORE',
    'YUNPANEL_WEBSITE_MIGRATION_LEDGER_STORE',
    'YUNPANEL_DNS_HOSTING_STORE',
    'YUNPANEL_DNS_CREDENTIAL_STORE',
    'YUNPANEL_MAIL_DOMAIN_STORE',
    'YUNPANEL_MAILBOX_STORE',
    'YUNPANEL_MAILBOX_QUOTA_STORE',
    'YUNPANEL_MAILBOX_FORWARDING_STORE',
    'YUNPANEL_MAIL_ALIAS_STORE',
    'YUNPANEL_MAIL_DKIM_ROOT',
    'YUNPANEL_MAIL_DKIM_RETIREMENT_STORE',
    'YUNPANEL_MAIL_SERVICE_IDENTITY_STORE',
    'YUNPANEL_MAIL_SRS_SECRET_STORE',
    'YUNPANEL_ROUNDCUBE_SECRET_STORE',
    'YUNPANEL_DATABASE_BINDING_STORE',
    'YUNPANEL_DATABASE_CREDENTIAL_STORE',
    'YUNPANEL_DOCKER_WORKLOAD_STORE',
    'YUNPANEL_DOCKER_COMPOSE_PROJECT_STORE',
    'YUNPANEL_DOCKER_COMPOSE_ENVIRONMENT_STORE',
    'YUNPANEL_DOCKER_REGISTRY_CREDENTIAL_STORE',
    'YUNPANEL_APPLICATION_ENVIRONMENT_STORE',
    'YUNPANEL_LOCAL_SERVER_ID',
    'YUN_AGENT_TOKEN',
  ]) assert.ok(unset.split(/\s+/).includes(name), `${name} must be removed from the web process environment`);
  assert.match(unit, /^InaccessiblePaths=\/etc\/yunpanel\/control-plane \/var\/lib\/yunpanel\/control-plane$/m);
});
