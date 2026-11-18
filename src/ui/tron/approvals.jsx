// Approval screens of Tron dapps (in-app browser, Android app): connecting a site (account and network), transactions
// it asks to sign - read from their bytes, each operation in words, contract calls simulated, the cost in energy and
// burnt TRX, unlimited approvals and unknown operations flagged - messages to sign, and the screen that explains a
// blocked change of permissions. Registered in the approval list (screens/approve.jsx) by src/mobile/tronPlugin.js;
// the signatures happen in the background (src/background/tronDapp.js) after the password or the fingerprint.
import { useEffect, useState } from 'preact/hooks';
import { Btn, Avatar, Icon, Spinner, useApp, rich } from '../components.jsx';
import { Site } from '../screens/approve.jsx';
import { fmtAmount, fmtNum, shortAddr } from '../../shared/format.js';
import { t, tn } from '../../shared/i18n.js';
import { fromHex, fromEvmAddress } from '../../shared/tron/core.js';
import { decodeRawData } from '../../shared/tron/proto.js';
import { TRON_CHAINS, TRON_MAINNET, TRON_NILE, constantCall, chainParams, TRC20 } from '../../shared/tron/api.js';
import { trc20Meta } from '../../shared/tron/tokens.js';
import { resourceState, costOf } from '../../shared/tron/fees.js';
import { KNOWN_CONTRACTS } from '../../shared/tron/history.js';
import { isChainEnabled } from '../../shared/chains.js';
import { useTronAccounts } from './hooks.js';

const hostOf = (url) => { try { return new URL(url).host; } catch { return ''; } };
const chainOfNode = (node) => TRON_CHAINS[node === 'nile' ? TRON_NILE : TRON_MAINNET];
const TRX = (sun) => `${fmtAmount(BigInt(sun || 0), 6, 6)} TRX`;
const UNLIMITED = 2n ** 128n;

function AccountLine({ account, address }) {
  const { state } = useApp();
  const acc = state.accounts.find((a) => a.address === account);
  return <div class="row small"><Avatar address={account} /><span class="bold">{acc?.name || t('approve.account')}</span><span class="muted mono">{shortAddr(address, 6)}</span></div>;
}

// ------------------------------------------------------------------ connect
function TronConnect({ req, done }) {
  const { state, chain } = useApp();
  const map = useTronAccounts();
  const accounts = map ? state.accounts.filter((a) => map[a.address]) : [];
  const [sel, setSel] = useState(null);
  const nileOn = isChainEnabled(TRON_NILE, state.settings);
  const [node, setNode] = useState(chain.id === TRON_NILE ? 'nile' : 'mainnet');
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (!map || sel) return;
    const pick = accounts.find((a) => a.address === state.selected) || accounts[0];
    if (pick) setSel(pick.address);
  }, [!!map]);
  const go = async () => { setBusy(true); await done(true, { account: sel, node }); setBusy(false); };
  return (
    <>
      <div class="content">
        <Site req={req} />
        <h3 style={{ margin: '0.25rem 0 0' }}>{t('tronapp.connect.title')}</h3>
        {!map ? <div class="row small muted"><Spinner /> {t('tronapp.loading')}</div> : !accounts.length ? <div class="error small">{t('tronapp.noAccount')}</div> : (
          <>
            <div class="small muted">{t('tronapp.choose')}</div>
            <div class="card" style={{ padding: '0.375rem' }}>
              {accounts.map((a) => (
                <label class="item" style={{ cursor: 'pointer' }}>
                  <input type="radio" name="tronacc" checked={sel === a.address} onChange={() => setSel(a.address)} />
                  <Avatar address={a.address} />
                  <div class="grow"><div class="bold">{a.name}</div><div class="small muted mono">{shortAddr(map[a.address].address, 6)}</div></div>
                </label>
              ))}
            </div>
          </>
        )}
        {nileOn && (
          <div class="seg seg-full">
            <button class={node === 'mainnet' ? 'on' : ''} onClick={() => setNode('mainnet')}>Tron</button>
            <button class={node === 'nile' ? 'on' : ''} onClick={() => setNode('nile')}>Nile (test)</button>
          </div>
        )}
        <div class="info small">{rich('tronapp.connect.info')}</div>
      </div>
      <div class="footer">
        <Btn kind="secondary" onClick={() => done(false)}>{t('approve.reject')}</Btn>
        <Btn loading={busy} disabled={!sel} onClick={go}>{t('approve.connect.button')}</Btn>
      </div>
    </>
  );
}

