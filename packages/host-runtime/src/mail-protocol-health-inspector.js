import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const SS = '/usr/bin/ss';
const MAX_OUTPUT = 32 * 1024;
const PROTOCOLS = Object.freeze([
  Object.freeze({ id: 'smtp', port: 25 }),
  Object.freeze({ id: 'submission', port: 587 }),
  Object.freeze({ id: 'imap', port: 143 }),
]);

export class MailProtocolHealthInspectorError extends Error {
  constructor(code, message, status = 503) {
    super(message);
    this.name = 'MailProtocolHealthInspectorError';
    this.code = code;
    this.status = status;
  }
}

function boundedText(value) {
  const output = String(value ?? '').trim();
  if (Buffer.byteLength(output) > MAX_OUTPUT) {
    throw new MailProtocolHealthInspectorError(
      'mail_protocol_health_output_too_large',
      'Mail protocol listener inspection output exceeded its bound',
    );
  }
  return output;
}

function listenerPresent(value) {
  return boundedText(value).split('\n').some((line) => line.trim().length > 0);
}

function digest(value) {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

export function createMailProtocolHealthInspector({
  run = (file, args, options = {}) => execFileAsync(file, args, {
    encoding: 'utf8',
    timeout: 10_000,
    maxBuffer: MAX_OUTPUT,
    windowsHide: true,
    env: { ...process.env, LC_ALL: 'C' },
    ...options,
  }),
} = {}) {
  if (typeof run !== 'function') {
    throw new MailProtocolHealthInspectorError(
      'mail_protocol_health_dependencies_invalid',
      'Mail protocol listener inspector dependency is invalid',
    );
  }

  async function inspect() {
    const observations = [];
    for (const protocol of PROTOCOLS) {
      let satisfied = false;
      try {
        const result = await run(SS, ['-H', '-ltn', `sport = :${protocol.port}`], {
          timeout: 10_000,
          maxBuffer: MAX_OUTPUT,
        });
        satisfied = listenerPresent(result?.stdout ?? result);
      } catch {
        satisfied = false;
      }
      observations.push(Object.freeze({
        id: protocol.id,
        port: protocol.port,
        satisfied,
      }));
    }
    const protocols = Object.freeze(observations);
    const blockers = Object.freeze(protocols.filter((entry) => !entry.satisfied).map((entry) => entry.id));
    const identity = Object.freeze({
      version: 1,
      protocols,
    });
    return Object.freeze({
      ...identity,
      sha256: digest(identity),
      ready: blockers.length === 0,
      blockers,
      sideEffects: false,
    });
  }

  return Object.freeze({ inspect });
}

export const mailProtocolHealthInternals = Object.freeze({
  ssPath: SS,
  maxOutput: MAX_OUTPUT,
  protocols: PROTOCOLS,
  boundedText,
  listenerPresent,
});
