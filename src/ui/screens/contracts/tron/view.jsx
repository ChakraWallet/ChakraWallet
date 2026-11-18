// Tron contract page (Contracts tab, Android app): the contract with the ABI it was deployed with (Tron keeps it on
// chain; one can be pasted when it's missing), then Read (views, the ones without arguments at once) / Write (each
// call simulated, its energy and burnt TRX shown, then signed) / Info (owner, who pays the energy, code). Addresses go
// in and come out as T…; inside the calls they are the same 20 bytes.
import { useEffect, useState } from 'preact/hooks';
import { Icon, Spinner, Btn, Sheet, CopyBtn, useApp } from '../../../components.jsx';
import { getChain } from '../../../../shared/chains.js';
import { shortAddr, fmtAmount, fmtNum } from '../../../../shared/format.js';
import { t } from '../../../../shared/i18n.js';
import { constantCall, chainParams, tronAddrUrl } from '../../../../shared/tron/api.js';
import { encodeRawData } from '../../../../shared/tron/proto.js';
import { resourceState, costOf, bandwidthBytes, feeLimitFor } from '../../../../shared/tron/fees.js';
import { loadTronContract, argOf, showValue, standardAbi } from '../../../../shared/tron/contracts.js';
import { addRecent, saveContract, unsaveContract, savedEntry, customAbi, setCustomAbi } from '../../../contractsStore.js';
import { sendContract } from '../../../tron/tx.js';
import { useTronAccounts } from '../../../tron/hooks.js';

const ZERO = 'T9yD14Nj9j7xAB4dbGeiX9h8unkKHxuWwb';
const TABS = ['read', 'write', 'info'];
const pretty = (v) => (typeof v === 'object' ? JSON.stringify(v, null, 1) : String(v));

function Shell({ onBack, title, right, children }) {
  return (
    <div class="screen">
      <div class="topbar">
        <button class="iconbtn" onClick={onBack} title={t('common.back')}><Icon name="back" /></button>
        <h1 class="ellipsis">{title || t('contracts.title')}</h1>
        {right}
      </div>
      <div class="content ct-content">{children}</div>
    </div>
  );
}

/** The selected account's Tron address (null: it has none, e.g. a TON-only account). */
function useMyTron() {
  const { account } = useApp();
  const map = useTronAccounts();
  return map ? map[account.address]?.address || null : undefined;
}

export function TronContractView({ chainId, address, onBack }) {
  const { state, toast } = useApp();
  const chain = getChain(chainId, state.customChains);
  const me = useMyTron();
  const [c, setC] = useState(null);
  const [err, setErr] = useState('');
  const [tab, setTab] = useState('read');
  const [saved, setSaved] = useState(null);
  const [reload, setReload] = useState(0);
  const [sending, setSending] = useState(null); // { fn, args, value }
  useEffect(() => {
    let alive = true;
    setErr(''); if (reload) setC(null);
    (async () => {
      const abi = await customAbi(chainId, address);
      const r = await loadTronContract(chain, address, { customAbi: abi });
      if (!alive) return;
      setC(r);
      if (r.exists) addRecent(chainId, address, r.name);
      if (r.exists && !r.reads.length && r.writes.length) setTab('write');
    })().catch((e) => alive && setErr(e.message));
    savedEntry(chainId, address).then((s) => alive && setSaved(s));
    return () => { alive = false; };
  }, [reload]);

  if (err) return <Shell onBack={onBack}><div class="error">{err}</div><Btn kind="secondary" onClick={() => setReload((x) => x + 1)}>{t('contracts.retry')}</Btn></Shell>;
  if (!c) return <Shell onBack={onBack}><div class="ct-loading"><Spinner lg /><span class="small muted">{t('contracts.loading')}</span></div></Shell>;
  if (!c.exists) {
    return (
      <Shell onBack={onBack} title={shortAddr(address)}>
        <div class="card col" style={{ gap: '.5rem' }}><b>{t('contracts.eoa.title')}</b><span class="small muted">{t('contracts.eoa.body', { chain: chain.name })}</span></div>
      </Shell>
    );
  }
  const toggleSave = async () => {
    if (saved) { await unsaveContract(chainId, address); setSaved(null); toast(t('contracts.unsaved')); return; }
    await saveContract({ chainId, address, name: c.name, abi: c.custom ? c.abi : undefined });
    setSaved(await savedEntry(chainId, address)); toast(t('contracts.saved'));
  };
  return (
    <Shell onBack={onBack} title={c.name || shortAddr(address)} right={<button class="iconbtn" title={t(saved ? 'contracts.unsave' : 'contracts.save')} onClick={toggleSave}><Icon name="star" size={18} /></button>}>
      <div class="card col ct-head">
        <div class="row" style={{ gap: '.5rem' }}><span class="mono small ellipsis grow">{address}</span><CopyBtn text={address} /></div>
        <div class="row small muted" style={{ gap: '.375rem', flexWrap: 'wrap' }}>
          <span class="badge">{chain.name}</span>
          {c.abiOnChain ? <span class="badge green">{t('tronc.abiOnChain')}</span> : c.custom ? <span class="badge primary">{t('tronc.abiCustom')}</span> : <span class="badge amber">{t('tronc.noAbi')}</span>}
          <a class="link small" href={tronAddrUrl(chain, address).replace('/address/', '/contract/')} target="_blank" rel="noopener" data-external>Tronscan <Icon name="external" size={12} /></a>
        </div>
      </div>
      <div class="tabs">{TABS.map((k) => <button class={`tab ${tab === k ? 'active' : ''}`} onClick={() => setTab(k)}>{t(`tronc.tab.${k}`)}</button>)}</div>
      {tab === 'read' && <ReadTab c={c} chain={chain} me={me} />}
      {tab === 'write' && (me === null ? <div class="warn small">{t('tronc.noTronKey')}</div> : <WriteTab c={c} onSend={setSending} />)}
      {tab === 'info' && <InfoTab c={c} chain={chain} chainId={chainId} address={address} onAbi={() => setReload((x) => x + 1)} />}
      {sending && me && <SendSheet chain={chain} c={c} me={me} {...sending} onClose={() => setSending(null)} />}
    </Shell>
  );
}

