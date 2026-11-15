// Guided forms for ABI functions: one field per parameter (address, numbers with units, bool, bytes, string, arrays,
// structs) and an advanced mode (JSON arguments, raw calldata, caller / block for reads). Results and reverts readable.
import { useState } from 'preact/hooks';
import { Icon, Spinner, Switch, Sheet, Avatar, useApp } from '../../components.jsx';
import { isEvmAccount } from '../../chains/index.js';
import { emptyValue, toArgs, argsFromJson, display, words, suggestUnit, toJson, parseInteger, ArgError } from '../../../shared/abiInput.js';
import { encodeCall, decodeResult, simulate, decodeRevert } from '../../../shared/contracts.js';
import { shortAddr, fmtDateTime } from '../../../shared/format.js';
import { t } from '../../../shared/i18n.js';
import { isAddress } from 'ethers';

const copy = async (text, toast) => { await navigator.clipboard.writeText(text); toast(t('common.copied')); };

/** Message of an argument error, with the name of the field. */
export function argMessage(e, inputs = []) {
  if (!(e instanceof ArgError)) return e?.message || String(e);
  const [i, ...rest] = String(e.path ?? '').split('.');
  const p = inputs[Number(i)];
  const field = p ? (p.name || `#${i}`) + rest.map((x) => `[${x}]`).join('') : '';
  return `${field ? field + ': ' : ''}${t(e.key, e.vars)}`;
}

// ------------------------------------------------------------ fields
function Label({ p, idx }) {
  return <span class="ct-label"><span>{p.name || (idx != null ? `#${idx}` : '')}</span><span class="ct-type">{p.type}</span></span>;
}

function AccountPick({ onPick, onClose }) {
  const { state } = useApp();
  return (
    <Sheet title={t('contracts.form.myAccounts')} onClose={onClose}>
      <div class="list">
        {state.accounts.filter(isEvmAccount).map((a) => (
          <button class="item" onClick={() => { onPick(a.address); onClose(); }}>
            <Avatar address={a.address} /><div class="grow"><div class="bold">{a.name}</div><div class="small muted mono">{shortAddr(a.address, 6)}</div></div>
          </button>
        ))}
      </div>
    </Sheet>
  );
}

function AddressField({ p, idx, value, onChange }) {
  const { state } = useApp();
  const [pick, setPick] = useState(false);
  const v = String(value || '').trim();
  const mine = isAddress(v) && state.accounts.find((a) => a.address.toLowerCase() === v.toLowerCase());
  return (
    <div class="ct-field">
      <Label p={p} idx={idx} />
      <div class="row" style={{ gap: '.375rem' }}>
        <input class="input mono" value={value} placeholder="0x…" spellcheck={false} autocapitalize="off" onInput={(e) => onChange(e.target.value)} />
        <button class="iconbtn" title={t('contracts.form.myAccounts')} onClick={() => setPick(true)}><Icon name="wallet" size={18} /></button>
      </div>
      {v && !isAddress(v) && <span class="tiny red">{t('contracts.err.badAddress')}</span>}
      {mine && <span class="tiny green">{mine.name}</span>}
      {pick && <AccountPick onPick={onChange} onClose={() => setPick(false)} />}
    </div>
  );
}

const TIME_PRESETS = [['10m', 600], ['1h', 3600], ['1d', 86400], ['7d', 604800]];

