// Contracts created from the Contracts tab on TON without a compiler: the official, already compiled code of
//  - the standard jetton (TEP-74 + TEP-89): minter.ton.org's discoverable minter and its jetton wallet, from
//    github.com/ton-blockchain/minter (src/lib/contracts/*.compiled.json);
//  - the standard NFT collection (TEP-62 + TEP-66 royalties): the editable collection and its item, from
//    @ton-community/assets-sdk 0.0.5 (compiled from ton-blockchain/token-contract).
// The code hashes are pinned here and checked by tests/tontemplates.test.js. They are the code of the most used
// jetton wallet, of the minter.ton.org jettons and of ~70% of the NFT collections on mainnet (checked when added).
// Token metadata goes on-chain (TEP-64), so a token doesn't depend on a server.
import { beginCell, Cell, contractAddress, storeStateInit } from '@ton/core';
import { buildOnchainContent, toB64 } from './cells.js';

export const CODES = {
  JETTON_MINTER: {
    hash: '9a0f98dd6fbf225eef8165e4e64417ee931f7eea000653439e7b5dcdc0644cd6',
    boc: 'te6ccgECDQEAApwAART/APSkE/S88sgLAQIBYgIKAgLMAwkC8dkGOASS+B8ADoaYGAuNhJL4HwfSB9IBj9ABi465D9ABj9ABgBaY/pn/aiaH0AfSBqahhACqk4XUcZmpqbGyiaY4L5cCSBfSB9AGoYEGhAMGuQ/QAYEogaKCF4BQpQKBnkKAJ9ASxni2ZmZPaqcEEIPe7L7yk4XXGBQEBgHANjc3AfoA+kD4KFQSBnBUIBNUFAPIUAT6AljPFgHPFszJIsjLARL0APQAywDJ+QBwdMjLAsoHy//J0FAGxwXy4EqhA0VFyFAE+gJYzxbMzMntVAH6QDAg1wsBwwCRW+MNBQA+ghDVMnbbcIAQyMsFUAPPFiL6AhLLassfyz/JgEL7AAGmghAsdrlzUnC64wI1NzcjwAOOGjNQNccF8uBJA/pAMFnIUAT6AljPFszMye1U4DUCwASOGFEkxwXy4EnUMEMAyFAE+gJYzxbMzMntVOBfBYQP8vAHAf42XwOCCJiWgBWgFbzy4EsC+kDTADCVyCHPFsmRbeKCENFzVABwgBjIywVQBc8WJPoCFMtqE8sfFMs/I/pEMHC6jjP4KEQDcFQgE1QUA8hQBPoCWM8WAc8WzMkiyMsBEvQA9ADLAMn5AHB0yMsCygfL/8nQzxaWbCJwAcsB4vQACAAKyYBA+wAAk7XwUIgG4KhAJqgoB5CgCfQEsZ4sA54tmZJFkZYCJegB6AGWAZJB8gDg6ZGWBZQPl/+ToO8AMZGWCrGeLKAJ9AQnltYlmZmS4/YBAgN6YAsMAH2tvPaiaH0AfSBqahg2GPwUALgqEAmqCgHkKAJ9ASxniwDni2ZkkWRlgIl6AHoAZYBk/IA4OmRlgWUD5f/k6EAAH68W9qJofQB9IGpqGD+qkEA=',
  },
  JETTON_WALLET: {
    hash: 'beb0683ebeb8927fe9fc8ec0a18bc7dd17899689825a121eab46c5a3a860d0ce',
    boc: 'te6ccgECEQEAAyMAART/APSkE/S88sgLAQIBYgIQAgLMAwYCAdQEBQDDCDHAJJfBOAB0NMDAXGwlRNfA/AM4PpA+kAx+gAxcdch+gAx+gAwc6m0AALTH4IQD4p+pVIgupUxNFnwCeCCEBeNRRlSILqWMUREA/AK4DWCEFlfB7y6k1nwC+BfBIQP8vCAAET6RDBwuvLhTYAIBIAcPAgEgCAoB8VA9M/+gD6QCHwAe1E0PoA+kD6QNQwUTahUirHBfLiwSjC//LiwlQ0QnBUIBNUFAPIUAT6AljPFgHPFszJIsjLARL0APQAywDJIPkAcHTIywLKB8v/ydAE+kD0BDH6ACDXScIA8uLEd4AYyMsFUAjPFnD6AhfLaxPMgJAJ6CEBeNRRnIyx8Zyz9QB/oCIs8WUAbPFiX6AlADzxbJUAXMI5FykXHiUAioE6CCCcnDgKAUvPLixQTJgED7ABAjyFAE+gJYzxYBzxbMye1UAgEgCw4C9ztRND6APpA+kDUMAjTP/oAUVGgBfpA+kBTW8cFVHNtcFQgE1QUA8hQBPoCWM8WAc8WzMkiyMsBEvQA9ADLAMn5AHB0yMsCygfL/8nQUA3HBRyx8uLDCvoAUaihggiYloBmtgihggiYloCgGKEnlxBJEDg3XwTjDSXXCwGAMDQBwUnmgGKGCEHNi0JzIyx9SMMs/WPoCUAfPFlAHzxbJcYAQyMsFJM8WUAb6AhXLahTMyXH7ABAkECMAfMMAI8IAsI4hghDVMnbbcIAQyMsFUAjPFlAE+gIWy2oSyx8Syz/JcvsAkzVsIeIDyFAE+gJYzxYBzxbMye1UANc7UTQ+gD6QPpA1DAH0z/6APpAMFFRoVJJxwXy4sEnwv/y4sIFggkxLQCgFrzy4sOCEHvdl97Iyx8Vyz9QA/oCIs8WAc8WyXGAGMjLBSTPFnD6AstqzMmAQPsAQBPIUAT6AljPFgHPFszJ7VSAAg9QBBrkPaiaH0AfSB9IGoYAmmPwQgLxqKMqRBdQQg97svvCd0JWPlxYumfmP0AGAnQKBHkKAJ9ASxniwDni2Zk9qpAAboPYF2omh9AH0gfSBqGE=',
  },
  NFT_COLLECTION: {
    hash: '64bb2d4661b5f2dc1a83bf5cbbe09e92ac0b460a1b879a5519386fca4c348bca',
    boc: 'te6ccgECFAEAAh8AART/APSkE/S88sgLAQIBYgINAgLNAwgE59EGOASK3wAOhpgYC42Eit8H0gGADpj+mf9qJofSBpn+pqahhBCDSenKgpQF1HFBuvgoDoQQhUZYBWuEAIZGWCqALnixJ9AQpltQnlj+WfgOeLZMAgfYBwGyi544L5cMiS4ADxgRLgAXGBEuAB8YEYGYHgAkBAUGBwBgNQLTP1MTu/LhklMTugH6ANQwKBA0WfAGjhIBpENDyFAFzxYTyz/MzMzJ7VSSXwXiAKY1cAPUMI43gED0lm+lII4pBqQggQD6vpPywY/egQGTIaBTJbvy9AL6ANQwIlRLMPAGI7qTAqQC3gSSbCHis+YwMlBEQxPIUAXPFhPLP8zMzMntVAAsMjQB+kAwQUTIUAXPFhPLP8zMzMntVAA8jhXU1DAQNEEwyFAFzxYTyz/MzMzJ7VTgXwSED/LwAgEgCQwCASAKCwAtAHIyz/4KM8WyXAgyMsBE/QA9ADLAMmAAGz5AHTIywISygfL/8nQgAD1FrwBHAh8AV3gBjIywVYzxZQBPoCE8trEszMyXH7AIAgEgDhMCASAPEABDuLXTHtRND6QNM/1NTUMBAkXwTQ1DHUMNBxyMsHAc8WzMmAIBIBESAC+12v2omh9IGmf6mpqGDYg6GmH6Yf9IBhAALbT0faiaH0gaZ/qamoYCi+CeAI4APgCwACW8gt9qJofSBpn+pqahgt6GoYLE',
  },
  NFT_ITEM: {
    hash: 'ba4d975d2b66231c1f0a0ccca6e8ff8f7ba0610c4b7639584b8e98303dc3128c',
    boc: 'te6ccgECDgEAAdwAART/APSkE/S88sgLAQIBYgINAgLOAwoCASAECQLPDIhxwCSXwPg0NMDAXGwkl8D4PpA+kAx+gAxcdch+gAx+gAwc6m0APACBLOOFDBsIjRSMscF8uGVAfpA1DAQI/AD4AbTH9M/ghBfzD0UUjC64wIwNDQ1NYIQL8smohK64wJfBIQP8vCAFCAKsMhA3XjJAE1E1xwXy4ZH6QCHwAfpA0gAx+gAg10nCAPLixIIK+vCAG6EhlFMVoKHeItcLAcMAIJIGoZE24iDC//LhkiGUECo3W+MNApMwMjTjDVUC8AMGBwB8ghAFE42RyFAJzxZQC88WcSRJFFRGoHCAEMjLBVAHzxZQBfoCFctqEssfyz8ibrOUWM8XAZEy4gHJAfsAEEcAaibwAYIQ1TJ22xA3RABtcXCAEMjLBVAHzxZQBfoCFctqEssfyz8ibrOUWM8XAZEy4gHJAfsAAHJwghCLdxc1BcjL/1AEzxYQJIBAcIAQyMsFUAfPFlAF+gIVy2oSyx/LPyJus5RYzxcBkTLiAckB+wAAET6RDBwuvLhTYAIBIAsMADs7UTQ0z/6QCDXScIAmn8B+kDUMBAkECPgMHBZbW2AAHQDyMs/WM8WAc8WzMntVIAAJoR+f4AU=',
  }
};
export const code = (k) => Cell.fromBase64(CODES[k].boc);
/** Name of a known code by its hash (hex): 'JETTON_MINTER' … or null. */
export const knownCode = (hash) => Object.keys(CODES).find((k) => CODES[k].hash === String(hash || '').toLowerCase()) || null;

