// Details of a TON history entry (Android app): the same sheet as the EVM history - what happened drawn with the real
// tokens, from / to, network, comment, fee paid, hash and the explorer link. The fee is read from the chain of
// transactions of the action (TON Center), so it includes the gas of jetton wallets minus what came back.
import { useEffect, useState } from 'preact/hooks';
import { Icon, Sheet, Avatar, TokenIcon, ChainIcon, CopyBtn, Spinner, useApp } from '../components.jsx';
import { fmtNum, fmtUsd, fmtAmount, fmtDateTime, shortAddr } from '../../shared/format.js';
import { t } from '../../shared/i18n.js';
import { tonTxUrl, gramPrice } from '../../shared/ton/api.js';
import { actionFee, showAddress } from '../../shared/ton/contracts.js';
import { KIND } from '../screens/history.jsx';

const KIND_OF = { out: 'send', in: 'receive', swap: 'swap', other: 'contract' };
const units = (raw, decimals) => Number(raw) / 10 ** decimals;
const amt = (x) => `${fmtNum(units(x.amount, x.decimals))} ${x.symbol}`;

/** Title of an entry, as in the list. */
export function tonTitle(r) {
  if (r.kind === 'swap') return t('ton.hist.swap', { a: r.swap.in.symbol, b: r.swap.out.symbol });
  if (r.kind === 'in') return t('ton.hist.received', { symbol: r.symbol });
  if (r.kind === 'out') return t('ton.hist.sent', { symbol: r.symbol });
  return t(`ton.hist.type.${TON_TYPES.has(r.type) ? r.type : 'other'}`);
}
export const TON_TYPES = new Set(['contract_deploy', 'call_contract', 'nft_transfer', 'nft_mint', 'jetton_mint', 'jetton_burn', 'stake_deposit', 'stake_withdrawal', 'auction_bid', 'dns_purchase']);

function Head({ r, chain, k }) {
  const tok = (x) => <TokenIcon symbol={x.symbol} icon={x.image} color={x.native ? chain.color : undefined} />;
  let visual, amounts = null;
  if (r.kind === 'swap') {
    visual = (
      <div class="head-route swap">
        <div class="head-node">{tok(r.swap.in)}<span class="muted">−{amt(r.swap.in)}</span></div>
        <div class="head-arrow"><Icon name="forward" size={18} /></div>
        <div class="head-node">{tok(r.swap.out)}<span class="green">+{amt(r.swap.out)}</span></div>
      </div>
    );
  } else if (r.kind === 'in' || r.kind === 'out') {
    visual = <span class="head-tok">{tok(r)}<span class={`dir-badge ${KIND_OF[r.kind]}`}><Icon name={KIND_OF[r.kind]} size={13} stroke={3} /></span></span>;
    amounts = <div class={`tx-hero-amt ${r.kind === 'in' ? 'green' : ''}`}>{r.kind === 'in' ? '+' : '−'}{amt(r)}</div>;
  } else {
    visual = <div class="tx-hero-ic round" style={{ background: k.bg, color: k.color }}><Icon name={k.icon} size={26} /></div>;
  }
  return (
    <div class="tx-head" style={{ '--tint': k.bg }}>
      {visual}
      <div class="tx-hero-title">{tonTitle(r)}</div>
      {amounts}
      <div class="row" style={{ gap: '0.375rem', justifyContent: 'center', flexWrap: 'wrap' }}>
        <span class="badge" style={{ background: k.bg, color: k.color }}>{t(k.label)}</span>
        <span class={`badge ${r.ok ? 'green' : 'red'}`}>{t(r.ok ? 'history.confirmed' : 'history.failed')}</span>
        {r.spam && <span class="badge red">{t('history.spam')}</span>}
      </div>
      <div class="small muted">{fmtDateTime(r.time)}</div>
    </div>
  );
}

export function TonTxDetail({ r, chain, wallet, onClose }) {
  const { account } = useApp();
  const k = KIND[KIND_OF[r.kind]];
  const [fee, setFee] = useState(r.kind === 'in' ? { bySender: true } : undefined);
  const [price, setPrice] = useState(null);
  useEffect(() => {
    gramPrice(chain).then(setPrice).catch(() => {});
    if (r.kind === 'in') return;
    if (!r.traceId) { setFee(null); return; }
    const transferred = r.kind === 'out' && r.native ? r.amount : r.kind === 'swap' && r.swap.in.native ? r.swap.in.amount : 0n;
    actionFee(chain, r.traceId, wallet, transferred).then(setFee).catch(() => setFee(null));
  }, []);
  const link = tonTxUrl(chain, r.txHash);
  const me = <span class="who"><Avatar address={account.address} /><span class="ellipsis">{account.name} · {shortAddr(showAddress(wallet, { testnet: chain.testnet, wallet: true }), 4)}</span></span>;
  const other = r.counterparty ? <span class="who"><Avatar address={r.counterparty} /><span class="ellipsis mono-s">{shortAddr(r.counterparty, 6)}</span><CopyBtn text={r.counterparty} /></span> : '—';
  const from = r.kind === 'in' ? other : r.kind === 'out' ? me : null;
  const to = r.kind === 'out' ? other : r.kind === 'in' ? me : null;
  const feeUsd = fee?.fee != null && price != null ? units(fee.fee, 9) * price : null;
  return (
    <Sheet title={t('history.details')} onClose={onClose}>
      <Head r={r} chain={chain} k={k} />
      <div class="card flat tx-rows">
        {from && <div class="tx-row"><span class="k">{t('history.fromLabel')}</span><span class="v">{from}</span></div>}
        {to && <div class="tx-row"><span class="k">{t('history.toLabel')}</span><span class="v">{to}</span></div>}
        {r.kind === 'swap' && r.counterparty && <div class="tx-row"><span class="k">{t('bridge.via')}</span><span class="v"><span class="method-pill ellipsis">{r.counterparty}</span></span></div>}
        {r.comment && <div class="tx-row"><span class="k">{t('ton.send.comment')}</span><span class="v"><span class="ellipsis">“{r.comment}”</span></span></div>}
        <div class="tx-row"><span class="k">{t('history.network')}</span><span class="v"><ChainIcon chain={chain} size={16} /><span class="ellipsis">{chain.name}</span></span></div>
        <div class="tx-row"><span class="k">{t('history.feePaid')}</span>
          <span class="v col-v">
            {fee === undefined ? <Spinner />
              : fee?.bySender ? <span class="muted">{t('history.feeBySender')}</span>
                : fee?.fee != null ? <><span>{fmtAmount(fee.fee, 9, 6)} {chain.native.symbol}</span>{feeUsd != null && <span class="tx-sub">≈ {fmtUsd(feeUsd)}</span>}</>
                  : <span class="muted">—</span>}
          </span>
        </div>
        {r.txHash && <div class="tx-row"><span class="k">{t('history.hash')}</span><span class="v"><span class="mono-s">{shortAddr(r.txHash, 6)}</span><CopyBtn text={r.txHash} /></span></div>}
      </div>
      {link && <a class="btn secondary block" href={link} target="_blank"><Icon name="external" size={16} /> {t('history.viewExplorer')}</a>}
    </Sheet>
  );
}
