// Bridge between TON and the EVM networks (Android app): GRAM through Relay, USD₮ (TON) through Symbiosis.
// Out of TON: TON messages signed like a send. Into TON: an EVM transaction (with an approval for the exact amount
// when the source is a token). Transfers go to the same list as the other bridges: tracked, notified on arrival.
import { useEffect, useRef, useState } from 'preact/hooks';
import { Icon, TokenIcon, ChainIcon, Btn, TopBar, Spinner, SuccessMark, FeeBox, useApp } from '../components.jsx';
import { NetworkSheet } from '../screens/home.jsx';
import { bg, local } from '../../shared/ext.js';
import { getChain, isChainEnabled, NATIVE } from '../../shared/chains.js';
import { POPULAR_TOKENS } from '../../shared/tokens.js';
import { rpc, ethCall, erc20, getAllowance, waitForReceipt } from '../../shared/rpc.js';
import { getNativePrice } from '../../shared/prices.js';
import { prepareTx, finalizeTx } from '../../shared/tx.js';
import { BRIDGE_CHAINS } from '../../shared/bridge.js';
import { fmtNum, fmtUsd, parseAmount, rawToInput, shortAddr } from '../../shared/format.js';
import { t } from '../../shared/i18n.js';
import { Buffer } from '../../shared/ton/buffer.js';
import { Address } from '../../shared/ton/core.js';
import { TON_CHAINS, tonWaitApplied } from '../../shared/ton/api.js';
import { TON_ASSETS, tonBridgeQuote } from '../../shared/ton/bridge.js';
import { useTonAccounts, useTonPortfolio, invalidateTon } from './hooks.js';
import { units } from './home.jsx';

const TON = TON_CHAINS[-239];
const STABLES = ['USDC', 'USDT', 'USD₮0', 'USDT0'];
const evmTokens = (c) => [{ address: NATIVE, symbol: c.native.symbol, decimals: c.native.decimals, native: true }, ...(POPULAR_TOKENS[c.id] || []).filter((x) => STABLES.includes(x.symbol))];
const minutes = (s) => (s == null ? '' : s < 60 ? t('bridge.time.sec', { n: Math.max(1, Math.round(s)) }) : t('bridge.time.min', { n: Math.round(s / 60) }));

