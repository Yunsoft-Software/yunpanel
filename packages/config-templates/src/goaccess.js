import { createHash } from 'node:crypto';
import path from 'node:path';

const SAFE_PATH = /^\/[A-Za-z0-9._/-]+$/;
const SAFE_WS_URL = /^(?:wss?:\/\/[A-Za-z0-9.:_-]+)?\/[A-Za-z0-9._/-]+$/;

export class GoAccessTemplateError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'GoAccessTemplateError';
    this.code = code;
  }
}

function assertSafeAbsolutePath(value, fieldName) {
  if (typeof value !== 'string' || !SAFE_PATH.test(value)) {
    throw new GoAccessTemplateError('invalid_path', `${fieldName} must be a safe absolute path`);
  }
  const normalized = path.posix.normalize(value);
  if (normalized !== value || value.includes('/../') || value.endsWith('/..')) {
    throw new GoAccessTemplateError('invalid_path', `${fieldName} must not contain traversal segments`);
  }
  return value;
}

function assertSafeWsUrl(value) {
  if (typeof value !== 'string' || !SAFE_WS_URL.test(value)) {
    throw new GoAccessTemplateError('invalid_ws_url', 'wsUrl must be a valid WebSocket URL or path');
  }
  return value;
}

export const GOACCESS_LOG_FORMAT = 'COMBINED';
export const GOACCESS_DATE_FORMAT = '%d/%b/%Y';
export const GOACCESS_TIME_FORMAT = '%H:%M:%S';
export const GOACCESS_DEFAULT_SOCKET_ROOT = '/run/yunpanel/goaccess';
export const GOACCESS_DEFAULT_REPORTS_ROOT = '/var/lib/yunpanel/reports/goaccess';

export function renderGoAccessConfig({
  logPath = null,
  outputPath = null,
  realTime = false,
  wsUrl = null,
  unixSocket = null,
  pidFile = null,
} = {}) {
  const lines = [
    `time-format ${GOACCESS_TIME_FORMAT}`,
    `date-format ${GOACCESS_DATE_FORMAT}`,
    `log-format ${GOACCESS_LOG_FORMAT}`,
  ];

  if (logPath !== null) {
    lines.push(`log-file ${assertSafeAbsolutePath(logPath, 'logPath')}`);
  }
  if (outputPath !== null) {
    lines.push(`output ${assertSafeAbsolutePath(outputPath, 'outputPath')}`);
  }
  if (realTime) {
    lines.push('real-time-html true');
    if (wsUrl !== null) {
      lines.push(`ws-url ${assertSafeWsUrl(wsUrl)}`);
    }
    if (unixSocket !== null) {
      lines.push(`unix-socket ${assertSafeAbsolutePath(unixSocket, 'unixSocket')}`);
    }
    if (pidFile !== null) {
      lines.push(`pid-file ${assertSafeAbsolutePath(pidFile, 'pidFile')}`);
    }
  }

  return `${lines.join('\n')}\n`;
}

export function previewGoAccessConfig(spec = {}) {
  const content = renderGoAccessConfig(spec);
  const checksum = createHash('sha256').update(content).digest('hex');
  return Object.freeze({
    content,
    checksum,
    logFormat: GOACCESS_LOG_FORMAT,
    dateFormat: GOACCESS_DATE_FORMAT,
    timeFormat: GOACCESS_TIME_FORMAT,
    realTime: spec.realTime === true,
  });
}

export const goAccessTemplatePolicy = Object.freeze({
  logFormat: GOACCESS_LOG_FORMAT,
  dateFormat: GOACCESS_DATE_FORMAT,
  timeFormat: GOACCESS_TIME_FORMAT,
  defaultSocketRoot: GOACCESS_DEFAULT_SOCKET_ROOT,
  defaultReportsRoot: GOACCESS_DEFAULT_REPORTS_ROOT,
});
