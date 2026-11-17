// New tokens and NFT collections on Solana, without a compiler: a Token-2022 token with its name, symbol and link
// inside it (supply minted to the account; optionally fixed for ever), or a Metaplex Core collection (with
// royalties). The new account's address is a new key made on the phone: it signs the creation, then has no power.
import { useState } from 'preact/hooks';
import { Icon, Btn, ChainIcon, Switch, useApp } from '../../../components.jsx';
import { getChain } from '../../../../shared/chains.js';
import { parseAmount } from '../../../../shared/format.js';
import { t } from '../../../../shared/i18n.js';
import { isAddress, keyOfSeed, utf8 } from '../../../../shared/solana/core.js';
import { rentExempt, isSolana, SOL_MAINNET } from '../../../../shared/solana/api.js';
import { createTokenIxs, mintSpace, core, LIMITS, metadataJson } from '../../../../shared/solana/templates.js';
import { NetworkSheet } from '../../home.jsx';
import { useSolWalletFor, copyText } from './parts.jsx';

const TOKEN = { name: '', symbol: '', decimals: '6', supply: '', uri: '', image: '', description: '', fixed: false, freezable: false };
const NFT = { name: '', uri: '', image: '', description: '', royalty: '5', royaltyTo: '' };
const MAX_ROYALTY = 50;

