// Write tab of a TON contract: guided operations of the standards (jetton, NFT) that the account is allowed to do,
// GRAM with a comment, and a free message builder (typed fields or a raw body, optional StateInit). Every message goes
// to the review (emulation, then signature).
import { useMemo, useState } from 'preact/hooks';
import { Icon, Switch, Spinner } from '../../../components.jsx';
import { t } from '../../../../shared/i18n.js';
import { parseAmount, fmtAmount } from '../../../../shared/format.js';
import { FIELD_TYPES, DEFAULT_BITS, buildCell, commentBody, parseAddr, parseBoc, toB64, FieldError, buildOnchainContent, describeCell } from '../../../../shared/ton/cells.js';
import { jettonTransferCell, DEFAULT_JETTON_VALUE } from '../../../../shared/ton/core.js';
import * as T from '../../../../shared/ton/templates.js';
import { showAddress, rawAddress } from '../../../../shared/ton/contracts.js';
import { CellTree } from './parts.jsx';

export const errText = (e) => (e instanceof FieldError ? t(e.key, e.vars) : e?.message || String(e));

/** Value of a result of the overview: ovValue(ov, 'get_jetton_data', 'admin') -> interpreted value or null. */
export function ovValue(ov, method, name) {
  const row = ov?.rows?.find((r) => r.method.name === method);
  return row?.values?.find((v) => v.name === name) || null;
}
const isMe = (v, me) => !!v?.v && typeof v.v.toRawString === 'function' && v.v.toRawString() === me;

function amountOf(text, decimals) {
  const n = parseAmount(text, decimals);
  if (n == null || n <= 0n) throw new FieldError('tonc.err.amount');
  return n;
}

