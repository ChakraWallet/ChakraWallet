// Forms generated from a Tact ABI: init arguments, typed messages (receivers) and getter arguments; plus the Read and
// Write cards of a contract compiled and deployed from the app (its ABI is kept with the saved contract).
import { useState } from 'preact/hooks';
import { Icon, Switch, Spinner } from '../../../components.jsx';
import { t } from '../../../../shared/i18n.js';
import { parseAmount } from '../../../../shared/format.js';
import { fieldKind, emptyOf, typeLabel, tactMessageBody, tactStackArg, tactHint, tactReceivers } from '../../../../shared/ton/tact.js';
import { commentBody, toB64 } from '../../../../shared/ton/cells.js';
import { runGetter, interpret } from '../../../../shared/ton/contracts.js';
import { TonValue, exitText } from './parts.jsx';
import { errText } from './write.jsx';

/** One ABI field. value: string | boolean | { v, unit } (coins) | object (struct). */
function TactField({ f, value, onChange, types, abiTypes, chain, wallet }) {
  const k = fieldKind(f.type, types);
  const label = <span class="ct-label"><span>{f.name}</span><span class="ct-type">{typeLabel(f.type)}</span></span>;
  if (k.kind === 'struct') {
    const def = abiTypes.find((x) => x.name === k.type);
    const set = value && typeof value === 'object';
    return (
      <div class="ct-group">
        {label}
        {k.optional && <label class="ct-bool"><span class="small">{t('tonc.tact.setOptional')}</span><Switch on={set} onChange={(on) => onChange(on ? emptyOf({ ...f.type, optional: false }, types, abiTypes) : '')} /></label>}
        {set && <TactFields fields={def?.fields || []} values={value} onChange={onChange} types={types} abiTypes={abiTypes} chain={chain} wallet={wallet} />}
      </div>
    );
  }
  if (k.kind === 'bool' && !k.optional) return <div class="ct-field ct-bool">{label}<Switch on={value === true} onChange={onChange} /></div>;
  if (k.kind === 'bool') {
    return <div class="ct-field">{label}<select class="input" value={String(value)} onChange={(e) => onChange(e.target.value)}><option value="">null</option><option value="true">true</option><option value="false">false</option></select></div>;
  }
  if (k.kind === 'coins') {
    const v = value && typeof value === 'object' ? value : { v: '', unit: 9 };
    return (
      <div class="ct-field">
        {label}
        <div class="row" style={{ gap: '.375rem' }}>
          <input class="input mono" inputMode="decimal" value={v.v} placeholder={k.optional ? 'null' : '0'} onInput={(e) => onChange({ ...v, v: e.target.value })} />
          <select class="input ct-unit" value={v.unit} onChange={(e) => onChange({ ...v, unit: Number(e.target.value) })}><option value={9}>{chain.native.symbol}</option><option value={0}>{t('tonc.ft.raw')}</option></select>
        </div>
      </div>
    );
  }
  if (k.kind === 'unsupported') return <div class="ct-field">{label}<span class="tiny red">{t('tonc.tact.err.unsupportedField')}</span></div>;
  const multi = k.kind === 'cell' || k.kind === 'map';
  const ph = k.kind === 'address' ? 'UQ… / EQ…' : multi ? t('tonc.ft.bocHint') : k.kind === 'bytes' ? `${k.bytes * 2} hex` : k.optional ? 'null' : k.kind === 'string' ? '' : '0';
  return (
    <div class="ct-field">
      {label}
      <div class="row" style={{ gap: '.375rem' }}>
        {multi ? <textarea class="input mono" rows={2} value={value} placeholder={ph} spellcheck={false} autocapitalize="off" onInput={(e) => onChange(e.target.value)} />
          : <input class={`input ${k.kind === 'string' ? '' : 'mono'}`} value={value} placeholder={ph} spellcheck={false} autocapitalize="off" inputMode={k.kind === 'int' || k.kind === 'uint' ? 'numeric' : undefined} onInput={(e) => onChange(e.target.value)} />}
        {k.kind === 'address' && wallet && <button class="iconbtn" title={t('tonc.f.me')} onClick={() => onChange(wallet.address)}><Icon name="wallet" size={18} /></button>}
      </div>
    </div>
  );
}

/** The fields of a struct / message / init: values is an object by field name. */
export function TactFields({ fields, values, onChange, types, abiTypes, chain, wallet }) {
  return (
    <>
      {fields.map((f) => <TactField f={f} value={values?.[f.name]} onChange={(v) => onChange({ ...values, [f.name]: v })} types={types} abiTypes={abiTypes} chain={chain} wallet={wallet} />)}
    </>
  );
}

export const emptyValues = (fields, types, abiTypes) => Object.fromEntries((fields || []).map((f) => [f.name, emptyOf(f.type, types, abiTypes)]));

