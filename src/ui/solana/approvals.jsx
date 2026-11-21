// Approval screens of Solana dapps (in-app browser, Android app): connecting a site, transactions it asks to sign (or
// sign and send: decoded, simulated - what leaves and enters the wallet - with the dangerous instructions flagged),
// messages to sign and Sign In With Solana. Registered in the approval list (screens/approve.jsx) by
// src/mobile/solanaPlugin.js; the signatures happen in the background (src/background/solanaDapp.js) after the
// password or the fingerprint.
import { useEffect, useState } from 'preact/hooks';
import { Btn, Avatar, ChainIcon, useApp, rich } from '../components.jsx';
import { Site, siteHost } from '../screens/approve.jsx';
import { Loading, SolValue, AddrValue } from '../screens/contracts/sol/parts.jsx';
import { fmtAmount, shortAddr } from '../../shared/format.js';
import { t, tn } from '../../shared/i18n.js';
import { SOL_CHAINS } from '../../shared/solana/api.js';
import { fromBase64, utf8 } from '../../shared/solana/core.js';
import { analyzeTx, looksLikeTransaction } from '../../shared/solana/inspect.js';
import { signInText } from '../../shared/solana/siws.js';
import { simText } from './tx.js';
import { useSolAccounts } from './hooks.js';


function AccountLine({ account, address }) {
  const { state } = useApp();
  const acc = state.accounts.find((a) => a.address === account);
  return <div class="row small"><Avatar address={account} /><span class="bold">{acc?.name || t('approve.account')}</span><span class="muted mono">{shortAddr(address, 6)}</span></div>;
}

/** The accounts with a Solana address, to choose one (connect, sign-in). */
function AccountChoice({ current, sel, setSel }) {
  const { state } = useApp();
  const map = useSolAccounts();
  const accounts = map ? state.accounts.filter((a) => map[a.address]) : [];
  useEffect(() => {
    if (!map || sel) return;
    const pick = accounts.find((a) => a.address === current) || accounts.find((a) => a.address === state.selected) || accounts[0];
    if (pick) setSel(pick.address);
  }, [!!map]);
  if (!map) return <Loading text={t('solapp.loading')} />;
  if (!accounts.length) return <div class="error small">{t('solapp.noAccount')}</div>;
  return (
    <>
      <div class="small muted">{t('solapp.choose')}</div>
      <div class="card" style={{ padding: '0.375rem' }}>
        {accounts.map((a) => (
          <label class="item" style={{ cursor: 'pointer' }}>
            <input type="radio" name="solacc" checked={sel === a.address} onChange={() => setSel(a.address)} />
            <Avatar address={a.address} />
            <div class="grow"><div class="bold">{a.name}</div><div class="small muted mono">{shortAddr(map[a.address].address, 6)}</div></div>
          </label>
        ))}
      </div>
    </>
  );
}

// ------------------------------------------------------------------ connect
function SolConnect({ req, done }) {
  const [sel, setSel] = useState(null);
  const [busy, setBusy] = useState(false);
  const go = async () => { setBusy(true); await done(true, { account: sel }); setBusy(false); };
  return (
    <>
      <div class="content">
        <Site req={req} />
        <h3 style={{ margin: '0.25rem 0 0' }}>{t('solapp.connect.title')}</h3>
        <AccountChoice current={req.params.current} sel={sel} setSel={setSel} />
        <div class="info small">{rich('solapp.connect.info')}</div>
      </div>
      <div class="footer">
        <Btn kind="secondary" onClick={() => done(false)}>{t('approve.reject')}</Btn>
        <Btn loading={busy} disabled={!sel} onClick={go}>{t('approve.connect.button')}</Btn>
      </div>
    </>
  );
}

// ------------------------------------------------------------------ transactions
const signed = (v) => (v > 0n ? '+' : '−');
const abs = (v) => (v < 0n ? -v : v);

