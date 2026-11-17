// Pieces shared by the Solana screens of the Contracts tab: the frame, addresses, decoded values, the wallet's
// Solana address.
import { Icon, Spinner, useApp } from '../../../components.jsx';
import { shortAddr } from '../../../../shared/format.js';
import { t } from '../../../../shared/i18n.js';
import { isAddress } from '../../../../shared/solana/core.js';
import { programName } from '../../../../shared/solana/programs.js';
import { useSolWallet } from '../../../solana/hooks.js';

export const useSolWalletFor = () => useSolWallet();

export async function copyText(text, toast) {
  try { await navigator.clipboard.writeText(text); toast(t('common.copied')); } catch { /* no clipboard */ }
}

export function Shell({ onBack, title, right, children, footer }) {
  return (
    <div class="screen">
      <div class="topbar">
        <button class="iconbtn" onClick={onBack} title={t('common.back')}><Icon name="back" /></button>
        <h1 class="ellipsis">{title || t('contracts.title')}</h1>
        {right}
      </div>
      <div class="content ct-content">{children}</div>
      {footer && <div class="footer">{footer}</div>}
    </div>
  );
}

export const Loading = ({ text }) => <div class="ct-loading"><Spinner lg /><span class="small muted">{text || t('contracts.loading')}</span></div>;

/** An address: its program name when known, short, copy on tap, open in the Contracts tab with the arrow. */
export function AddrValue({ address, onOpenAddress, me }) {
  const { toast } = useApp();
  if (!address) return <span class="muted">—</span>;
  const name = programName(address);
  return (
    <span class="row" style={{ gap: '.25rem', display: 'inline-flex', flexWrap: 'wrap' }}>
      <span class="mono tiny" style={{ wordBreak: 'break-all', cursor: 'copy' }} onClick={() => copyText(address, toast)}>{name ? `${name} · ${shortAddr(address, 4)}` : shortAddr(address, 6)}</span>
      {address === me && <span class="badge green">{t('solc.you')}</span>}
      {onOpenAddress && <button class="iconbtn sm" title={t('solc.open')} onClick={() => onOpenAddress(address)}><Icon name="forward" size={12} /></button>}
    </span>
  );
}

/** A value decoded from an account or an instruction (Borsh): nested, addresses clickable. */
export function SolValue({ v, onOpenAddress, me, depth = 0 }) {
  if (v === null || v === undefined) return <span class="muted tiny">null</span>;
  if (typeof v === 'bigint') return <span class="mono tiny">{v.toString()}</span>;
  if (typeof v === 'boolean') return <span class="mono tiny">{String(v)}</span>;
  if (typeof v === 'number') return <span class="mono tiny">{String(v)}</span>;
  if (typeof v === 'string') return isAddress(v) && v.length >= 32 ? <AddrValue address={v} onOpenAddress={onOpenAddress} me={me} /> : <span class="tiny" style={{ wordBreak: 'break-word' }}>{v || '""'}</span>;
  if (v instanceof Uint8Array) return <span class="mono tiny" style={{ wordBreak: 'break-all' }}>0x{Array.from(v, (x) => x.toString(16).padStart(2, '0')).join('') || '—'}</span>;
  if (Array.isArray(v)) {
    if (!v.length) return <span class="muted tiny">[]</span>;
    return <div class="col sol-val" style={{ paddingLeft: depth ? '.5rem' : 0 }}>{v.slice(0, 200).map((x, i) => <div class="row" style={{ gap: '.375rem', alignItems: 'flex-start' }}><span class="tiny muted">{i}</span><SolValue v={x} onOpenAddress={onOpenAddress} me={me} depth={depth + 1} /></div>)}</div>;
  }
  const entries = Object.entries(v);
  return (
    <div class="col sol-val" style={{ paddingLeft: depth ? '.5rem' : 0, gap: '.125rem' }}>
      {entries.map(([k, x]) => (
        <div class="row" style={{ gap: '.375rem', alignItems: 'flex-start', flexWrap: 'wrap' }}>
          <span class="tiny muted">{k === '__variant' ? t('solc.variant') : k}</span>
          <SolValue v={x} onOpenAddress={onOpenAddress} me={me} depth={depth + 1} />
        </div>
      ))}
    </div>
  );
}

/** Lamports as SOL text. */
export const solText = (lamports, chain, digits = 6) => `${(Number(lamports || 0) / 1e9).toLocaleString(undefined, { maximumFractionDigits: digits })} ${chain.native.symbol}`;
