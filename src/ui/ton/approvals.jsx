// Approval screens of TON Connect (dapps of the in-app browser, Android app): connecting a site (and signing in with
// ton_proof), a transaction it asks for (emulated first: what leaves the wallet, every step, the cost) and a
// signData request. Registered in the approval list (screens/approve.jsx) by src/mobile/tonPlugin.js; the signatures
// themselves happen in the background (src/background/tonconnect.js) after the password or the fingerprint.
import { useEffect, useState } from 'preact/hooks';
import { Cell } from '@ton/core';
import { Btn, Avatar, ChainIcon, useApp } from '../components.jsx';
import { Site } from '../screens/approve.jsx';
import { StepsView, Loading } from '../screens/contracts/ton/parts.jsx';
import { fmtAmount, shortAddr } from '../../shared/format.js';
import { t, tn } from '../../shared/i18n.js';
import { TON_CHAINS, tonAccount } from '../../shared/ton/api.js';
import { emulateMessages, showAddress } from '../../shared/ton/contracts.js';
import { sameSite } from '../../shared/ton/tonconnect.js';
import { useTonAccounts } from './hooks.js';

const FEE_MARGIN = 20_000_000n; // 0.02 GRAM for the wallet's own fees when the emulation can't say
const hostOf = (url) => { try { return new URL(url).host; } catch { return ''; } };

/** Name and icon the dapp gives in its manifest, with the address it declares. */
function DappLine({ manifest }) {
  const [icon, setIcon] = useState(!!manifest?.iconUrl);
  if (!manifest) return null;
  return (
    <div class="row small" style={{ gap: '.5rem' }}>
      {icon && <img src={manifest.iconUrl} alt="" onError={() => setIcon(false)} style={{ width: '1.5rem', height: '1.5rem', borderRadius: '.375rem' }} />}
      <span class="bold ellipsis">{manifest.name}</span>
      <span class="muted ellipsis">{manifest.host}</span>
    </div>
  );
}

/**
 * Through the bridge (QR code or link) Chakra can't see the page: the site is only what the dapp declares in its
 * manifest. On the connection screen it says so (warn).
 */
function RemoteSite({ manifest, warn }) {
  const [icon, setIcon] = useState(!!manifest?.iconUrl);
  return (
    <>
      <div class="site">
        {icon ? <img src={manifest.iconUrl} alt="" onError={() => setIcon(false)} /> : <div class="fav" />}
        <div class="grow" style={{ minWidth: 0 }}>
          <div class="bold ellipsis">{manifest?.host}</div>
          <div class="tiny muted ellipsis">{manifest?.name}</div>
        </div>
        <span class="badge">{t('tonconnect.remote.badge')}</span>
      </div>
      {warn && <div class="warn small">{t('tonconnect.remote.unverified', { host: manifest?.host })}</div>}
    </>
  );
}
/** The site of a request: the page (in-app browser) or what the dapp declares (bridge). */
const SiteOf = ({ req }) => (req.params.remote ? <RemoteSite manifest={req.params.manifest} /> : <Site req={req} />);

/** The account of the session, with its TON address. */
function TonAccountLine({ account, address, network }) {
  const { state } = useApp();
  const acc = state.accounts.find((a) => a.address === account);
  const shown = showAddress(address, { testnet: network === '-3', wallet: true });
  return <div class="row small"><Avatar address={account} /><span class="bold">{acc?.name || t('approve.account')}</span><span class="muted mono">{shortAddr(shown, 6)}</span></div>;
}

