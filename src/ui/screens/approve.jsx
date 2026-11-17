import { useEffect, useState } from 'preact/hooks';
import { Interface, MaxUint256, formatUnits } from 'ethers';
import { bg, ext } from '../../shared/ext.js';
import { getChain } from '../../shared/chains.js';
import { isEvmAccount } from '../chains/index.js';
import { getTokenInfo } from '../../shared/rpc.js';
import { prepareTx, finalizeTx } from '../../shared/tx.js';
import { fmtAmount, shortAddr, hexToUtf8, toFloat, fmtUsd } from '../../shared/format.js';
import { TopBar, Btn, Avatar, Icon, Spinner, FeeBox, TokenIcon, ChainIcon, useApp, Empty, rich } from '../components.jsx';
import { useNativePrice } from '../hooks.js';
import { useSiteIcon } from '../siteIcons.js';
import { useRecipientCheck, PoisonWarning } from '../poisonCheck.jsx';
import { t, tn } from '../../shared/i18n.js';

// must match AUTH_KINDS in the background: these need fingerprint or password
const AUTH_TITLES = { sign: 'approve.auth.sign', ethSign: 'approve.auth.sign', typed: 'approve.auth.sign', tx: 'approve.auth.tx' }; // i18n keys

// Requests of other families (TON Connect in the Android app: src/ui/ton/approvals.jsx), registered by their module:
// kind -> { View, authTitle(req) -> i18n key when it needs fingerprint or password (as the background's auth), sentToast }
const EXTRA = {};
export function registerApprovalViews(views) { Object.assign(EXTRA, views); }
const authTitle = (req) => AUTH_TITLES[req.kind] || EXTRA[req.kind]?.authTitle?.(req) || null;

const KNOWN = new Interface([
  'function approve(address spender, uint256 amount)',
  'function transfer(address to, uint256 amount)',
  'function transferFrom(address from, address to, uint256 amount)',
  'function setApprovalForAll(address operator, bool approved)',
  'function increaseAllowance(address spender, uint256 addedValue)',
]);

