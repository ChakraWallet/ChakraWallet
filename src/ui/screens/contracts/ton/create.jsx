// New TON contracts from the official templates, without a compiler: a jetton (deployed and with its initial supply
// minted to the account in one message) or an NFT collection. The address depends on the code and the initial data,
// so it is known before signing; an identical contract that already exists is opened instead of deployed again.
import { useEffect, useMemo, useState } from 'preact/hooks';
import { Icon, Btn, Spinner, ChainIcon, useApp } from '../../../components.jsx';
import { getChain } from '../../../../shared/chains.js';
import { parseAmount, fmtAmount } from '../../../../shared/format.js';
import { t } from '../../../../shared/i18n.js';
import { parseAddr } from '../../../../shared/ton/cells.js';
import { jettonDeploy, nftCollectionDeploy, JETTON_DEPLOY_VALUE, NFT_COLLECTION_DEPLOY_VALUE, MAX_ROYALTY } from '../../../../shared/ton/templates.js';
import { tonAddressStatus, isTon } from '../../../../shared/ton/api.js';
import { showAddress } from '../../../../shared/ton/contracts.js';
import { NetworkSheet } from '../../home.jsx';
import { useTonWalletFor } from './parts.jsx';
import { errText } from './write.jsx';

const JETTON = { name: '', symbol: '', decimals: '9', supply: '', image: '', description: '' };
const NFT = { name: '', description: '', image: '', itemsBase: '', royalty: '5', royaltyTo: '' };

