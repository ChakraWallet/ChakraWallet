import { local } from '../../shared/ext.js';
import { fmtUsd, fmtNum, shortAddr } from '../../shared/format.js';
import { TopBar, TokenIcon, ChainIcon, Icon, explorerAddr, useApp } from '../components.jsx';
import { t } from '../../shared/i18n.js';

export function TokenDetails({ token: tk }) {
  const { chain, nav, back, toast, setPortfolioCache } = useApp();
  const hide = async () => {
    await local.update('hiddenTokens', {}, (all) => ({ ...all, [chain.id]: [...new Set([...(all[chain.id] || []), tk.address])] }));
    await local.update('customTokens', {}, (all) => ({ ...all, [chain.id]: (all[chain.id] || []).filter((x) => x.address !== tk.address) }));
    setPortfolioCache({});
    toast(t('token.hidden', { symbol: tk.symbol })); back();
  };
  const copy = async () => { await navigator.clipboard.writeText(tk.address); toast(t('common.copied')); };
  const explorer = !tk.native && explorerAddr(chain, tk.address) ? `${chain.explorer}/token/${tk.address}` : null;
  return (
    <div class="screen">
      <TopBar title={tk.name || tk.symbol} />
      <div class="content">
        {/* balance first: the token, the network it lives on, how much and what it's worth */}
        <div class="tk-hero">
          <span class="tk-ic">
            <TokenIcon symbol={tk.symbol} icon={tk.icon} color={tk.native ? chain.color : undefined} />
            {!tk.native && <span class="tk-chain"><ChainIcon chain={chain} size={22} /></span>}
          </span>
          <div class="tk-amount">{fmtNum(tk.amount ?? 0, 8)}<small>{tk.symbol}</small></div>
          <div class="tk-usd">{tk.usd != null ? fmtUsd(tk.usd) : t('token.noPrice')}</div>
        </div>

        <div class="actions" style={{ gridTemplateColumns: 'repeat(3, 1fr)' }}>
          <button class="action" onClick={() => nav('send', { tokenAddress: tk.address })}><span class="ic"><Icon name="send" /></span>{t('home.send')}</button>
          <button class="action" onClick={() => nav('receive')}><span class="ic"><Icon name="receive" /></span>{t('home.receive')}</button>
          <button class="action" disabled={!chain.swap} onClick={() => nav('swap', { fromAddress: tk.address })}><span class="ic"><Icon name="swap" /></span>{t('home.swap')}</button>
        </div>

        <div class="card tk-info">
          <div class="tk-row"><span class="k">{t('token.price')}</span><span class="v">{tk.price != null ? fmtUsd(tk.price) : '—'}</span></div>
          <div class="tk-row"><span class="k">{t('token.network')}</span><span class="v"><ChainIcon chain={chain} size={18} />{chain.name}</span></div>
          {!tk.native && (
            <button class="tk-row" onClick={copy} title={t('token.copyContract')}>
              <span class="k">{t('token.contract')}</span>
              <span class="v mono">{shortAddr(tk.address, 4)}<Icon name="copy" size={15} /></span>
            </button>
          )}
          {!tk.native && <div class="tk-row"><span class="k">{t('token.decimals')}</span><span class="v">{tk.decimals}</span></div>}
          {explorer && (
            <a class="tk-row" href={explorer} target="_blank" rel="noopener">
              <span class="k">{t('token.viewExplorer')}</span>
              <span class="v"><Icon name="external" size={15} /></span>
            </a>
          )}
        </div>

        {!tk.native && <button class="tk-hide" onClick={hide}><Icon name="eye" size={16} />{t('token.hide')}</button>}
      </div>
    </div>
  );
}
