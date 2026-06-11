import { defineConfig } from 'vite';

export default defineConfig({
  optimizeDeps: {
    exclude: ['shared'],
  },
  server: {
    port: 5173,
    proxy: {
      '/api': 'http://localhost:3001',
      '/ws': { target: 'ws://localhost:3001', ws: true },
    },
  },
  build: {
    outDir: 'dist',
    sourcemap: false,
    chunkSizeWarningLimit: 2200,
  },
});
