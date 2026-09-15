import dgram from 'node:dgram';
import net from 'node:net';
import { randomInt } from 'node:crypto';

const DNS_PORT = 53;
const LOOPBACK_V4 = '127.0.0.1';
const TIMEOUT_MS = 3_000;
const REFUSED_RCODE = 5;

export class PowerDnsSocketHealthError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'PowerDnsSocketHealthError';
    this.code = code;
  }
}

function encodeQuestion(name, { recursionDesired = false } = {}) {
  const labels = String(name).toLowerCase().split('.').filter(Boolean);
  if (labels.length < 2 || labels.some((label) => label.length < 1 || label.length > 63 || !/^[a-z0-9-]+$/.test(label))) {
    throw new PowerDnsSocketHealthError('powerdns_probe_name_invalid', 'PowerDNS DNS probe name is invalid');
  }
  const id = randomInt(0, 65536);
  const header = Buffer.alloc(12);
  header.writeUInt16BE(id, 0);
  header.writeUInt16BE(recursionDesired ? 0x0100 : 0x0000, 2);
  header.writeUInt16BE(1, 4);
  const parts = [header];
  for (const label of labels) {
    const value = Buffer.from(label, 'ascii');
    parts.push(Buffer.from([value.length]), value);
  }
  const tail = Buffer.alloc(5);
  tail[0] = 0;
  tail.writeUInt16BE(1, 1);
  tail.writeUInt16BE(1, 3);
  parts.push(tail);
  return Object.freeze({ id, packet: Buffer.concat(parts) });
}

function responseFlags(packet, expectedId) {
  if (!Buffer.isBuffer(packet) || packet.length < 12 || packet.readUInt16BE(0) !== expectedId) {
    throw new PowerDnsSocketHealthError('powerdns_dns_probe_response_invalid', 'PowerDNS DNS probe returned an invalid response');
  }
  const flags = packet.readUInt16BE(2);
  if ((flags & 0x8000) === 0) {
    throw new PowerDnsSocketHealthError('powerdns_dns_probe_response_invalid', 'PowerDNS DNS probe did not return a response packet');
  }
  return Object.freeze({
    rcode: flags & 0x000f,
    recursionAvailable: (flags & 0x0080) !== 0,
    authoritative: (flags & 0x0400) !== 0,
  });
}

function udpExchange(query, { host = LOOPBACK_V4, port = DNS_PORT, timeoutMs = TIMEOUT_MS } = {}) {
  return new Promise((resolve, reject) => {
    const socket = dgram.createSocket('udp4');
    let settled = false;
    const closeSocket = () => {
      try { socket.close(() => {}); } catch { /* Socket may not have bound before an early send/error failure. */ }
    };
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      closeSocket();
      if (error) reject(error); else resolve(value);
    };
    const timer = setTimeout(() => finish(new PowerDnsSocketHealthError('powerdns_udp_timeout', 'PowerDNS UDP/53 probe timed out')), timeoutMs);
    socket.once('error', () => finish(new PowerDnsSocketHealthError('powerdns_udp_unavailable', 'PowerDNS UDP/53 probe failed')));
    socket.once('message', (message) => {
      try { finish(null, responseFlags(message, query.id)); }
      catch (error) { finish(error); }
    });
    socket.send(query.packet, port, host, (error) => {
      if (error) finish(new PowerDnsSocketHealthError('powerdns_udp_unavailable', 'PowerDNS UDP/53 probe failed'));
    });
  });
}

function tcpExchange(query, { host = LOOPBACK_V4, port = DNS_PORT, timeoutMs = TIMEOUT_MS } = {}) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection({ host, port });
    let buffer = Buffer.alloc(0);
    let settled = false;
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      if (error) reject(error); else resolve(value);
    };
    const timer = setTimeout(() => finish(new PowerDnsSocketHealthError('powerdns_tcp_timeout', 'PowerDNS TCP/53 probe timed out')), timeoutMs);
    socket.once('error', () => finish(new PowerDnsSocketHealthError('powerdns_tcp_unavailable', 'PowerDNS TCP/53 probe failed')));
    socket.once('connect', () => {
      const length = Buffer.alloc(2);
      length.writeUInt16BE(query.packet.length, 0);
      socket.write(Buffer.concat([length, query.packet]));
    });
    socket.on('data', (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      if (buffer.length < 2) return;
      const size = buffer.readUInt16BE(0);
      if (size < 12 || size > 65535) return finish(new PowerDnsSocketHealthError('powerdns_dns_probe_response_invalid', 'PowerDNS TCP DNS response length is invalid'));
      if (buffer.length < size + 2) return;
      try { finish(null, responseFlags(buffer.subarray(2, size + 2), query.id)); }
      catch (error) { finish(error); }
    });
  });
}

export function createPowerDnsSocketHealthInspector({
  udpProbe = udpExchange,
  tcpProbe = tcpExchange,
  probeName = 'yunpanel-recursion-probe.invalid',
} = {}) {
  if (typeof udpProbe !== 'function' || typeof tcpProbe !== 'function') {
    throw new PowerDnsSocketHealthError('powerdns_socket_probe_dependencies_invalid', 'PowerDNS socket probe dependencies are unavailable');
  }

  async function inspect() {
    const plainQuery = encodeQuestion(probeName, { recursionDesired: false });
    const recursiveQuery = encodeQuestion(probeName, { recursionDesired: true });
    let udp;
    let tcp;
    let recursion;
    try {
      [udp, tcp, recursion] = await Promise.all([
        udpProbe(plainQuery),
        tcpProbe(plainQuery),
        udpProbe(recursiveQuery),
      ]);
    } catch (error) {
      if (error instanceof PowerDnsSocketHealthError) {
        return Object.freeze({ satisfied: false, reason: error.code });
      }
      return Object.freeze({ satisfied: false, reason: 'powerdns_socket_probe_failed' });
    }
    if (recursion.recursionAvailable || recursion.rcode !== REFUSED_RCODE) {
      return Object.freeze({
        satisfied: false,
        reason: 'powerdns_recursion_policy_invalid',
        recursion: Object.freeze({ rcode: recursion.rcode, available: recursion.recursionAvailable }),
      });
    }
    return Object.freeze({
      satisfied: true,
      udp53: true,
      tcp53: true,
      recursive: false,
      udp: Object.freeze({ rcode: udp.rcode, authoritative: udp.authoritative }),
      tcp: Object.freeze({ rcode: tcp.rcode, authoritative: tcp.authoritative }),
      recursion: Object.freeze({ rcode: recursion.rcode, available: false }),
    });
  }

  return Object.freeze({ inspect });
}

export const powerDnsSocketHealthInternals = Object.freeze({
  encodeQuestion,
  responseFlags,
  udpExchange,
  tcpExchange,
  constants: Object.freeze({ DNS_PORT, LOOPBACK_V4, TIMEOUT_MS, REFUSED_RCODE }),
});
