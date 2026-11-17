import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

const page = (f) => fileURLToPath(new URL(f, import.meta.url));

export default defineConfig({
  plugins: [react()],
  base: './', // works from any folder or sub-path once deployed
  build: {
    rollupOptions: {
      // the landing page, and /ton-connect: where TON Connect links land when Chakra can't open them by itself
      input: { main: page('index.html'), tonconnect: page('ton-connect.html') },
    },
  },
});
