// Pieces shared by the TON screens of the Contracts tab: the account's TON wallet on a given network, values read
// from get methods, the steps of a message (emulated or on chain), and a field-by-field cell view.
import { useEffect, useState } from 'preact/hooks';
import { Icon, Spinner, useApp } from '../../../components.jsx';
import { fmtAmount, fmtDateTime, shortAddr } from '../../../../shared/format.js';
import { t } from '../../../../shared/i18n.js';
import { useTonAccounts } from '../../../ton/hooks.js';
import { showAddress, exitKey, fetchMetadata } from '../../../../shared/ton/contracts.js';
import { describeCell, fetchableUri, toB64, opName, opHex } from '../../../../shared/ton/cells.js';
import { knownCode } from '../../../../shared/ton/templates.js';

export const copyText = async (text, toast) => { await navigator.clipboard.writeText(text); toast(t('common.copied')); };

/** The selected account's TON wallet on `chain`: { address (friendly), raw, publicKey, version } | null (no TON key) | undefined (loading). */
export function useTonWalletFor(chain) {
  const { account } = useApp();
  const map = useTonAccounts();
  if (!map) return undefined;
  const w = map[account.address];
  if (!w) return null;
  const net = chain?.testnet ? w.testnet : w.mainnet;
  return { address: net.friendly, raw: net.raw, publicKey: w.publicKey, version: w.version };
}

/** Name of an operation: translated when known, else as TonAPI / the table calls it. */
export function opLabel(name) {
  const s = t(`tonc.op.${name}`);
  return s.startsWith('tonc.op.') ? String(name).replace(/_/g, ' ') : s;
}

/** Label of a get-method result: translated when it's a standard one, else its name. */
export function outLabel(name) {
  const s = t(`tonc.out.${name}`);
  return s.startsWith('tonc.out.') ? name : s;
}

/** Description of an exit code (TVM / contract). */
export function exitText(code) {
  if (code == null) return '';
  const k = exitKey(code);
  return k ? t(`tonc.exit.${k}`) : t('tonc.exit.custom', { code });
}

const short = (a, chain) => shortAddr(showAddress(a, { testnet: chain?.testnet }), 6);

/** An address with copy and "open as contract". */
export function AddrValue({ address, chain, onOpenAddress, mine }) {
  const { toast } = useApp();
  if (address == null) return <span class="muted">{t('tonc.value.none')}</span>;
  const text = showAddress(address, { testnet: chain?.testnet });
  return (
    <span class="ct-node-v">
      <span class="mono">{text}{mine ? <span class="tiny green"> · {t('tonc.value.you')}</span> : null}</span>
      <button class="iconbtn sm" title={t('common.copy')} onClick={() => copyText(text, toast)}><Icon name="copy" size={13} /></button>
      {onOpenAddress && <button class="iconbtn sm" title={t('contracts.openAsContract')} onClick={() => onOpenAddress(address.toRawString ? address.toRawString() : address)}><Icon name="forward" size={13} /></button>}
    </span>
  );
}

/** TEP-64 content: on-chain fields, or the off-chain link with what it says (read on demand). */
function ContentValue({ v }) {
  const [meta, setMeta] = useState(null);
  const url = fetchableUri(v.uri || v.onchain?.uri);
  useEffect(() => { if (url) fetchMetadata(url).then(setMeta); }, [url]);
  const fields = { ...(meta || {}), ...(v.onchain || {}) };
  const keys = ['name', 'symbol', 'decimals', 'description', 'image'].filter((k) => fields[k] != null && typeof fields[k] !== 'object');
  return (
    <div class="ct-node-c">
      {(v.uri || v.onchain?.uri) && <span class="tiny"><span class="muted">{t('tonc.value.link')} </span><span class="mono">{v.uri || v.onchain.uri}</span></span>}
      {keys.map((k) => <span class="tiny"><b>{k}</b> <span class={k === 'image' ? 'mono' : ''}>{String(fields[k])}</span></span>)}
      {url && !meta && <span class="tiny muted">{t('tonc.value.offchain')}</span>}
      {!url && !keys.length && <span class="tiny muted">{t('tonc.value.emptyContent')}</span>}
    </div>
  );
}