export const OP = {
  mint: 21, internalTransfer: 0x178d4519, changeAdmin: 3, changeContent: 4, burn: 0x595f07bc,
  nftDeploy: 1, nftChangeOwner: 3, nftEditContent: 4, nftTransfer: 0x5fcc3d14,
};

// GRAM attached to the messages: what isn't spent stays as the contract's storage reserve or comes back (excesses)
export const JETTON_DEPLOY_VALUE = 150_000_000n; // minter: deployment, its reserve, and the first holder's wallet
export const JETTON_MINT_VALUE = 100_000_000n; // a later mint, sent to the minter
export const JETTON_MINT_FORWARD = 50_000_000n; // from the minter to the holder's jetton wallet (deploys it; the rest comes back)
export const JETTON_ADMIN_VALUE = 50_000_000n; // change admin / metadata
export const JETTON_BURN_VALUE = 50_000_000n;
export const NFT_COLLECTION_DEPLOY_VALUE = 50_000_000n;
export const NFT_MINT_VALUE = 80_000_000n; // a mint, sent to the collection
export const NFT_ITEM_FORWARD = 50_000_000n; // from the collection to the new item
export const NFT_TRANSFER_VALUE = 50_000_000n;
export const MAX_ROYALTY = 50; // percent

export const stateInitB64 = (init) => toB64(beginCell().store(storeStateInit(init)).endCell());

