// Forms for Solana programs: one field per argument of an IDL instruction (numbers, text, addresses, bytes, options,
// lists, structs, enums), the instruction's accounts (filled where they can be: the wallet, well-known programs,
// program-derived addresses), simulation, then the review; and a free instruction for programs without an IDL.
import { useMemo, useState } from 'preact/hooks';
import { Icon, Spinner, Switch } from '../../../components.jsx';
import { t } from '../../../../shared/i18n.js';
import { isAddress } from '../../../../shared/solana/core.js';
import { autoAccounts, buildIxFromIdl, toBytes, idlError, isIntType, showValue, decode } from '../../../../shared/solana/idl.js';
import { plan } from '../../../solana/tx.js';
import { SolValue } from './parts.jsx';

const typeText = (t0) => (typeof t0 === 'string' ? t0 : t0.vec ? `Vec<${typeText(t0.vec)}>` : t0.option ? `Option<${typeText(t0.option)}>` : t0.coption ? `COption<${typeText(t0.coption)}>`
  : t0.array ? `[${typeText(t0.array[0])}; ${t0.array[1]}]` : t0.defined || '?');

/** The starting value of a field of a type. */
export function emptyValue(type, types) {
  if (type === 'bool') return false;
  if (typeof type === 'string') return '';
  if (type.option || type.coption) return null;
  if (type.vec) return [];
  if (type.array) return type.array[0] === 'u8' ? '' : Array.from({ length: type.array[1] }, () => emptyValue(type.array[0], types));
  if (type.defined) {
    const d = types.get(type.defined);
    if (!d) return '';
    if (d.kind === 'alias') return emptyValue(d.type, types);
    if (d.kind === 'struct') return Object.fromEntries(d.fields.map((f) => [f.name, emptyValue(f.type, types)]));
    if (d.kind === 'tuple') return Object.fromEntries(d.fields.map((f, i) => [`_${i}`, emptyValue(f, types)]));
    if (d.kind === 'enum') return variantValue(d.variants[0], types);
  }
  return '';
}
const variantValue = (vr, types) => ({
  __variant: vr.name,
  ...Object.fromEntries((vr.fields || []).map((f) => [f.name, emptyValue(f.type, types)])),
  ...Object.fromEntries((vr.tuple || []).map((f, i) => [`_${i}`, emptyValue(f, types)])),
});