function TxCard({ a, i, n, chain, me }) {
  const [open, setOpen] = useState(false);
  return (
    <div class="card col" style={{ gap: '.375rem' }}>
      {n > 1 && <b class="small">{t('solapp.tx.nth', { n: i + 1 })}</b>}
      <div class={a.sim.ok ? 'success small' : 'error small'}>{a.sim.ok ? t('solapp.tx.simOk') : simText(a.sim.err, a.sim.logs)}</div>
      {(a.sol != null && a.sol !== 0n) || a.tokens.length ? (
        <div class="col" style={{ gap: '.125rem' }}>
          <span class="tiny muted">{t('solapp.tx.changes')}</span>
          {a.sol != null && a.sol !== 0n && <b class={a.sol < 0n ? '' : 'green'}>{signed(a.sol)}{fmtAmount(abs(a.sol), 9, 6)} {chain.native.symbol}</b>}
          {a.tokens.map((x) => <b class={x.delta < 0n ? '' : 'green'}>{signed(x.delta)}{fmtAmount(abs(x.delta), x.decimals, 6)} {x.symbol}{x.known ? '' : ` · ${t('solapp.tx.unverified')}`}</b>)}
        </div>
      ) : a.sim.ok ? <span class="tiny muted">{t('solapp.tx.noChange')}</span> : null}
      <button class="link tiny" style={{ alignSelf: 'flex-start' }} onClick={() => setOpen(!open)}>{open ? t('solapp.tx.hide') : tn('solapp.tx.show', a.instructions.length)}</button>
      {open && a.instructions.map((ix) => (
        <div class="col" style={{ gap: '.125rem', borderTop: '1px solid var(--border)', paddingTop: '.375rem' }}>
          <span class="small"><b>{ix.known?.name || t('solc.decoder.instruction')}</b> · {ix.program || shortAddr(ix.programId || '?', 4)}</span>
          {ix.known ? <SolValue v={ix.known.fields} me={me} /> : <AddrValue address={ix.programId} />}
        </div>
      ))}
      {open && a.sim.logs.length > 0 && <details><summary class="tiny muted">{t('solc.sim.showLogs', { n: a.sim.logs.length })}</summary><pre class="ct-log mono tiny">{a.sim.logs.join('\n')}</pre></details>}
    </div>
  );
}

function SolTx({ req, done }) {
  const { setPortfolioCache } = useApp();
  const { account, address, chainId, txs, send } = req.params;
  const chain = SOL_CHAINS[chainId];
  const [list, setList] = useState(null);
  const [err, setErr] = useState('');
  const [ack, setAck] = useState(false);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    Promise.all(txs.map((x) => analyzeTx(chain, fromBase64(x), address))).then(setList).catch((e) => setErr(e.message));
  }, []);
  const risks = list ? list.flatMap((a) => a.risks).filter((r, i, all) => all.findIndex((x) => x.key === r.key) === i) : [];
  const danger = risks.some((r) => r.level === 'danger');
  const failed = list?.some((a) => !a.sim.ok);
  const confirm = async () => {
    setBusy(true);
    setPortfolioCache((c) => { const n = { ...c }; delete n[`${chain.id}:${account}`]; return n; });
    await done(true);
    setBusy(false);
  };
  return (
    <>
      <div class="content">
        <Site req={req} />
        <h3 style={{ margin: '0.25rem 0 0' }}>{send ? tn('solapp.tx.titleSend', txs.length) : tn('solapp.tx.titleSign', txs.length)}</h3>
        <AccountLine account={account} address={address} />
        <div class="card kv">
          <span class="k">{t('approve.network')}</span><span class="v"><span class="row" style={{ justifyContent: 'flex-end', gap: '.375rem' }}><ChainIcon chain={chain} size={18} />{chain.name}</span></span>
        </div>
        {!send && <div class="info small">{t('solapp.tx.signOnly')}</div>}
        {risks.map((r) => <div class={r.level === 'danger' ? 'error' : 'warn'}><b>{t('common.attention')}</b> {t(`solapp.risk.${r.key}`, { ...r.vars, to: shortAddr(r.vars?.to || '', 6), delegate: shortAddr(r.vars?.delegate || '', 6) })}</div>)}
        {err && <div class="error">{err}</div>}
        {!list && !err && <Loading text={t('solapp.tx.simulating')} />}
        {list?.map((a, i) => <TxCard a={a} i={i} n={list.length} chain={chain} me={address} />)}
        {(failed || danger) && <label class="ack row small"><input type="checkbox" checked={ack} onChange={(e) => setAck(e.target.checked)} /> {danger ? rich('solapp.tx.ackDanger') : t('contracts.tx.sendAnyway')}</label>}
      </div>
      <div class="footer">
        <Btn kind="secondary" onClick={() => done(false)}>{t('approve.reject')}</Btn>
        <Btn kind={failed || danger ? 'danger' : 'primary'} loading={busy} disabled={(!list && !err) || ((failed || danger) && !ack)} onClick={confirm}>
          {send ? t('common.confirm') : t('approve.sign.button')}
        </Btn>
      </div>
    </>
  );
}