export function SolCreate({ kind, chainId: initialChain, onBack, open }) {
  const { state, toast } = useApp();
  const [chainId, setChainId] = useState(initialChain ?? SOL_MAINNET);
  const chain = getChain(chainId, state.customChains);
  const wallet = useSolWalletFor(chain);
  const [o, setO] = useState(kind === 'token' ? { ...TOKEN } : { ...NFT });
  const [pick, setPick] = useState(false);
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const set = (k, v) => setO({ ...o, [k]: v });
  const len = (s) => utf8(s.trim()).length;

  const check = () => {
    if (!o.name.trim()) return t('solc.create.err.required');
    if (len(o.name) > LIMITS.name) return t('solc.create.err.long', { field: t('solc.f.name'), max: LIMITS.name });
    if (o.uri.trim() && !/^https?:\/\/|^ipfs:\/\/|^ar:\/\//i.test(o.uri.trim())) return t('solc.create.err.uri');
    if (len(o.uri) > LIMITS.uri) return t('solc.create.err.long', { field: t('solc.f.uri'), max: LIMITS.uri });
    if (kind === 'token') {
      if (!o.symbol.trim()) return t('solc.create.err.required');
      if (len(o.symbol) > LIMITS.symbol) return t('solc.create.err.long', { field: t('solc.f.symbol'), max: LIMITS.symbol });
      const d = Number(o.decimals);
      if (!Number.isInteger(d) || d < 0 || d > LIMITS.decimals) return t('solc.create.err.decimals');
      if (o.supply.trim() && parseAmount(o.supply.trim(), d) == null) return t('solc.err.amount');
      if (o.fixed && !o.supply.trim()) return t('solc.create.err.fixedEmpty');
    } else {
      const r = Number(String(o.royalty || '0').replace(',', '.'));
      if (!(r >= 0 && r <= MAX_ROYALTY)) return t('solc.create.err.royalty', { max: MAX_ROYALTY });
      if (o.royaltyTo.trim() && !isAddress(o.royaltyTo.trim())) return t('contracts.err.badAddress');
    }
    return null;
  };
  const problem = wallet ? check() : null;

  const go = async () => {
    setErr(''); setBusy(true);
    try {
      const me = wallet.raw;
      const seed = crypto.getRandomValues(new Uint8Array(32));
      const address = keyOfSeed(seed).address;
      if (kind === 'token') {
        const decimals = Number(o.decimals);
        const supply = o.supply.trim() ? parseAmount(o.supply.trim(), decimals) : 0n;
        const texts = { name: o.name.trim(), symbol: o.symbol.trim(), uri: o.uri.trim() };
        const rent = await rentExempt(chain, mintSpace(texts).full);
        open({
          name: 'soltx', chainId,
          req: {
            title: t('solc.create.token.title'), extraSeeds: [seed], deploy: { address, name: `${texts.name} (${texts.symbol})`, kind: 'token' },
            risks: o.fixed ? ['fixedSupply'] : [],
            summary: [[t('solc.f.name'), texts.name], [t('solc.f.symbol'), texts.symbol], [t('solc.token.decimals'), String(decimals)], [t('solc.create.supply'), o.supply.trim() || '0'],
              [t('solc.create.fixed'), o.fixed ? t('solc.yes') : t('solc.no')], [t('solc.create.freezable'), o.freezable ? t('solc.yes') : t('solc.no')], [t('solc.f.address'), address]],
            instructions: createTokenIxs({ payer: me, mint: address, decimals, supply, ...texts, fixedSupply: o.fixed, freezable: o.freezable, rent }),
          },
        }, { replace: true });
      } else {
        const bps = Math.round(Number(String(o.royalty || '0').replace(',', '.')) * 100);
        const to = o.royaltyTo.trim() || me;
        open({
          name: 'soltx', chainId,
          req: {
            title: t('solc.create.nft.title'), extraSeeds: [seed], deploy: { address, name: o.name.trim(), kind: 'nft' },
            summary: [[t('solc.f.name'), o.name.trim()], [t('solc.create.royalty'), `${bps / 100}%`], [t('solc.f.address'), address]],
            instructions: [core.createCollection({ payer: me, collection: address, name: o.name.trim(), uri: o.uri.trim(), royaltyBps: bps, royaltyTo: to })],
          },
        }, { replace: true });
      }
    } catch (e) { setErr(e.message); }
    setBusy(false);
  };

  const text = (k, extra = {}) => (
    <div class="field">
      <label>{t(`solc.create.f.${k}`)}</label>
      <input class="input" value={o[k]} spellcheck={false} autocapitalize="off" onInput={(e) => set(k, e.target.value)} {...extra} />
    </div>
  );
  const json = metadataJson({ name: o.name.trim(), symbol: o.symbol?.trim() || '', description: o.description.trim(), image: o.image.trim() });

  return (
    <div class="screen">
      <div class="topbar"><button class="iconbtn" onClick={onBack} title={t('common.back')}><Icon name="back" /></button><h1>{t(`solc.create.${kind}.title`)}</h1></div>
      <div class="content ct-content">
        <div class="info small">{t(`solc.create.${kind}.intro`)}</div>
        <button class="item card flat" onClick={() => setPick(true)}>
          <ChainIcon chain={chain} size={24} /><div class="grow"><div class="bold">{chain.name}</div><div class="tiny muted">{t('solc.create.network')}</div></div><Icon name="chevron" size={14} />
        </button>
        {wallet === null && <div class="error">{t('solc.noKey')}</div>}
        {text('name')}
        {kind === 'token' && (
          <>
            <div class="row" style={{ gap: '.5rem' }}>
              <div class="grow">{text('symbol')}</div>
              <div style={{ width: '6rem' }}>{text('decimals', { inputMode: 'numeric' })}</div>
            </div>
            {text('supply', { inputMode: 'decimal', placeholder: '1000000' })}
            <div class="row between small"><span>{t('solc.create.fixed')}<br /><span class="tiny muted">{t('solc.create.fixedHint')}</span></span><Switch on={o.fixed} onChange={(v) => set('fixed', v)} /></div>
            <div class="row between small"><span>{t('solc.create.freezable')}<br /><span class="tiny muted">{t('solc.create.freezableHint')}</span></span><Switch on={o.freezable} onChange={(v) => set('freezable', v)} /></div>
          </>
        )}
        {kind === 'nft' && (
          <div class="row" style={{ gap: '.5rem' }}>
            <div style={{ width: '6rem' }}>{text('royalty', { inputMode: 'decimal' })}</div>
            <div class="grow">{text('royaltyTo', { placeholder: t('solc.create.royaltyToMe') })}</div>
          </div>
        )}
        {text('uri', { placeholder: 'https://…/metadata.json' })}
        <details class="card">
          <summary class="small">{t('solc.create.json.title')}</summary>
          <div class="col" style={{ gap: '.5rem', marginTop: '.5rem' }}>
            <span class="tiny muted">{t('solc.create.json.hint')}</span>
            {text('image', { placeholder: 'https://…/logo.png' })}
            {text('description')}
            <pre class="ct-log mono tiny">{json}</pre>
            <button class="btn secondary sm" onClick={() => copyText(json, toast)}><Icon name="copy" size={14} /> {t('common.copy')}</button>
          </div>
        </details>
        <div class="tiny muted">{t(`solc.create.${kind}.note`, { symbol: chain.native.symbol })}</div>
        {problem && o.name && <div class="tiny red">{problem}</div>}
        {err && <div class="error">{err}</div>}
      </div>
      <div class="footer">
        <Btn loading={busy} disabled={!wallet || !!problem} onClick={go}>{t('solc.create.go')}</Btn>
      </div>
      {pick && <NetworkSheet current={chainId} onPick={setChainId} only={isSolana} onClose={() => setPick(false)} />}
    </div>
  );
}
