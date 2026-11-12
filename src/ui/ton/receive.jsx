// TON receive (Android app): QR of the account's TON address (ton:// link), optionally with an amount of GRAM.
// Jettons arrive at the same address.
import { useState } from 'preact/hooks';
import { Icon, Avatar, QR, CopyBtn, TopBar, Spinner, useApp, TokenIcon, Btn } from '../components.jsx';
import { fmtNum, fmtUsd, shortAddr } from '../../shared/format.js';
import { parseAmount } from '../../shared/format.js';
import { t } from '../../shared/i18n.js';
import { tonLink, Address } from '../../shared/ton/core.js';
import { tonAddrUrl } from '../../shared/ton/api.js';
import { useTonWallet, useTonPortfolio } from './hooks.js';

export function TonReceive() {
  const { account, chain } = useApp();
  const w = useTonWallet();
  const [ask, setAsk] = useState(false);
  const [amount, setAmount] = useState('');
  if (!w) return <div class="screen"><TopBar title={t('receive.title')} /><div class="content">{w === null ? <div class="error">{t('ton.noKey.body')}</div> : <Spinner />}</div></div>;
  const raw = ask ? parseAmount(amount, 9) : null;
  const uri = tonLink(w.address, { amount: raw && raw > 0n ? raw : null });
  return (
    <div class="screen">
      <TopBar title={t('receive.title')} />
      <div class="content" style={{ alignItems: 'center', textAlign: 'center' }}>
        <div class="row"><Avatar address={account.address} /><span class="bold">{account.name}</span></div>
        <div class="seg receive-seg" role="tablist">
          <button class={!ask ? 'on' : ''} onClick={() => setAsk(false)}>{t('receive.address')}</button>
          <button class={ask ? 'on' : ''} onClick={() => setAsk(true)}>{t('receive.ask')}</button>
        </div>
        {ask && (
          <div class="card ask-card">
            <div class="input-wrap">
              <input inputMode="decimal" placeholder="0" value={amount} onInput={(e) => setAmount(e.target.value)} />
              <span class="token-select"><TokenIcon sm symbol={chain.native.symbol} color={chain.color} />{chain.native.symbol}</span>
            </div>
            <div class="small muted">{raw && raw > 0n ? t('ton.receive.askFor', { amount, symbol: chain.native.symbol }) : t('receive.askHint')}</div>
          </div>
        )}
        <div class="qr-wrap"><QR text={uri} size={220} /></div>
        <div class="card flat mono" style={{ width: '100%' }}>{w.address}</div>
        <div class="row" style={{ gap: '0.5rem', flexWrap: 'wrap', justifyContent: 'center' }}>
          <CopyBtn text={w.address} label={t('receive.copyAddress')} />
          {ask && raw && raw > 0n && <CopyBtn text={uri} label={t('receive.copyLink')} />}
        </div>
        <div class="info small" style={{ textAlign: 'left' }}>{t(chain.testnet ? 'ton.receive.noteTestnet' : 'ton.receive.note')}</div>
      </div>
    </div>
  );
}

/** GRAM or a jetton: balance, value, contract, send / receive. */
export function TonToken({ jetton }) {
  const { chain, nav } = useApp();
  const w = useTonWallet();
  const { data } = useTonPortfolio(chain, w?.raw);
  const j = jetton ? data?.jettons.find((x) => x.master === jetton) : null;
  const tk = jetton ? j : data && { symbol: chain.native.symbol, name: chain.native.name, amount: data.gram.amount, usd: data.gram.usd, price: data.gram.price };
  const master = j ? Address.parse(j.master).toString({ urlSafe: true, bounceable: true, testOnly: !!chain.testnet }) : null;
  return (
    <div class="screen">
      <TopBar title={tk?.symbol || ''} />
      <div class="content">
        {!tk ? <Spinner /> : (
          <>
            <div class="card col" style={{ alignItems: 'center', gap: '.375rem', textAlign: 'center' }}>
              <TokenIcon symbol={tk.symbol} icon={j?.image} color={jetton ? undefined : chain.color} />
              <div style={{ fontSize: '1.5rem', fontWeight: 750 }}>{fmtNum(tk.amount)} {tk.symbol}</div>
              {tk.usd != null && <div class="muted">{fmtUsd(tk.usd)}{tk.price != null ? ` · ${fmtUsd(tk.price)}` : ''}</div>}
              <div class="small muted">{tk.name}</div>
            </div>
            {master && (
              <div class="card kv">
                <span class="k">{t('ton.token.contract')}</span>
                <span class="v mono"><a class="link" href={tonAddrUrl(chain, master)} target="_blank">{shortAddr(master, 6)}</a></span>
                <span class="k">{t('ton.token.decimals')}</span><span class="v">{j.decimals}</span>
              </div>
            )}
            {j && !j.known && <div class="warn small">{t('ton.token.unknown')}</div>}
          </>
        )}
      </div>
      <div class="footer">
        <Btn kind="secondary" onClick={() => nav('receive')}><Icon name="receive" size={16} /> {t('home.receive')}</Btn>
        <Btn disabled={!tk} onClick={() => nav('send', { jetton: jetton || null })}><Icon name="send" size={16} /> {t('home.send')}</Btn>
      </div>
    </div>
  );
}