// ------------------------------------------------------------ read
function ReadTab({ c, chain, me }) {
  const [ov, setOv] = useState(null);
  const [tick, setTick] = useState(0);
  const noArgs = c.reads.filter((f) => !f.inputs.length).slice(0, 16);
  useEffect(() => {
    let alive = true;
    setOv(null);
    (async () => {
      const out = [];
      for (const f of noArgs) { // one at a time: TronGrid without a key allows few requests a second
        const r = await constantCall(chain, { owner: me || ZERO, contract: c.address, data: c.iface.encodeFunctionData(f, []).slice(2) }).catch(() => null);
        let value = null;
        if (r?.ok) { try { const d = c.iface.decodeFunctionResult(f, `0x${r.result}`); value = f.outputs.map((p, i) => showValue(p, d[i])); } catch { /* not decodable */ } }
        out.push({ f, value });
        if (alive) setOv([...out]);
      }
      if (alive) setOv([...out]);
    })();
    return () => { alive = false; };
  }, [tick]);
  if (!c.reads.length) return <div class="empty">{t('contracts.read.noneGuessed')}</div>;
  return (
    <>
      {noArgs.length > 0 && (
        <div class="card col ct-overview">
          <div class="row between"><b class="small">{t('contracts.read.overview')}</b><button class="iconbtn sm" title={t('contracts.refresh')} onClick={() => setTick((x) => x + 1)}><Icon name="refresh" size={14} /></button></div>
          {!ov ? <Spinner /> : ov.map(({ f, value }) => (
            <div class="ct-ov-row"><span class="ct-ov-k">{f.name}</span><div class="ct-ov-v">{value == null ? <span class="tiny muted">{t('contracts.read.reverted')}</span> : value.map((v) => <span class="mono small" style={{ wordBreak: 'break-all' }}>{pretty(v)}</span>)}</div></div>
          ))}
        </div>
      )}
      {c.reads.filter((f) => f.inputs.length).map((f) => <FnCard fn={f} c={c} chain={chain} me={me} />)}
    </>
  );
}

