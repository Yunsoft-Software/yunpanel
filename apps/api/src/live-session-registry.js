import { createHash, randomUUID } from 'node:crypto';

function identity(value, field) {
  if (typeof value !== 'string' || value.length < 1 || value.length > 128 || /[\u0000-\u001f\u007f]/.test(value)) {
    throw new TypeError(`${field} is invalid`);
  }
  return value;
}

export function createLiveSessionRegistry({ requireGenerationBoundary = false, generationBoundary = null } = {}) {
  if (typeof requireGenerationBoundary !== 'boolean') throw new TypeError('Terminal generation policy is invalid');
  const connections = new Map();
  const leases = new Map();
  const fences = new Map();
  const dockerProjectFences = new Map();
  const generationId = randomUUID();
  let recoverWebsiteLease = null;

  const failure = (code, status = 503) => Object.assign(new Error(
    code === 'terminal_website_removing'
      ? 'Site siliniyor'
      : code === 'terminal_docker_project_busy'
        ? 'Docker projesi durduruluyor veya kaldırılıyor'
        : 'Terminal kapatılamadı',
  ), { name: 'TerminalLifecycleError', code, status });
  const digest = (value) => createHash('sha256').update(JSON.stringify(value)).digest('hex');

  function processIdentity(value) {
    const keys = ['pid', 'ppid', 'pgid', 'sid', 'starttime'];
    if (!value || Object.keys(value).length !== keys.length || Object.keys(value).some(key => !keys.includes(key))
      || ['pid', 'pgid', 'sid'].some(key => !Number.isSafeInteger(value[key]) || value[key] < 1)
      || !Number.isSafeInteger(value.ppid) || value.ppid < 0
      || typeof value.starttime !== 'string' || !/^[0-9]{1,30}$/.test(value.starttime)) throw failure('terminal_drain_evidence_unavailable');
    return { pid: value.pid, ppid: value.ppid, pgid: value.pgid, sid: value.sid, starttime: value.starttime };
  }

  function normalizeBoundary(value) {
    const keys = ['version', 'verified', 'source', 'unit', 'cgroup', 'killMode', 'sendSigkill', 'onlyCurrentApiMember', 'api', 'socketNamespace', 'unitSha256', 'observedAt'];
    if (!value || Object.keys(value).length !== keys.length || Object.keys(value).some(key => !keys.includes(key))
      || value.version !== 1 || value.verified !== true || value.source !== 'systemd_cgroup_v2'
      || value.unit !== 'yunpanel-api.service' || value.cgroup !== '/system.slice/yunpanel-api.service'
      || value.killMode !== 'control-group' || value.sendSigkill !== true || value.onlyCurrentApiMember !== true
      || typeof value.unitSha256 !== 'string' || !/^[a-f0-9]{64}$/.test(value.unitSha256)
      || typeof value.observedAt !== 'string' || Number.isNaN(Date.parse(value.observedAt))) throw failure('terminal_drain_generation_unknown');
    const socket = value.socketNamespace;
    if (!socket || Object.keys(socket).length !== 7 || socket.path !== '/run/yunpanel/ttyd' || socket.empty !== true
      || typeof socket.exists !== 'boolean' || !Number.isSafeInteger(socket.gid) || socket.gid < 1
      || (socket.exists ? !/^[0-9]{1,30}$/.test(socket.dev) || !/^[0-9]{1,30}$/.test(socket.ino) || socket.mode !== 0o2770
        : socket.dev !== null || socket.ino !== null || socket.mode !== null)) throw failure('terminal_drain_generation_unknown');
    return { version: 1, verified: true, source: 'systemd_cgroup_v2', unit: value.unit, cgroup: value.cgroup,
      killMode: 'control-group', sendSigkill: true, onlyCurrentApiMember: true, api: processIdentity(value.api),
      socketNamespace: { path: socket.path, empty: true, exists: socket.exists, dev: socket.dev, ino: socket.ino, gid: socket.gid, mode: socket.mode },
      unitSha256: value.unitSha256, observedAt: value.observedAt };
  }
  const boundary = generationBoundary?.verified === true ? normalizeBoundary(generationBoundary) : null;
  function requireGeneration() {
    if (requireGenerationBoundary && !boundary) throw failure('terminal_drain_generation_unknown');
  }

  function processEvidence(value) {
    if (!value.started) return { version: 1, started: false };
    const root = processIdentity(value.root), creator = processIdentity(value.creator), known = value.known.map(processIdentity);
    if (!known.some(item => item.pid === root.pid && item.starttime === root.starttime)
      || new Set(known.map(item => item.pid)).size !== known.length || root.ppid !== creator.pid
      || root.sid !== root.pid || root.pgid !== root.pid) throw failure('terminal_drain_evidence_unavailable');
    let socket = null;
    if (value.socket !== null) {
      if (!value.socket || Object.keys(value.socket).length !== 2
        || !/^\/run\/yunpanel\/ttyd\/[0-9a-f-]{36}\.sock$/.test(value.socket.path)) throw failure('terminal_drain_evidence_unavailable');
      const raw = value.socket.identity;
      if (!raw || Object.keys(raw).length !== 6 || !/^[0-9]{1,30}$/.test(raw.dev) || !/^[0-9]{1,30}$/.test(raw.ino)
        || !/^[0-9]{1,30}$/.test(raw.kernelInode)
        || ['uid', 'gid', 'mode'].some(key => !Number.isSafeInteger(raw[key]) || raw[key] < 0)
        || raw.mode > 0o7777) throw failure('terminal_drain_evidence_unavailable');
      socket = { path: value.socket.path, identity: { dev: raw.dev, ino: raw.ino, uid: raw.uid, gid: raw.gid, mode: raw.mode, kernelInode: raw.kernelInode } };
    }
    return { version: 1, started: true, root, known, socket, creator };
  }

  function assertWebsiteOpen(websiteId) {
    const id = identity(websiteId, 'websiteId');
    if (fences.has(id)) throw failure('terminal_website_removing', 409);
    requireGeneration();
    return true;
  }

  function assertDockerProjectOpen(dockerProjectId) {
    const id = identity(dockerProjectId, 'dockerProjectId');
    if (dockerProjectFences.has(id)) throw failure('terminal_docker_project_busy', 409);
    return true;
  }

  function normalizeSnapshot(value, websiteId) {
    if (!value || value.version !== 1 || value.websiteId !== websiteId || value.complete !== true
      || typeof value.reservationId !== 'string' || typeof value.generationId !== 'string'
      || !Array.isArray(value.leases) || value.leases.length > 100
      || typeof value.capturedAt !== 'string' || Number.isNaN(Date.parse(value.capturedAt))) {
      throw failure('terminal_drain_evidence_unavailable');
    }
    const entries = value.leases.map((entry) => {
      if (!entry || !['node-pty', 'ttyd'].includes(entry.backend)
        || typeof entry.leaseId !== 'string' || !entry.evidence || entry.evidence.version !== 1
        || typeof entry.evidence.started !== 'boolean') throw failure('terminal_drain_evidence_unavailable');
      const allowed = entry.evidence.started
        ? ['version', 'started', 'root', 'known', 'socket', 'creator'] : ['version', 'started'];
      if (Object.keys(entry.evidence).some(key => !allowed.includes(key))
        || entry.evidence.started && (!entry.evidence.root || !entry.evidence.creator
          || !Array.isArray(entry.evidence.known) || entry.evidence.known.length > 256)) {
        throw failure('terminal_drain_evidence_unavailable');
      }
      return { leaseId: identity(entry.leaseId, 'leaseId'), backend: entry.backend, evidence: processEvidence(entry.evidence) };
    }).sort((a, b) => a.leaseId.localeCompare(b.leaseId));
    const snapshotBoundary = value.generationBoundary ? normalizeBoundary(value.generationBoundary) : null;
    if (requireGenerationBoundary && !snapshotBoundary
      || snapshotBoundary && (Date.parse(snapshotBoundary.observedAt) > Date.parse(value.capturedAt)
        || entries.some(entry => entry.evidence.started && (entry.evidence.creator.pid !== snapshotBoundary.api.pid
          || entry.evidence.creator.starttime !== snapshotBoundary.api.starttime)))) throw failure('terminal_drain_generation_unknown');
    if (new Set(entries.map(entry => entry.leaseId)).size !== entries.length) throw failure('terminal_drain_evidence_unavailable');
    const snapshot = { version: 1, websiteId, reservationId: identity(value.reservationId, 'reservationId'),
      generationId: identity(value.generationId, 'generationId'), generationBoundary: snapshotBoundary,
      capturedAt: value.capturedAt, complete: true, leases: entries };
    if (Buffer.byteLength(JSON.stringify(snapshot)) > 1024 * 1024) throw failure('terminal_drain_limit');
    return snapshot;
  }

  function matchingFence(websiteId, operationId) {
    const fence = fences.get(identity(websiteId, 'websiteId'));
    if (!fence || fence.operationId !== identity(operationId, 'operationId')) throw failure('terminal_website_fence_conflict', 409);
    return fence;
  }

  function verifiedClosure(value) {
    if (!value || value.verified !== true || value.childExited !== true || value.processesExited !== true
      || value.socketRemoved !== true || !Number.isSafeInteger(value.processCount) || value.processCount < 0
      || value.processCount > 256) throw failure('terminal_drain_unverified');
    const processes = Array.isArray(value.processes) ? value.processes.map(processIdentity) : [];
    if (processes.length !== value.processCount || new Set(processes.map(item => item.pid)).size !== processes.length) throw failure('terminal_drain_unverified');
    return { verified: true, childExited: true, processesExited: true, socketRemoved: true, processCount: value.processCount, processes };
  }

  function finishLease(record, proof) {
    const result = verifiedClosure(proof);
    leases.delete(record.id);
    const fence = fences.get(record.websiteId);
    if (fence) fence.closed.set(record.id, result);
    return result;
  }

  function beginWebsiteOpen({ websiteId, backend, snapshot, stop, drain } = {}) {
    assertWebsiteOpen(websiteId);
    if (!['node-pty', 'ttyd'].includes(backend) || typeof snapshot !== 'function'
      || typeof stop !== 'function' || typeof drain !== 'function') throw new TypeError('Website terminal lifecycle callbacks are required');
    if (leases.size >= 200) throw failure('terminal_drain_limit');
    const record = { id: randomUUID(), websiteId, backend, snapshot, stop, drain, stopRequested: false, withoutProcess: false };
    leases.set(record.id, record);
    return Object.freeze({
      id: record.id,
      isFenced: () => fences.has(record.websiteId),
      async awaitRemovalDecision() {
        const fence = fences.get(record.websiteId);
        if (fence && fence.operationId === null) await fence.decision;
      },
      settleWithoutProcess() {
        record.withoutProcess = true;
        return finishLease(record, { verified: true, childExited: true, processesExited: true, socketRemoved: true, processCount: 0 });
      },
      finish: (proof) => finishLease(record, proof),
    });
  }

  function reserveWebsiteRemoval(websiteId) {
    const id = identity(websiteId, 'websiteId');
    let fence = fences.get(id);
    if (!fence) {
      let decide;
      const decision = new Promise(resolve => { decide = resolve; });
      fence = { websiteId: id, reservationId: randomUUID(), operationId: null, snapshot: null,
        receipt: null, draining: null, closed: new Map(), decision, decide };
      fences.set(id, fence);
    }
    return Object.freeze({
      cancel() {
        if (fence.operationId !== null || fences.get(id) !== fence) return false;
        fences.delete(id);
        fence.decide();
        return true;
      },
      async snapshot() {
        requireGeneration();
        const entries = [...leases.values()].filter(record => record.websiteId === id);
        let timer;
        let evidence;
        try {
          evidence = await Promise.race([Promise.all(entries.map(async record => ({ leaseId: record.id, backend: record.backend,
            evidence: await record.snapshot() }))), new Promise((_, reject) => {
            timer = setTimeout(() => reject(failure('terminal_drain_timeout')), 10_000);
          })]);
        } finally { clearTimeout(timer); }
        return normalizeSnapshot({ version: 1, websiteId: id, reservationId: fence.reservationId,
          generationId, generationBoundary: boundary, capturedAt: new Date().toISOString(), complete: true, leases: evidence }, id);
      },
    });
  }

  function commitWebsiteRemoval(websiteId, operationId, rawSnapshot) {
    const id = identity(websiteId, 'websiteId'), op = identity(operationId, 'operationId');
    const fence = fences.get(id), snapshot = normalizeSnapshot(rawSnapshot, id);
    if (!fence || fence.reservationId !== snapshot.reservationId || fence.operationId !== null && fence.operationId !== op
      || fence.snapshot && digest(fence.snapshot) !== digest(snapshot)) throw failure('terminal_website_fence_conflict', 409);
    fence.operationId = op;
    fence.snapshot = snapshot;
    fence.decide?.();
    terminateWhere(record => record.websiteId === id, 'website_removal');
    for (const record of leases.values()) {
      if (record.websiteId !== id || record.stopRequested) continue;
      record.stopRequested = true;
      try { Promise.resolve(record.stop('website_removal')).catch(() => {}); } catch {}
    }
    return true;
  }

  function restoreWebsiteRemoval(websiteId, operationId, rawSnapshot, receipt = null) {
    const id = identity(websiteId, 'websiteId'), op = identity(operationId, 'operationId');
    const existing = fences.get(id);
    if (existing && existing.operationId !== null && existing.operationId !== op) throw failure('terminal_website_fence_conflict', 409);
    const snapshot = rawSnapshot ? normalizeSnapshot(rawSnapshot, id) : null;
    const fence = existing ?? { websiteId: id, reservationId: snapshot?.reservationId ?? randomUUID(), closed: new Map(), draining: null };
    if (existing?.snapshot && snapshot && digest(existing.snapshot) !== digest(snapshot)) throw failure('terminal_website_fence_conflict', 409);
    fence.operationId = op; fence.snapshot = snapshot; fence.receipt = receipt;
    fences.set(id, fence);
    if (snapshot) commitWebsiteRemoval(id, op, snapshot);
  }

  async function drainWebsite(websiteId, operationId, { snapshot: supplied = null, priorReceipt = null, timeoutMs = 30_000 } = {}) {
    const fence = matchingFence(websiteId, operationId);
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 120_000) throw new TypeError('Terminal drain deadline is invalid');
    const snapshot = supplied ? normalizeSnapshot(supplied, websiteId) : fence.snapshot;
    if (!snapshot || fence.snapshot && digest(snapshot) !== digest(fence.snapshot)) throw failure('terminal_drain_evidence_unavailable');
    const snapshotSha256 = digest(snapshot), prior = priorReceipt ?? fence.receipt;
    if (prior?.version === 1 && prior.verified === true && prior.websiteId === websiteId && prior.operationId === operationId
      && prior.snapshotSha256 === snapshotSha256 && ![...leases.values()].some(record => record.websiteId === websiteId)) {
      if (prior.scope !== 'website_manager_owned' || prior.leaseCount !== snapshot.leases.length || !Array.isArray(prior.leases)
        || prior.leases.length !== snapshot.leases.length || typeof prior.startedAt !== 'string' || typeof prior.completedAt !== 'string'
        || Number.isNaN(Date.parse(prior.startedAt)) || Date.parse(prior.completedAt) < Date.parse(prior.startedAt)
        || Number.isNaN(Date.parse(prior.completedAt)) || prior.zeroOpenUnderFence !== (snapshot.leases.length === 0)) throw failure('terminal_drain_unverified');
      const closed = prior.leases.map((value, index) => {
        if (value.leaseId !== snapshot.leases[index].leaseId || value.backend !== snapshot.leases[index].backend) throw failure('terminal_drain_unverified');
        return { leaseId: value.leaseId, backend: value.backend, ...verifiedClosure(value) };
      });
      if (prior.processCount !== closed.reduce((sum, value) => sum + value.processCount, 0)) throw failure('terminal_drain_unverified');
      return { version: 1, websiteId, operationId, snapshotSha256, verified: true, scope: 'website_manager_owned',
        leaseCount: closed.length, processCount: prior.processCount, leases: closed, zeroOpenUnderFence: prior.zeroOpenUnderFence,
        startedAt: prior.startedAt, completedAt: prior.completedAt };
    }
    if (fence.draining) return fence.draining;
    const startedAt = new Date().toISOString(), deadline = performance.now() + timeoutMs;
    const wait = async (value) => {
      const left = Math.ceil(deadline - performance.now());
      if (left <= 0) throw failure('terminal_drain_timeout');
      let timer;
      try { return await Promise.race([Promise.resolve(value), new Promise((_, reject) => {
        timer = setTimeout(() => reject(failure('terminal_drain_timeout')), left);
      })]); } finally { clearTimeout(timer); }
    };
    fence.draining = (async () => {
      const results = await Promise.allSettled(snapshot.leases.map(async entry => {
        let closure = fence.closed.get(entry.leaseId);
        const record = leases.get(entry.leaseId);
        if (!closure && record) {
          const result = await wait(record.drain({ timeoutMs: Math.max(1, Math.ceil(deadline - performance.now())) }));
          closure = fence.closed.get(entry.leaseId) ?? finishLease(record, result);
        }
        if (!closure && !entry.evidence.started) closure = { verified: true, childExited: true, processesExited: true, socketRemoved: true, processCount: 0 };
        if (!closure && recoverWebsiteLease) closure = await wait(recoverWebsiteLease(entry, { websiteId, operationId,
          timeoutMs: Math.max(1, Math.ceil(deadline - performance.now())) }));
        return { leaseId: entry.leaseId, backend: entry.backend, ...verifiedClosure(closure) };
      }));
      const failed = results.find(result => result.status === 'rejected');
      if (failed) throw failed.reason;
      if ([...leases.values()].some(record => record.websiteId === websiteId)) throw failure('terminal_drain_unverified');
      const closed = results.map(result => result.value);
      const receipt = { version: 1, websiteId, operationId, snapshotSha256, verified: true,
        scope: 'website_manager_owned', leaseCount: closed.length, processCount: closed.reduce((sum, value) => sum + value.processCount, 0),
        leases: closed, zeroOpenUnderFence: snapshot.leases.length === 0, startedAt, completedAt: new Date().toISOString() };
      fence.receipt = receipt;
      return structuredClone(receipt);
    })();
    try { return await fence.draining; } finally { fence.draining = null; }
  }

  function remove(connectionId) {
    return connections.delete(connectionId);
  }

  function register({ sessionId, userId, websiteId = null, dockerProjectId = null, containerId = null, terminate } = {}) {
    const normalizedSessionId = identity(sessionId, 'sessionId');
    const normalizedUserId = identity(userId, 'userId');
    const normalizedWebsiteId = websiteId === null ? null : identity(websiteId, 'websiteId');
    const normalizedDockerProjectId = dockerProjectId === null ? null : identity(dockerProjectId, 'dockerProjectId');
    const normalizedContainerId = containerId === null ? null : identity(containerId, 'containerId');
    if (normalizedWebsiteId !== null) assertWebsiteOpen(normalizedWebsiteId);
    if (normalizedDockerProjectId !== null) assertDockerProjectOpen(normalizedDockerProjectId);
    if (typeof terminate !== 'function') throw new TypeError('Live session terminate callback is required');
    const connectionId = randomUUID();
    connections.set(connectionId, {
      id: connectionId,
      sessionId: normalizedSessionId,
      userId: normalizedUserId,
      websiteId: normalizedWebsiteId,
      dockerProjectId: normalizedDockerProjectId,
      containerId: normalizedContainerId,
      terminate,
    });
    return Object.freeze({ connectionId, unregister: () => remove(connectionId) });
  }

  function terminateWhere(predicate, reason) {
    let count = 0;
    for (const [connectionId, connection] of connections) {
      if (!predicate(connection)) continue;
      connections.delete(connectionId);
      count += 1;
      try { connection.terminate(reason); } catch {}
    }
    return count;
  }

  function revokeDockerProject(dockerProjectId, reason = 'docker_project_lifecycle') {
    const normalized = identity(dockerProjectId, 'dockerProjectId');
    return terminateWhere((connection) => connection.dockerProjectId === normalized, reason);
  }

  function fenceDockerProject(dockerProjectId, reason = 'docker_project_lifecycle') {
    const normalized = identity(dockerProjectId, 'dockerProjectId');
    const current = dockerProjectFences.get(normalized);
    if (current) {
      current.count += 1;
      current.reason = reason;
    } else {
      dockerProjectFences.set(normalized, { count: 1, reason });
    }
    const revoked = revokeDockerProject(normalized, reason);
    let released = false;
    return Object.freeze({
      revoked,
      release() {
        if (released) return false;
        released = true;
        const entry = dockerProjectFences.get(normalized);
        if (!entry) return false;
        entry.count -= 1;
        if (entry.count <= 0) dockerProjectFences.delete(normalized);
        return true;
      },
    });
  }

  return {
    register,
    assertWebsiteOpen,
    assertDockerProjectOpen,
    fenceDockerProject,
    revokeDockerProject,
    beginWebsiteOpen,
    reserveWebsiteRemoval,
    commitWebsiteRemoval,
    restoreWebsiteRemoval,
    drainWebsite,
    websiteLifecycleSize: websiteId => [...leases.values()].filter(record => record.websiteId === identity(websiteId, 'websiteId')).length,
    configureWebsiteRecovery(handler) {
      if (typeof handler !== 'function' || recoverWebsiteLease !== null) throw new TypeError('Website terminal recovery is already configured or invalid');
      recoverWebsiteLease = handler;
    },
    revokeSession(sessionId, reason = 'session_revoked') {
      const normalized = identity(sessionId, 'sessionId');
      return terminateWhere((connection) => connection.sessionId === normalized, reason);
    },
    revokeUser(userId, reason = 'user_sessions_revoked') {
      const normalized = identity(userId, 'userId');
      return terminateWhere((connection) => connection.userId === normalized, reason);
    },
    closeAll(reason = 'server_shutdown') {
      return terminateWhere(() => true, reason);
    },
    size() { return connections.size; },
  };
}