// ------------------------------------------------------------ jetton
/** Body of a mint (op 21): `amount` units to `to`, excesses back to `response`. Only the admin can send it. */
export function jettonMintBody({ to, amount, response, forward = JETTON_MINT_FORWARD, queryId = 0n }) {
  const transfer = beginCell()
    .storeUint(OP.internalTransfer, 32).storeUint(queryId, 64).storeCoins(amount)
    .storeAddress(null) // from: none (minted)
    .storeAddress(response) // excesses go back here
    .storeCoins(0) // no transfer notification
    .storeBit(0)
    .endCell();
  return beginCell().storeUint(OP.mint, 32).storeUint(queryId, 64).storeAddress(to).storeCoins(forward).storeRef(transfer).endCell();
}

/** New jetton from its metadata: { address, init, message }: one message deploys it and mints the initial supply to the admin. */
export function jettonDeploy({ admin, name, symbol, decimals = 9, image, description, supply = 0n }) {
  const content = buildOnchainContent({ name, symbol, decimals: String(decimals), image, description });
  const data = beginCell().storeCoins(0).storeAddress(admin).storeRef(content).storeRef(code('JETTON_WALLET')).endCell();
  const init = { code: code('JETTON_MINTER'), data };
  const address = contractAddress(0, init);
  const body = supply > 0n ? jettonMintBody({ to: admin, amount: supply, response: admin }) : null;
  return { address, init, message: { to: address.toRawString(), value: String(JETTON_DEPLOY_VALUE), bounce: false, init: stateInitB64(init), ...(body ? { body: toB64(body) } : {}) } };
}