/** Guided operations for this contract and this account. */
function guidedOps(c, ov, wallet, token) {
  const me = wallet.raw;
  const meAddr = parseAddr(me);
  const dec = token?.decimals ?? 9, sym = token?.symbol || '';
  const out = [];
  if (c.kind === 'jetton_master') {
    const admin = ovValue(ov, 'get_jetton_data', 'admin');
    const isAdmin = admin ? isMe(admin, me) : rawAddress(c.jetton?.admin) === me;
    const content = ovValue(ov, 'get_jetton_data', 'content')?.v?.onchain || {};
    if (isAdmin) {
      out.push({
        key: 'mint', fields: [['to', 'address', wallet.address], ['amount', 'tokens', '']], value: T.JETTON_MINT_VALUE,
        build: (v) => T.jettonMintBody({ to: parseAddr(v.to), amount: amountOf(v.amount, dec), response: meAddr }),
        summary: (v) => [[t('tonc.f.to'), v.to], [t('tonc.f.amount'), `${v.amount} ${sym}`]],
      });
      out.push({
        key: 'meta', risk: 'admin', value: T.JETTON_ADMIN_VALUE,
        fields: [['name', 'text', content.name || c.jetton?.name || ''], ['symbol', 'text', content.symbol || c.jetton?.symbol || ''], ['image', 'text', content.image || ''], ['description', 'text', content.description || '']],
        build: (v) => T.jettonChangeContentBody({ content: buildOnchainContent({ name: v.name, symbol: v.symbol, decimals: String(dec), image: v.image, description: v.description }) }),
        summary: (v) => [[t('tonc.f.name'), v.name], [t('tonc.f.symbol'), v.symbol]],
      });
      out.push({
        key: 'admin', risk: 'admin', fields: [['admin', 'address', '']], value: T.JETTON_ADMIN_VALUE,
        build: (v) => T.jettonChangeAdminBody({ admin: parseAddr(v.admin) }), summary: (v) => [[t('tonc.f.admin'), v.admin]],
      });
      out.push({ key: 'dropAdmin', risk: 'renounce', fields: [], value: T.JETTON_ADMIN_VALUE, build: () => T.jettonChangeAdminBody({ admin: null }), summary: () => [] });
    }
  }
  if (c.kind === 'jetton_wallet' && isMe(ovValue(ov, 'get_wallet_data', 'owner'), me)) {
    out.push({
      key: 'jtransfer', fields: [['to', 'address', ''], ['amount', 'tokens', ''], ['comment', 'text', '']], value: DEFAULT_JETTON_VALUE,
      build: (v) => jettonTransferCell({ amount: amountOf(v.amount, dec), to: parseAddr(v.to), responseTo: meAddr, comment: v.comment.trim() || undefined }),
      summary: (v) => [[t('tonc.f.to'), v.to], [t('tonc.f.amount'), `${v.amount} ${sym}`]],
    });
    out.push({
      key: 'burn', risk: 'burn', fields: [['amount', 'tokens', '']], value: T.JETTON_BURN_VALUE,
      build: (v) => T.jettonBurnBody({ amount: amountOf(v.amount, dec), response: meAddr }), summary: (v) => [[t('tonc.f.amount'), `${v.amount} ${sym}`]],
    });
  }
  if (c.kind === 'nft_collection' && isMe(ovValue(ov, 'get_collection_data', 'owner'), me)) {
    const next = ovValue(ov, 'get_collection_data', 'next_item_index')?.v ?? 0n;
    out.push({
      key: 'nftMint', fields: [['index', 'int', String(next)], ['owner', 'address', wallet.address], ['content', 'text', `${next}.json`]], value: T.NFT_MINT_VALUE,
      build: (v) => {
        let idx;
        try { idx = BigInt(v.index.trim()); } catch { throw new FieldError('tonc.err.number'); }
        if (idx < 0n || idx > next) throw new FieldError('tonc.err.index', { max: String(next) });
        return T.nftMintBody({ index: idx, owner: parseAddr(v.owner), content: v.content.trim() });
      },
      summary: (v) => [['#', v.index], [t('tonc.f.owner'), v.owner], [t('tonc.f.content'), v.content]],
    });
    out.push({
      key: 'collOwner', risk: 'admin', fields: [['owner', 'address', '']], value: T.JETTON_ADMIN_VALUE,
      build: (v) => T.nftChangeOwnerBody({ owner: parseAddr(v.owner) }), summary: (v) => [[t('tonc.f.owner'), v.owner]],
    });
  }
  if (c.kind === 'nft_item' && isMe(ovValue(ov, 'get_nft_data', 'owner'), me)) {
    out.push({
      key: 'nftTransfer', fields: [['to', 'address', '']], value: T.NFT_TRANSFER_VALUE,
      build: (v) => T.nftTransferBody({ to: parseAddr(v.to), response: meAddr }), summary: (v) => [[t('tonc.f.to'), v.to]],
    });
  }
  return out;
}

function Field({ k, kind, value, onChange, wallet, sym, chain }) {
  return (
    <div class="ct-field">
      <span class="ct-label"><span>{t(`tonc.f.${k}`)}</span>{kind === 'tokens' && sym ? <span class="ct-type">{sym}</span> : kind === 'gram' ? <span class="ct-type">{chain.native.symbol}</span> : null}</span>
      <div class="row" style={{ gap: '.375rem' }}>
        <input class={`input ${kind === 'address' || kind === 'int' ? 'mono' : ''}`} inputMode={kind === 'tokens' || kind === 'gram' ? 'decimal' : kind === 'int' ? 'numeric' : undefined}
          value={value} placeholder={kind === 'address' ? 'UQ… / EQ…' : ''} spellcheck={false} autocapitalize="off" onInput={(e) => onChange(e.target.value)} />
        {kind === 'address' && <button class="iconbtn" title={t('tonc.f.me')} onClick={() => onChange(wallet.address)}><Icon name="wallet" size={18} /></button>}
      </div>
    </div>
  );
}