// ------------------------------------------------------------------ connect (and sign-in)
function TonConnect({ req, done }) {
  const { state } = useApp();
  const map = useTonAccounts();
  const { manifest, network, proof, domain, current, remote } = req.params;
  const testnet = network === '-3';
  const accounts = map ? state.accounts.filter((a) => map[a.address]) : [];
  const [sel, setSel] = useState(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (!map || sel) return;
    const pick = accounts.find((a) => a.address === current) || accounts.find((a) => a.address === state.selected) || accounts[0];
    if (pick) setSel(pick.address);
  }, [!!map]);
  const mismatch = !remote && !sameSite(manifest.host, domain);
  const go = async () => { setBusy(true); await done(true, { account: sel }); setBusy(false); };

  return (
    <>
      <div class="content">
        {remote ? <RemoteSite manifest={manifest} warn /> : <><Site req={req} /><DappLine manifest={manifest} /></>}
        <h3 style={{ margin: '0.25rem 0 0' }}>{proof ? t('tonconnect.connect.titleProof') : t('tonconnect.connect.title')}</h3>
        {mismatch && <div class="warn small">{t('tonconnect.connect.mismatch', { name: manifest.name, host: manifest.host, site: domain })}</div>}
        {testnet && <div class="warn small">{t('tonconnect.connect.testnet')}</div>}
        {!map && <Loading text={t('tonconnect.connect.loading')} />}
        {map && !accounts.length && <div class="error small">{t('tonconnect.connect.noTon')}</div>}
        {accounts.length > 0 && (
          <>
            <div class="small muted">{t('tonconnect.connect.choose')}</div>
            <div class="card" style={{ padding: '0.375rem' }}>
              {accounts.map((a) => {
                const w = map[a.address][testnet ? 'testnet' : 'mainnet'];
                return (
                  <label class="item" style={{ cursor: 'pointer' }}>
                    <input type="radio" name="tonacc" checked={sel === a.address} onChange={() => setSel(a.address)} />
                    <Avatar address={a.address} />
                    <div class="grow"><div class="bold">{a.name}</div><div class="small muted mono">{shortAddr(w.friendly, 6)}</div></div>
                  </label>
                );
              })}
            </div>
          </>
        )}
        {proof && <div class="info small">{t('tonconnect.connect.proofInfo', { domain })}</div>}
        <div class="info small">{t('tonconnect.connect.info')}</div>
      </div>
      <div class="footer">
        <Btn kind="secondary" onClick={() => done(false)}>{t('approve.reject')}</Btn>
        <Btn loading={busy} disabled={!sel} onClick={go}>{proof ? t('tonconnect.connect.signIn') : t('tonconnect.connect.button')}</Btn>
      </div>
    </>
  );
}

// ------------------------------------------------------------------ sendTransaction
/** Text comment of a message body (op 0), or null. */
function commentOf(body) {
  try {
    const s = Cell.fromBase64(body).beginParse();
    if (s.remainingBits < 32 || s.loadUint(32) !== 0 || s.remainingBits % 8) return null;
    return s.loadStringTail();
  } catch { return null; }
}

