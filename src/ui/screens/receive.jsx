import { useState, useMemo } from 'preact/hooks';
import { parseAmount, fmtUsd } from '../../shared/format.js';
import { TopBar, QR, CopyBtn, Avatar, Icon, TokenIcon, Sheet, useApp, rich } from '../components.jsx';
import { useTokenList } from './send.jsx';
import { useChainAddress } from '../hooks.js';
import { driverFor } from '../chains/index.js';
import { t } from '../../shared/i18n.js';

/** The receive screen: the family's own when it has one (driver.ui.Receive: Bitcoin's address types), else the address. */
export function Receive() {
  const { chain } = useApp();
  const Own = driverFor(chain).ui?.Receive;
  return Own ? <Own /> : <ReceiveDefault />;
}

function ReceiveDefault() {
  const addr = useChainAddress(); // the account's address on this network
  return <ReceiveView address={addr.address} missing={addr.missing} />;
}

/** QR, address, payment request. extra: shown under the address (e.g. Bitcoin: the address type, a new address). */
export function ReceiveView({ address, missing = false, extra = null }) {
  const { account, chain } = useApp();
  const { tokens } = useTokenList();
  const drv = driverFor(chain);
  const [ask, setAsk] = useState(false);
  const [token, setToken] = useState(null);
  const [amount, setAmount] = useState('');
  const [picker, setPicker] = useState(false);

  // tokens you can ask for (EVM: the ones you hold + the network's well-known ones; TON links carry GRAM only)
  const choices = useMemo(() => drv.receiveTokens(chain, tokens), [tokens, chain.id]);
  const tk = token || choices[0];
  const raw = ask && tk ? parseAmount(amount, tk.decimals) : null;
  const amountRaw = raw && raw > 0n ? raw.toString() : null;
  const uri = address ? drv.paymentLink(chain, { address, token: tk, amountRaw, ask }) : '';
  if (!address) {
    return <div class="screen"><TopBar title={t('receive.title')} /><div class="content">{missing ? <div class="error">{t('chain.noKey.body', { network: chain.name })}</div> : <div class="empty"><span class="spinner" /></div>}</div></div>;
  }
  const note = drv.receiveNote(chain, ask);
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
              <button class="token-select" onClick={() => choices.length > 1 && setPicker(true)}><TokenIcon sm symbol={tk.symbol} icon={tk.icon} color={tk.native ? chain.color : undefined} /><span class="sym">{tk.symbol}</span><Icon name="chevron" size={14} /></button>
            </div>
            <div class="small muted">{raw && raw > 0n ? t('receive.askFor', { amount, symbol: tk.symbol, chain: chain.name }) + (usd != null ? ` · ≈ ${fmtUsd(usd)}` : '') : t('receive.askHint')}</div>
          </div>
        )}
        <div class="qr-wrap"><QR text={uri} size={220} /></div>
        <div class="card flat mono" style={{ width: '100%' }}>{address}</div>
        <div class="row" style={{ gap: '0.5rem', flexWrap: 'wrap', justifyContent: 'center' }}>
          <CopyBtn text={address} label={t('receive.copyAddress')} />
          {ask && raw && raw > 0n && <CopyBtn text={uri} label={t('receive.copyLink')} />}
        </div>
        {extra}
        <div class="info small" style={{ textAlign: 'left' }}>
          {note.network ? rich(note.key, { network: <b>{chain.name}</b> }) : t(note.key)}
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