// ------------------------------------------------------------------ transactions
const resWord = (r) => t(r === 1 ? 'tron.res.energy' : 'tron.res.bandwidth');
const name = (a, metas) => KNOWN_CONTRACTS[a] || metas[a]?.symbol || shortAddr(a, 5);

/** One operation of the transaction, in words: { icon, title, rows: [[k, v]], warn, danger }. */
function explain(c, metas, me) {
  const p = c.parameter || {};
  switch (c.type) {
    case 'TransferContract':
      return { icon: 'send', title: t('tronapp.op.sendTrx', { amount: TRX(p.amount) }), rows: [[t('send.to'), p.to_address]] };
    case 'TransferAssetContract':
      return { icon: 'send', title: t('tronapp.op.sendTrc10', { amount: fmtNum(Number(p.amount || 0), 0), id: p.asset_name }), rows: [[t('send.to'), p.to_address]] };
    case 'TriggerSmartContract': {
      const data = String(p.data || '');
      const sel = data.slice(0, 8);
      const token = metas[p.contract_address];
      const rows = [[t('tronapp.contract'), `${name(p.contract_address, metas)} · ${shortAddr(p.contract_address, 5)}`]];
      if (p.call_value) rows.push([t('tronapp.pays'), TRX(p.call_value)]);
      let fn = null;
      try { fn = TRC20.parseTransaction({ data: `0x${data}` }); } catch { /* not a token function */ }
      if (fn && token && (sel === 'a9059cbb' || sel === '23b872dd')) {
        const amount = fn.args[fn.args.length - 1];
        const to = fn.args[fn.args.length - 2];
        return { icon: 'send', title: t('tronapp.op.sendToken', { amount: fmtAmount(amount, token.decimals, 6), symbol: token.symbol }), rows: [...rows, [t('send.to'), fromEvmAddress(String(to)) || String(to)]] };
      }
      if (fn && sel === '095ea7b3') {
        const amount = fn.args[1];
        const unlimited = amount >= UNLIMITED;
        return {
          icon: 'approve', title: unlimited ? t('tronapp.op.approveAll', { symbol: token?.symbol || name(p.contract_address, metas) }) : t('tronapp.op.approve', { amount: token ? fmtAmount(amount, token.decimals, 6) : String(amount), symbol: token?.symbol || '' }),
          rows: [...rows, [t('tronapp.spender'), fromEvmAddress(String(fn.args[0])) || String(fn.args[0])]], warn: unlimited ? t('tronapp.unlimited') : null,
        };
      }
      return { icon: 'contract', title: t('tronapp.op.call', { name: name(p.contract_address, metas) }), rows: [...rows, [t('tronapp.function'), sel ? `0x${sel}` : '–']] };
    }
    case 'FreezeBalanceV2Contract': return { icon: 'lock', title: t('tron.h.stake', { amount: TRX(p.frozen_balance), res: resWord(p.resource) }), rows: [] };
    case 'UnfreezeBalanceV2Contract': return { icon: 'lockOpen', title: t('tron.h.unstake', { amount: TRX(p.unfreeze_balance), res: resWord(p.resource) }), rows: [] };
    case 'WithdrawExpireUnfreezeContract': return { icon: 'receive', title: t('tron.h.withdrawUnstaked'), rows: [] };
    case 'CancelAllUnfreezeV2Contract': return { icon: 'refresh', title: t('tron.h.cancelUnstake'), rows: [] };
    case 'DelegateResourceContract': return { icon: 'share', title: t('tron.h.delegate', { amount: TRX(p.balance), res: resWord(p.resource) }), rows: [[t('send.to'), p.receiver_address]], warn: p.receiver_address !== me ? t('tronapp.delegateOut') : null };
    case 'UnDelegateResourceContract': return { icon: 'share', title: t('tron.h.undelegate', { res: resWord(p.resource) }), rows: [[t('tronapp.from'), p.receiver_address]] };
    case 'VoteWitnessContract': return { icon: 'vote', title: tn('tron.h.vote', (p.votes || []).length), rows: (p.votes || []).map((v) => [shortAddr(v.vote_address, 5), fmtNum(Number(v.vote_count || 0), 0)]) };
    case 'WithdrawBalanceContract': return { icon: 'trophy', title: t('tron.h.rewards'), rows: [] };
    case 'CreateSmartContract': return { icon: 'code', title: t('tronapp.op.deploy', { name: p.new_contract?.name || '' }), rows: [], warn: t('tronapp.deployWarn') };
    default: return { icon: 'warn', title: t('tronapp.op.unknown', { type: c.type }), rows: [], danger: true };
  }
}

