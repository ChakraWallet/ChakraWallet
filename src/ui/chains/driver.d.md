# Chain driver interface

The wallet screens (home, token details, history, receive, send, swap, bridge, accounts, settings) are written once
against this interface. One driver per **family** of networks (`evm`, `ton`, …): a network's family is its `kind` in
`src/shared/chains.js` (EVM networks have none). Registry: `src/ui/chains/index.js` (`registerDriver`, `driverFor`).
The contract is checked by `tests/drivers.test.js` for every registered driver.

Conventions: amounts are raw integers as **strings** in data that is cached (portfolios, history) and **bigint**
in live objects (reviews, quotes); addresses are strings, `raw` = the form the network's APIs want, `address` = the
form shown to people; texts returned by a driver are already translated (`t()`), except where an **i18n key** is
asked for (noted below), which the screen translates.

## Required

| member | returns | notes |
| --- | --- | --- |
| `kind` | `'evm' \| 'ton' \| …` | |
| `features` | `{ memo, feeMarket, customTokens, customNfts, poisonCheck, approvals, dapps, contracts, predictions }` | missing = false |
| `resolveAddresses(chain, accounts)` | `{ [account.address]: { address, raw, …extra } \| null }` (may be a Promise) | null: the account has no key for this family. `resolveAddressesSync` (optional) when known at once |
| `validateAddress(chain, text, ownAddress)` | `{ ok, normalized, toSelf, warnings: [{ key }] }` or `{ ok: false, error }` | `error`, `warnings[].key`: i18n keys |
| `parseQr(chain, text)` | `{ address, chainId?, token?, amountRaw?, amountText?, memo? } \| null` | `token`: an address, or NATIVE; `amountText`: an amount already in the token's units, when its decimals aren't known yet (Solana Pay) |
| `paymentLink(chain, { address, token, amountRaw, ask })` | string | what the receive QR shows; `parseQr` must read it back |
| `loadPortfolio(chain, raw, { hiddenTokens, customTokens, … })` | `{ native: { balance, amount, price, usd }, tokens: [{ address, symbol, name, decimals, balance, amount, price, usd, icon, priceKey? }], hidden: [tokens the user hid, with `hidden: true`; also those put apart automatically as probable junk, with `junk: true` too: shown again, they become the user's custom tokens], totalUsd, updated, … }` | JSON-serialisable (cached on the device); hidden tokens apart (to be shown again), out of `tokens` and of the total |
| `loadHistory(chain, raw, cursor, { localLog, etherscanKey })` | `{ items, next, error, unsupported, limitUntil? }` | items as `classify()` in `src/shared/history.js`: `{ hash, time, kind, transfers: [{ dir, symbol, decimals, amount, icon, token, native, counterparty }], status, from, to, fee, sentByMe, spam }`; optional `via` (provider), `comment`, `label` (title), `glyph` (`{ icon, tone }`: an icon of the operation's own, tone `amber` / `green` / `red` / `primary`, e.g. Tron's stake), `loadFee()` (fee read when the details open). `limitUntil`: the indexer's shared free pool ran out until then (ms; -1 when it doesn't say) |
| `prepareSend(chain, { wallet, account, token, to, amountRaw, isMax, memo, portfolio })` | review (below) | `wallet` = the resolved address of the account |
| `confirmSend(chain, review, { wallet, account, speed, authorize, title })` | `{ hash?, wait?: Promise<{ hash \| txHash }> }` | `authorize(fn, title)` asks the password and calls `fn(password)`; `wait` when the network confirms in seconds |

**Review** (what the confirm screens show): `{ recipient, rows: [{ k, v }], notes: [text], amount(speed) → bigint,
problem(speed) → text | null, fee }`. **Fee**: `{ kind: 'market', prepared, valueWei(speed), valueUsd, extraRows }`
(Slow / Normal / Fast, `src/shared/tx.js`) or `{ kind: 'fixed', amount, decimals, symbol, label?, unknownText?, extraRows }`.
Both are drawn by `FeeView` (`components.jsx`).

## Also used by the screens