/** A getter of the ABI: typed arguments, typed results. */
export function TactGetterCard({ g, c, chain, me, onOpenAddress }) {
  const [open, setOpen] = useState(false);
  const [vals, setVals] = useState(() => Object.fromEntries(g.arguments.map((a) => [a.name, fieldKind(a.type).kind === 'coins' ? { v: '', unit: 9 } : ''])));
  const [busy, setBusy] = useState(false);
  const [res, setRes] = useState(null);
  const [err, setErr] = useState('');
  const run = async () => {
    setErr(''); setRes(null); setBusy(true);
    try { setRes(await runGetter(chain, c.address, g.name, g.arguments.map((a) => tactStackArg(a.type, vals[a.name])))); } catch (e) { setErr(errText(e)); }
    setBusy(false);
  };
  return (
    <div class={`ct-fn ${open ? 'open' : ''}`}>
      <button class="ct-fn-head" onClick={() => setOpen(!open)}>
        <span class="grow"><span class="ct-fn-name">{g.name}</span><span class="ct-fn-sig">({g.arguments.map((a) => `${a.name}: ${typeLabel(a.type)}`).join(', ')}){g.returnType ? `: ${typeLabel(g.returnType)}` : ''}</span></span>
        <span class="badge green">ABI</span>
        <Icon name="chevron" size={14} />
      </button>
      {open && (
        <div class="ct-fn-body">
          <TactFields fields={g.arguments} values={vals} onChange={setVals} types={{}} abiTypes={[]} chain={chain} wallet={me ? { address: me } : null} />
          {err && <div class="error">{err}</div>}
          {res && !res.ok && <div class="error">{t('tonc.step.exit', { code: res.exitCode })}: {exitText(res.exitCode)}</div>}
          {res?.ok && <div class="ct-result">{res.items.map((it) => <TonValue v={interpret(it, res.items.length === 1 ? tactHint(g.returnType) : null, {})} name={g.returnType?.type || ''} chain={chain} onOpenAddress={onOpenAddress} me={me} />)}</div>}
          <div class="row ct-fn-actions"><span class="grow" /><button class="btn primary sm" disabled={busy} onClick={run}>{busy ? <Spinner /> : t('contracts.fn.read')}</button></div>
        </div>
      )}
    </div>
  );
}

/** A receiver of the ABI: typed message (fields), fixed text, or free text. */
export function TactReceiverCard({ r, tact, c, chain, wallet, onSend }) {
  const def = r.kind === 'typed' ? tact.abi.types.find((x) => x.name === r.type) : null;
  const [open, setOpen] = useState(false);
  const [vals, setVals] = useState(() => emptyValues(def?.fields, tact.types, tact.abi.types));
  const [text, setText] = useState('');
  const [amount, setAmount] = useState('0.05');
  const [err, setErr] = useState('');
  const title = r.kind === 'typed' ? r.type : r.kind === 'text' ? `"${r.text}"` : t('tonc.tact.anyText');
  const review = () => {
    setErr('');
    try {
      const v = parseAmount(amount, 9);
      if (v == null) throw new Error(t('tonc.err.amount'));
      const body = r.kind === 'typed' ? tactMessageBody(r.type, vals, tact.types) : commentBody(r.kind === 'text' ? r.text : text);
      onSend({ title, risks: [], summary: [[t('tonc.f.amount'), `${amount} ${chain.native.symbol}`]], messages: [{ to: c.address, value: String(v), bounce: true, body: toB64(body) }] });
    } catch (e) { setErr(e.path ? `${e.path}: ${errText(e)}` : errText(e)); }
  };
  return (
    <div class={`ct-fn ${open ? 'open' : ''}`}>
      <button class="ct-fn-head" onClick={() => setOpen(!open)}>
        <span class="grow"><span class="ct-fn-name">{title}</span><span class="ct-fn-sig">{r.kind === 'typed' ? `op 0x${(tact.types[r.type]?.header ?? 0).toString(16).padStart(8, '0')} · ${(def?.fields || []).map((f) => f.name).join(', ') || '—'}` : t('tonc.tact.textMessage')}</span></span>
        <span class="badge green">ABI</span>
        <Icon name="chevron" size={14} />
      </button>
      {open && (
        <div class="ct-fn-body">
          {def && <TactFields fields={def.fields} values={vals} onChange={setVals} types={tact.types} abiTypes={tact.abi.types} chain={chain} wallet={wallet} />}
          {r.kind === 'anyText' && <div class="ct-field"><span class="ct-label"><span>{t('tonc.f.comment')}</span></span><input class="input" value={text} onInput={(e) => setText(e.target.value)} /></div>}
          <div class="ct-field">
            <span class="ct-label"><span>{t('tonc.f.amount')}</span><span class="ct-type">{chain.native.symbol}</span></span>
            <input class="input mono" inputMode="decimal" value={amount} onInput={(e) => setAmount(e.target.value)} />
          </div>
          {err && <div class="error">{err}</div>}
          <div class="row ct-fn-actions"><span class="grow" /><button class="btn primary sm" onClick={review}>{t('tonc.write.review')}</button></div>
        </div>
      )}
    </div>
  );
}

/** Receivers worth a card (the empty one is the plain GRAM transfer, already there). */
export const receiverCards = (tact) => tactReceivers(tact?.abi).filter((r) => r.kind === 'typed' || r.kind === 'text' || r.kind === 'anyText');
