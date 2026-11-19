// Simplified, hand-drawn chain marks (inline SVG, bundled: no network requests).
const W = '#fff';

const LOGOS = {
  // Ethereum
  1: (
    <>
      <circle cx="16" cy="16" r="16" fill="#627EEA" />
      <path fill={W} fill-opacity=".6" d="M16.5 4v8.9l7.5 3.3z" />
      <path fill={W} d="M16.5 4L9 16.2l7.5-3.3z" />
      <path fill={W} fill-opacity=".6" d="M16.5 22v6l7.5-10.4z" />
      <path fill={W} d="M16.5 28v-6L9 17.6z" />
      <path fill={W} fill-opacity=".2" d="M16.5 20.6l7.5-4.4-7.5-3.3z" />
      <path fill={W} fill-opacity=".6" d="M9 16.2l7.5 4.4v-7.7z" />
    </>
  ),
  // Base
  8453: (
    <>
      <circle cx="16" cy="16" r="16" fill="#0052FF" />
      <path fill={W} d="M15.98 25C20.97 25 25 20.97 25 16s-4.03-9-9.02-9C11.25 7 7.37 10.63 7 15.25h11.9v1.5H7C7.37 21.37 11.25 25 15.98 25z" />
    </>
  ),
  // Arbitrum
  42161: (
    <>
      <circle cx="16" cy="16" r="16" fill="#213147" />
      <path fill="none" stroke="#9DCCED" stroke-width="1.4" d="M16 6.2l8.5 4.9v9.8L16 25.8l-8.5-4.9v-9.8z" />
      <path fill="#12AAFF" d="M17.2 12.4l1.3-.1 4 6.4-1.8 1.1z" />
      <path fill="#12AAFF" d="M19.6 21.2l-3-4.8 1-1.7 3.8 6z" />
      <path fill={W} d="M11.3 21.6l4.6-7.5 1.8.1-4.6 7.9zM9.7 20.7l5.5-8.8 1.7.1-5.5 9.6z" />
    </>
  ),
  // Optimism
  10: (
    <>
      <circle cx="16" cy="16" r="16" fill="#FF0420" />
      <text x="16" y="20.2" fill={W} font-size="11.5" font-weight="800" font-style="italic" text-anchor="middle" font-family="Arial, Helvetica, sans-serif">OP</text>
    </>
  ),
  // Polygon
  137: (
    <>
      <circle cx="16" cy="16" r="16" fill="#8247E5" />
      <path fill="none" stroke={W} stroke-width="2.1" stroke-linejoin="round" d="M19.4 13.1l-3.1-1.8-3.1 1.8v3.6M12.6 18.9l3.1 1.8 3.1-1.8v-3.6" />
      <path fill="none" stroke={W} stroke-width="2.1" stroke-linejoin="round" d="M13.2 16.7l-3.1 1.8-3-1.8v-3.6l3-1.8 3.1 1.8M18.8 15.3l3.1-1.8 3 1.8v3.6l-3 1.8-3.1-1.8" />
    </>
  ),
  // BNB Chain
  56: (
    <>
      <circle cx="16" cy="16" r="16" fill="#F0B90B" />
      <path fill={W} d="M12.1 14.1L16 10.2l3.9 3.9 2.3-2.3L16 5.6l-6.2 6.2zM5.6 16l2.3-2.3 2.3 2.3-2.3 2.3zM12.1 17.9L16 21.8l3.9-3.9 2.3 2.3L16 26.4l-6.2-6.2zM21.8 16l2.3-2.3 2.3 2.3-2.3 2.3zM18.3 16L16 13.7 13.7 16 16 18.3z" />
    </>
  ),
  // Avalanche
  43114: (
    <>
      <circle cx="16" cy="16" r="16" fill="#E84142" />
      <path fill={W} d="M20.3 16.5c.5-.8 1.2-.8 1.7 0l3.1 5.4c.5.8.1 1.5-.8 1.5h-6.3c-.9 0-1.3-.7-.8-1.5zM14.2 7.9c.5-.8 1.2-.8 1.7 0l.7 1.3 1.6 2.9c.4.8.4 1.8 0 2.6l-4.3 7.4c-.4.8-1.3 1.3-2.2 1.3H8.1c-.9 0-1.3-.7-.8-1.5z" />
    </>
  ),
  // Gnosis
  100: (
    <>
      <circle cx="16" cy="16" r="16" fill="#3E6957" />
      <circle cx="11.6" cy="14.6" r="3.4" fill="none" stroke={W} stroke-width="1.8" />
      <circle cx="20.4" cy="14.6" r="3.4" fill="none" stroke={W} stroke-width="1.8" />
      <path fill={W} d="M16 17.8l2 2.6-2 2.6-2-2.6z" />
      <path fill="none" stroke={W} stroke-width="1.8" stroke-linecap="round" d="M8.2 10.4l2.4 1.2M23.8 10.4l-2.4 1.2" />
    </>
  ),
  // Linea: the "L" with its corner, on the brand's dark ground
  59144: (
    <>
      <circle cx="16" cy="16" r="16" fill="#121212" />
      <path fill={W} d="M9.5 8.6h2.6v12.7h10.4v2.6H9.5z" />
      <path fill="#61DFFF" d="M18.3 8.6h4.2v4.2h-4.2z" />
    </>
  ),
  // Sepolia (grey ethereum)
  // Solana: three slanted bars, purple to green (solid colours: a gradient's id would clash between icons)
  [-501]: (
    <>
      <circle cx="16" cy="16" r="16" fill="#121212" />
      <path fill="#14F195" d="M10.4 9.6h14.2l-3 3H7.4z" />
      <path fill="#5F9BD8" d="M7.4 14.5h14.2l3 3H10.4z" />
      <path fill="#9945FF" d="M10.4 19.4h14.2l-3 3H7.4z" />
    </>
  ),
  [-502]: (
    <>
      <circle cx="16" cy="16" r="16" fill="#9CA3AF" />
      <path fill={W} d="M10.4 9.6h14.2l-3 3H7.4z" />
      <path fill={W} fill-opacity=".75" d="M7.4 14.5h14.2l3 3H10.4z" />
      <path fill={W} fill-opacity=".5" d="M10.4 19.4h14.2l-3 3H7.4z" />
    </>
  ),
  // Tron: the faceted triangle, white on red
  [-195]: (
    <>
      <circle cx="16" cy="16" r="16" fill="#EB0029" />
      <path fill="none" stroke={W} stroke-width="1.6" stroke-linejoin="round" d="M8.2 8.6l16.9 3.9-10.6 13zM8.2 8.6l10.4 6.2 6.5-2.3M18.6 14.8l-4.1 10.7" />
    </>
  ),
  [-196]: (
    <>
      <circle cx="16" cy="16" r="16" fill="#9CA3AF" />
      <path fill="none" stroke={W} stroke-width="1.6" stroke-linejoin="round" d="M8.2 8.6l16.9 3.9-10.6 13zM8.2 8.6l10.4 6.2 6.5-2.3M18.6 14.8l-4.1 10.7" />
    </>
  ),
  // Bitcoin: the official mark (public domain, Bitcoin.svg), drawn at 32x32
  [-8333]: (
    <>
      <g transform="scale(.5) translate(.0063 -.003)"><path fill="#F7931A" d="m63.033,39.744c-4.274,17.143-21.637,27.576-38.782,23.301-17.138-4.274-27.571-21.638-23.295-38.78,4.272-17.145,21.635-27.579,38.775-23.305,17.144,4.274,27.576,21.64,23.302,38.784z" /><path fill={W} d="m46.103,27.444c0.637-4.258-2.605-6.547-7.038-8.074l1.438-5.768-3.511-0.875-1.4,5.616c-0.923-0.23-1.871-0.447-2.813-0.662l1.41-5.653-3.509-0.875-1.439,5.766c-0.764-0.174-1.514-0.346-2.242-0.527l0.004-0.018-4.842-1.209-0.934,3.75s2.605,0.597,2.55,0.634c1.422,0.355,1.679,1.296,1.636,2.042l-1.638,6.571c0.098,0.025,0.225,0.061,0.365,0.117-0.117-0.029-0.242-0.061-0.371-0.092l-2.296,9.205c-0.174,0.432-0.615,1.08-1.609,0.834,0.035,0.051-2.552-0.637-2.552-0.637l-1.743,4.019,4.569,1.139c0.85,0.213,1.683,0.436,2.503,0.646l-1.453,5.834,3.507,0.875,1.439-5.772c0.958,0.26,1.888,0.5,2.798,0.726l-1.434,5.745,3.511,0.875,1.453-5.823c5.987,1.133,10.489,0.676,12.384-4.739,1.527-4.36-0.076-6.875-3.226-8.515,2.294-0.529,4.022-2.038,4.483-5.155zm-8.022,11.249c-1.085,4.36-8.426,2.003-10.806,1.412l1.928-7.729c2.38,0.594,10.012,1.77,8.878,6.317zm1.086-11.312c-0.99,3.966-7.1,1.951-9.082,1.457l1.748-7.01c1.982,0.494,8.365,1.416,7.334,5.553z" /></g>
    </>
  ),
  [-48333]: (
    <>
      <g transform="scale(.5) translate(.0063 -.003)"><path fill="#9CA3AF" d="m63.033,39.744c-4.274,17.143-21.637,27.576-38.782,23.301-17.138-4.274-27.571-21.638-23.295-38.78,4.272-17.145,21.635-27.579,38.775-23.305,17.144,4.274,27.576,21.64,23.302,38.784z" /><path fill={W} d="m46.103,27.444c0.637-4.258-2.605-6.547-7.038-8.074l1.438-5.768-3.511-0.875-1.4,5.616c-0.923-0.23-1.871-0.447-2.813-0.662l1.41-5.653-3.509-0.875-1.439,5.766c-0.764-0.174-1.514-0.346-2.242-0.527l0.004-0.018-4.842-1.209-0.934,3.75s2.605,0.597,2.55,0.634c1.422,0.355,1.679,1.296,1.636,2.042l-1.638,6.571c0.098,0.025,0.225,0.061,0.365,0.117-0.117-0.029-0.242-0.061-0.371-0.092l-2.296,9.205c-0.174,0.432-0.615,1.08-1.609,0.834,0.035,0.051-2.552-0.637-2.552-0.637l-1.743,4.019,4.569,1.139c0.85,0.213,1.683,0.436,2.503,0.646l-1.453,5.834,3.507,0.875,1.439-5.772c0.958,0.26,1.888,0.5,2.798,0.726l-1.434,5.745,3.511,0.875,1.453-5.823c5.987,1.133,10.489,0.676,12.384-4.739,1.527-4.36-0.076-6.875-3.226-8.515,2.294-0.529,4.022-2.038,4.483-5.155zm-8.022,11.249c-1.085,4.36-8.426,2.003-10.806,1.412l1.928-7.729c2.38,0.594,10.012,1.77,8.878,6.317zm1.086-11.312c-0.99,3.966-7.1,1.951-9.082,1.457l1.748-7.01c1.982,0.494,8.365,1.416,7.334,5.553z" /></g>
    </>
  ),
  // TON (coin: GRAM)
  [-239]: (
    <>
      <circle cx="16" cy="16" r="16" fill="#0098EA" />
      <path fill="none" stroke={W} stroke-width="1.8" stroke-linejoin="round" d="M10.6 10.2h10.8c.95 0 1.55 1.03 1.07 1.85L16.85 21.9a.98.98 0 0 1-1.7 0L9.53 12.05c-.48-.82.12-1.85 1.07-1.85zM16 10.4v12" />
    </>
  ),
  [-3]: (
    <>
      <circle cx="16" cy="16" r="16" fill="#9CA3AF" />
      <path fill="none" stroke={W} stroke-width="1.8" stroke-linejoin="round" d="M10.6 10.2h10.8c.95 0 1.55 1.03 1.07 1.85L16.85 21.9a.98.98 0 0 1-1.7 0L9.53 12.05c-.48-.82.12-1.85 1.07-1.85zM16 10.4v12" />
    </>
  ),
  11155111: (
    <>
      <circle cx="16" cy="16" r="16" fill="#9CA3AF" />
      <path fill={W} fill-opacity=".7" d="M16.5 4v8.9l7.5 3.3z" />
      <path fill={W} d="M16.5 4L9 16.2l7.5-3.3z" />
      <path fill={W} fill-opacity=".7" d="M16.5 22v6l7.5-10.4z" />
      <path fill={W} d="M16.5 28v-6L9 17.6z" />
    </>
  ),
};

// Native coins / common tokens -> logo of the chain they belong to
const SYMBOL_LOGO = { BTC: -8333, WBTC: -8333, GRAM: -239, TON: -239, SOL: -501, WSOL: -501, TRX: -195, WTRX: -195, ETH: 1, WETH: 1, POL: 137, MATIC: 137, WPOL: 137, BNB: 56, WBNB: 56, AVAX: 43114, WAVAX: 43114, XDAI: 100, WXDAI: 100, OP: 10, ARB: 42161, LINEA: 59144 };

export function hasChainLogo(id) { return !!LOGOS[id]; }
export function symbolLogoId(symbol = '') { return SYMBOL_LOGO[symbol.toUpperCase()]; }

export function ChainLogo({ id, size = 36 }) {
  const l = LOGOS[id];
  if (!l) return null;
  return <svg viewBox="0 0 32 32" style={{ width: `${size / 16}rem`, height: `${size / 16}rem`, display: 'block', flex: 'none', borderRadius: '50%' }}>{l}</svg>;
}
