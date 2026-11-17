// How Chakra presents itself to TON Connect dapps: shared by the page provider (src/mobile/tonconnectInpage.js, no
// TON libraries there) and the background (src/background/tonconnect.js). `APP_NAME` is also the key of the JS bridge
// (window.chakra.tonconnect) and, once registered, Chakra's app_name in ton-connect/wallets-list: never change it.

export const APP_NAME = 'chakra';
export const PROTOCOL_VERSION = 2;
export const SIGN_DATA_TYPES = ['text', 'binary', 'cell'];

/** Shown by dapps in their wallet list (works without the registry: spec/bridge.md, walletInfo). */
export const WALLET_INFO = {
  name: 'Chakra', app_name: APP_NAME, image: 'https://chakrawallet.dev/icon.png', about_url: 'https://chakrawallet.dev', platforms: ['android'],
};

/** Messages per transaction: W5 wallets take up to 255, older ones (v4r2, v3r2) 4. */
export const maxMessages = (version) => (version === 'v5r1' ? 255 : 4);

/** DeviceInfo (spec/connect.md); `features` lists only what Chakra does. The plain 'SendTransaction' is for old SDKs. */
export function deviceInfo(max, appVersion) {
  return {
    platform: 'android', appName: APP_NAME, appVersion: String(appVersion || '1.0.0'), maxProtocolVersion: PROTOCOL_VERSION,
    features: ['SendTransaction', { name: 'SendTransaction', maxMessages: max }, { name: 'SignData', types: SIGN_DATA_TYPES }],
  };
}