/** A value read from a get method (see shared/ton/contracts.js interpret). */
export function TonValue({ v, name, chain, onOpenAddress, me }) {
  const { toast } = useApp();
  const [tree, setTree] = useState(false);
  const label = name ? <div class="ct-node-k"><b>{name}</b> <span class="ct-type">{v.t}</span></div> : null;
  if (v.t === 'tuple') {
    return <div class="ct-node">{label}<div class="ct-node-c">{v.items.map((x, i) => <TonValue v={x} name={`[${i}]`} chain={chain} onOpenAddress={onOpenAddress} me={me} />)}{!v.items.length && <span class="tiny muted">[]</span>}</div></div>;
  }
  if (v.t === 'content') return <div class="ct-node">{label}<ContentValue v={v.v} /></div>;
  if (v.t === 'address') return <div class="ct-node">{label}<AddrValue address={v.v} chain={chain} onOpenAddress={onOpenAddress} mine={!!me && !!v.v && v.v.toRawString() === me} /></div>;
  if (v.t === 'cell' || v.t === 'code' || v.t === 'text') {
    const b64 = toB64(v.cell);
    const known = v.t === 'code' ? knownCode(v.hash) : null;
    return (
      <div class="ct-node">
        {label}
        {v.t === 'text' && <span class="small">“{v.v}”</span>}
        {v.t === 'code' && <span class="tiny"><span class="muted">hash </span><span class="mono">{v.hash}</span>{known ? <span class="green"> · {t(`tonc.code.${known}`)}</span> : null}</span>}
        <span class="ct-node-v">
          <span class="mono tiny ellipsis">{b64}</span>
          <button class="iconbtn sm" title={t('common.copy')} onClick={() => copyText(b64, toast)}><Icon name="copy" size={13} /></button>
          {v.t !== 'code' && <button class="iconbtn sm" title={t('tonc.cell.read')} onClick={() => setTree(!tree)}><Icon name="search" size={13} /></button>}
        </span>
        {tree && <CellTree node={describeCell(v.cell)} />}
      </div>
    );
  }
  let text = '', sub = '';
  if (v.t === 'int') { text = v.v.toString(); sub = v.v >= 10n || v.v < 0n ? `0x${(v.v < 0n ? -v.v : v.v).toString(16)}` : ''; }
  else if (v.t === 'bool') text = v.v ? t('tonc.value.true') : t('tonc.value.false');
  else if (v.t === 'amount') { text = `${fmtAmount(v.v, v.decimals, 9)}${v.symbol ? ` ${v.symbol}` : ''}`; sub = v.v.toString(); }
  else if (v.t === 'time') { text = v.v ? fmtDateTime(v.v) : '0'; sub = String(v.v / 1000); }
  else if (v.t === 'hex') text = v.v;
  else if (v.t === 'null') text = 'null';
  else text = JSON.stringify(v.raw ?? v);
  return (
    <div class="ct-node">
      {label}
      <div class="ct-node-v">
        <span class={v.t === 'hex' || v.t === 'int' ? 'mono' : ''}>{text}</span>
        <button class="iconbtn sm" title={t('common.copy')} onClick={() => copyText(v.t === 'amount' ? v.v.toString() : text, toast)}><Icon name="copy" size={13} /></button>
      </div>
      {sub && <div class="tiny muted mono">{sub}</div>}
    </div>
  );
}

/** Field-by-field view of a cell (describeCell). */
export function CellTree({ node, depth = 0 }) {
  const g = node.guess;
  return (
    <div class={depth ? 'ct-node-c' : 'ct-result'}>
      <span class="tiny muted">{t('tonc.cell.bits', { n: node.bits })}{node.refs.length ? ` · ${t('tonc.cell.refs', { n: node.refs.length + node.more })}` : ''}{node.exotic ? ' · exotic' : ''}</span>
      {g.op != null && <span class="tiny"><b>op</b> <span class="mono">{opHex(g.op)}</span>{g.opName ? ` · ${opLabel(g.opName)}` : ''}</span>}
      {g.queryId != null && <span class="tiny"><b>query_id</b> <span class="mono">{g.queryId.toString()}</span></span>}
      {g.text != null && <span class="tiny">“{g.text}”</span>}
      {g.address && <span class="tiny"><b>{t('tonc.cell.address')}</b> <span class="mono">{showAddress(g.address)}</span></span>}
      {node.bits > 0 && <span class="mono tiny ct-calldata">{node.hex}</span>}
      {node.refs.map((r, i) => <div><span class="tiny muted">ref {i}</span><CellTree node={r} depth={depth + 1} /></div>)}
      {node.more > 0 && <span class="tiny muted">{t('tonc.cell.more', { n: node.more })}</span>}
    </div>
  );
}

/** Steps of a message: one row per transaction of the chain (emulated or real). */
export function StepsView({ steps, wallet, chain }) {
  if (!steps?.length) return null;
  return (
    <div class="col ct-steps">
      {steps.map((s) => {
        const mine = wallet && s.account === wallet;
        const op = s.op != null ? (s.opName || (typeof s.op === 'number' ? opName(s.op) : opName(Number(s.op))) || null) : null;
        return (
          <div class={`ct-step ${s.ok ? '' : 'bad'}`} style={{ paddingLeft: `${Math.min(s.depth, 6) * 0.75}rem` }}>
            <span class={`ct-step-ic ${s.ok ? (s.bounced ? 'amber' : 'green') : 'red'}`}><Icon name={s.ok ? (s.bounced ? 'back' : 'check') : 'close'} size={12} stroke={3} /></span>
            <div class="grow">
              <div class="small"><span class="mono">{mine ? t('tonc.value.yourWallet') : short(s.account, chain)}</span>{s.interfaces?.length ? <span class="tiny muted"> · {s.interfaces[0]}</span> : null}</div>
              <div class="tiny muted">
                {s.value > 0n ? `${fmtAmount(s.value, 9, 4)} ${chain.native.symbol}` : ''}
                {op ? `${s.value > 0n ? ' · ' : ''}${opLabel(op)}` : s.op != null ? `${s.value > 0n ? ' · ' : ''}${typeof s.op === 'string' ? s.op : opHex(s.op)}` : ''}
                {s.bounced ? ` · ${t('tonc.step.bounced')}` : ''}
                {s.noState ? ` · ${t('tonc.step.noState')}` : ''}
              </div>
              {!s.ok && <div class="tiny red">{s.exitCode != null ? `${t('tonc.step.exit', { code: s.exitCode })}: ${exitText(s.exitCode)}` : s.actionCode != null ? t('tonc.step.action', { code: s.actionCode }) : t('tonc.step.failed')}</div>}
            </div>
          </div>
        );
      })}
    </div>
  );
}

/** Small "loading" row. */
export const Loading = ({ text }) => <div class="info row"><Spinner /> {text}</div>;
