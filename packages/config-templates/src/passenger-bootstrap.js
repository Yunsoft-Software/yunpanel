import path from 'node:path';
import { assertUuid } from '@yunpanel/shared';

const APP_ROOT = '/var/lib/yunpanel/apps';
const DATA_ROOT = '/var/lib/yunpanel/data';
const APP_ENVS = new Set(['production', 'development']);

export class PassengerBootstrapTemplateError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'PassengerBootstrapTemplateError';
    this.code = code;
  }
}

function appId(value) {
  try { return assertUuid(value, 'applicationId'); }
  catch { throw new PassengerBootstrapTemplateError('passenger_bootstrap_application_invalid', 'Passenger bootstrap Application identity is invalid'); }
}

function exactEnvironmentPath(applicationId, value) {
  const expected = path.posix.join(DATA_ROOT, applicationId, 'passenger', 'environment.json');
  if (value !== expected) {
    throw new PassengerBootstrapTemplateError('passenger_bootstrap_environment_path_invalid', 'Passenger bootstrap environment path is outside managed state');
  }
  return expected;
}

function managedAppPath(applicationId, value, field) {
  const root = path.posix.join(APP_ROOT, applicationId, 'current');
  if (typeof value !== 'string' || !path.posix.isAbsolute(value) || path.posix.normalize(value) !== value
    || (value !== root && !value.startsWith(`${root}/`))) {
    throw new PassengerBootstrapTemplateError('passenger_bootstrap_path_invalid', `${field} is outside the active managed release`);
  }
  return value;
}

export function renderPassengerBootstrap({
  applicationId,
  appEnv,
  environmentPath,
  appRoot,
  startupPath,
} = {}) {
  const id = appId(applicationId);
  if (!APP_ENVS.has(appEnv)) {
    throw new PassengerBootstrapTemplateError('passenger_bootstrap_app_env_invalid', 'Passenger bootstrap app environment is invalid');
  }
  const envPath = exactEnvironmentPath(id, environmentPath);
  const root = managedAppPath(id, appRoot, 'appRoot');
  const startup = managedAppPath(id, startupPath, 'startupPath');
  if (!startup.startsWith(`${root}/`)) {
    throw new PassengerBootstrapTemplateError('passenger_bootstrap_startup_invalid', 'Passenger startup file must stay inside the configured app root');
  }

  return `import { readFile } from 'node:fs/promises';\nimport { pathToFileURL } from 'node:url';\n\nconst values = JSON.parse(await readFile(${JSON.stringify(envPath)}, 'utf8'));\nif (!values || typeof values !== 'object' || Array.isArray(values)) throw new Error('Invalid managed environment');\nfor (const [key, value] of Object.entries(values)) {\n  if (typeof value !== 'string') throw new Error('Invalid managed environment value');\n  process.env[key] = value;\n}\nprocess.env.NODE_ENV = ${JSON.stringify(appEnv)};\nprocess.env.HOST = '127.0.0.1';\nprocess.env.YUNPANEL_APPLICATION_ID = ${JSON.stringify(id)};\nprocess.chdir(${JSON.stringify(root)});\nawait import(pathToFileURL(${JSON.stringify(startup)}).href);\n`;
}

export const passengerBootstrapTemplatePolicy = Object.freeze({
  appRoot: APP_ROOT,
  dataRoot: DATA_ROOT,
  appEnvironments: Object.freeze([...APP_ENVS]),
});