export function Site({ req }) {
  const host = req.origin.replace(/^https?:\/\//, '');
  const hd = useSiteIcon(req.origin); // HD icon from the site's metadata (in-app browser only)
  const icon = hd || req.favicon;
  return (
    <div class="site">
      {icon ? <img src={icon} alt="" /> : <div class="fav" />}
      <div class="grow" style={{ minWidth: 0 }}>
        <div class="bold ellipsis">{host}</div>
        <div class="tiny muted ellipsis">{req.title || req.origin}</div>
      </div>
      {!req.origin.startsWith('https://') && <span class="badge red">{t('approve.insecure')}</span>}
    </div>
  );
}

function AccountLine({ address }) {
  const { state } = useApp();
  const acc = state.accounts.find((a) => a.address.toLowerCase() === address.toLowerCase());
  return <div class="row small"><Avatar address={address} /><span class="bold">{acc?.name || t('approve.account')}</span><span class="muted">{shortAddr(address)}</span></div>;
}

// ------------------------------------------------------------------ connect
function Connect({ req, done }) {
  const { state } = useApp();
  // the selected account by default, unless it is a TON-only account (sites use Ethereum accounts)
  const [sel, setSel] = useState(() => { const evm = state.accounts.filter(isEvmAccount); return [(evm.find((a) => a.address === state.selected) || evm[0])?.address].filter(Boolean); });
  const toggle = (a) => setSel(sel.includes(a) ? sel.filter((x) => x !== a) : [...sel, a]);
  return (
    <>
      <div class="content">
        <Site req={req} />
        <h3 style={{ margin: '0.25rem 0 0' }}>{t('approve.connect.title')}</h3>
        <div class="small muted">{t('approve.connect.choose')}</div>
        <div class="card" style={{ padding: '0.375rem' }}>
          {state.accounts.filter(isEvmAccount).map((a) => ( // sites use Ethereum accounts
            <label class="item" style={{ cursor: 'pointer' }}>
              <input type="checkbox" checked={sel.includes(a.address)} onChange={() => toggle(a.address)} />
              <Avatar address={a.address} />
              <div class="grow"><div class="bold">{a.name}</div><div class="small muted">{shortAddr(a.address)}</div></div>
            </label>
          ))}
        </div>
        <div class="info small">{rich('approve.connect.info')}</div>
      </div>
      <div class="footer">
        <Btn kind="secondary" onClick={() => done(false)}>{t('approve.reject')}</Btn>
        <Btn disabled={!sel.length} onClick={() => done(true, { accounts: sel })}>{t('approve.connect.button')}</Btn>
      </div>
    </>
  );
}

// ------------------------------------------------------------------ personal_sign
function SignMessage({ req, done }) {
  const [message, address] = req.params;
  const text = /^0x/i.test(message) ? hexToUtf8(message) : message;
  const siwe = text && /wants you to sign in with your Ethereum account/i.test(text);
  const siweDomain = siwe ? text.split(' ')[0] : null;
  const host = new URL(req.origin).host;
  return (
    <>
      <div class="content">
        <Site req={req} />
        <h3 style={{ margin: '0.25rem 0 0' }}>{siwe ? t('approve.sign.siweTitle') : t('approve.sign.title')}</h3>
        <AccountLine address={address} />
        {siwe && siweDomain !== host && <div class="error small"><b>{t('common.attention')}</b> {t('approve.sign.siweMismatch', { domain: siweDomain, host })}</div>}
        <div class="info small">{rich('approve.sign.free')}</div>
        <div class="section-title">{t('approve.sign.message')}</div>
        <pre class="data">{text ?? message}</pre>
        {text == null && <div class="warn small">{t('approve.sign.unreadable')}</div>}
      </div>
      <div class="footer">
        <Btn kind="secondary" onClick={() => done(false)}>{t('approve.reject')}</Btn>
        <Btn onClick={() => done(true)}>{t('approve.sign.button')}</Btn>
      </div>
    </>
  );
}

// ------------------------------------------------------------------ eth_sign (raw hash)
function EthSign({ req, done }) {
  const [address, hash] = req.params;
  const [ack, setAck] = useState(false);
  return (
    <>
      <div class="content">
        <Site req={req} />
        <div class="error" style={{ fontSize: '0.875rem' }}>
          <div class="row bold" style={{ fontSize: '1rem', marginBottom: '0.375rem' }}><Icon name="warn" /> {t('approve.ethSign.title')}</div>
          {rich('approve.ethSign.body')}
        </div>
        <AccountLine address={address} />
        <div class="section-title">{t('approve.ethSign.hash')}</div>
        <pre class="data">{hash}</pre>
        <div class="warn small">{t('approve.ethSign.warn')}</div>
        <label class="card flat row" style={{ cursor: 'pointer', borderColor: ack ? 'var(--red)' : undefined }}>
          <input type="checkbox" checked={ack} onChange={(e) => setAck(e.target.checked)} />
          <span class="small">{rich('approve.ethSign.ack', { site: req.origin.replace(/^https?:\/\//, '') })}</span>
        </label>
      </div>
      <div class="footer">
        <Btn onClick={() => done(false)}>{t('approve.reject')}</Btn>
        <Btn kind="danger" disabled={!ack} onClick={() => done(true, { acknowledged: true })}>{t('approve.ethSign.button')}</Btn>
      </div>
    </>
  );
}

// ------------------------------------------------------------------ typed data
function Tree({ value, depth = 0 }) {
  if (value === null || typeof value !== 'object') return <span class="mono">{String(value)}</span>;
  return (
    <div style={{ paddingLeft: depth ? '0.625rem' : 0, borderLeft: depth ? '2px solid var(--border)' : 0 }}>
      {Object.entries(value).map(([k, v]) => (
        <div style={{ margin: '0.1875rem 0' }}>
          <span class="small muted">{k}: </span>
          {typeof v === 'object' && v !== null ? <Tree value={v} depth={depth + 1} /> : <span class="mono">{String(v)}</span>}
        </div>
      ))}
    </div>
  );
}

function SignTyped({ req, done }) {
  const { chain } = useApp();
  const [address, typed] = req.params;
  const pt = typed.primaryType || '';
  const isPermit = /permit/i.test(pt);
  const m = typed.message || {};
  const spender = m.spender || m.details?.spender || m.permitted?.spender;
  const rawAmt = m.value ?? m.amount ?? m.details?.amount ?? m.permitted?.amount;
  const unlimited = rawAmt !== undefined && BigInt(String(rawAmt)) >= MaxUint256 / 2n;
  const [tok, setTok] = useState(null);
  const tokenAddr = isPermit ? (m.details?.token || m.permitted?.token || typed.domain?.verifyingContract) : null;
  useEffect(() => { if (tokenAddr) getTokenInfo(chain, tokenAddr).then(setTok).catch(() => {}); }, [tokenAddr]);
  return (
    <>
      <div class="content">
        <Site req={req} />
        <h3 style={{ margin: '0.25rem 0 0' }}>{isPermit ? t('approve.typed.permitTitle') : t('approve.typed.title')}</h3>
        <AccountLine address={address} />
        {isPermit ? (
          <div class="error small">
            {rich(tok ? 'approve.typed.permitSpendToken' : 'approve.typed.permitSpend', { spender: spender ? shortAddr(spender) : t('approve.typed.anAddress'), symbol: tok?.symbol })}
            {rawAmt !== undefined && <> {rich('approve.typed.amount', { amount: unlimited ? t('approve.unlimited') : tok ? `${formatUnits(BigInt(String(rawAmt)), tok.decimals)} ${tok.symbol}` : String(rawAmt) })}</>}. {t('approve.typed.permitRisk')}
          </div>
        ) : (
          <div class="info small">{t('approve.typed.free')}</div>
        )}
        <div class="card kv small">
          {typed.domain?.name && <><span class="k">{t('approve.app')}</span><span class="v">{typed.domain.name}</span></>}
          {typed.domain?.chainId !== undefined && <><span class="k">{t('approve.network')}</span><span class="v">{getChain(Number(typed.domain.chainId))?.name || typed.domain.chainId}</span></>}
          {typed.domain?.verifyingContract && <><span class="k">{t('approve.contract')}</span><span class="v mono">{shortAddr(typed.domain.verifyingContract, 6)}</span></>}
          <span class="k">{t('approve.type')}</span><span class="v">{pt}</span>
        </div>
        <div class="section-title">{t('approve.content')}</div>
        <div class="card small" style={{ maxHeight: '13.75rem', overflow: 'auto' }}><Tree value={m} /></div>
      </div>
      <div class="footer">
        <Btn kind="secondary" onClick={() => done(false)}>{t('approve.reject')}</Btn>
        <Btn kind={isPermit ? 'danger' : 'primary'} onClick={() => done(true)}>{t('approve.sign.button')}</Btn>
      </div>
    </>
  );
}

// ------------------------------------------------------------------ transaction
function TxRequest({ req, done }) {
  const { chain } = useApp();
  const [tx] = req.params;
  const nativePrice = useNativePrice(chain);
  const [prepared, setPrepared] = useState(null);
  const [speed, setSpeed] = useState('normal');
  const [err, setErr] = useState('');
  const [decoded, setDecoded] = useState(null);
  const [tok, setTok] = useState(null);
  const [busy, setBusy] = useState(false);
  const data = tx.data || tx.input || '0x';
  const value = BigInt(tx.value || 0);
  // who receives the funds: the decoded transfer() recipient, or the address of a plain native send
  const [payee, setPayee] = useState(data === '0x' && value > 0n ? tx.to : '');
  const payeeCheck = useRecipientCheck(payee);
  const [ack, setAck] = useState(false);

  useEffect(() => {
    prepareTx(chain, tx.from, { to: tx.to, value: tx.value, data, gas: tx.gas || tx.gasLimit }).then(setPrepared).catch((e) => setErr(e.message));
    if (data.length >= 10 && tx.to) {
      try {
        const d = KNOWN.parseTransaction({ data });
        setDecoded(d);
        if (d?.name === 'transfer') setPayee(d.args[0]);
        if (d) getTokenInfo(chain, tx.to).then(setTok).catch(() => {});
      } catch { /* unknown method */ }
    }
  }, []);

  let titleText = data === '0x' ? t('approve.tx.send', { symbol: chain.native.symbol }) : t('approve.tx.contract');
  let detail = null;
  if (decoded) {
    const n = decoded.name, a = decoded.args;
    const amt = (v) => (tok ? (BigInt(v) >= MaxUint256 / 2n ? t('approve.unlimited') : `${fmtAmount(v, tok.decimals)} ${tok.symbol}`) : String(v));
    if (n === 'approve' || n === 'increaseAllowance') {
      titleText = t('approve.tx.approveTitle', { symbol: tok?.symbol || t('approve.tx.token') });
      const unl = BigInt(a[1]) >= MaxUint256 / 2n;
      detail = <div class={unl ? 'error small' : 'warn small'}>{rich('approve.tx.approveDetail', { spender: shortAddr(a[0], 6), amount: amt(a[1]) })}{unl && ` ${t('approve.tx.unlimitedRisk')}`}</div>;
    } else if (n === 'transfer') {
      titleText = t('approve.tx.send', { symbol: tok?.symbol || t('approve.tx.token') });
      detail = <div class="info small">{rich('approve.tx.sendDetail', { amount: amt(a[1]), to: shortAddr(a[0], 6) })}</div>;
    } else if (n === 'transferFrom') {
      titleText = t('approve.tx.transferTitle', { symbol: tok?.symbol || t('approve.tx.token') });
      detail = <div class="info small">{rich('approve.tx.transferDetail', { amount: amt(a[2]), from: shortAddr(a[0]), to: shortAddr(a[1]) })}</div>;
    } else if (n === 'setApprovalForAll') {
      titleText = a[1] ? t('approve.tx.nftAll') : t('approve.tx.nftRevoke');
      detail = a[1] ? <div class="error small">{rich('approve.tx.nftAllDetail', { operator: shortAddr(a[0], 6) })}</div> : null;
    }
  }

  const approve = async () => {
    setBusy(true);
    await done(true, { tx: finalizeTx(prepared, speed), title: titleText });
    setBusy(false);
  };

  return (
    <>
      <div class="content">
        <Site req={req} />
        <h3 style={{ margin: '0.25rem 0 0' }}>{titleText}</h3>
        <AccountLine address={tx.from} />
        {detail}
        <PoisonWarning check={payeeCheck} to={payee || ''} ack={ack} setAck={setAck} />
        <div class="card kv">
          <span class="k">{t('approve.network')}</span><span class="v">{chain.name}</span>
          <span class="k">{t('approve.to')}</span><span class="v mono">{tx.to ? shortAddr(tx.to, 8) : t('approve.newContract')}</span>
          <span class="k">{t('approve.amount')}</span><span class="v bold">{fmtAmount(value, chain.native.decimals, 8)} {chain.native.symbol}{nativePrice != null && value > 0n && <div class="tiny muted">{fmtUsd(toFloat(value) * nativePrice)}</div>}</span>
          {decoded && <><span class="k">{t('approve.function')}</span><span class="v">{decoded.name}</span></>}
          {!decoded && data !== '0x' && <><span class="k">{t('approve.function')}</span><span class="v mono">{data.slice(0, 10)}</span></>}
        </div>
        <FeeBox chain={chain} prepared={prepared} speed={speed} setSpeed={setSpeed} nativePrice={nativePrice} valueWei={value} />
        {data !== '0x' && (
          <details>
            <summary class="small muted" style={{ cursor: 'pointer' }}>{tn('approve.rawData', (data.length - 2) / 2)}</summary>
            <pre class="data">{data}</pre>
          </details>
        )}
        {err && <div class="error">{err}</div>}
      </div>
      <div class="footer">
        <Btn kind="secondary" onClick={() => done(false)}>{t('approve.reject')}</Btn>
        <Btn kind={payeeCheck.risky ? 'danger' : 'primary'} loading={busy} disabled={!prepared || (payeeCheck.risky && !ack)} onClick={approve}>{t('common.confirm')}</Btn>
      </div>
    </>
  );
}

// ------------------------------------------------------------------ chain / asset
function SwitchChain({ req, done }) {
  const { state } = useApp();
  const to = getChain(req.params.chainId, state.customChains);
  const from = getChain(req.params.from, state.customChains);
  return (
    <>
      <div class="content">
        <Site req={req} />
        <h3 style={{ margin: '0.25rem 0 0' }}>{req.params.enable ? t('approve.switch.enableTitle', { name: to?.name }) : t('approve.switch.title')}</h3>
        <div class="card row between">
          <div class="col center" style={{ alignItems: 'center' }}><ChainIcon chain={from} /><span class="small">{from?.name}</span></div>
          <Icon name="send" />
          <div class="col center" style={{ alignItems: 'center' }}><ChainIcon chain={to} /><span class="small bold">{to?.name}</span></div>
        </div>
        {req.params.enable && <div class="info small">{t('approve.switch.enableNote', { name: to?.name })}</div>}
        <div class="small muted">{t('approve.switch.note')}</div>
      </div>
      <div class="footer"><Btn kind="secondary" onClick={() => done(false)}>{t('common.cancel')}</Btn><Btn onClick={() => done(true)}>{req.params.enable ? t('approve.switch.enableButton') : t('approve.switch.button')}</Btn></div>
    </>
  );
}

function AddChain({ req, done }) {
  const c = req.params.chain;
  return (
    <>
      <div class="content">
        <Site req={req} />
        <h3 style={{ margin: '0.25rem 0 0' }}>{t('approve.addChain.title')}</h3>
        <div class="warn small">{t('approve.addChain.warn')}</div>
        <div class="card kv">
          <span class="k">{t('common.name')}</span><span class="v">{c.name}</span>
          <span class="k">{t('approve.chainId')}</span><span class="v">{c.id}</span>
          <span class="k">{t('approve.currency')}</span><span class="v">{c.native.symbol}</span>
          <span class="k">RPC</span><span class="v mono">{c.rpc[0]}</span>
          {c.explorer && <><span class="k">{t('common.explorer')}</span><span class="v mono">{c.explorer}</span></>}
        </div>
      </div>
      <div class="footer"><Btn kind="secondary" onClick={() => done(false)}>{t('common.cancel')}</Btn><Btn onClick={() => done(true)}>{t('approve.addChain.button')}</Btn></div>
    </>
  );
}

function WatchAsset({ req, done }) {
  const tk = req.params.token;
  return (
    <>
      <div class="content">
        <Site req={req} />
        <h3 style={{ margin: '0.25rem 0 0' }}>{t('approve.watch.title')}</h3>
        <div class="card row"><TokenIcon symbol={tk.symbol} icon={tk.image} /><div><div class="bold">{tk.symbol}</div><div class="small muted mono">{tk.address}</div></div></div>
        <div class="small muted">{t('approve.watch.note')}</div>
      </div>
      <div class="footer"><Btn kind="secondary" onClick={() => done(false)}>{t('common.cancel')}</Btn><Btn onClick={() => done(true)}>{t('common.add')}</Btn></div>
    </>
  );
}

const VIEWS = { connect: Connect, sign: SignMessage, ethSign: EthSign, typed: SignTyped, tx: TxRequest, switchChain: SwitchChain, addChain: AddChain, watchAsset: WatchAsset };

export function Approvals({ standalone }) {
  const { state, back, toast, authorize } = useApp();
  const [list, setList] = useState(null);
  const [err, setErr] = useState('');

  const load = async (keepOpen = false) => {
    const l = await bg('listPending');
    // unlock requests are satisfied as soon as the wallet is unlocked
    for (const r of l.filter((x) => x.kind === 'unlock')) await bg('resolveApproval', { id: r.id, approved: true }).catch(() => {});
    const rest = l.filter((x) => x.kind !== 'unlock');
    setList(rest);
    // closes only if nothing arrived meanwhile (a site may ask again right after an answer)
    if (!rest.length && standalone && !keepOpen) {
      setTimeout(async () => {
        const now = await bg('listPending').catch(() => []);
        if (!now.some((x) => x.kind !== 'unlock')) window.close();
      }, 300);
    }
  };
  useEffect(() => { load(); }, [state.pending]);
  useEffect(() => {
    const onMsg = (m) => { if (m?.type === 'pendingChanged') load(); };
    ext.runtime.onMessage.addListener(onMsg);
    return () => ext.runtime.onMessage.removeListener(onMsg);
  }, []);

  if (!list) return <div class="screen" style={{ alignItems: 'center', justifyContent: 'center' }}><Spinner lg /></div>;
  const req = list[0];

  const done = async (approved, data) => {
    setErr('');
    let failed = false;
    try {
      const call = (extra) => bg('resolveApproval', { id: req.id, approved, data: { ...data, ...extra } });
      const title = approved && authTitle(req);
      if (title) await authorize((password) => call({ password }), t(title));
      else await call();
      if (approved && (req.kind === 'tx' || EXTRA[req.kind]?.sentToast)) toast(t('approve.txSent'));
    } catch (e) {
      if (e.cancelled) return;
      setErr(e.message); failed = true;
    }
    await load(failed);
    if (!standalone && list.length <= 1) back();
  };

  const V = req ? VIEWS[req.kind] || EXTRA[req.kind]?.View : null;
  return (
    <div class="screen">
      <TopBar title={list.length > 1 ? t('approve.requestOf', { total: list.length }) : t('approve.request')} onBack={standalone ? false : undefined}
        right={list.length > 1 && <button class="btn ghost sm" onClick={async () => { for (const r of list) await bg('resolveApproval', { id: r.id, approved: false }).catch(() => {}); load(); }}>{t('approve.rejectAll')}</button>} />
      {err && <div class="error" style={{ margin: '0.75rem 1rem 0' }}>{err}</div>}
      {!req && <div class="content"><Empty>{t('approve.none')}</Empty></div>}
      {V && <V key={req.id} req={req} done={done} />}
    </div>
  );
}
