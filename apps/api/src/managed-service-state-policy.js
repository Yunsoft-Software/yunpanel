import { MANAGED_SERVICE_IDS } from '@yunpanel/protocol';

function definition(packages, units, checksConfiguration = false) {
  return Object.freeze({
    packages: Object.freeze([...packages]),
    units: Object.freeze([...units]),
    checksConfiguration,
  });
}

const POLICY = new Map([
  ['nginx', definition(['nginx'], ['nginx.service'])],
  ['mariadb', definition(['mariadb-server'], ['mariadb.service'])],
  ['mysql', definition(['mysql-server'], ['mysql.service'])],
  ['docker', definition(['docker.io'], ['docker.service'])],
  ['cron', definition(['cron'], ['cron.service'])],
  ['postfix', definition(['postfix'], ['postfix.service'], true)],
  ['dovecot', definition(['dovecot-imapd'], ['dovecot.service'], true)],
  ['rspamd', definition(['rspamd'], ['rspamd.service'], true)],
  ['roundcube', definition(['roundcube-core'], [], true)],
]);

if (POLICY.size !== MANAGED_SERVICE_IDS.length || MANAGED_SERVICE_IDS.some((id) => !POLICY.has(id))) {
  throw new Error('Managed service state policy does not match the protocol catalog');
}

export function managedServiceStatePolicy(serviceId) {
  return POLICY.get(serviceId) ?? null;
}