function NumberField({ p, idx, value, onChange, unit, setUnit, token, chain }) {
  const units = [[0, t('contracts.form.unitRaw')]];
  if (/^uint/.test(p.type)) {
    units.push([9, 'gwei'], [18, chain?.native?.symbol || 'ether']);
    if (token?.decimals != null && ![0, 9, 18].includes(token.decimals)) units.push([token.decimals, token.symbol || `10^${token.decimals}`]);
    else if (token?.decimals === 18 && token.symbol) units[2] = [18, `${token.symbol} / ${chain?.native?.symbol || 'ether'}`];
  }
  let preview = null;
  if (unit && String(value).trim()) { try { preview = parseInteger(value, unit).toString(); } catch { preview = null; } }
  const timeLike = /^uint/.test(p.type) && /deadline|expir|until|time|end|start|unlock/i.test(p.name || '');
  return (
    <div class="ct-field">
      <Label p={p} idx={idx} />
      <div class="row" style={{ gap: '.375rem' }}>
        <input class="input mono" inputMode="decimal" value={value} placeholder="0" spellcheck={false} autocapitalize="off" onInput={(e) => onChange(e.target.value)} />
        {units.length > 1 && (
          <select class="input ct-unit" value={unit || 0} onChange={(e) => setUnit(Number(e.target.value))}>
            {units.map(([d, l]) => <option value={d}>{l}</option>)}
          </select>
        )}
      </div>
      {preview && <span class="tiny muted mono">= {preview}</span>}
      {timeLike && (
        <div class="pills">
          {TIME_PRESETS.map(([l, s]) => <button class="pill" onClick={() => { setUnit(0); onChange(String(Math.floor(Date.now() / 1000) + s)); }}>{t('contracts.form.inTime', { t: l })}</button>)}
        </div>
      )}
    </div>
  );
}

/** One parameter of any type (recursive for arrays and tuples). path: '0', '1.2', ... (units are kept by path). */
export function ParamInput({ p, value, onChange, path, units, setUnits, token, chain, idx, bare }) {
  const setUnit = (d) => setUnits({ ...units, [path]: d });
  const label = bare ? null : <Label p={p} idx={idx} />;
  if (p.baseType === 'tuple') {
    return (
      <div class="ct-group">
        {label}
        {p.components.map((c, i) => (
          <ParamInput p={c} idx={i} value={value?.[i]} path={`${path}.${i}`} units={units} setUnits={setUnits} token={token} chain={chain}
            onChange={(v) => { const n = [...(value || [])]; n[i] = v; onChange(n); }} />
        ))}
      </div>
    );
  }
  if (p.baseType === 'array') {
    const fixed = p.arrayLength > 0;
    const list = value || [];
    return (
      <div class="ct-group">
        {label}
        {list.map((v, i) => (
          <div class="ct-arr-row">
            <span class="ct-idx">{i}</span>
            <div class="grow">
              <ParamInput p={p.arrayChildren} bare value={v} path={`${path}.${i}`} units={units} setUnits={setUnits} token={token} chain={chain}
                onChange={(x) => { const n = [...list]; n[i] = x; onChange(n); }} />
            </div>
            {!fixed && <button class="iconbtn sm" title={t('common.delete')} onClick={() => onChange(list.filter((_, j) => j !== i))}><Icon name="close" size={14} /></button>}
          </div>
        ))}
        {!fixed && <button class="link ct-add" onClick={() => onChange([...list, emptyValue(p.arrayChildren)])}><Icon name="plus" size={14} /> {t('contracts.form.addItem')}</button>}
        {!fixed && !list.length && <span class="tiny muted">{t('contracts.form.emptyArray')}</span>}
      </div>
    );
  }
  if (p.baseType === 'bool') return <div class="ct-field ct-bool">{label}<Switch on={!!value} onChange={onChange} /></div>;
  if (p.baseType === 'address') return <AddressField p={p} idx={idx} value={value} onChange={onChange} />;
  if (/^u?int/.test(p.baseType)) return <NumberField p={p} idx={idx} value={value} onChange={onChange} unit={units[path]} setUnit={setUnit} token={token} chain={chain} />;
  const isStr = p.baseType === 'string';
  return (
    <div class="ct-field">
      {label}
      <input class={`input ${isStr ? '' : 'mono'}`} value={value} spellcheck={false} autocapitalize="off" placeholder={isStr ? '' : t('contracts.form.bytesHint')} onInput={(e) => onChange(e.target.value)} />
    </div>
  );
}