/** A guided operation, as a collapsible card like the functions of an EVM contract. */
function OpCard({ op, c, chain, wallet, token, onSend }) {
  const [open, setOpen] = useState(false);
  const [vals, setVals] = useState(() => Object.fromEntries(op.fields.map(([k, , d]) => [k, d])));
  const [err, setErr] = useState('');
  const review = () => {
    setErr('');
    try {
      const body = op.build(vals);
      onSend({
        title: t(`tonc.op.${op.key}.title`), risks: op.risk ? [op.risk] : [], summary: op.summary(vals),
        messages: [{ to: c.address, value: String(op.value), bounce: true, body: toB64(body) }],
      });
    } catch (e) { setErr(errText(e)); }
  };
  return (
    <div class={`ct-fn ${open ? 'open' : ''}`}>
      <button class="ct-fn-head" onClick={() => setOpen(!open)}>
        <span class="grow"><span class="ct-fn-name">{t(`tonc.op.${op.key}.title`)}</span><span class="ct-fn-sig">{t(`tonc.op.${op.key}.sub`)}</span></span>
        {op.risk && <span class={`badge ${op.risk === 'renounce' || op.risk === 'burn' ? 'red' : 'amber'}`}>{t(`tonc.risk.${op.risk}.badge`)}</span>}
        <Icon name="chevron" size={14} />
      </button>
      {open && (
        <div class="ct-fn-body">
          {op.fields.map(([k, kind]) => <Field k={k} kind={kind} value={vals[k]} onChange={(v) => setVals({ ...vals, [k]: v })} wallet={wallet} sym={token?.symbol} chain={chain} />)}
          {!op.fields.length && <span class="small muted">{t(`tonc.op.${op.key}.hint`)}</span>}
          <span class="tiny muted">{t('tonc.write.attached', { amount: fmtAmount(op.value, 9, 4), symbol: chain.native.symbol })}</span>
          {err && <div class="error">{err}</div>}
          <div class="row ct-fn-actions"><span class="grow" /><button class="btn primary sm" onClick={review}>{t('tonc.write.review')}</button></div>
        </div>
      )}
    </div>
  );
}

/** GRAM to the contract, with an optional comment. */
function GramCard({ c, chain, onSend }) {
  const [open, setOpen] = useState(false);
  const [amount, setAmount] = useState('');
  const [comment, setComment] = useState('');
  const [err, setErr] = useState('');
  const review = () => {
    setErr('');
    const v = parseAmount(amount, 9);
    if (v == null || v <= 0n) { setErr(t('tonc.err.amount')); return; }
    const body = comment.trim() ? toB64(commentBody(comment.trim())) : undefined;
    onSend({ title: t('tonc.op.gram.title'), risks: [], summary: [[t('tonc.f.amount'), `${amount} ${chain.native.symbol}`], ...(comment.trim() ? [[t('tonc.f.comment'), comment.trim()]] : [])], messages: [{ to: c.address, value: String(v), bounce: c.status === 'active', ...(body ? { body } : {}) }] });
  };
  return (
    <div class={`ct-fn ${open ? 'open' : ''}`}>
      <button class="ct-fn-head" onClick={() => setOpen(!open)}>
        <span class="grow"><span class="ct-fn-name">{t('tonc.op.gram.title')}</span><span class="ct-fn-sig">{t('tonc.op.gram.sub')}</span></span>
        <Icon name="chevron" size={14} />
      </button>
      {open && (
        <div class="ct-fn-body">
          <Field k="amount" kind="gram" value={amount} onChange={setAmount} chain={chain} />
          <Field k="comment" kind="text" value={comment} onChange={setComment} chain={chain} />
          {err && <div class="error">{err}</div>}
          <div class="row ct-fn-actions"><span class="grow" /><button class="btn primary sm" onClick={review}>{t('tonc.write.review')}</button></div>
        </div>
      )}
    </div>
  );
}

const newField = (type = 'uint') => ({ type, bits: DEFAULT_BITS[type] ?? '', unit: 9, value: type === 'bool' ? 'false' : '' });
const PRESETS = {
  opq: () => [{ ...newField('uint'), bits: 32, label: 'op' }, { ...newField('uint'), bits: 64, value: '0', label: 'query_id' }],
  comment: () => [{ ...newField('uint'), bits: 32, value: '0', label: 'op' }, { ...newField('text'), label: 'text' }],
};