/** A field for a value of an IDL type (recursive for options, lists, structs, enums). */
export function TypeInput({ name, type, types, value, onChange, me }) {
  const label = <span class="ct-label"><span>{name}</span><span class="ct-type">{typeText(type)}</span></span>;
  if (type === 'bool') return <div class="ct-field row between">{label}<Switch on={!!value} onChange={onChange} /></div>;
  if (type === 'pubkey') {
    const v = String(value || '').trim();
    return (
      <div class="ct-field">
        {label}
        <div class="row" style={{ gap: '.375rem' }}>
          <input class="input mono" value={value} placeholder={t('solc.form.address')} spellcheck={false} autocapitalize="off" onInput={(e) => onChange(e.target.value)} />
          {me && <button class="iconbtn" title={t('solc.form.me')} onClick={() => onChange(me)}><Icon name="wallet" size={18} /></button>}
        </div>
        {v && !isAddress(v) && <span class="tiny red">{t('contracts.err.badAddress')}</span>}
      </div>
    );
  }
  if (typeof type === 'string' || (type.array && type.array[0] === 'u8') || (type.vec === 'u8')) {
    const num = isIntType(type) || type === 'f32' || type === 'f64';
    const bytes = type === 'bytes' || type.array || type.vec;
    return (
      <div class="ct-field">
        {label}
        <input class={`input ${num || bytes ? 'mono' : ''}`} inputMode={num ? 'decimal' : undefined} value={value} placeholder={bytes ? '0x…' : num ? '0' : ''}
          spellcheck={false} autocapitalize="off" onInput={(e) => onChange(e.target.value)} />
      </div>
    );
  }
  if (type.option || type.coption) {
    const inner = type.option || type.coption;
    const on = value !== null && value !== undefined;
    return (
      <div class="ct-field">
        <div class="row between">{label}<Switch on={on} onChange={(x) => onChange(x ? emptyValue(inner, types) : null)} /></div>
        {on && <div class="sol-nest"><TypeInput name={t('solc.form.value')} type={inner} types={types} value={value} onChange={onChange} me={me} /></div>}
      </div>
    );
  }
  if (type.vec || type.array) {
    const inner = type.vec || type.array[0];
    const list = Array.isArray(value) ? value : [];
    const fixed = !!type.array;
    return (
      <div class="ct-field">
        {label}
        <div class="sol-nest col" style={{ gap: '.375rem' }}>
          {list.map((x, i) => (
            <div class="row" style={{ gap: '.25rem', alignItems: 'flex-start' }}>
              <div class="grow"><TypeInput name={`${i}`} type={inner} types={types} value={x} me={me} onChange={(v) => { const n = [...list]; n[i] = v; onChange(n); }} /></div>
              {!fixed && <button class="iconbtn sm" title={t('solc.form.remove')} onClick={() => onChange(list.filter((_, k) => k !== i))}><Icon name="trash" size={14} /></button>}
            </div>
          ))}
          {!fixed && <button class="link small" onClick={() => onChange([...list, emptyValue(inner, types)])}><Icon name="plus" size={12} /> {t('solc.form.add')}</button>}
        </div>
      </div>
    );
  }
  if (type.defined) {
    const d = types.get(type.defined);
    if (!d) return <div class="ct-field">{label}<span class="tiny red">{t('solc.form.unknownType', { name: type.defined })}</span></div>;
    if (d.kind === 'alias') return <TypeInput name={name} type={d.type} types={types} value={value} onChange={onChange} me={me} />;
    if (d.kind === 'struct' || d.kind === 'tuple') {
      const fields = d.kind === 'struct' ? d.fields : d.fields.map((f, i) => ({ name: `_${i}`, type: f }));
      return (
        <div class="ct-field">
          {label}
          <div class="sol-nest col" style={{ gap: '.375rem' }}>
            {fields.map((f) => <TypeInput name={f.name} type={f.type} types={types} value={value?.[f.name]} me={me} onChange={(v) => onChange({ ...(value || {}), [f.name]: v })} />)}
          </div>
        </div>
      );
    }
    if (d.kind === 'enum') {
      const vr = d.variants.find((x) => x.name === value?.__variant) || d.variants[0];
      const fields = vr.fields || (vr.tuple || []).map((f, i) => ({ name: `_${i}`, type: f }));
      return (
        <div class="ct-field">
          {label}
          <select class="input" value={vr.name} onChange={(e) => onChange(variantValue(d.variants.find((x) => x.name === e.target.value), types))}>
            {d.variants.map((x) => <option value={x.name}>{x.name}</option>)}
          </select>
          {fields.length > 0 && <div class="sol-nest col" style={{ gap: '.375rem' }}>
            {fields.map((f) => <TypeInput name={f.name} type={f.type} types={types} value={value?.[f.name]} me={me} onChange={(v) => onChange({ ...value, __variant: vr.name, [f.name]: v })} />)}
          </div>}
        </div>
      );
    }
  }
  return <div class="ct-field">{label}<span class="tiny red">{t('solc.form.unsupported')}</span></div>;
}

