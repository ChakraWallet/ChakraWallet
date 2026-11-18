// TronWeb for the pages of the in-app browser (Android): Tron dapps build their transactions with a `tronWeb` object,
// as TronLink gives them. The library is large, so it isn't in every page: the app injects this script only when a
// site uses Tron (src/mobile/tronInpage.js asks for it). It only makes the class available; tronInpage.js creates the
// instance with Chakra's address and signing, and no key ever reaches the page.
import { TronWeb } from 'tronweb';

(() => {
  if (window.__ChakraTronWeb) return;
  Object.defineProperty(window, '__ChakraTronWeb', { value: TronWeb, configurable: false, writable: false });
  window.dispatchEvent(new Event('chakra-tronweb'));
})();
