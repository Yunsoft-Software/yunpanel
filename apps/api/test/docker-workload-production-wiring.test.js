import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const testDirectory = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.resolve(testDirectory, '../../..');
const source = readFileSync(path.join(repositoryRoot, 'apps/api/src/index.js'), 'utf8');
const envExample = readFileSync(path.join(repositoryRoot, '.env.example'), 'utf8');
const webUnit = readFileSync(path.join(repositoryRoot, 'packaging/systemd/yunpanel-web.service'), 'utf8');

test('production API persists Docker workload tracking outside the Website registry', () => {
  assert.match(source, /const dockerWorkloadStorePath = process\.env\.YUNPANEL_DOCKER_WORKLOAD_STORE \?\? path\.resolve\('\.data\/docker-workload-registry\.json'\);/);
  assert.match(source, /const dockerWorkloadRegistry = createDockerWorkloadRegistry\(\{[\s\S]*filePath: dockerWorkloadStorePath,[\s\S]*serverExists:/);
  assert.match(source, /await dockerWorkloadRegistry\.init\(\);/);
  assert.match(source, /dockerWorkloadRegistry,[\s\S]*applicationEnvironmentRegistry,/);
  assert.match(envExample, /^YUNPANEL_DOCKER_WORKLOAD_STORE=\.data\/docker-workload-registry\.json$/m);
  assert.match(webUnit, /UnsetEnvironment=.*YUNPANEL_DOCKER_WORKLOAD_STORE/);
});