// ------------------------------------------------------------------ messages
/** Printable text, or null (binary data). */
function asText(bytes) {
  try {
    const s = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    return /[\u0000-\u0008\u000e-\u001f]/.test(s) ? null : s;
  } catch { return null; }
}

function SolSignMessage({ req, done }) {
  const { account, address, message } = req.params;
  const bytes = fromBase64(message);
  const text = asText(bytes);
  const disguised = looksLikeTransaction(bytes);
  const [ack, setAck] = useState(false);
  const [busy, setBusy] = useState(false);
  const go = async () => { setBusy(true); await done(true); setBusy(false); };
  return (
    <>
      <div class="content">
        <Site req={req} />
        <h3 style={{ margin: '0.25rem 0 0' }}>{t('approve.sign.title')}</h3>
        <AccountLine account={account} address={address} />
        {disguised && <div class="error"><b>{t('common.attention')}</b> {t('solapp.sign.disguised')}</div>}
        {text != null ? (
          <div class="col" style={{ gap: '.25rem' }}><span class="small muted">{t('approve.sign.message')}</span><pre class="data mono">{text}</pre></div>
        ) : (
          <>
            <div class="warn small">{t('approve.sign.unreadable')}</div>
            <pre class="data mono">{Array.from(bytes, (x) => x.toString(16).padStart(2, '0')).join('')}</pre>
          </>
        )}
        <div class="info small">{t('solapp.sign.free')}</div>
        {(text == null || disguised) && <label class="ack row small"><input type="checkbox" checked={ack} onChange={(e) => setAck(e.target.checked)} /> {rich('solapp.sign.ack', { site: siteHost(req) })}</label>}
      </div>
      <div class="footer">
        <Btn kind="secondary" onClick={() => done(false)}>{t('approve.reject')}</Btn>
        <Btn kind={text == null || disguised ? 'danger' : 'primary'} loading={busy} disabled={(text == null || disguised) && !ack} onClick={go}>{t('approve.sign.button')}</Btn>
      </div>
    </>
  );
}

function SolSignIn({ req, done }) {
  const map = useSolAccounts();
  const [sel, setSel] = useState(null);
  const [busy, setBusy] = useState(false);
  const { input } = req.params;
  const address = sel && map?.[sel]?.address;
  const text = address ? signInText({ ...input, address }) : null;
  const go = async () => { setBusy(true); await done(true, { account: sel }); setBusy(false); };
  return (
    <>
      <div class="content">
        <Site req={req} />
        <h3 style={{ margin: '0.25rem 0 0' }}>{t('solapp.signIn.title')}</h3>
        <AccountChoice current={req.params.current} sel={sel} setSel={setSel} />
        {text && <div class="col" style={{ gap: '.25rem' }}><span class="small muted">{t('approve.sign.message')}</span><pre class="data mono">{text}</pre></div>}
        <div class="info small">{t('solapp.signIn.info', { site: input.domain })}</div>
        {utf8(text || '').length > 4000 && <div class="warn small">{t('solapp.signIn.long')}</div>}
      </div>
      <div class="footer">
        <Btn kind="secondary" onClick={() => done(false)}>{t('approve.reject')}</Btn>
        <Btn loading={busy} disabled={!sel} onClick={go}>{t('solapp.signIn.button')}</Btn>
      </div>
    </>
  );
}

/** For screens/approve.jsx (registerApprovalViews); authTitle: the requests the background asks a password for. */
export const solanaApprovalViews = {
  solConnect: { View: SolConnect, authTitle: () => null },
  solTx: { View: SolTx, authTitle: () => 'approve.auth.tx' },
  solTxSend: { View: SolTx, authTitle: () => 'approve.auth.tx', sentToast: true },
  solSignMessage: { View: SolSignMessage, authTitle: () => 'approve.auth.sign' },
  solSignIn: { View: SolSignIn, authTitle: () => 'approve.auth.sign' },
};
