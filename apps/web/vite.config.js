import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { createBuildInfo, writeBuildInfoFile } from '../../scripts/emit-build-info.mjs';

const webRootDir = path.dirname(fileURLToPath(import.meta.url));
const repositoryRootDir = path.resolve(webRootDir, '../..');

function yunpanelBuildInfoPlugin(buildInfo) {
  let resolvedOutDir = path.resolve(webRootDir, 'dist');
  return {
    name: 'yunpanel-build-info',
    apply: 'build',
    configResolved(resolvedConfig) {
      resolvedOutDir = path.resolve(resolvedConfig.root, resolvedConfig.build.outDir);
    },
    closeBundle() {
      writeBuildInfoFile(path.join(resolvedOutDir, 'build-info.json'), buildInfo);
    },
  };
}

export default defineConfig(({ command }) => {
  const buildInfo = createBuildInfo({
    repoDir: repositoryRootDir,
    env: process.env,
    strict: command === 'build',
  });

  return {
    define: {
      __YUNPANEL_FRONTEND_BUILD_INFO__: JSON.stringify(buildInfo),
    },
    plugins: [
      react(),
      yunpanelBuildInfoPlugin(buildInfo),
    ],
    server: {
      proxy: {
        '/api': {
          target: 'http://127.0.0.1:3001',
          changeOrigin: true,
        },
      },
    },
  };
});
