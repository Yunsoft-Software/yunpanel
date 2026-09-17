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
    || typeof manager.operation !== 'function' || typeof manager.resolve !== 'function'
    || typeof manager.retry !== 'function'
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

  async function operation() {
    return manager.operation();
  }

  async function resolve(intent, recovery) {
    const base = await manager.resolve(intent, recovery);
    if (!base?.satisfied) {
      throw new PowerDnsAuthoritativeManagerError(
        'powerdns_recovery_unverified',
        'PowerDNS recovery inspection did not return verified base evidence',
      );
    }
    const sockets = await socketState();
    if (!sockets.satisfied) {
      throw new PowerDnsAuthoritativeManagerError(
        sockets.reason ?? 'powerdns_socket_unhealthy',
        'PowerDNS recovery found unhealthy DNS socket or recursion policy evidence',
      );
    }
    return Object.freeze({ ...base, sockets });
  }

  async function retry(intent, recovery) {
    const base = await manager.retry(intent, recovery);
    if (!base?.satisfied) {
      throw new PowerDnsAuthoritativeManagerError(
        'powerdns_retry_unverified',
        'PowerDNS retry did not return verified base evidence',
      );
    }
    const sockets = await socketState();
    if (!sockets.satisfied) {
      throw new PowerDnsAuthoritativeManagerError(
        sockets.reason ?? 'powerdns_socket_unhealthy',
        'PowerDNS retry completed with unhealthy DNS socket or recursion policy evidence',
      );
    }
    return Object.freeze({ ...base, sockets });
  }

  return Object.freeze({ inspect, apply, operation, resolve, retry });
}
