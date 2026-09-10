// Temporary compatibility alias for the retained development route. Production
// host inspection is agentless; remove this file when the legacy route itself is
// retired after migration rollback acceptance.
export { inspectLocalHost as inspectLocalAgent } from './local-host-inspection.js';
