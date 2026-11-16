// The code of a TON template before it is created: what the form generates (the contract's initial data and the
// deployment message), then the official FunC sources it runs - the same files that compile to the code deployed
// (tests/tonsources.test.js checks the hashes).
import { useState } from 'preact/hooks';
import { Icon } from '../../../components.jsx';
import { fmtAmount } from '../../../../shared/format.js';
import { t } from '../../../../shared/i18n.js';
import { CODES, JETTON_DEPLOY_VALUE, NFT_COLLECTION_DEPLOY_VALUE } from '../../../../shared/ton/templates.js';
import { TEMPLATE_SOURCES, SOURCE_FILES } from '../../../../shared/ton/templateSources.js';
import { showAddress } from '../../../../shared/ton/contracts.js';
import { CodeEditor, langOf } from '../codeEditor.jsx';

const GENERATED = 'generated.fc';
const q = (s) => JSON.stringify(String(s ?? ''));
const pad = (s, n) => String(s).padEnd(n);
const hash = (k) => `${CODES[k].hash.slice(0, 16)}…`;

/** The part made from the form: initial data and deployment message, as commented FunC-style text. */
function generated(kind, o, ctx) {
  const { me, address, symbol, testnet } = ctx;
  const addr = (a) => showAddress(a, { testnet });
  const wallet = (a) => showAddress(a, { testnet, wallet: true }); // a wallet: UQ…
  if (kind === 'jetton') {
    const sym = o.symbol.trim().toUpperCase();
    const meta = [['name', o.name.trim()], ['symbol', sym], ['decimals', o.decimals], ['image', o.image.trim()], ['description', o.description.trim()]].filter(([, v]) => v !== '');
    return [
      ';; Generated from the form: the initial data of the new jetton minter and the message that creates it.',
      ';; The contract code is not generated: it is the official jetton-minter.fc (next tab), unchanged.',
      '',
      ';; storage#_ total_supply:Coins admin_address:MsgAddress content:^Cell jetton_wallet_code:^Cell = Storage;',
      `total_supply       = 0;  ;; it grows with the mint below`,
      `admin_address      = ${wallet(me)};  ;; you: you can mint and change the metadata`,
      ';; content: on-chain metadata (TEP-64), no server needed',
      ...meta.map(([k, v]) => `content.${pad(k, 12)} = ${q(v)};`),
      `jetton_wallet_code = jetton-wallet.fc;  ;; code hash ${hash('JETTON_WALLET')}`,
      '',
      ';; Deployment: one message from your wallet',
      `to    = ${address ? addr(address) : '…'};  ;; the address depends only on code + data`,
      `value = ${fmtAmount(JETTON_DEPLOY_VALUE, 9, 3)} ${symbol};`,
      `init  = { code: jetton-minter.fc (hash ${hash('JETTON_MINTER')}), data: the storage above };`,
      ctx.supply > 0n
        ? `body  = mint(to: you, amount: ${fmtAmount(ctx.supply, Number(o.decimals) || 0)} ${sym});  ;; op 21: the initial supply goes to your jetton wallet`
        : 'body  = none;  ;; no initial supply',
    ].join('\n');
  }
  const royalty = Number(String(o.royalty || '0').replace(',', '.')) || 0;
  const meta = [['name', o.name.trim()], ['description', o.description.trim()], ['image', o.image.trim()]].filter(([, v]) => v !== '');
  return [
    ';; Generated from the form: the initial data of the new NFT collection and the message that creates it.',
    ';; The contract code is not generated: it is the official nft-collection-editable.fc (next tab), unchanged.',
    '',
    ';; storage: owner_address next_item_index:uint64 ^content nft_item_code:^Cell royalty_params:^Cell',
    `owner_address   = ${wallet(me)};  ;; you: you can mint items and change the metadata`,
    'next_item_index = 0;',
    ';; content: the collection (on-chain metadata, TEP-64) + the common base of the items\' links',
    ...meta.map(([k, v]) => `collection.${pad(k, 12)} = ${q(v)};`),
    `items_base      = ${q(o.itemsBase.trim())};  ;; an item's link = this base + its own suffix`,
    `nft_item_code   = nft-item.fc;  ;; code hash ${hash('NFT_ITEM')}`,
    `royalty_params  = { factor: ${Math.round(royalty * 100)}, base: 10000, address: ${o.royaltyTo.trim() || wallet(me)} };  ;; ${royalty}% (TEP-66)`,
    '',
    ';; Deployment: one message from your wallet',
    `to    = ${address ? addr(address) : '…'};  ;; the address depends only on code + data`,
    `value = ${fmtAmount(NFT_COLLECTION_DEPLOY_VALUE, 9, 3)} ${symbol};`,
    `init  = { code: nft-collection-editable.fc (hash ${hash('NFT_COLLECTION')}), data: the storage above };`,
  ].join('\n');
}

/** Expandable code view of a template (like the EVM templates' preview). ctx: { me, address, supply, symbol, testnet } */
export function TonTemplateCode({ kind, o, ctx }) {
  const [open, setOpen] = useState(false);
  const [file, setFile] = useState(GENERATED);
  const main = kind === 'jetton' ? TEMPLATE_SOURCES.JETTON_MINTER : TEMPLATE_SOURCES.NFT_COLLECTION;
  const files = SOURCE_FILES[main.dir];
  // the contract first, the code it deploys second, then the includes
  const names = [main.main, kind === 'jetton' ? 'jetton-wallet.fc' : 'nft-item.fc', ...Object.keys(files).filter((f) => f !== main.main && f !== 'jetton-wallet.fc' && f !== 'nft-item.fc').sort()];
  const source = file === GENERATED ? generated(kind, o, ctx) : files[file];
  return (
    <div class={`card ct-preview ${open ? 'open' : ''}`}>
      <button class="ct-preview-head" onClick={() => setOpen(!open)} aria-expanded={open}>
        <span class="ct-kind-ic sm"><Icon name="code" size={16} /></span>
        <span class="grow"><b class="small">{t('tonc.code.title')}</b><span class="tiny muted">{t('tonc.code.sub')}</span></span>
        <span class="ct-chev"><Icon name="chevron" size={16} /></span>
      </button>
      {open && (
        <>
          <div class="tiny muted ct-code-note">{t('tonc.code.note', { repo: main.repo })}</div>
          <div class="ct-files">
            {[GENERATED, ...names].map((f) => <button class={`chip ct-file ${f === file ? 'on' : ''}`} onClick={() => setFile(f)}>{f === GENERATED ? t('tonc.code.generated') : f.split('/').pop()}</button>)}
          </div>
          <CodeEditor key={file} value={source} readOnly lang={langOf(file === GENERATED ? 'x.fc' : file)} />
        </>
      )}
    </div>
  );
}