`addressPlaceholder(chain)`, `receiveTokens(chain, held)` (tokens a payment request can ask for),
`receiveNote(chain, ask)` → `{ key, network? }` (i18n key; `network`: the key has a `{network}` slot),
`priceKey(chain, token)` (DefiLlama key for the price chart, or null), `explorerToken(chain, address)`,
`isName(chain, text)` and `resolveName(chain, text)` (optional: recipients typed as names, e.g. TON DNS; `resolveName` -> `{ name, address, accountName, isWallet, scam }` or throws), `tokenPlaceholder(chain)`, `poisonKit(chain)` (with `features.poisonCheck`, when the family's addresses aren't EVM's: see `src/shared/poison.js`), `tokenInfo(chain, address)` and `isTokenAddress(chain, text)` (custom tokens: required with `features.customTokens`; `tokenInfo` may add `scam: true`, shown as a warning before adding), `tokenWarning(chain, token)` → i18n key | null,
`homeNotice(chain, portfolio)` → i18n key | null, `displayAddress(account)` (accounts of this family only),
`loadNfts(chain, raw, { etherscanKey })` (optional) → `{ items: [{ key, contract, tokenId, name, collection, image, description,
standard, amount, spam, address? }], unsupported }` (the home screen's NFTs, `src/shared/nft.js`), `explorerNft(chain, nft)`,
`defaultChainId` (where an account of this family only lives).

## Swap (optional: no `swapSupported` → no swap)

- `swapSupported(chain)`, `swapTokens(chain)` → extra tokens to offer, `swapMax(chain, token, balance)` → bigint
- `swapQuotes(chain, { from, to, amountRaw, slippageBps, wallet, nativePrice }, { onQuotes, onError })` → `{ stop() }`.
  `onQuotes({ quotes, errors, ctx })` once (aggregators) or at every update (live quotes). Quote: `{ provider, amountOut,
  minOut, outUsd, gasUsd, netUsd, gasCostWei, … }`, best first. `ctx`: `{ nativePrice, priceIn, priceOut }`.
- `swapSteps(chain, quote, { from, to, amountRaw, wallet, account, portfolio, inUsd, title })` → steps (below)
- optional texts: `swapNote(chain)`, `swapNoQuotes(errors)`

## Steps (swap and bridge)

`[{ key: 'approve' | 'swap' | 'bridge', title, note?, waitBeforeNext?, prepare() → review-like { fee, problem() },
send(review, { speed, auth }) → { hash?, wait?, quote? } }]`. The screen prepares and confirms them in order
(`src/ui/steps.js`); `auth(fn)` reuses one password for the whole operation; `waitBeforeNext`: the step must be
mined before the next one (an approval, a swap whose output the next step spends); `note`: a line shown above the
step (what it does, in a multi-step operation); `quote`: the quote the step actually used, when it asked for a
fresh one (after an approval or a swap): its `ref` and `provider` are what the transfer is tracked with.

## Bridge (optional): `driver.bridge`

`{ chains() → networks offered, supports(from, to), freeRecipient, recipientNote?(toChain), refuel,
onlyTokens, tokens(chain, other), reserve(chain, token, balance) → bigint, quotes(p) → { quotes, errors },
steps(quote, p), note?(p) }`, with
`p = { fromChain, toChain, fromToken, toToken, amount, fromAddr, toAddr, account, refuel, nativePrice, portfolio, title }`.
One bridge per pair of networks: `bridgeFor(from, to)` picks the driver whose `supports` says yes.

- `refuel` and `onlyTokens` are a value or a function: `refuel({ fromChain, toChain, fromToken, toToken })` → the
  gas top-up on arrival is offered; `onlyTokens(chain, side)` (`side`: `'from'` | `'to'`) → on that side only the
  tokens of `tokens()` (otherwise the source can be any token held).
- `recipientNote(toChain)` → a warning shown when the funds go to an address outside the wallet (TON: no memo).
- A quote with `twoStep` is an operation in two transactions (TON: jetton → GRAM, then GRAM → the other network):
  the screen marks it and explains both before anything is signed.

## Speed up / cancel (optional): `driver.replace`

For networks where a transaction can wait in a queue ordered by its fee (EVM; Bitcoin: RBF): a transaction still
waiting is sent again, in its place, with a higher fee - the same one ("speed up") or nothing ("cancel").

- `options(chain, item)` → `{ speedUp, cancel } | null`: what a history row allows now (sync, from the row only).
- `prepare(chain, item, { mode: 'speedUp' | 'cancel', wallet, account, nativePrice })` → a review, as `prepareSend`'s
  (`rows`, `notes`, `fee`, `amount(speed)`, `problem(speed)`).
- `confirm(chain, review, { wallet, account, speed, authorize, title })` → `{ hash, wait? }`.

The history rows say what became of a transaction: `status` may also be `'replaced'` (another one took its place),
`'cancelled'`, `'dropped'` (never included, and nobody holds it any more: `options` may offer `speedUp` to send it
again); a row that is itself a replacement has `replacement: 'speedUp' | 'cancel'` and `replaces` (the hash it
replaced). One row per operation: the transactions that replaced each other show as one. Screen:
`src/ui/screens/replaceTx.jsx`. EVM: `src/ui/chains/evm.js` (the background rebuilds the transaction from what it kept
when it sent it, and takes only the fees from the screen).

## Accounts and settings (optional): `driver.ui`

`HomeExtra` (component: `{ chain, data (the portfolio), reload }`, shown on the home under its notice: e.g. Solana's
empty token accounts to close, Tron's energy and bandwidth), `screens` (`{ name: Component }`: screens of the family's
own, opened with `nav(name, params)`, e.g. Tron's `tronResources`), `addOptions` (more ways to add an account, e.g. Solana's vanity address: `[{ key, icon, label, sub (i18n keys),
Component: { onBack, onDone(account) } }]`), `ImportAccount` (component: `{ onBack, onDone(account) }`), `importLabel`, `importSub`, `typeLabel`, `typeShort`,
`addressLabel` (i18n keys), `useSummaries()` → `{ per: { [account.address]: { chain, p, pending } }, busy, reload }`
(balances in the accounts' summary), `settings: [{ key, label, hint }]` (Settings > Data, e.g. API keys).