function TonTx({ req, done }) {
  const { setPortfolioCache } = useApp();
  const { account, network, address, publicKey, version, messages, manifest } = req.params;
  const chain = TON_CHAINS[network];
  const [sim, setSim] = useState(null);
  const [simErr, setSimErr] = useState('');
  const [plainBalance, setPlainBalance] = useState(null);
  const [ack, setAck] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    emulateMessages(chain, { publicKey, version }, messages).then(setSim).catch((e) => {
      setSimErr(e.message || 'emulation');
      tonAccount(chain, showAddress(address, { testnet: chain.testnet, wallet: true })).then((a) => setPlainBalance(a.balance)).catch(() => {});
    });
  }, []);

  const total = messages.reduce((s, m) => s + BigInt(m.value), 0n);
  const cost = sim && sim.net < 0n ? -sim.net : total + FEE_MARGIN;
  const balance = sim ? sim.balance : plainBalance;
  const insufficient = balance != null && balance < total + FEE_MARGIN;
  const drain = !!sim?.risk?.transfer_all_remaining_balance;
  const big = !!sim && sim.balance > 0n && total * 2n > sim.balance;
  const simFailed = !!sim && !sim.ok;
  // what can leave the wallet, as the emulation sees it (GRAM, jettons, NFTs)
  const leaving = [];
  const r = sim?.risk;
  if (r) {
    if (BigInt(r.ton || 0) > 0n) leaving.push(`${fmtAmount(BigInt(r.ton), 9, 6)} ${chain.native.symbol}`);
    for (const j of r.jettons || []) leaving.push(`${fmtAmount(BigInt(j.quantity || 0), j.jetton?.decimals ?? 9, 6)} ${j.jetton?.symbol || 'jetton'}`);
    if (r.nfts?.length) leaving.push(tn('tonconnect.tx.nfts', r.nfts.length));
  }

  const confirm = async () => {
    setBusy(true);
    // the home reloads this network's balances next time (shared cache, same key as usePortfolio)
    setPortfolioCache((c) => { const n = { ...c }; delete n[`${chain.id}:${account}`]; return n; });
    await done(true);
    setBusy(false);
  };

  return (
    <>
      <div class="content">
        <SiteOf req={req} />
        <h3 style={{ margin: '0.25rem 0 0' }}>{t('tonconnect.tx.title', { name: manifest?.name || hostOf(req.origin) })}</h3>
        <TonAccountLine account={account} address={address} network={network} />
        {leaving.length > 0 && (
          <div class="card col" style={{ gap: '.25rem' }}>
            <span class="small muted">{t('tonconnect.tx.leaving')}</span>
            {leaving.map((x) => <b>{x}</b>)}
          </div>
        )}
        <div class="card kv">
          <span class="k">{t('approve.network')}</span><span class="v"><span class="row" style={{ justifyContent: 'flex-end', gap: '.375rem' }}><ChainIcon chain={chain} size={18} />{chain.name}</span></span>
          <span class="k">{t('tonc.review.attached')}</span><span class="v bold">{fmtAmount(total, 9, 6)} {chain.native.symbol}</span>
          {messages.length > 1 && <><span class="k">{t('tonc.review.messages')}</span><span class="v">{messages.length}</span></>}
          {sim && <><span class="k">{t('tonc.review.cost')}</span><span class="v">≈ {fmtAmount(cost, 9, 6)} {chain.native.symbol}</span></>}
          {balance != null && <><span class="k">{t('tonc.balance')}</span><span class="v">{fmtAmount(balance, 9, 4)} {chain.native.symbol}</span></>}
        </div>
        {sim && <div class="tiny muted">{t('tonc.review.costHint')}</div>}
        <div class="card col" style={{ gap: '.5rem' }}>
          {messages.map((m, i) => {
            const comment = m.body ? commentOf(m.body) : null;
            return (
              <div class="col" style={{ gap: '.125rem' }}>
                <span class="tiny muted">{messages.length > 1 ? t('tonconnect.tx.message', { n: i + 1 }) : t('approve.to')}</span>
                <span class="small mono" style={{ wordBreak: 'break-all' }}>{m.to}</span>
                <span class="small"><b>{fmtAmount(BigInt(m.value), 9, 6)} {chain.native.symbol}</b>
                  {m.init ? ` · ${t('tonconnect.tx.deploy')}` : ''}{m.body && comment == null ? ` · ${t('tonconnect.tx.call')}` : ''}</span>
                {comment != null && <span class="tiny">{t('tonconnect.tx.comment')}: <span class="mono">{comment}</span></span>}
              </div>
            );
          })}
        </div>
        {drain && <div class="error"><b>{t('common.attention')}</b> {t('tonc.risk.drain')}</div>}
        {big && !drain && <div class="warn"><b>{t('common.attention')}</b> {t('tonc.risk.bigValue')}</div>}
        {!sim && !simErr && <Loading text={t('tonc.review.emulating')} />}
        {simErr && <div class="warn col" style={{ gap: '.25rem' }}>{t('tonc.review.simUnavailable')}<span class="tiny" style={{ opacity: 0.8 }}>{t('tonc.review.simReason', { reason: simErr })}</span></div>}
        {sim && (
          <div class="card col">
            <div class={sim.bounced ? 'warn' : sim.ok ? 'success' : 'error'}>{sim.bounced ? t('tonc.review.simBounced') : sim.ok ? t('tonc.review.simOk') : t('tonc.review.simFailed')}</div>
            <StepsView steps={sim.steps} wallet={sim.wallet} chain={chain} />
          </div>
        )}
        {insufficient && <div class="error">{t('send.insufficientNative', { symbol: chain.native.symbol })}</div>}
        {simFailed && <label class="ack row small"><input type="checkbox" checked={ack} onChange={(e) => setAck(e.target.checked)} /> {t('contracts.tx.sendAnyway')}</label>}
      </div>
      <div class="footer">
        <Btn kind="secondary" onClick={() => done(false)}>{t('approve.reject')}</Btn>
        <Btn kind={simFailed || drain ? 'danger' : 'primary'} loading={busy}
          disabled={(!sim && !simErr) || insufficient || (simFailed && !ack)} onClick={confirm}>{t('common.confirm')}</Btn>
      </div>
    </>
  );
}

