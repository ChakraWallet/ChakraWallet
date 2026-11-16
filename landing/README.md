# Chakra — landing page

React + Vite, English only.

```
npm install
npm run dev       # http://localhost:5173
npm run build     # static site in dist/ (relative paths: works from any folder)
```

Store links (App Store, Android, Chrome, Firefox) are in `LINKS` at the top of `src/App.jsx`: replace the
`#download` placeholders before publishing.

## Screenshots

The phone screenshots in `public/shots/` are taken from the real app, not mock-ups:

- `shots/build-demo.mjs` bundles the Android app UI (`src/mobile/index.jsx` of the main project) for a plain
  browser. Only the data layer is replaced: `shots/mocks/` returns invented balances, transactions, swap quotes,
  prices and prediction markets; `shots/stubs/` stands in for the Capacitor native plugins. Nothing reaches the
  network except public token icons.
- `shots/capture.mjs` opens it in headless Chromium (393×852 @3x), creates a demo wallet with three accounts
  from a fixed, public seed (never send funds to it), and saves each screen as JPEG.

```
npm install --prefix ..   # the main project's dependencies (esbuild, preact, ethers…)
npm run shots             # or: node shots/capture.mjs swap predict   (only some scenes)
```

Chromium is looked up in the usual paths (`/snap/bin/chromium`, `/usr/bin/chromium`…); set `CHROME_PATH` otherwise.
`node shots/icons.mjs` regenerates the logo and favicons from the app's own icon renderer.

## Online: https://chakrawallet.dev

Published on GitHub Pages by `.github/workflows/landing.yml` at every push to `master` that changes `landing/`
(or by hand: Actions › Landing › Run workflow). Repository: https://github.com/ChakraWallet/ChakraWallet

One-time setup:

1. **GitHub › Settings › Pages**: Source **GitHub Actions**.
2. **DNS at the registrar** for `chakrawallet.dev` (remove any parking / forwarding records first):

   | type | name | value |
   | --- | --- | --- |
   | A | @ | 185.199.108.153 |
   | A | @ | 185.199.109.153 |
   | A | @ | 185.199.110.153 |
   | A | @ | 185.199.111.153 |
   | AAAA | @ | 2606:50c0:8000::153 |
   | AAAA | @ | 2606:50c0:8001::153 |
   | AAAA | @ | 2606:50c0:8002::153 |
   | AAAA | @ | 2606:50c0:8003::153 |
   | CNAME | www | `chakrawallet.github.io` |

3. **Settings › Pages › Custom domain**: `chakrawallet.dev`, wait for the DNS check, then **Enforce HTTPS**
   (`.dev` domains are HTTPS-only in every browser: the site works once GitHub has issued the certificate,
   usually within an hour).
4. Optional, recommended: verify the domain for the organization (Organization settings › Pages › Add a domain),
   so no other repository can take it.
