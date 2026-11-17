import { useEffect, useMemo, useState } from 'preact/hooks';
import { local } from '../../shared/ext.js';
import { fmtUsd, fmtNum, shortAddr } from '../../shared/format.js';
import { priceChart, CHART_RANGES } from '../../shared/prices.js';
import { TopBar, TokenIcon, ChainIcon, Icon, useApp, usePrivacy } from '../components.jsx';
import { LineChart } from '../chart.jsx';
import { driverFor } from '../chains/index.js';
import { t } from '../../shared/i18n.js';

/** Price of the token over a period (DefiLlama, the same source as every price in the app). */
function PriceChart({ priceKey, price }) {
  const [range, setRange] = useState('1w');
  const [points, setPoints] = useState(null);
  const [hover, setHover] = useState(null);
  useEffect(() => {
    let alive = true; setPoints(null); setHover(null);
    priceChart(priceKey, range).then((p) => alive && setPoints(p)).catch(() => alive && setPoints([]));
    return () => { alive = false; };
  }, [priceKey, range]);
  // the last point is the current price, so the line ends where the number above it says
  const pts = useMemo(() => (points?.length && price != null ? [...points, { t: Date.now(), p: price }] : points || []), [points, price]);
  const shown = hover ? hover.p : price ?? pts[pts.length - 1]?.p;
  const first = pts[0]?.p;
  const change = first && shown != null ? ((shown - first) / first) * 100 : null;
  return (
    <div class="card tk-chart">
      <div class="tk-chart-head">
        <span class="tk-chart-price">{shown != null ? fmtUsd(shown) : '—'}</span>
        {change != null && Math.abs(change) >= 0.005 && <span class={`tk-chart-chg ${change > 0 ? 'up' : 'down'}`}>{change > 0 ? '▲' : '▼'} {Math.abs(change).toFixed(2)}%</span>}
        <span class="tiny muted tk-chart-when">{hover ? '' : t(`token.chart.range.${range}`)}</span>
      </div>
      {points === null ? <div class="pm-chart pm-chart-sk"><span class="skeleton" /></div>
        : pts.length < 2 ? <div class="pm-chart pm-chart-empty small muted">{t('token.chart.none')}</div>
          : <LineChart kind="price" points={pts} onHover={setHover} label={t('token.chart.label')} fmtY={(v) => fmtUsd(v)} tipValue={(v) => fmtUsd(v)} />}
      <div class="tabs pm-intervals">
        {Object.keys(CHART_RANGES).map((r) => <button class={`tab ${range === r ? 'active' : ''}`} onClick={() => setRange(r)}>{t(`token.chart.${r}`)}</button>)}
      </div>
    </div>
  );
}

export function TokenDetails({ token: tk }) {
  const { chain, nav, back, toast, setPortfolioCache } = useApp();
  const { m } = usePrivacy();
  const drv = driverFor(chain);
  const hide = async () => {
    await local.update('hiddenTokens', {}, (all) => ({ ...all, [chain.id]: [...new Set([...(all[chain.id] || []), tk.address])] }));
    await local.update('customTokens', {}, (all) => ({ ...all, [chain.id]: (all[chain.id] || []).filter((x) => x.address !== tk.address) }));
    setPortfolioCache({});
    toast(t('token.hidden', { symbol: tk.symbol })); back();
  };
  // a hidden token (opened from "hidden tokens" on the home screen): back among the others
  const unhide = async () => {
    await local.update('hiddenTokens', {}, (all) => ({ ...all, [chain.id]: (all[chain.id] || []).filter((a) => a !== tk.address) }));
    // hidden automatically as probable junk (Solana): shown from now on as a token the user chose
    if (tk.junk) {
      const keep = { address: tk.address, symbol: tk.symbol, name: tk.name || '', decimals: tk.decimals, icon: tk.icon || '', ...(tk.program ? { program: tk.program } : {}) };
      await local.update('customTokens', {}, (all) => ({ ...all, [chain.id]: [...(all[chain.id] || []).filter((x) => x.address !== tk.address), keep] }));
    }
    setPortfolioCache({});
    toast(t('token.shown', { symbol: tk.symbol })); back();
  };
  const copy = async () => { await navigator.clipboard.writeText(tk.address); toast(t('common.copied')); };
  const explorer = !tk.native && chain.explorer ? drv.explorerToken(chain, tk.address) : null;
  const priceKey = drv.priceKey(chain, tk);
  const warning = drv.tokenWarning?.(chain, tk); // e.g. a TON jetton STON.fi doesn't know
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
          <div class="tk-amount">{m(fmtNum(tk.amount ?? 0, 8))}<small>{tk.symbol}</small></div>
          <div class="tk-usd">{tk.usd != null ? m(fmtUsd(tk.usd)) : t('token.noPrice')}</div>
        </div>

        <div class="actions" style={{ gridTemplateColumns: 'repeat(3, 1fr)' }}>
          <button class="action" onClick={() => nav('send', { tokenAddress: tk.address })}><span class="ic"><Icon name="send" /></span>{t('home.send')}</button>
          <button class="action" onClick={() => nav('receive')}><span class="ic"><Icon name="receive" /></span>{t('home.receive')}</button>
          <button class="action" disabled={!drv.swapSupported?.(chain)} onClick={() => nav('swap', { fromAddress: tk.address })}><span class="ic"><Icon name="swap" /></span>{t('home.swap')}</button>
        </div>

        {priceKey && !chain.testnet && <PriceChart priceKey={priceKey} price={tk.price} />}

        {warning && <div class="warn small">{t(warning)}</div>}

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

        {!tk.native && (tk.hidden
          ? <button class="tk-hide show" onClick={unhide}><Icon name="eye" size={16} />{t('token.unhide')}</button>
          : <button class="tk-hide" onClick={hide}><Icon name="eyeOff" size={16} />{t('token.hide')}</button>)}
      </div>
    </div>
  );
}