export function TonBridge({ dir: initialDir }) {
  const { chain, account, state, authorize, reset } = useApp();
  const tonMap = useTonAccounts();
  const tonW = tonMap?.[account.address]?.mainnet || null;
  const evmAcc = account.type === 'ton' ? state.accounts.find((a) => a.type !== 'ton') : account;
  const usable = BRIDGE_CHAINS.map((id) => getChain(id)).filter((c) => c && isChainEnabled(c.id, state.settings));
  const [dir, setDir] = useState(initialDir || (chain.kind === 'ton' ? 'out' : 'in'));
  const [evmId, setEvmId] = useState(usable.some((c) => c.id === chain.id) ? chain.id : 8453);
  const evmChain = getChain(evmId);
  const [assetKey, setAssetKey] = useState('GRAM');
  const asset = TON_ASSETS[assetKey];
  const [evmTok, setEvmTok] = useState(() => evmTokens(evmChain)[0]);
  const [amount, setAmount] = useState('');
  const [evmBal, setEvmBal] = useState(null);
  const [quote, setQuote] = useState(null);
  const [quoting, setQuoting] = useState(false);
  const [sheet, setSheet] = useState(null);
  const [step, setStep] = useState('form');
  const [prepared, setPrepared] = useState(null);
  const [speed, setSpeed] = useState('normal');
  const [nativePrice, setNativePrice] = useState(null);
  const [busy, setBusy] = useState('');
  const [err, setErr] = useState('');
  const [sent, setSent] = useState(null);
  const authPw = useRef(null);
  const { data: tonData, reload: tonReload } = useTonPortfolio(TON, tonW?.raw);

  useEffect(() => { setEvmTok(evmTokens(evmChain)[0]); getNativePrice(evmChain).then(setNativePrice).catch(() => setNativePrice(null)); }, [evmId]);
  // source balance on the EVM side
  useEffect(() => {
    setEvmBal(null);
    if (dir !== 'in' || !evmAcc) return;
    const q = evmTok.native ? rpc(evmChain, 'eth_getBalance', [evmAcc.address, 'latest']) : ethCall(evmChain, evmTok.address, erc20.encodeFunctionData('balanceOf', [evmAcc.address]));
    q.then((b) => setEvmBal(BigInt(b))).catch(() => setEvmBal(0n));
  }, [dir, evmId, evmTok.address, evmAcc?.address]);

  const usdtJetton = tonData?.jettons.find((j) => { try { return Address.parse(j.master).equals(Address.parse(TON_ASSETS.USDT.master)); } catch { return false; } });
  const srcDecimals = dir === 'out' ? asset.decimals : evmTok.decimals;
  const dstDecimals = dir === 'out' ? evmTok.decimals : asset.decimals;
  const srcSymbol = dir === 'out' ? asset.symbol : evmTok.symbol, dstSymbol = dir === 'out' ? evmTok.symbol : asset.symbol;
  const balance = dir === 'out' ? (assetKey === 'GRAM' ? tonData?.gram.balance : usdtJetton?.balance ?? 0n) : evmBal;
  const raw = parseAmount(amount, srcDecimals);
  const tooMuch = raw != null && balance != null && raw > balance;

  const params = () => ({ dir, evmChain, evmToken: evmTok, tonAsset: asset, amount: raw.toString(), evmAddress: evmAcc.address, tonAddress: tonW.friendly });
  const reqId = useRef(0);
  const fetchQuote = async () => {
    setQuote(null); setErr('');
    if (!raw || raw <= 0n || tooMuch || !tonW || !evmAcc) return;
    const id = ++reqId.current;
    setQuoting(true);
    try { const q = await tonBridgeQuote(params()); if (id === reqId.current) setQuote(q); } catch (e) { if (id === reqId.current) setErr(e.message); }
    if (id === reqId.current) setQuoting(false);
  };
  useEffect(() => {
    if (step !== 'form') return undefined;
    const tm = setTimeout(fetchQuote, 700);
    const iv = setInterval(() => { if (!document.hidden) fetchQuote(); }, 30000);
    return () => { clearTimeout(tm); clearInterval(iv); };
  }, [amount, dir, evmId, evmTok.address, assetKey, step, !!tonW]);

  const sendEvm = (p, keep) => {
    const go = (password) => bg('sendTransaction', { ...p, password });
    if (authPw.current) { const pw = authPw.current; if (!keep) authPw.current = null; return go(pw); }
    return authorize(async (password) => { const h = await go(password); if (keep) authPw.current = password; return h; }, t('bridge.confirmTitle'));
  };
  const title = () => t('bridge.txTitle', { amount: fmtNum(units(raw, srcDecimals)), symbol: srcSymbol, from: dir === 'out' ? TON.name : evmChain.name, to: dir === 'out' ? evmChain.name : TON.name, provider: quote?.provider });

  const save = async (q, txHash) => {
    const entry = {
      id: txHash, txHash, provider: q.provider, tool: q.provider, ref: q.ref, created: Date.now(), status: 'pending',
      fromChainId: dir === 'out' ? TON.id : evmId, toChainId: dir === 'out' ? evmId : TON.id,
      from: dir === 'out' ? account.address : evmAcc.address, to: dir === 'out' ? evmAcc.address : tonW.friendly,
      fromToken: { symbol: srcSymbol, decimals: srcDecimals }, toToken: { symbol: dstSymbol, decimals: dstDecimals },
      amountIn: raw.toString(), amountOut: q.amountOut, durationSec: q.durationSec,
    };
    await local.update('bridges', [], (l) => [entry, ...l].slice(0, 50));
    return entry;
  };

  const proceed = async () => {
    setErr('');
    try {
      let q = quote;
      if (q.exec.kind === 'ton') {
        const need = q.exec.messages.reduce((s, m) => s + BigInt(m.value), 0n) + 30_000_000n;
        if (need > (tonData?.gram.balance ?? 0n)) throw new Error(t('ton.swap.needGram', { amount: fmtNum(units(need, 9), 3), symbol: 'GRAM' }));
        setBusy(t('bridge.busy.sending'));
        const r = await authorize((password) => bg('tonSend', { from: account.address, chainId: TON.id, messages: q.exec.messages, mode: q.exec.mode, password }), t('bridge.confirmTitle'));
        const hex = Buffer.from(r.hash, 'base64').toString('hex');
        const entry = await save(q, hex);
        invalidateTon(TON.id, tonW.raw);
        setSent(entry); setStep('done');
        tonWaitApplied(TON, r.wallet, r.seqno, { hash: r.hash }).then((x) => {
          tonReload();
          if (x.txHash) local.update('bridges', [], (l) => l.map((b) => (b.id === entry.id ? { ...b, txHash: x.txHash } : b)));
        }).catch(() => {});
      } else {
        if (q.exec.spender && !evmTok.native) {
          setBusy(t('bridge.busy.checkingApproval'));
          if ((await getAllowance(evmChain, evmTok.address, evmAcc.address, q.exec.spender)) < raw) {
            setBusy(t('bridge.busy.approving'));
            const p = await prepareTx(evmChain, evmAcc.address, { to: evmTok.address, data: erc20.encodeFunctionData('approve', [q.exec.spender, raw]), value: '0x0' });
            const h = await sendEvm({ from: evmAcc.address, tx: finalizeTx(p, 'normal'), title: t('bridge.approvalTitle', { symbol: evmTok.symbol }) }, true);
            setBusy(t('bridge.busy.waitingApproval'));
            if ((await waitForReceipt(evmChain, h)).status !== '0x1') throw new Error(t('bridge.approvalFailed'));
            setBusy(t('bridge.busy.requoting'));
            q = await tonBridgeQuote(params()); // quotes expire
          }
        }
        setBusy(t('bridge.busy.preparing'));
        setPrepared({ ...(await prepareTx(evmChain, evmAcc.address, q.exec.tx)), quote: q });
        setStep('confirm');
      }
    } catch (e) { if (!e.cancelled) setErr(e.message); authPw.current = null; }
    setBusy('');
  };

  const sendConfirmed = async () => {
    setErr(''); setBusy(t('bridge.busy.sending'));
    try {
      const h = await sendEvm({ from: evmAcc.address, tx: finalizeTx(prepared, speed), title: title() }, false);
      setSent(await save(prepared.quote, h)); setStep('done');
    } catch (e) { if (!e.cancelled) setErr(e.message); }
    setBusy('');
  };

  if (!tonMap) return <div class="screen"><TopBar title={t('ton.bridge.title')} /><div class="content" style={{ alignItems: 'center' }}><Spinner lg /></div></div>;
  if (!tonW) return <div class="screen"><TopBar title={t('ton.bridge.title')} /><div class="content"><div class="error">{t('ton.noKey.body')}</div></div></div>;
  if (!evmAcc) return <div class="screen"><TopBar title={t('ton.bridge.title')} /><div class="content"><div class="error">{t('ton.needEvmAccount')}</div></div></div>;

  if (step === 'done' && sent) {
    return (
      <div class="screen">
        <div class="content" style={{ alignItems: 'center', justifyContent: 'center', textAlign: 'center' }}>
          <SuccessMark />
          <h2 style={{ margin: 0 }}>{t('ton.bridge.sent')}</h2>
          <div class="muted">{fmtNum(units(BigInt(sent.amountIn), srcDecimals))} {srcSymbol} → ≈ {fmtNum(units(BigInt(sent.amountOut || 0), dstDecimals))} {dstSymbol}</div>
          <div class="small muted">{t('ton.bridge.tracking', { time: minutes(sent.durationSec) || '…' })}</div>
        </div>
        <div class="footer"><Btn onClick={() => reset('home')}>{t('send.done')}</Btn></div>
      </div>
    );
  }

  if (step === 'confirm' && prepared) {
    const q = prepared.quote;
    return (
      <div class="screen">
        <TopBar title={t('bridge.confirm')} onBack={() => { setStep('form'); setPrepared(null); }} />
        <div class="content">
          <Summary q={q} />
          <FeeBox chain={evmChain} prepared={prepared} speed={speed} setSpeed={setSpeed} nativePrice={nativePrice} valueWei={evmTok.native ? raw : 0n} />
          {err && <div class="error">{err}</div>}
        </div>
        <div class="footer"><Btn loading={!!busy} onClick={sendConfirmed}>{t('bridge.send')}</Btn></div>
      </div>
    );
  }

  function Summary({ q }) {
    return (
      <div class="card kv">
        <span class="k">{t('bridge.sentAmount')}</span><span class="v">{fmtNum(units(raw, srcDecimals))} {srcSymbol}</span>
        <span class="k">{t('bridge.expected')}</span><span class="v bold">{fmtNum(units(BigInt(q.amountOut || 0), dstDecimals))} {dstSymbol}</span>
        <span class="k">{t('ton.bridge.min')}</span><span class="v">{fmtNum(units(BigInt(q.minOut || 0), dstDecimals))} {dstSymbol}</span>
        <span class="k">{t('bridge.recipient')}</span><span class="v mono">{shortAddr(dir === 'out' ? evmAcc.address : tonW.friendly, 6)}</span>
        <span class="k">{t('bridge.via')}</span><span class="v">{q.provider}{q.durationSec != null ? ` · ${minutes(q.durationSec)}` : ''}</span>
        {q.feesUsd > 0 && <><span class="k">{t('ton.bridge.fees')}</span><span class="v">{fmtUsd(q.feesUsd)}</span></>}
      </div>
    );
  }

  const side = (isTon) => (
    <div class="card col" style={{ gap: '0.5rem' }}>
      <div class="row between small muted">
        <span>{(dir === 'out') === isTon ? t('swap.from') : t('swap.toEst')}</span>
        {isTon ? <span class="row" style={{ gap: '.375rem' }}><ChainIcon chain={TON} size={18} /> TON</span>
          : <button class="chain-pick" onClick={() => setSheet('chain')}><ChainIcon chain={evmChain} size={18} /><span>{evmChain.name}</span><Icon name="chevron" size={12} /></button>}
      </div>
      <div class="pills">
        {isTon ? Object.values(TON_ASSETS).map((a) => <button class={`pill ${assetKey === a.key ? 'active' : ''}`} onClick={() => { setAssetKey(a.key); setAmount(''); }}>{a.symbol}</button>)
          : evmTokens(evmChain).map((x) => <button class={`pill ${evmTok.address === x.address ? 'active' : ''}`} onClick={() => { setEvmTok(x); setAmount(''); }}>{x.symbol}</button>)}
      </div>
    </div>
  );

  return (
    <div class="screen">
      <TopBar title={t('ton.bridge.title')} />
      <div class="content">
        <div class="seg seg-full" role="tablist">
          <button class={dir === 'out' ? 'on' : ''} onClick={() => { setDir('out'); setAmount(''); }}>{t('ton.bridge.out')}</button>
          <button class={dir === 'in' ? 'on' : ''} onClick={() => { setDir('in'); setAmount(''); }}>{t('ton.bridge.in')}</button>
        </div>
        {side(dir === 'out')}
        <div class="field">
          <div class="row between"><label>{t('send.amount')}</label><span class="small muted">{balance != null ? t('send.balance', { amount: fmtNum(units(balance, srcDecimals)), symbol: srcSymbol }) : ''}</span></div>
          <div class="input-wrap">
            <input inputMode="decimal" placeholder="0" value={amount} onInput={(e) => setAmount(e.target.value)} />
            {balance != null && <button class="btn ghost sm" onClick={() => setAmount(rawToInput(dir === 'out' && assetKey === 'GRAM' ? (balance > 200_000_000n ? balance - 200_000_000n : 0n) : balance, srcDecimals))}>{t('send.max')}</button>}
            <span class="token-select"><TokenIcon sm symbol={srcSymbol} color={srcSymbol === 'GRAM' ? TON.color : undefined} />{srcSymbol}</span>
          </div>
          {tooMuch && <span class="small red">{t('send.overBalance')}</span>}
        </div>
        {side(dir === 'in')}
        {quoting && <div class="info row"><Spinner /> {t('ton.bridge.quoting')}</div>}
        {quote && !quoting && <Summary q={quote} />}
        {assetKey === 'USDT' && <div class="tiny muted">{t('ton.bridge.usdtNote')}</div>}
        {err && <div class="error small">{err}</div>}
      </div>
      <div class="footer"><Btn loading={!!busy} disabled={!quote || quoting || !!busy || tooMuch} onClick={proceed}>{busy || t('common.continue')}</Btn></div>
      {sheet === 'chain' && <NetworkSheet current={evmId} onPick={(id) => { setEvmId(id); setAmount(''); }} only={(c) => BRIDGE_CHAINS.includes(c.id)} onClose={() => setSheet(null)} />}
    </div>
  );
}