/** The outcome of a simulation, readable: success / the program's error (named by the IDL), its log, returned data. */
export function SimView({ sim, idl, returnType }) {
  const [logs, setLogs] = useState(false);
  if (!sim) return null;
  const named = sim.problem ? idlError(idl, JSON.stringify(sim.sim?.err || '') + (sim.logs || []).join(' ')) : null;
  let ret = null;
  const rd = sim.sim?.returnData?.data?.[0];
  if (rd) {
    const bytes = Uint8Array.from(atob(rd), (c) => c.charCodeAt(0));
    try { ret = returnType ? decode(returnType, bytes, 0, idl.types)[0] : bytes; } catch { ret = bytes; }
  }
  return (
    <div class="col" style={{ gap: '.375rem' }}>
      <div class={sim.problem ? 'error' : 'success'}>{sim.problem ? (named ? `${named.name}: ${named.msg || named.code}` : sim.problem) : t('solc.sim.ok', { units: sim.units })}</div>
      {ret != null && <div class="card col"><span class="tiny muted">{t('solc.sim.returned')}</span><SolValue v={ret} /></div>}
      {sim.logs?.length > 0 && <button class="link tiny" onClick={() => setLogs(!logs)}>{logs ? t('solc.sim.hideLogs') : t('solc.sim.showLogs', { n: sim.logs.length })}</button>}
      {logs && <pre class="ct-log mono tiny">{sim.logs.join('\n')}</pre>}
    </div>
  );
}

/** An instruction of the program's IDL, as a collapsible card: arguments, accounts, simulate, review. */
export function IxCard({ idl, ix, programId, chain, wallet, onSend, startOpen }) {
  const [open, setOpen] = useState(!!startOpen);
  const [args, setArgs] = useState(() => Object.fromEntries(ix.args.map((a) => [a.name, emptyValue(a.type, idl.types)])));
  const [given, setGiven] = useState({}); // accounts typed by the user
  const [busy, setBusy] = useState(false);
  const [sim, setSim] = useState(null);
  const [err, setErr] = useState('');
  const me = wallet?.raw || null;
  const accounts = useMemo(() => {
    try { return autoAccounts(idl, ix, { programId, me, args, given }); } catch { return { ...given }; }
  }, [args, given, me]);
  const build = () => buildIxFromIdl(idl, ix, { programId, args, accounts });
  const simulateIt = async () => {
    setErr(''); setSim(null);
    let instr;
    try { instr = build(); } catch (e) { setErr(e.message); return; }
    if (!me) { setErr(t('solc.noKey')); return; }
    setBusy(true);
    try { setSim(await plan(chain, { payer: me, instructions: [instr] })); } catch (e) { setErr(e.message); }
    setBusy(false);
  };
  const review = () => {
    setErr('');
    let instr;
    try { instr = build(); } catch (e) { setErr(e.message); return; }
    onSend({
      title: ix.name, idl, instructions: [instr],
      summary: [...ix.args.map((a) => [a.name, showValue(args[a.name]).replace(/^"|"$/g, '')]), ...ix.accounts.filter((a) => a.writable).map((a) => [`${a.name} ✎`, accounts[a.name] || '—'])],
    });
  };
  return (
    <div class={`ct-fn ${open ? 'open' : ''}`}>
      <button class="ct-fn-head" onClick={() => setOpen(!open)}>
        <span class="grow">
          <span class="ct-fn-name">{ix.name}</span>
          <span class="ct-fn-sig">{ix.args.map((a) => `${a.name}: ${typeText(a.type)}`).join(', ') || '—'}</span>
        </span>
        <Icon name="chevron" size={14} />
      </button>
      {open && (
        <div class="ct-fn-body">
          {ix.docs.length > 0 && <span class="tiny muted">{ix.docs.join(' ')}</span>}
          {ix.args.map((a) => <TypeInput name={a.name} type={a.type} types={idl.types} value={args[a.name]} me={me} onChange={(v) => setArgs({ ...args, [a.name]: v })} />)}
          <div class="group-title tiny">{t('solc.form.accounts')}</div>
          {ix.accounts.map((a) => {
            const v = accounts[a.name] || '';
            const auto = !given[a.name] && !!v;
            return (
              <div class="ct-field">
                <span class="ct-label">
                  <span>{a.name}</span>
                  <span class="ct-type">{[a.signer && t('solc.form.signer'), a.writable && t('solc.form.writable'), a.optional && t('solc.form.optional'), a.pda && 'PDA'].filter(Boolean).join(' · ')}</span>
                </span>
                <div class="row" style={{ gap: '.375rem' }}>
                  <input class="input mono" value={v} placeholder={a.optional ? t('solc.form.optionalHint') : t('solc.form.address')} spellcheck={false} autocapitalize="off"
                    onInput={(e) => setGiven({ ...given, [a.name]: e.target.value.trim() })} />
                  {me && !a.address && <button class="iconbtn" title={t('solc.form.me')} onClick={() => setGiven({ ...given, [a.name]: me })}><Icon name="wallet" size={18} /></button>}
                </div>
                {auto && <span class="tiny muted">{a.pda ? t('solc.form.derived') : t('solc.form.auto')}</span>}
                {v && !isAddress(v) && <span class="tiny red">{t('contracts.err.badAddress')}</span>}
              </div>
            );
          })}
          {err && <div class="error">{err}</div>}
          <SimView sim={sim} idl={idl} returnType={ix.returns} />
          <div class="row ct-fn-actions">
            <span class="grow" />
            <button class="btn secondary sm" disabled={busy} onClick={simulateIt}>{busy ? <Spinner /> : t('contracts.fn.simulate')}</button>
            <button class="btn primary sm" onClick={review}>{t('contracts.fn.send')}</button>
          </div>
        </div>
      )}
    </div>
  );
}

