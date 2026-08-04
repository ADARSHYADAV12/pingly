import { resolve } from 'node:path';
import { defineConfig, externalizeDepsPlugin } from 'electron-vite';

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    build: {
      rollupOptions: {
        // shim is a standalone zero-dependency script, not part of the Electron main bundle
        input: {
          index: resolve(__dirname, 'src/main/index.ts'),
          shim: resolve(__dirname, 'src/shim/main.ts'),
          // plain node, no electron — see the header of adapter-test.ts for how to run it
          adaptertest: resolve(__dirname, 'scripts/adapter-test.ts'),
          adapterstatus: resolve(__dirname, 'scripts/adapter-status.ts')
        }
      }
    }
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    build: {
      rollupOptions: { input: resolve(__dirname, 'src/preload/index.ts') }
    }
  },
  renderer: {
    root: resolve(__dirname, 'src/renderer'),
    build: {
      rollupOptions: {
        input: {
          dock: resolve(__dirname, 'src/renderer/index.html'),
          setup: resolve(__dirname, 'src/renderer/setup.html')
        }
      }
    }
  }
});
