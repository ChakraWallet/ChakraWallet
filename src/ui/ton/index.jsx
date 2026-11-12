// TON screens (Android app), used by app.jsx in place of the EVM ones while a TON network is selected.
// Screens not listed here (accounts, settings, wallets...) are shared.
import { TonHome, TonHistory } from './home.jsx';
import { TonSend } from './send.jsx';
import { TonReceive, TonToken } from './receive.jsx';
import { ImportTon } from './import.jsx';
import { TonSwap } from './swap.jsx';
import { TonBridge } from './bridge.jsx';
import { Address } from '../../shared/ton/core.js';
import { useTonSummaries } from './hooks.js';

export const tonScreens = { home: TonHome, send: TonSend, receive: TonReceive, token: TonToken, history: TonHistory, swap: TonSwap, bridge: TonBridge };

/** Pieces used by shared screens (accounts) without importing TON code in the extension. */
export const tonShared = {
  ImportTon,
  useSummaries: useTonSummaries, // TON balances in the accounts' multichain summary
  extra: { tonBridge: TonBridge }, // screens also reachable from EVM networks (Bridge -> "To / from TON")
  /** "0:abc…" -> UQ… (as wallets show addresses) */
  friendly: (raw, testnet = false) => { try { return Address.parseRaw(raw).toString({ urlSafe: true, bounceable: false, testOnly: testnet }); } catch { return raw; } },
};
