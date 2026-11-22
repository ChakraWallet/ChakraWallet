import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import legal from '../src/shared/locales/en/legal.js'; // the app's terms of use, in English

const page = (f) => fileURLToPath(new URL(f, import.meta.url));

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** terms.html: the app's own terms (the same keys src/ui/terms.jsx shows) in place of the <!--TERMS--> marker. */
const terms = {
  name: 'chakra-terms',
  transformIndexHtml: {
    order: 'pre',
    handler(html) {
      if (!html.includes('<!--TERMS-->')) return html;
      const n = Object.keys(legal).filter((k) => /^terms\.\d+\.t$/.test(k)).length;
      let body = `<p class="lg-meta">${esc(legal['terms.updated'])}</p>\n      <p class="lg-lead">${esc(legal['terms.intro'])}</p>`;
      for (let i = 1; i <= n; i++) {
        body += `\n      <section><h2>${i}. ${esc(legal[`terms.${i}.t`])}</h2><p>${esc(legal[`terms.${i}.b`])}</p></section>`;
      }
      return html.replace('<!--TERMS-->', body);
    },
  },
};

export default defineConfig({
  plugins: [react(), terms],
  base: './', // works from any folder or sub-path once deployed
  build: {
    rollupOptions: {
      input: {
        main: page('index.html'),
        // /ton-connect: where TON Connect links land when Chakra can't open them by itself
        tonconnect: page('ton-connect.html'),
        // /terms and /privacy: linked from the app and from the store listings
        terms: page('terms.html'),
        privacy: page('privacy.html'),
      },
    },
  },
});
