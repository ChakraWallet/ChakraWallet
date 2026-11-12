// Address-poisoning protection in the UI (Send, Bridge recipient, sites' token transfers): the verdict for a
// recipient, and the red warning with the two addresses compared, which must be acknowledged to continue.
import { useEffect, useState } from 'preact/hooks';
import { isAddress } from 'ethers';
import { addressBook, checkRecipient } from '../shared/poison.js';
import { Icon, useApp } from './components.jsx';
import { t } from '../shared/i18n.js';

const books = new Map(); // `${chainId}:${account}` -> promise (one history scan per screen session)

/** -> { level: 'known' | 'lookalike' | 'poisoned' | null, similar, risky } for `to` on `chain` (default: current). */
export function useRecipientCheck(to, chain) {
  const { chain: current, account, state } = useApp();
  const c = chain || current;
  const [book, setBook] = useState(null);
  useEffect(() => {
    const key = `${c.id}:${account.address}`;
    if (!books.has(key)) {
      books.set(key, addressBook(c, account.address, state.accounts.map((a) => a.address), { etherscanKey: state.settings.etherscanKey }).catch(() => null));
      setTimeout(() => books.delete(key), 5 * 60e3);
    }
    books.get(key).then(setBook);
  }, [c.id, account.address]);
  const addr = String(to || '').trim();
  const v = isAddress(addr) ? checkRecipient(addr, book) : { level: null };
  return { ...v, risky: v.level === 'lookalike' || v.level === 'poisoned' };
}

/** An address with the characters that differ from `b` highlighted. */
export function AddrDiff({ a, b }) {
  const x = a.toLowerCase(), y = b.toLowerCase();
  return <div class="mono addr-diff">{[...a].map((ch, i) => <span class={x[i] !== y[i] ? 'diff' : ''}>{ch}</span>)}</div>;
}

export function PoisonWarning({ check, to, ack, setAck }) {
  if (!check.risky) return null;
  const poisoned = check.level === 'poisoned';
  return (
    <div class="poison-warn">
      <div class="row" style={{ gap: '0.5rem' }}><Icon name="warn" size={20} /><b>{t(poisoned ? 'send.poison.poisonedTitle' : 'send.poison.title')}</b></div>
      <div class="small">{t(poisoned ? 'send.poison.poisonedText' : 'send.poison.text')}</div>
      {check.similar && (
        <div class="addr-compare">
          <div class="small muted">{t('send.poison.youEntered')}</div><AddrDiff a={to.trim()} b={check.similar} />
          <div class="small muted">{t('send.poison.youUsed')}</div><AddrDiff a={check.similar} b={to.trim()} />
        </div>
      )}
      <label class="row ack"><input type="checkbox" checked={ack} onChange={(e) => setAck(e.target.checked)} /><span class="small bold">{t('send.poison.ack')}</span></label>
    </div>
  );
}