/** A free instruction to any program: accounts with their roles and the data (hex), for programs without an IDL. */
export function RawIxCard({ programId, chain, wallet, onSend }) {
  const [open, setOpen] = useState(false);
  const [keys, setKeys] = useState([]);
  const [data, setData] = useState('');
  const [busy, setBusy] = useState(false);
  const [sim, setSim] = useState(null);
  const [err, setErr] = useState('');
  const me = wallet?.raw || null;
  const build = () => {
    for (const k of keys) if (!isAddress(k.pubkey)) throw new Error(t('contracts.err.badAddress'));
    let bytes;
    try { bytes = toBytes(data.trim()); } catch { throw new Error(t('contracts.err.badHex')); }
    return { programId, keys: keys.map((k) => ({ pubkey: k.pubkey.trim(), isSigner: k.isSigner, isWritable: k.isWritable })), data: bytes };
  };
  const simulateIt = async () => {
    setErr(''); setSim(null);
    let ix;
    try { ix = build(); } catch (e) { setErr(e.message); return; }
    if (!me) { setErr(t('solc.noKey')); return; }
    setBusy(true);
    try { setSim(await plan(chain, { payer: me, instructions: [ix] })); } catch (e) { setErr(e.message); }
    setBusy(false);
  };
  const review = () => {
    setErr('');
    let ix;
    try { ix = build(); } catch (e) { setErr(e.message); return; }
    onSend({ title: t('solc.raw.title'), instructions: [ix], summary: [[t('solc.raw.data'), data.trim() || '—'], [t('solc.form.accounts'), String(keys.length)]] });
  };
  const set = (i, patch) => setKeys(keys.map((k, j) => (j === i ? { ...k, ...patch } : k)));
  return (
    <div class={`ct-fn ${open ? 'open' : ''}`}>
      <button class="ct-fn-head" onClick={() => setOpen(!open)}>
        <span class="grow"><span class="ct-fn-name">{t('solc.raw.title')}</span><span class="ct-fn-sig">{t('solc.raw.sub')}</span></span>
        <Icon name="chevron" size={14} />
      </button>
      {open && (
        <div class="ct-fn-body">
          <div class="group-title tiny">{t('solc.form.accounts')}</div>
          {keys.map((k, i) => (
            <div class="card col" style={{ gap: '.375rem', padding: '.5rem' }}>
              <div class="row" style={{ gap: '.375rem' }}>
                <input class="input mono" value={k.pubkey} placeholder={t('solc.form.address')} spellcheck={false} autocapitalize="off" onInput={(e) => set(i, { pubkey: e.target.value })} />
                {me && <button class="iconbtn" title={t('solc.form.me')} onClick={() => set(i, { pubkey: me, isSigner: true })}><Icon name="wallet" size={18} /></button>}
                <button class="iconbtn" title={t('solc.form.remove')} onClick={() => setKeys(keys.filter((_, j) => j !== i))}><Icon name="trash" size={16} /></button>
              </div>
              <div class="row" style={{ gap: '1rem' }}>
                <label class="row small" style={{ gap: '.375rem' }}><input type="checkbox" checked={k.isSigner} onChange={(e) => set(i, { isSigner: e.target.checked })} /> {t('solc.form.signer')}</label>
                <label class="row small" style={{ gap: '.375rem' }}><input type="checkbox" checked={k.isWritable} onChange={(e) => set(i, { isWritable: e.target.checked })} /> {t('solc.form.writable')}</label>
              </div>
            </div>
          ))}
          <button class="link small" onClick={() => setKeys([...keys, { pubkey: '', isSigner: false, isWritable: false }])}><Icon name="plus" size={12} /> {t('solc.form.addAccount')}</button>
          <div class="ct-field">
            <span class="ct-label"><span>{t('solc.raw.data')}</span><span class="ct-type">hex</span></span>
            <textarea class="input mono" rows={3} value={data} placeholder="0x…" spellcheck={false} autocapitalize="off" onInput={(e) => setData(e.target.value)} />
          </div>
          {err && <div class="error">{err}</div>}
          <SimView sim={sim} />
          <div class="row ct-fn-actions">
            <span class="grow" />
            <button class="btn secondary sm" disabled={busy} onClick={simulateIt}>{busy ? <Spinner /> : t('contracts.fn.simulate')}</button>
            <button class="btn primary sm" onClick={review}>{t('contracts.fn.send')}</button>
          </div>
        </div>
      )}
    </div>
  );
}

