// What "Connect with QR" (wallet card, Settings) can open: protocols that connect a dapp shown on another screen.
// Registered by platform modules (TON Connect in the Android app: src/mobile/tonPlugin.js). With none registered (the
// browser extension) the button isn't shown; on the wallet card, only on the networks of a protocol's family.
const list = [];

/**
 * { family, match(text) -> true when the code is this protocol's, open(text) -> Promise (the connection, approval
 * included) }. family: the networks it connects (e.g. 'ton').
 */
export const registerConnector = (c) => { list.push(c); };
/** Any protocol, or (with a family) one that connects that family's networks. */
export const hasConnectors = (family) => list.some((c) => !family || c.family === family);
export const connectorFor = (text) => list.find((c) => { try { return c.match(text); } catch { return false; } }) || null;
