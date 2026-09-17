import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';

const here = (p: string) => fileURLToPath(new URL(p, import.meta.url));

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      '@': here('./src'),
      // The web app consumes shared contracts from source (docs/adr/0005).
      '@stockflow/contracts': here('../../packages/contracts/src/index.ts'),
    },
  },
  server: { port: 5173 },
});