// ------------------------------------------------------------ a function: its inputs, then read it or send it
function FnCard({ fn, c, chain, me, onSend }) {
  const [open, setOpen] = useState(false);
  const [vals, setVals] = useState(() => fn.inputs.map(() => ''));
  const [value, setValue] = useState('');
  const [res, setRes] = useState(null);
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const read = fn.stateMutability === 'view' || fn.stateMutability === 'pure';
  const args = () => fn.inputs.map((p, i) => { try { return argOf(p, vals[i]); } catch { throw new Error(t('tronc.badArg', { name: p.name || `#${i}`, type: p.type })); } });
  const run = async () => {
    setErr(''); setRes(null);
    let a;
    try { a = args(); } catch (e) { setErr(e.message); return; }
    if (!read) {
      const v = String(value).trim();
      const sun = v ? (() => { const m = /^(\d+)(?:[.,](\d{0,6}))?$/.exec(v); return m ? BigInt(m[1]) * 1_000_000n + BigInt((m[2] || '').padEnd(6, '0') || '0') : null; })() : 0n;
      if (sun == null) { setErr(t('tronc.badValue')); return; }
      onSend({ fn, args: a, value: sun });
      return;
    }
    setBusy(true);
    try {
      const r = await constantCall(chain, { owner: me || ZERO, contract: c.address, data: c.iface.encodeFunctionData(fn, a).slice(2) });
      if (!r.ok) setErr(r.message || t('contracts.read.reverted'));
      else { const d = c.iface.decodeFunctionResult(fn, `0x${r.result}`); setRes(fn.outputs.map((p, i) => ({ name: p.name, v: showValue(p, d[i]) }))); }
    } catch (e) { setErr(e.message); }
    setBusy(false);
  };
  return (
    <div class="ct-fn">
      <button class="ct-fn-head" onClick={() => setOpen(!open)}>
        <span class="ct-fn-name grow">{fn.name}</span>
        <span class="ct-fn-sig">({fn.inputs.map((p) => p.type).join(', ')})</span>
        <Icon name="chevron" size={14} />
      </button>
      {open && (
        <div class="ct-fn-body">
          {fn.inputs.map((p, i) => (
            <div class="ct-field">
              <span class="ct-label"><span>{p.name || `#${i}`}</span><span class="ct-type">{p.type}</span></span>
              <input class="input mono" value={vals[i]} spellcheck={false} autocapitalize="off" placeholder={p.type === 'address' ? 'T…' : p.type.endsWith(']') || p.type.startsWith('tuple') ? '[…]' : ''}
                onInput={(e) => { const n = [...vals]; n[i] = e.target.value; setVals(n); }} />
            </div>
          ))}
          {fn.stateMutability === 'payable' && (
            <div class="ct-field"><span class="ct-label"><span>{t('contracts.fn.value')}</span><span class="ct-type">TRX</span></span><input class="input mono" inputMode="decimal" value={value} placeholder="0" onInput={(e) => setValue(e.target.value)} /></div>
          )}
          {err && <div class="error small">{err}</div>}
          {res && <div class="ct-result">{res.map((r) => <div class="ct-node"><span class="tiny muted">{r.name || ''}</span><span class="mono small" style={{ wordBreak: 'break-all' }}>{pretty(r.v)}</span></div>)}</div>}
          <div class="row ct-fn-actions"><Btn class="sm" loading={busy} onClick={run}>{read ? t('tronc.read') : t('tronc.write')}</Btn></div>
        </div>
      )}
    </div>
  );
}

// ------------------------------------------------------------ write
function WriteTab({ c, onSend }) {
  if (!c.writes.length) return <div class="empty">{t('tronc.noWrites')}</div>;
  return c.writes.map((f) => <FnCard fn={f} c={c} onSend={onSend} />);
}

