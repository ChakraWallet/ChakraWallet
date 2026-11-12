import { useState, useMemo } from 'preact/hooks';
import { NATIVE } from '../../shared/chains.js';
import { POPULAR_TOKENS } from '../../shared/tokens.js';
import { parseAmount, fmtUsd } from '../../shared/format.js';
import { paymentUri } from '../../shared/eip681.js';
import { TopBar, QR, CopyBtn, Avatar, Icon, TokenIcon, Sheet, useApp, rich } from '../components.jsx';
import { useTokenList } from './send.jsx';
import { t } from '../../shared/i18n.js';

export function Receive() {
  const { account, chain } = useApp();
  const { tokens } = useTokenList();
  const [ask, setAsk] = useState(false);
  const [token, setToken] = useState(null);
  const [amount, setAmount] = useState('');
  const [picker, setPicker] = useState(false);

  // tokens you can ask for: the ones you hold + the network's well-known ones
  const choices = useMemo(() => {
    const seen = new Set(tokens.map((x) => x.address.toLowerCase()));
    return [...tokens.filter((x) => !x.spam), ...(POPULAR_TOKENS[chain.id] || []).filter((x) => !seen.has(x.address))];
  }, [tokens, chain.id]);
  const tk = token || choices[0];
  const raw = ask && tk ? parseAmount(amount, tk.decimals) : null;
  const uri = ask && tk ? paymentUri({ address: account.address, chainId: chain.id, token: tk.native ? NATIVE : tk.address, amountRaw: raw && raw > 0n ? raw.toString() : null }) : account.address;
  const usd = raw && tk?.price != null ? (Number(amount.replace(',', '.')) || 0) * tk.price : null;

  return (
    <div class="screen">
      <TopBar title={t('receive.title')} />
      <div class="content" style={{ alignItems: 'center', textAlign: 'center' }}>
        <div class="row"><Avatar address={account.address} /><span class="bold">{account.name}</span></div>
        <div class="seg receive-seg" role="tablist">
          <button class={!ask ? 'on' : ''} onClick={() => setAsk(false)}>{t('receive.address')}</button>
          <button class={ask ? 'on' : ''} onClick={() => setAsk(true)}>{t('receive.ask')}</button>
        </div>
        {ask && tk && (
          <div class="card ask-card">
            <div class="input-wrap">
              <input inputMode="decimal" placeholder="0" value={amount} onInput={(e) => setAmount(e.target.value)} />
              <button class="token-select" onClick={() => setPicker(true)}><TokenIcon sm symbol={tk.symbol} icon={tk.icon} color={tk.native ? chain.color : undefined} />{tk.symbol}<Icon name="chevron" size={14} /></button>
            </div>
            <div class="small muted">{raw && raw > 0n ? t('receive.askFor', { amount, symbol: tk.symbol, chain: chain.name }) + (usd != null ? ` · ≈ ${fmtUsd(usd)}` : '') : t('receive.askHint')}</div>
          </div>
        )}
        <div class="qr-wrap"><QR text={uri} size={220} /></div>
        <div class="card flat mono" style={{ width: '100%' }}>{account.address}</div>
        <div class="row" style={{ gap: '0.5rem', flexWrap: 'wrap', justifyContent: 'center' }}>
          <CopyBtn text={account.address} label={t('receive.copyAddress')} />
          {ask && raw && raw > 0n && <CopyBtn text={uri} label={t('receive.copyLink')} />}
        </div>
        <div class="info small" style={{ textAlign: 'left' }}>
          {ask ? t('receive.askNote') : rich('receive.note', { network: <b>{chain.name}</b> })}
        </div>
      </div>
      {picker && (
        <Sheet title={t('send.pickToken')} onClose={() => setPicker(false)}>
          <div class="list">
            {choices.map((x) => (
              <button class="item" onClick={() => { setToken(x); setPicker(false); }}>
                <TokenIcon symbol={x.symbol} icon={x.icon} color={x.native ? chain.color : undefined} />
                <div class="grow" style={{ textAlign: 'left' }}><div class="bold">{x.symbol}</div><div class="small muted ellipsis">{x.name}</div></div>
              </button>
            ))}
          </div>
        </Sheet>
      )}
    </div>
  );
}