/** Change admin (op 3); admin null = no admin any more (nobody can mint or change the metadata). */
export const jettonChangeAdminBody = ({ admin, queryId = 0n }) => beginCell().storeUint(OP.changeAdmin, 32).storeUint(queryId, 64).storeAddress(admin).endCell();
/** Replace the metadata (op 4). */
export const jettonChangeContentBody = ({ content, queryId = 0n }) => beginCell().storeUint(OP.changeContent, 32).storeUint(queryId, 64).storeRef(content).endCell();
/** Burn (TEP-74), sent to one's own jetton wallet. */
export const jettonBurnBody = ({ amount, response, queryId = 0n }) => beginCell().storeUint(OP.burn, 32).storeUint(queryId, 64).storeCoins(amount).storeAddress(response).storeMaybeRef(null).endCell();

// ------------------------------------------------------------ NFT collection
/** Royalty (TEP-66): percent with two decimals, over a base of 10000. */
export function royaltyCell(percent, to) {
  const p = Number(percent || 0);
  if (!(p >= 0 && p <= MAX_ROYALTY)) throw new Error('royalty');
  return beginCell().storeUint(Math.round(p * 100), 16).storeUint(10000, 16).storeAddress(to).endCell();
}

/**
 * New NFT collection: { address, init, message }. The collection's metadata is on-chain; an item's metadata link is
 * `itemsBase` + the item's own suffix (e.g. https://…/nft/ + 1.json).
 */
export function nftCollectionDeploy({ owner, name, description, image, itemsBase = '', royaltyPercent = 0, royaltyTo }) {
  const content = beginCell()
    .storeRef(buildOnchainContent({ name, description, image }))
    .storeRef(beginCell().storeStringTail(String(itemsBase || '')).endCell())
    .endCell();
  const data = beginCell()
    .storeAddress(owner).storeUint(0, 64).storeRef(content).storeRef(code('NFT_ITEM')).storeRef(royaltyCell(royaltyPercent, royaltyTo || owner))
    .endCell();
  const init = { code: code('NFT_COLLECTION'), data };
  const address = contractAddress(0, init);
  return { address, init, message: { to: address.toRawString(), value: String(NFT_COLLECTION_DEPLOY_VALUE), bounce: false, init: stateInitB64(init) } };
}

/** Mint item `index` (op 1) for `owner`; `content` = the suffix of its metadata link. Only the collection's owner can. */
export function nftMintBody({ index, owner, content = '', forward = NFT_ITEM_FORWARD, queryId = 0n }) {
  const item = beginCell().storeAddress(owner).storeRef(beginCell().storeStringTail(String(content)).endCell()).endCell();
  return beginCell().storeUint(OP.nftDeploy, 32).storeUint(queryId, 64).storeUint(BigInt(index), 64).storeCoins(forward).storeRef(item).endCell();
}
/** New owner of the collection (op 3). */
export const nftChangeOwnerBody = ({ owner, queryId = 0n }) => beginCell().storeUint(OP.nftChangeOwner, 32).storeUint(queryId, 64).storeAddress(owner).endCell();
/** Transfer of an NFT item (TEP-62), sent to the item by its owner; 1 nanoGRAM forwarded so the new owner is notified. */
export const nftTransferBody = ({ to, response, forward = 1n, queryId = 0n }) => beginCell()
  .storeUint(OP.nftTransfer, 32).storeUint(queryId, 64).storeAddress(to).storeAddress(response).storeMaybeRef(null).storeCoins(forward).storeBit(0).endCell();