/**
 * A guided operation (token management, NFTs, programs) as a collapsible card. op: { key, risk?, fields: [[name,
 * kind ('address' | 'amount' | 'text' | 'int'), default]], build(values) -> request for the review }.
 */
export function OpCard({ op, wallet, sym }) {
  const [open, setOpen] = useState(false);
  const [vals, setVals] = useState(() => Object.fromEntries(op.fields.map(([k, , d]) => [k, d ?? ''])));
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const go = async () => {
    setErr(''); setBusy(true);
    try { await op.run(vals); } catch (e) { setErr(e.message); }
    setBusy(false);
  };
  return (
    <div class={`ct-fn ${open ? 'open' : ''}`}>
      <button class="ct-fn-head" onClick={() => setOpen(!open)}>
        <span class="grow"><span class="ct-fn-name">{t(`solc.op.${op.key}.title`)}</span><span class="ct-fn-sig">{t(`solc.op.${op.key}.sub`)}</span></span>
        {op.risk && <span class={`badge ${op.risk === 'renounce' || op.risk === 'close' ? 'red' : 'amber'}`}>{t(`solc.risk.${op.risk}.badge`)}</span>}
        <Icon name="chevron" size={14} />
      </button>
      {open && (
        <div class="ct-fn-body">
          {op.fields.map(([k, kind]) => (
            <div class="ct-field">
              <span class="ct-label"><span>{t(`solc.f.${k}`)}</span>{kind === 'amount' && sym ? <span class="ct-type">{sym}</span> : null}</span>
              <div class="row" style={{ gap: '.375rem' }}>
                <input class={`input ${kind === 'address' || kind === 'int' ? 'mono' : ''}`} inputMode={kind === 'amount' ? 'decimal' : kind === 'int' ? 'numeric' : undefined}
                  value={vals[k]} placeholder={kind === 'address' ? t('solc.form.address') : ''} spellcheck={false} autocapitalize="off" onInput={(e) => setVals({ ...vals, [k]: e.target.value })} />
                {kind === 'address' && wallet && <button class="iconbtn" title={t('solc.form.me')} onClick={() => setVals({ ...vals, [k]: wallet.raw })}><Icon name="wallet" size={18} /></button>}
              </div>
            </div>
          ))}
          {!op.fields.length && <span class="small muted">{t(`solc.op.${op.key}.hint`)}</span>}
          {err && <div class="error">{err}</div>}
          <div class="row ct-fn-actions"><span class="grow" /><button class="btn primary sm" disabled={busy} onClick={go}>{busy ? <Spinner /> : t('solc.review')}</button></div>
        </div>
      )}
    </div>
  );
}
