import {
  createPowerDnsAuthoritativeDurableManager,
} from './powerdns-authoritative-durable-manager.js';
import { PowerDnsAuthoritativeManagerError } from './powerdns-authoritative-manager.js';
import { createPowerDnsSocketHealthInspector } from './powerdns-socket-health-inspector.js';

export function createPowerDnsAuthoritativeReadyManager({
  manager = createPowerDnsAuthoritativeDurableManager(),
  socketInspector = createPowerDnsSocketHealthInspector(),
} = {}) {
  if (!manager || typeof manager.inspect !== 'function' || typeof manager.apply !== 'function'
    || !socketInspector || typeof socketInspector.inspect !== 'function') {
    throw new PowerDnsAuthoritativeManagerError(
      'powerdns_ready_manager_dependencies_invalid',
      'PowerDNS readiness manager dependencies are unavailable',
    );
  }

  async function socketState() {
    const sockets = await socketInspector.inspect();
    if (!sockets || typeof sockets !== 'object') {
      throw new PowerDnsAuthoritativeManagerError(
        'powerdns_socket_health_invalid',
        'PowerDNS socket health inspector returned invalid evidence',
      );
    }
    return sockets;
  }

  async function inspect(intent) {
    const base = await manager.inspect(intent);
    if (!base?.satisfied) return base;
    const sockets = await socketState();
    if (!sockets.satisfied) {
      return Object.freeze({
        ...base,
        satisfied: false,
        reason: sockets.reason ?? 'powerdns_socket_unhealthy',
        sockets,
      });
    }
    return Object.freeze({ ...base, sockets });
  }

  async function apply(intent) {
    const base = await manager.apply(intent);
    if (!base?.satisfied) {
      throw new PowerDnsAuthoritativeManagerError(
        'powerdns_base_apply_unverified',
        'PowerDNS base apply did not return verified evidence',
      );
    }
    const sockets = await socketState();
    if (!sockets.satisfied) {
      throw new PowerDnsAuthoritativeManagerError(
        sockets.reason ?? 'powerdns_socket_unhealthy',
        'PowerDNS service started but DNS socket or recursion policy verification failed',
      );
    }
    return Object.freeze({ ...base, sockets });
  }

  return Object.freeze({ inspect, apply });
}