export function TonCreate({ kind, chainId: initialChain, onBack, open }) {
  const { state } = useApp();
  const [chainId, setChainId] = useState(initialChain ?? -239);
  const chain = getChain(chainId, state.customChains);
  const wallet = useTonWalletFor(chain);
  const [o, setO] = useState(kind === 'jetton' ? { ...JETTON } : { ...NFT });
  const [pick, setPick] = useState(false);
  const [exists, setExists] = useState(null); // null | 'checking' | status
  const set = (k, v) => setO({ ...o, [k]: v });

  const built = useMemo(() => {
    if (!wallet) return null;
    try {
      const me = parseAddr(wallet.raw);
      if (kind === 'jetton') {
        const decimals = Number(o.decimals);
        if (!o.name.trim() || !o.symbol.trim()) return { error: t('tonc.create.err.required') };
        if (!Number.isInteger(decimals) || decimals < 0 || decimals > 18) return { error: t('tonc.create.err.decimals') };
        const supply = o.supply.trim() ? parseAmount(o.supply, decimals) : 0n;
        if (supply == null) return { error: t('tonc.err.amount') };
        return { ...jettonDeploy({ admin: me, name: o.name.trim(), symbol: o.symbol.trim().toUpperCase(), decimals, image: o.image.trim(), description: o.description.trim(), supply }), supply };
      }
      if (!o.name.trim()) return { error: t('tonc.create.err.required') };
      const royalty = Number(String(o.royalty || '0').replace(',', '.'));
      if (!(royalty >= 0 && royalty <= MAX_ROYALTY)) return { error: t('tonc.create.err.royalty', { max: MAX_ROYALTY }) };
      const royaltyTo = o.royaltyTo.trim() ? parseAddr(o.royaltyTo) : me;
      return nftCollectionDeploy({ owner: me, name: o.name.trim(), description: o.description.trim(), image: o.image.trim(), itemsBase: o.itemsBase.trim(), royaltyPercent: royalty, royaltyTo });
    } catch (e) { return { error: errText(e) }; }
  }, [wallet, o, kind]);
  const raw = built?.address?.toRawString();

  // the same code + data give the same address: if it is already deployed, open it instead
  useEffect(() => {
    if (!raw || !chain) { setExists(null); return undefined; }
    setExists('checking');
    const tm = setTimeout(() => tonAddressStatus(chain, raw).then(setExists).catch(() => setExists(null)), 900);
    return () => clearTimeout(tm);
  }, [raw, chainId]);

  const go = () => {
    const name = kind === 'jetton' ? `${o.name.trim()} (${o.symbol.trim().toUpperCase()})` : o.name.trim();
    open({
      name: 'tontx', chainId,
      req: {
        title: t(`tonc.create.${kind}.title`), risks: [], deploy: { address: raw, name, kind },
        summary: kind === 'jetton'
          ? [[t('tonc.f.name'), o.name.trim()], [t('tonc.f.symbol'), o.symbol.trim().toUpperCase()], [t('tonc.f.decimals'), o.decimals], [t('tonc.create.supply'), o.supply.trim() || '0']]
          : [[t('tonc.f.name'), o.name.trim()], [t('tonc.create.royalty'), `${o.royalty || 0}%`]],
        messages: [built.message],
      },
    }, { replace: true });
  };
  const text = (k, extra = {}) => (
    <div class="field">
      <label>{t(`tonc.create.f.${k}`)}</label>
      <input class="input" value={o[k]} spellcheck={false} autocapitalize="off" onInput={(e) => set(k, e.target.value)} {...extra} />
    </div>
  );
  const value = kind === 'jetton' ? JETTON_DEPLOY_VALUE : NFT_COLLECTION_DEPLOY_VALUE;

  return (
    <div class="screen">
      <div class="topbar"><button class="iconbtn" onClick={onBack} title={t('common.back')}><Icon name="back" /></button><h1>{t(`tonc.create.${kind}.title`)}</h1></div>
      <div class="content ct-content">
        <div class="info small">{t(`tonc.create.${kind}.intro`)}</div>
        <button class="item card flat" onClick={() => setPick(true)}>
          <ChainIcon chain={chain} size={24} /><div class="grow"><div class="bold">{chain.name}</div><div class="tiny muted">{t('tonc.create.network')}</div></div><Icon name="chevron" size={14} />
        </button>
        {wallet === null && <div class="error">{t('tonc.write.noKey')}</div>}
        {text('name')}
        {kind === 'jetton' && (
          <>
            <div class="row" style={{ gap: '.5rem' }}>
              <div class="grow">{text('symbol', { style: { textTransform: 'uppercase' } })}</div>
              <div style={{ width: '6rem' }}>{text('decimals', { inputMode: 'numeric' })}</div>
            </div>
            {text('supply', { inputMode: 'decimal', placeholder: '1000000' })}
          </>
        )}
        {text('image', { placeholder: 'https://…/logo.png' })}
        {text('description')}
        {kind === 'nft' && (
          <>
            {text('itemsBase', { placeholder: 'https://…/nft/' })}
            <span class="tiny muted">{t('tonc.create.itemsBaseHint')}</span>
            <div class="row" style={{ gap: '.5rem' }}>
              <div style={{ width: '6rem' }}>{text('royalty', { inputMode: 'decimal' })}</div>
              <div class="grow">{text('royaltyTo', { placeholder: t('tonc.create.royaltyToMe') })}</div>
            </div>
          </>
        )}
        <div class="tiny muted">{t(`tonc.create.${kind}.note`, { amount: fmtAmount(value, 9, 3), symbol: chain.native.symbol })}</div>
        {built?.error && o.name && <div class="tiny red">{built.error}</div>}
        {raw && (
          <div class="card col" style={{ gap: '.25rem' }}>
            <span class="tiny muted">{t('tonc.create.address')}</span>
            <span class="mono tiny" style={{ wordBreak: 'break-all' }}>{showAddress(raw, { testnet: chain.testnet })}</span>
            {exists === 'checking' && <Spinner />}
            {exists === 'active' && (
              <div class="warn small col" style={{ gap: '.375rem' }}>
                {t('tonc.create.exists')}
                <button class="btn secondary sm" onClick={() => open({ name: 'contract', chainId, address: raw }, { replace: true })}><Icon name="code" size={14} /> {t('contracts.tx.openContract')}</button>
              </div>
            )}
          </div>
        )}
      </div>
      <div class="footer">
        <Btn disabled={!raw || exists === 'checking' || exists === 'active'} onClick={go}>{t('tonc.create.go')}</Btn>
      </div>
      {pick && <NetworkSheet current={chainId} onPick={setChainId} only={isTon} onClose={() => setPick(false)} />}
    </div>
  );
}