/** Units suggested for the top-level numeric fields (token amounts in transfer/approve/mint...). */
const initialUnits = (fn, token) => Object.fromEntries(fn.inputs.map((p, i) => [String(i), suggestUnit(p, fn.name, token)]).filter(([, d]) => d));

// ------------------------------------------------------------ results
function subText(sub, token) {
  if (sub.kind === 'time') return fmtDateTime(sub.ms);
  if (sub.kind === 'units') return `= ${sub.text} ${token?.symbol || ''}`;
  if (sub.kind === 'ether') return t('contracts.result.as18', { v: sub.text });
  if (sub.kind === 'text') return `"${sub.text}"`;
  return '';
}

export function ValueNode({ n, token, onOpenAddress }) {
  const { toast } = useApp();
  if (n.children) {
    return (
      <div class="ct-node">
        {(n.name || n.type) && <div class="ct-node-k">{n.name && <b>{n.name}</b>} <span class="ct-type">{n.type}</span>{n.count != null ? <span class="ct-type"> · {n.count}</span> : null}</div>}
        <div class="ct-node-c">{n.children.map((c, i) => <ValueNode n={{ ...c, name: c.name || (n.count != null ? `[${i}]` : '') }} token={token} onOpenAddress={onOpenAddress} />)}</div>
      </div>
    );
  }
  return (
    <div class="ct-node">
      {n.name && <div class="ct-node-k"><b>{n.name}</b> <span class="ct-type">{n.type}</span></div>}
      <div class="ct-node-v">
        <span class={n.mono ? 'mono' : ''}>{n.text}</span>
        <button class="iconbtn sm" title={t('common.copy')} onClick={() => copy(n.text, toast)}><Icon name="copy" size={13} /></button>
        {n.address && onOpenAddress && !/^0x0{40}$/i.test(n.address) && <button class="iconbtn sm" title={t('contracts.openAsContract')} onClick={() => onOpenAddress(n.address)}><Icon name="forward" size={13} /></button>}
      </div>
      {n.sub && <div class="tiny muted">{subText(n.sub, token)}</div>}
    </div>
  );
}

/** Decoded outputs of a function, or the raw words when the output types are unknown. */
export function ResultView({ fn, data, token, onOpenAddress }) {
  const { toast } = useApp();
  let decoded = null;
  try { decoded = decodeResult(fn, data); } catch { decoded = null; }
  if (decoded && fn.outputs.length) {
    return <div class="ct-result">{fn.outputs.map((p, i) => <ValueNode n={display(p, decoded[i], { decimals: token?.decimals, fn: fn.name })} token={token} onOpenAddress={onOpenAddress} />)}</div>;
  }
  const w = words(data);
  return (
    <div class="ct-result">
      {!w.length ? <span class="small muted">{t('contracts.result.noData')}</span> : (
        <>
          <span class="tiny muted">{t('contracts.result.raw')}</span>
          {w.map((x) => <span class="mono tiny">{x}</span>)}
          <button class="link" onClick={() => copy(data, toast)}>{t('common.copy')}</button>
        </>
      )}
    </div>
  );
}

/** A decoded revert. */
export function RevertView({ r, message }) {
  let body;
  if (!r) body = <span>{message || t('contracts.revert.unknown')}</span>;
  else if (r.kind === 'empty') body = <span>{t('contracts.revert.empty')}</span>;
  else if (r.kind === 'reason') body = <span>“{r.message}”</span>;
  else if (r.kind === 'panic') body = <span>{t(`contracts.panic.${r.panic}`)} <span class="mono tiny">(0x{r.code.toString(16)})</span></span>;
  else if (r.kind === 'custom') {
    body = (
      <span>
        <b class="mono">{r.name}</b>({(r.inputs || []).map((p, i) => <span>{i ? ', ' : ''}{p.name ? `${p.name}: ` : ''}<span class="mono">{String(r.args?.[i])}</span></span>)})
        {r.guessed && <span class="tiny"> · {t('contracts.revert.guessed')}</span>}
      </span>
    );
  } else body = <span class="mono tiny">{r.data}</span>;
  return <div class="error"><b>{t('contracts.revert.title')}</b> {body}</div>;
}