/** Typed fields of a cell (also used by the TON studio for cell arguments). */
export function FieldsEditor({ fields, setFields, chain }) {
  const set = (i, patch) => setFields(fields.map((f, j) => (j === i ? { ...f, ...patch } : f)));
  return (
    <div class="col" style={{ gap: '.5rem' }}>
      {fields.map((f, i) => (
        <div class="ct-group">
          <div class="row" style={{ gap: '.375rem' }}>
            <span class="ct-idx">{i}</span>
            <select class="input ct-unit" value={f.type} onChange={(e) => set(i, { ...newField(e.target.value), value: f.value, label: f.label })}>
              {FIELD_TYPES.map((x) => <option value={x}>{t(`tonc.ft.${x}`)}</option>)}
            </select>
            {(f.type === 'uint' || f.type === 'int') && <input class="input mono ct-bits" inputMode="numeric" value={f.bits} title={t('tonc.ft.bits')} onInput={(e) => set(i, { bits: e.target.value })} />}
            {f.type === 'coins' && (
              <select class="input ct-unit" value={f.unit} onChange={(e) => set(i, { unit: Number(e.target.value) })}>
                <option value={9}>{chain.native.symbol}</option><option value={0}>{t('tonc.ft.raw')}</option>
              </select>
            )}
            <span class="grow tiny muted ellipsis">{f.label || ''}</span>
            <button class="iconbtn sm" title={t('common.delete')} onClick={() => setFields(fields.filter((_, j) => j !== i))}><Icon name="close" size={14} /></button>
          </div>
          {f.type === 'bool' ? <div class="ct-bool"><span class="small">{f.value === 'true' ? t('tonc.value.true') : t('tonc.value.false')}</span><Switch on={f.value === 'true'} onChange={(v) => set(i, { value: v ? 'true' : 'false' })} /></div>
            : f.type === 'ref' || f.type === 'maybeRef' || f.type === 'slice' ? <textarea class="input mono" rows={2} value={f.value} placeholder={t('tonc.ft.bocHint')} spellcheck={false} autocapitalize="off" onInput={(e) => set(i, { value: e.target.value })} />
              : <input class={`input ${f.type === 'text' ? '' : 'mono'}`} value={f.value} placeholder={t(`tonc.ft.${f.type}.ph`)} spellcheck={false} autocapitalize="off" inputMode={f.type === 'coins' ? 'decimal' : undefined} onInput={(e) => set(i, { value: e.target.value })} />}
        </div>
      ))}
      <div class="pills">
        <button class="pill" onClick={() => setFields([...fields, newField('uint')])}><Icon name="plus" size={12} /> {t('tonc.builder.field')}</button>
        <button class="pill" onClick={() => setFields([...fields, ...PRESETS.opq()])}>op + query_id</button>
        <button class="pill" onClick={() => setFields([...fields, ...PRESETS.comment()])}>{t('tonc.builder.comment')}</button>
      </div>
    </div>
  );
}