// ------------------------------------------------------------------ signData
function TonSignData({ req, done }) {
  const { account, network, address, manifest, domain, payload } = req.params;
  const readable = payload.type === 'text';
  const [ack, setAck] = useState(false);
  const [busy, setBusy] = useState(false);
  const go = async () => { setBusy(true); await done(true); setBusy(false); };
  const bytes = payload.type === 'binary' ? Math.floor((payload.bytes.replace(/=+$/, '').length * 3) / 4) : 0;

  return (
    <>
      <div class="content">
        <SiteOf req={req} />
        <h3 style={{ margin: '0.25rem 0 0' }}>{t('tonconnect.sign.title', { name: manifest?.name || domain })}</h3>
        <TonAccountLine account={account} address={address} network={network} />
        {readable ? (
          <div class="col" style={{ gap: '.25rem' }}>
            <span class="small muted">{t('tonconnect.sign.text')}</span>
            <pre class="data mono">{payload.text}</pre>
          </div>
        ) : (
          <>
            <div class={payload.type === 'cell' ? 'error small' : 'warn small'}>
              {t('tonconnect.sign.unreadable')}{payload.type === 'cell' ? ` ${t('tonconnect.sign.cellWarn')}` : ''}
            </div>
            <details>
              <summary class="small muted" style={{ cursor: 'pointer' }}>{payload.type === 'cell' ? t('tonconnect.sign.schema') : tn('tonconnect.sign.bytes', bytes)}</summary>
              <pre class="data mono">{payload.type === 'cell' ? `${payload.schema}\n\n${payload.cell}` : payload.bytes}</pre>
            </details>
          </>
        )}
        <div class="card kv">
          <span class="k">{t('tonconnect.sign.domain')}</span><span class="v">{domain}</span>
          <span class="k">{t('approve.network')}</span><span class="v">{TON_CHAINS[network]?.name}</span>
        </div>
        <div class="info small">{t('tonconnect.sign.info')}</div>
        {!readable && <label class="ack row small"><input type="checkbox" checked={ack} onChange={(e) => setAck(e.target.checked)} /> {t('tonconnect.sign.ack')}</label>}
      </div>
      <div class="footer">
        <Btn kind="secondary" onClick={() => done(false)}>{t('approve.reject')}</Btn>
        <Btn kind={readable ? 'primary' : 'danger'} loading={busy} disabled={!readable && !ack} onClick={go}>{t('tonconnect.sign.button')}</Btn>
      </div>
    </>
  );
}

/** For screens/approve.jsx (registerApprovalViews); authTitle: the same requests the background asks a password for. */
export const tonApprovalViews = {
  tonConnect: { View: TonConnect, authTitle: (req) => (req.params.proof ? 'tonconnect.auth.proof' : null) },
  tonTx: { View: TonTx, authTitle: () => 'approve.auth.tx', sentToast: true },
  tonSignData: { View: TonSignData, authTitle: () => 'approve.auth.sign' },
};
