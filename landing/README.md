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