/** A call to send: simulated, its cost shown, then signed. */
function SendSheet({ chain, c, me, fn, args, value, onClose }) {
  const { account, authorize, toast } = useApp();
  const [plan, setPlan] = useState(null);
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(null);
  const data = c.iface.encodeFunctionData(fn, args).slice(2);
  const contract = { type: 'TriggerSmartContract', parameter: { owner_address: me, contract_address: c.address, call_value: value, data } };
  useEffect(() => {
    (async () => {
      const sim = await constantCall(chain, { owner: me, contract: c.address, data, callValue: value });
      const [res, params] = await Promise.all([resourceState(chain, me), chainParams(chain)]);
      const energy = sim.energy || 100_000;
      const draft = encodeRawData({ contract, ref: { ref_block_bytes: '0000', ref_block_hash: '0000000000000000' }, expiration: Date.now(), timestamp: Date.now(), fee_limit: 100_000_000 });
      const cost = costOf({ res, params, bytes: bandwidthBytes(draft), energy });
      setPlan({ sim, energy, cost, feeLimit: feeLimitFor(energy, res, params), balance: BigInt(res.account?.balance || 0) });
    })().catch((e) => setErr(e.message));
  }, []);
  const send = async () => {
    setErr(''); setBusy(true);
    try {
      const r = await sendContract(chain, { account, contract, feeLimit: plan.feeLimit, auth: (fn2) => authorize(fn2, t('tronc.sendTitle', { name: fn.name })) });
      const w = await r.wait;
      toast(t('tronc.sent')); setDone(w.hash);
    } catch (e) { if (!e.cancelled) setErr(e.message); }
    setBusy(false);
  };
  const short = plan && plan.cost.total + value > plan.balance;
  return (
    <Sheet title={fn.name} onClose={onClose}>
      {!plan && !err && <div class="row small muted"><Spinner /> {t('tronapp.simulating')}</div>}
      {plan && (
        <>
          {plan.sim.ok ? <div class="info small">{t('tronc.simOk')}</div> : <div class="error small">{t('tronapp.simFailed', { reason: plan.sim.message || '' })}</div>}
          <div class="card">
            {value > 0n && <div class="row between small"><span class="muted">{t('tronapp.pays')}</span><b>{fmtAmount(value, 6, 6)} TRX</b></div>}
            <div class="row between small"><span class="muted">{t('tron.res.energy')}</span><span>{fmtNum(plan.energy, 0)}{plan.cost.energy.burn ? '' : ` · ${t('tron.res.covered')}`}</span></div>
            <div class="row between small"><span class="muted">{t('tron.fee.label')}</span><b>≈ {fmtAmount(plan.cost.total, 6, 4)} TRX</b></div>
          </div>
          {short && <div class="warn small">{t('tron.send.noTrxFee', { amount: `${fmtAmount(plan.cost.total + value, 6, 4)} TRX` })}</div>}
        </>
      )}
      {err && <div class="error small">{err}</div>}
      {done ? <div class="success small">{t('tronc.sent')} · <span class="mono">{shortAddr(done, 8)}</span></div>
        : <Btn kind={plan?.sim.ok === false ? 'danger' : 'primary'} loading={busy} disabled={!plan || short} onClick={send}>{t('tronc.send')}</Btn>}
    </Sheet>
  );
}

// ------------------------------------------------------------ info
function InfoTab({ c, chain, chainId, address, onAbi }) {
  const [text, setText] = useState('');
  const [err, setErr] = useState('');
  const saveAbi = async () => {
    setErr('');
    try {
      const j = JSON.parse(text);
      const abi = standardAbi(Array.isArray(j) ? j : j.abi || j.entrys ? j : []);
      if (!abi.length) throw new Error();
      await setCustomAbi(chainId, address, abi);
      onAbi();
    } catch { setErr(t('tronc.badAbi')); }
  };
  return (
    <>
      <div class="card kv">
        {c.name && <><span class="k">{t('tronc.name')}</span><span class="v">{c.name}</span></>}
        {c.owner && <><span class="k">{t('tronc.owner')}</span><span class="v mono">{shortAddr(c.owner, 6)}</span></>}
        <span class="k">{t('tronc.userPays')}</span><span class="v">{c.userPercent}%</span>
        {c.userPercent < 100 && <><span class="k">{t('tronc.ownerLimit')}</span><span class="v">{fmtNum(c.energyLimit, 0)}</span></>}
        <span class="k">{t('tronc.code')}</span><span class="v">{fmtNum(c.codeSize, 0)} B</span>
      </div>
      <div class="tiny muted">{t('tronc.energyShare')}</div>
      {(!c.abiOnChain || c.custom) && (
        <div class="card col" style={{ gap: '.5rem' }}>
          <b class="small">{t('tronc.pasteAbi')}</b>
          <textarea class="input mono" rows={4} value={text} placeholder='[{"type":"function", …}]' onInput={(e) => setText(e.target.value)} />
          {err && <div class="error small">{err}</div>}
          <div class="row">
            <Btn class="grow sm" disabled={!text.trim()} onClick={saveAbi}>{t('common.save')}</Btn>
            {c.custom && <Btn kind="secondary" class="grow sm" onClick={async () => { await setCustomAbi(chainId, address, null); onAbi(); }}>{t('tronc.clearAbi')}</Btn>}
          </div>
        </div>
      )}
    </>
  );
}
