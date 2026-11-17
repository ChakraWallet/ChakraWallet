// Address-poisoning protection in the UI (Send, Bridge recipient, sites' token transfers): the verdict for a
// recipient, and the red warning with the two addresses compared, which must be acknowledged to continue.
import { useEffect, useState } from 'preact/hooks';
import { addressBook, checkRecipient, EVM_KIT } from '../shared/poison.js';
import { Icon, useApp } from './components.jsx';
import { t } from '../shared/i18n.js';
import { driverFor } from './chains/index.js';
import { indexerKeys } from './hooks.js';

const books = new Map(); // `${chainId}:${account}` -> promise (one history scan per screen session)

/**
 * -> { level: 'known' | 'lookalike' | 'poisoned' | null, similar, shown, risky } for `to` on `chain` (default: current).
 * The family's rules come from its driver (poisonKit; EVM's by default), its history from the driver too.
 */
export function useRecipientCheck(to, chain) {
  const { chain: current, account, state } = useApp();
  const c = chain || current;
  const drv = driverFor(c);
  const kit = drv.poisonKit?.(c) || EVM_KIT;
  const [book, setBook] = useState(null);
  const enabled = !!drv.features?.poisonCheck; // families whose history the check reads
  useEffect(() => {
    if (!enabled) return;
    const key = `${c.id}:${account.address}`;
    if (!books.has(key)) {
      books.set(key, (async () => {
        // this account's and the other accounts' addresses on this network (TON: their TON wallets)
        const resolved = await (drv.resolveAddressesSync?.(c, state.accounts) || drv.resolveAddresses(c, state.accounts));
        const mine = resolved[account.address];
        if (!mine) return null;
        const own = Object.values(resolved).filter(Boolean).map((x) => x.raw);
        const history = (ch, me, cursor, o) => drv.loadHistory(ch, me, cursor, o);
        return addressBook(c, mine.raw, own, { ...indexerKeys(state.settings), history }, kit);
      })().catch(() => null));
      setTimeout(() => books.delete(key), 5 * 60e3);
    }
    books.get(key).then(setBook);
  }, [c.id, account.address]);
  const v = enabled ? checkRecipient(to, book, kit) : { level: null };
  return { ...v, risky: v.level === 'lookalike' || v.level === 'poisoned' };
}

/** An address with the characters that differ from `b` highlighted (hex ignores case, TON's base64 doesn't). */
export function AddrDiff({ a, b }) {
  const hex = /^0x/i.test(a);
  const x = hex ? a.toLowerCase() : a, y = hex ? b.toLowerCase() : b;
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
          <div class="small muted">{t('send.poison.youEntered')}</div><AddrDiff a={check.shown || to.trim()} b={check.similar} />
          <div class="small muted">{t('send.poison.youUsed')}</div><AddrDiff a={check.similar} b={check.shown || to.trim()} />
        </div>
      )}
      <label class="row ack"><input type="checkbox" checked={ack} onChange={(e) => setAck(e.target.checked)} /><span class="small bold">{t('send.poison.ack')}</span></label>
    </div>
  );
}
