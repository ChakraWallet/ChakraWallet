// What "Connect with QR" (wallet card, Settings) can open: protocols that connect a dapp shown on another screen.
// Registered by platform modules (TON Connect in the Android app: src/mobile/tonPlugin.js). With none registered (the
// browser extension) the button isn't shown.
const list = [];

/** { match(text) -> true when the code is this protocol's, open(text) -> Promise (the connection, approval included) } */
export const registerConnector = (c) => { list.push(c); };
export const hasConnectors = () => list.length > 0;
export const connectorFor = (text) => list.find((c) => { try { return c.match(text); } catch { return false; } }) || null;