function TronTx({ req, done }) {
  const { account, address, node, raw } = req.params;
  const chain = chainOfNode(node);
  const d = decodeRawData(raw);
  const [metas, setMetas] = useState({});
  const [sim, setSim] = useState(null); // { ok, energy, message } of the contract call, if any
  const [fee, setFee] = useState(null);
  const [ack, setAck] = useState(false);
  const [busy, setBusy] = useState(false);
  const call = d.contracts.find((c) => c.type === 'TriggerSmartContract');
  useEffect(() => {
    let alive = true;
    (async () => {
      const addrs = [...new Set(d.contracts.map((c) => c.parameter?.contract_address).filter(Boolean))];
      const m = {};
      for (const a of addrs) m[a] = await trc20Meta(chain, a).catch(() => null);
      if (alive) setMetas(m);
      let energy = 0;
      if (call) {
        const p = call.parameter;
        const r = await constantCall(chain, { owner: address, contract: p.contract_address, data: p.data || '', callValue: p.call_value || 0 }).catch(() => null);
        if (alive) setSim(r || { ok: null });
        energy = r?.energy || 0;
      }
      const [res, params] = await Promise.all([resourceState(chain, address), chainParams(chain)]).catch(() => [null, null]);
      if (res && alive) setFee(costOf({ res, params, bytes: raw.length / 2 + 134, energy }));
    })();
    return () => { alive = false; };
  }, []);
  const ops = d.contracts.map((c) => explain(c, metas, address));
  const danger = ops.some((o) => o.danger) || sim?.ok === false;
  const go = async () => { setBusy(true); await done(true); setBusy(false); };
  return (
    <>
      <div class="content">
        <Site req={req} />
        <h3 style={{ margin: '0.25rem 0 0' }}>{t('tronapp.tx.title')}</h3>
        <AccountLine account={account} address={address} />
        {node === 'nile' && <span class="badge amber">Nile (test)</span>}
        {ops.map((o) => (
          <div class={`card tr-op ${o.danger ? 'danger' : ''}`}>
            <div class="row" style={{ gap: '.5rem' }}><Icon name={o.icon} size={18} /><b class="grow">{o.title}</b></div>
            {o.rows.map(([k, v]) => <div class="row between small"><span class="muted">{k}</span><span class="mono ellipsis" style={{ maxWidth: '65%' }}>{v}</span></div>)}
            {o.warn && <div class="warn small">{o.warn}</div>}
          </div>
        ))}
        {call && sim == null && <div class="row small muted"><Spinner /> {t('tronapp.simulating')}</div>}
        {sim?.ok === false && <div class="error small">{t('tronapp.simFailed', { reason: sim.message || '' })}</div>}
        <div class="card">
          <div class="row between small"><span class="muted">{t('tron.fee.label')}</span><b>{fee ? `≈ ${TRX(fee.total)}` : '…'}</b></div>
          {fee?.energy.need > 0 && <div class="row between tiny muted"><span>{t('tron.res.energy')}</span><span>{fmtNum(fee.energy.need, 0)}{fee.energy.burn ? '' : ` · ${t('tron.res.covered')}`}</span></div>}
          {d.raw.fee_limit > 0 && <div class="row between tiny muted"><span>{t('tronapp.feeLimit')}</span><span>{TRX(d.raw.fee_limit)}</span></div>}
        </div>
        {danger && <label class="ack row small"><input type="checkbox" checked={ack} onChange={(e) => setAck(e.target.checked)} /> {rich('tronapp.ack', { site: hostOf(req.origin) })}</label>}
      </div>
      <div class="footer">
        <Btn kind="secondary" onClick={() => done(false)}>{t('approve.reject')}</Btn>
        <Btn kind={danger ? 'danger' : 'primary'} loading={busy} disabled={danger && !ack} onClick={go}>{t('approve.sign.button')}</Btn>
      </div>
    </>
  );
}