/** Free message: amount, bounce, body (typed fields or raw BoC), optional StateInit. */
function BuilderCard({ c, chain, onSend }) {
  const [open, setOpen] = useState(false);
  const [mode, setMode] = useState('fields');
  const [fields, setFields] = useState(() => PRESETS.opq());
  const [raw, setRaw] = useState('');
  const [init, setInit] = useState('');
  const [amount, setAmount] = useState('0.05');
  const [bounce, setBounce] = useState(c.status === 'active');
  const [err, setErr] = useState('');
  const [tree, setTree] = useState(false);
  const built = useMemo(() => {
    if (!open) return null;
    try { return { cell: mode === 'fields' ? buildCell(fields) : raw.trim() ? parseBoc(raw) : null }; } catch (e) { return { error: errText(e), index: e.index }; }
  }, [open, mode, fields, raw]);
  const review = () => {
    setErr('');
    const v = parseAmount(amount, 9);
    if (v == null) { setErr(t('tonc.err.amount')); return; }
    if (built?.error) { setErr(built.index != null ? `#${built.index}: ${built.error}` : built.error); return; }
    let initB64;
    try { initB64 = init.trim() ? toB64(parseBoc(init)) : undefined; } catch (e) { setErr(errText(e)); return; }
    const body = built?.cell ? toB64(built.cell) : undefined;
    onSend({
      title: t('tonc.op.custom.title'), risks: ['raw'], summary: [[t('tonc.f.amount'), `${amount} ${chain.native.symbol}`], [t('tonc.f.bounce'), bounce ? t('tonc.value.true') : t('tonc.value.false')]],
      messages: [{ to: c.address, value: String(v), bounce, ...(body ? { body } : {}), ...(initB64 ? { init: initB64 } : {}) }],
    });
  };
  return (
    <div class={`ct-fn ${open ? 'open' : ''}`}>
      <button class="ct-fn-head" onClick={() => setOpen(!open)}>
        <span class="grow"><span class="ct-fn-name">{t('tonc.op.custom.title')}</span><span class="ct-fn-sig">{t('tonc.op.custom.sub')}</span></span>
        <Icon name="chevron" size={14} />
      </button>
      {open && (
        <div class="ct-fn-body">
          <Field k="amount" kind="gram" value={amount} onChange={setAmount} chain={chain} />
          <label class="ct-field ct-bool"><span class="small">{t('tonc.f.bounce')}<span class="tiny muted"> · {t('tonc.f.bounceHint')}</span></span><Switch on={bounce} onChange={setBounce} /></label>
          <div class="seg">
            <button class={mode === 'fields' ? 'on' : ''} onClick={() => setMode('fields')}>{t('tonc.builder.fields')}</button>
            <button class={mode === 'raw' ? 'on' : ''} onClick={() => setMode('raw')}>{t('tonc.builder.raw')}</button>
          </div>
          {mode === 'fields' ? <FieldsEditor fields={fields} setFields={setFields} chain={chain} />
            : <textarea class="input mono" rows={3} value={raw} placeholder={t('tonc.ft.bocHint')} spellcheck={false} autocapitalize="off" onInput={(e) => setRaw(e.target.value)} />}
          {built?.cell && (
            <div class="ct-field">
              <span class="ct-label"><span>{t('tonc.builder.body')}</span><span class="ct-type">{t('tonc.cell.bits', { n: built.cell.bits.length })}</span></span>
              <span class="mono tiny ct-calldata">{toB64(built.cell)}</span>
              <button class="link tiny" onClick={() => setTree(!tree)}>{t('tonc.cell.read')}</button>
              {tree && <CellTree node={describeCell(built.cell)} />}
            </div>
          )}
          {built?.error && <div class="tiny red">{built.index != null ? `#${built.index}: ` : ''}{built.error}</div>}
          <details class="ct-adv">
            <summary class="small">{t('tonc.builder.init')}</summary>
            <textarea class="input mono" rows={2} value={init} placeholder={t('tonc.builder.initHint')} spellcheck={false} autocapitalize="off" onInput={(e) => setInit(e.target.value)} />
          </details>
          {err && <div class="error">{err}</div>}
          <div class="row ct-fn-actions"><span class="grow" /><button class="btn primary sm" onClick={review}>{t('tonc.write.review')}</button></div>
        </div>
      )}
    </div>
  );
}

export function TonWriteTab({ c, chain, ov, token, wallet, onSend, extra }) {
  const ops = useMemo(() => (wallet && ov ? guidedOps(c, ov, wallet, token) : []), [c, ov, wallet, token]);
  if (wallet === undefined) return <Spinner />;
  if (!wallet) return <div class="warn small">{t('tonc.write.noKey')}</div>;
  const roles = { jetton_master: 'admin', jetton_wallet: 'owner', nft_collection: 'owner', nft_item: 'owner' };
  return (
    <>
      <div class="info small">{t('tonc.write.as', { address: showAddress(wallet.raw, { testnet: chain.testnet, wallet: true }).slice(0, 10) + '…', chain: chain.name })}</div>
      {!ov && roles[c.kind] && <div class="row small muted"><Spinner /> {t('tonc.write.checking')}</div>}
      {ov && roles[c.kind] && !ops.length && <div class="tiny muted">{t(`tonc.write.notYour.${roles[c.kind]}`)}</div>}
      {ops.map((op) => <OpCard key={op.key} op={op} c={c} chain={chain} wallet={wallet} token={token} onSend={onSend} />)}
      {extra}
      <GramCard c={c} chain={chain} onSend={onSend} />
      <BuilderCard c={c} chain={chain} onSend={onSend} />
    </>
  );
}
