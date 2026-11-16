# Sources of the TON templates

The FunC sources of the official contracts the Contracts tab deploys on TON (`src/shared/ton/templates.js`), shown
in the app before a jetton or an NFT collection is created. They compile to exactly the code the app deploys: the
code hashes pinned in `templates.js` (checked by `tests/tonsources.test.js`).

| folder | from | commit | license |
| --- | --- | --- | --- |
| `jetton/` | github.com/ton-blockchain/minter-contract `contracts/` (the minter.ton.org jetton) | `074b7d5` | MIT (`jetton/LICENSE`) |
| `nft/` | github.com/ton-blockchain/token-contract `nft/` (editable collection + item) | `1182ad9` | MIT-like (`nft/LICENSE`) |

`src/shared/ton/templateSources.js` is generated from these files (without the standard library) by
`node scripts/ton-sources.mjs`; run it after changing them.