// ------------------------------------------------------------------ messages
function TronSignMessage({ req, done }) {
  const { account, address, message, hex } = req.params;
  let text = message;
  if (hex) {
    try { const s = new TextDecoder('utf-8', { fatal: true }).decode(fromHex(message)); text = /[\x00-\x08\x0e-\x1f]/.test(s) ? null : s; } catch { text = null; }
  }
  const [ack, setAck] = useState(false);
  const [busy, setBusy] = useState(false);
  const go = async () => { setBusy(true); await done(true); setBusy(false); };
  return (
    <>
      <div class="content">
        <Site req={req} />
        <h3 style={{ margin: '0.25rem 0 0' }}>{t('approve.sign.title')}</h3>
        <AccountLine account={account} address={address} />
        {text != null ? <div class="col" style={{ gap: '.25rem' }}><span class="small muted">{t('approve.sign.message')}</span><pre class="data mono">{text}</pre></div>
          : <><div class="warn small">{t('approve.sign.unreadable')}</div><pre class="data mono">{message}</pre></>}
        <div class="info small">{t('tronapp.sign.free')}</div>
        {text == null && <label class="ack row small"><input type="checkbox" checked={ack} onChange={(e) => setAck(e.target.checked)} /> {rich('tronapp.ack', { site: hostOf(req.origin) })}</label>}
      </div>
      <div class="footer">
        <Btn kind="secondary" onClick={() => done(false)}>{t('approve.reject')}</Btn>
        <Btn kind={text == null ? 'danger' : 'primary'} loading={busy} disabled={text == null && !ack} onClick={go}>{t('approve.sign.button')}</Btn>
      </div>
    </>
  );
}

// ------------------------------------------------------------------ blocked: a change of the account's permissions
function TronBlocked({ req, done }) {
  const { account, address } = req.params;
  return (
    <>
      <div class="content">
        <Site req={req} />
        <div class="tr-blocked">
          <span class="tr-blocked-ic"><Icon name="shield" size={30} /></span>
          <h3>{t('tronapp.blocked.title')}</h3>
          <AccountLine account={account} address={address} />
          <p class="small">{rich('tronapp.blocked.body', { site: hostOf(req.origin) })}</p>
          <p class="small">{t('tronapp.blocked.what')}</p>
        </div>
      </div>
      <div class="footer">
        <Btn onClick={() => done(false)}>{t('tronapp.blocked.close')}</Btn>
      </div>
    </>
  );
}

export const tronApprovalViews = {
  tronConnect: { View: TronConnect, authTitle: () => null },
  tronTx: { View: TronTx, authTitle: () => 'approve.auth.tx' },
  tronSignMessage: { View: TronSignMessage, authTitle: () => 'approve.auth.sign' },
  tronBlocked: { View: TronBlocked, authTitle: () => null },
};

