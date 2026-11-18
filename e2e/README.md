# End-to-end tests

Send, swap and bridge, on EVM and TON, through the **real interface** of the app, signed by its vault, executed by
**local blockchains**. No testnet, no faucet, no external service: the browser can reach `127.0.0.1` only.

```
npm run e2e              # everything (about 1.5 minutes)
npm run e2e -- ton       # only the files whose name contains "ton"
```

Runs on GitHub on every push to master and pull request (`.github/workflows/e2e.yml`); on failure the screenshots
are attached to the run (`e2e/.artifacts/`).

## What runs

| piece | what it is |
| --- | --- |
| `env/evm.mjs` | two Anvil nodes, **Local A** (31337) and **Local B** (31338), the test accounts funded at genesis; contracts compiled from `env/contracts/` (solc + OpenZeppelin): a USDC-like token on each, a DEX on A, a bridge deposit contract on each |
| `env/ton.mjs` | **TON Local**: `@ton/sandbox` (real wallet v5r1 and jetton contracts, signatures and seqno checked) behind a TON Center v3-compatible API; a USD₮-like jetton; the TON side of swaps (Omniston over WebSocket) and bridges |
| `env/tcbridge.mjs` | a **TON Connect bridge** in the real one's format (SSE + POST), for dapps outside the app |
| `env/services.mjs` | the public services, simulated in their real formats: prices (DefiLlama), a swap aggregator (KyberSwap) for the local DEX, a bridge (Relay) with a relayer that pays on the other network, an Etherscan-compatible indexer built from the local nodes |
| `app/` | the Android app's code built for a browser (as the landing screenshots): `setup.js` points the services at the local ones (`src/shared/endpoints.js`), `networks.js` adds the local networks like any other |
| `tests/*.test.mjs` | Playwright (Chromium) drives the app like a person, then checks the balances on the networks |

The wallet under test is the public test phrase `test test … junk` (Anvil's): never use it anywhere else.

## What it proves, and what it doesn't

Proved: our code end to end - reading quotes, allowance checks, approvals of the exact amount, one password for the
steps of an operation, transactions and TON messages built and signed correctly (the nodes and the TON contracts
reject anything wrong), fees, the first TON send deploying the wallet, jetton transfers, waiting for confirmation,
balances, history, bridge tracking until arrival. Speed up and cancel (`replace.test.mjs`, Anvil with automatic
mining off): a transfer left waiting is replaced from the history's details, the next block holds only the
replacement, and the history shows the operation once ("Sped up" / "Cancelled"). Bridges with TON: GRAM both ways, any EVM token to TON, GRAM to an
EVM token for another address with gas on arrival, a jetton in two steps (swap to GRAM, then the bridge), the warning
about the memo when the recipient is outside the wallet. TON Connect: a dapp page of the in-app browser (played by the
test through the stand-in of the native plugin, `app/stubs/capacitor-core.js`) signs in (`ton_proof`), sends GRAM and
asks a text signature through the real approval screens, then Chakra disconnects it. TON Connect through the bridge: a
`tc://` link opens the app, and a dapp played by the test (with tweetnacl, as the SDK) connects and sends GRAM only
through the local bridge, sealed end to end. (The local USD₮ has another address than the real one: for
the app it is "another jetton", which is what the two-step test uses.)

Not covered here: the real contracts of STON.fi, Uniswap and the bridges, the routes real aggregators choose, changes
in their APIs (the simulated services always answer the same way), Polymarket, the Android native side (including how a
real page reaches the app: `window.chakra.tonconnect`, `window.ethereum`), TonAPI's emulation of TON messages.

## Adding a test

Copy a test of `tests/evm.test.mjs` or `tests/ton.test.mjs`: `openWallet(chainId)` opens a fresh wallet on a network,
`authorize(page)` fills the password, `waitFor()` waits for a balance. A new family of networks (docs/adding-a-chain.md)
needs its local network in `env/` and its services in the same formats as the real ones.