// ------------------------------------------------------------ function card
/**
 * A function of the contract: fields, then Read (view) or Simulate / Send (writes).
 * onSend({ to, data, value, fn, args }) opens the transaction review.
 */
export function FnCard({ fn, contract, chain, onSend, onOpenAddress, startOpen }) {
  const { account } = useApp();
  const [open, setOpen] = useState(!!startOpen);
  const [vals, setVals] = useState(() => fn.inputs.map(emptyValue));
  const [units, setUnits] = useState(() => initialUnits(fn, contract.token));
  const [adv, setAdv] = useState(false);
  const [json, setJson] = useState('');
  const [raw, setRaw] = useState('');
  const [value, setValue] = useState('');
  const [from, setFrom] = useState('');
  const [block, setBlock] = useState('');
  const [busy, setBusy] = useState(false);
  const [res, setRes] = useState(null);
  const [err, setErr] = useState('');
  const custom = fn.custom; // free call: any calldata
  const showValue = fn.payable || custom || (adv && !fn.read);

  const build = () => {
    let data, args = null;
    if (fn.unknown || custom) {
      const d = raw.trim().replace(/\s+/g, '');
      if (d && !/^0x[0-9a-fA-F]*$|^[0-9a-fA-F]*$/.test(d)) throw new ArgError('contracts.err.badHex', '');
      const body = d.replace(/^0x/, '');
      if (body.length % 2) throw new ArgError('contracts.err.badHex', '');
      data = custom ? '0x' + body : body.toLowerCase().startsWith(fn.selector.slice(2)) ? '0x' + body : fn.selector + body;
    } else {
      args = adv && json.trim() ? argsFromJson(fn.inputs, json) : toArgs(fn.inputs, vals, { units });
      data = encodeCall(fn, args);
    }
    const v = value.trim() ? parseInteger(value, chain.native.decimals) : 0n;
    return { data, value: v, args };
  };
  const blockTag = () => { const b = block.trim(); return !b ? 'latest' : /^\d+$/.test(b) ? '0x' + BigInt(b).toString(16) : b; };

  const run = async () => {
    setErr(''); setRes(null);
    let b;
    try { b = build(); } catch (e) { setErr(argMessage(e, fn.inputs)); return; }
    const caller = adv && from.trim() ? from.trim() : account.address;
    if (adv && from.trim() && !isAddress(caller)) { setErr(t('contracts.err.badAddress')); return; }
    setBusy(true);
    try {
      const r = await simulate(chain, { from: caller, to: contract.address, data: b.data, value: b.value, block: adv ? blockTag() : 'latest' });
      if (r.ok) setRes({ ok: true, data: r.result });
      else setRes({ ok: false, revert: r.revert != null ? await decodeRevert(r.revert, contract.iface) : null, message: r.message });
    } catch (e) { setErr(e.message); }
    setBusy(false);
  };
  const send = () => {
    setErr('');
    let b;
    try { b = build(); } catch (e) { setErr(argMessage(e, fn.inputs)); return; }
    onSend({ to: contract.address, data: b.data, value: b.value, fn, args: b.args });
  };
  const calldata = (() => { try { return open && adv ? build().data : null; } catch { return null; } })();

  return (
    <div class={`ct-fn ${open ? 'open' : ''}`}>
      <button class="ct-fn-head" onClick={() => setOpen(!open)}>
        <span class="grow">
          <span class="ct-fn-name">{custom ? t('contracts.custom.title') : fn.name || fn.selector}</span>
          <span class="ct-fn-sig">{custom ? t('contracts.custom.sub') : fn.unknown ? t('contracts.fn.unknownSig') : fn.inputs.map((p) => `${p.type}${p.name ? ' ' + p.name : ''}`).join(', ') || '—'}</span>
        </span>
        {fn.payable && <span class="badge amber">payable</span>}
        {fn.guessed && !fn.unknown && <span class="badge" title={t('contracts.fn.guessedHint')}>{t('contracts.fn.guessed')}</span>}
        <Icon name="chevron" size={14} />
      </button>
      {open && (
        <div class="ct-fn-body">
          {!fn.unknown && !custom && !(adv && json.trim()) && fn.inputs.map((p, i) => (
            <ParamInput p={p} idx={i} value={vals[i]} path={String(i)} units={units} setUnits={setUnits} token={contract.token} chain={chain}
              onChange={(v) => { const n = [...vals]; n[i] = v; setVals(n); }} />
          ))}
          {(fn.unknown || custom) && (
            <div class="ct-field">
              <span class="ct-label"><span>{custom ? t('contracts.custom.data') : t('contracts.fn.rawArgs')}</span></span>
              <textarea class="input mono" rows={3} value={raw} placeholder={custom ? '0x…' : `${fn.selector}…`} spellcheck={false} autocapitalize="off" onInput={(e) => setRaw(e.target.value)} />
            </div>
          )}
          {showValue && (
            <div class="ct-field">
              <span class="ct-label"><span>{t('contracts.fn.value')}</span><span class="ct-type">{chain.native.symbol}</span></span>
              <input class="input mono" inputMode="decimal" value={value} placeholder="0" onInput={(e) => setValue(e.target.value)} />
            </div>
          )}
          {adv && (
            <div class="ct-adv">
              {!fn.unknown && !custom && fn.inputs.length > 0 && (
                <div class="ct-field">
                  <span class="ct-label"><span>{t('contracts.fn.json')}</span></span>
                  <textarea class="input mono" rows={3} value={json} placeholder={`[${fn.inputs.map((p) => `"${p.type}"`).join(', ')}]`} spellcheck={false} autocapitalize="off" onInput={(e) => setJson(e.target.value)} />
                  <span class="tiny muted">{t('contracts.fn.jsonHint')}</span>
                </div>
              )}
              <div class="ct-field">
                <span class="ct-label"><span>{t('contracts.fn.from')}</span></span>
                <input class="input mono" value={from} placeholder={account.address} spellcheck={false} autocapitalize="off" onInput={(e) => setFrom(e.target.value)} />
              </div>
              <div class="ct-field">
                <span class="ct-label"><span>{t('contracts.fn.block')}</span></span>
                <input class="input mono" value={block} placeholder="latest" spellcheck={false} autocapitalize="off" onInput={(e) => setBlock(e.target.value)} />
              </div>
              {calldata && <div class="ct-field"><span class="ct-label"><span>calldata</span></span><span class="mono tiny ct-calldata">{calldata}</span></div>}
            </div>
          )}
          {err && <div class="error">{err}</div>}
          {res && (res.ok ? <ResultView fn={fn} data={res.data} token={contract.token} onOpenAddress={onOpenAddress} /> : <RevertView r={res.revert} message={res.message} />)}
          {res?.ok && !fn.read && <div class="tiny muted">{t('contracts.fn.simOk')}</div>}
          <div class="row ct-fn-actions">
            <button class="link" onClick={() => setAdv(!adv)}>{adv ? t('contracts.fn.lessOptions') : t('contracts.fn.moreOptions')}</button>
            <span class="grow" />
            {fn.read ? (
              <button class="btn primary sm" disabled={busy} onClick={run}>{busy ? <Spinner /> : t('contracts.fn.read')}</button>
            ) : (
              <>
                <button class="btn secondary sm" disabled={busy} onClick={run}>{busy ? <Spinner /> : t('contracts.fn.simulate')}</button>
                <button class="btn primary sm" onClick={send}>{t('contracts.fn.send')}</button>
              </>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

export { toJson };
