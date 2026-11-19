// Receiving bitcoin: the account's next unused address of the type chosen - SegWit (bc1q…, any service can pay it)
// or Taproot (bc1p…, where inscriptions and runes usually go) - and a new one on request. Addresses already given
// stay valid; at most 20 unused ones are given out ahead, so other wallets restoring the phrase still find the funds.
import { useEffect, useState } from 'preact/hooks';
import { useApp, Btn } from '../components.jsx';
import { ReceiveView } from '../screens/receive.jsx';
import { useChainAddress } from '../hooks.js';
import { t } from '../../shared/i18n.js';
import { TYPES } from '../../shared/btc/keys.js';
import { decodeAccount, loadState, receiveAddress, newReceiveAddress } from '../../shared/btc/account.js';

let lastType = 'p2wpkh';

export function BtcReceive({ type: wanted }) {
  const { chain, toast } = useApp();
  const addr = useChainAddress();
  const a = addr.raw ? decodeAccount(addr.raw) : null;
  const types = a?.receive || [];
  const [type, setTypeState] = useState(wanted || lastType);
  const setType = (x) => { lastType = x; setTypeState(x); };
  const [cur, setCur] = useState(null);
  const [busy, setBusy] = useState(false);
  const shown = types.includes(type) ? type : types[0];
  useEffect(() => {
    if (!a) return undefined;
    let alive = true;
    loadState(chain, a).then((s) => alive && setCur(receiveAddress(chain, a, s, shown)));
    return () => { alive = false; };
  }, [addr.raw, shown]);
  const single = a && cur ? !!a.branches[cur.b]?.single : true;
  const fresh = async () => {
    setBusy(true);
    try {
      const r = await newReceiveAddress(chain, a, shown);
      if (r.limit) toast(t('btc.receive.limit'), 'warn');
      setCur(r);
    } finally { setBusy(false); }
  };
  const extra = a && (
    <div class="col" style={{ gap: '0.5rem', width: '100%', alignItems: 'center' }}>
      {types.length > 1 && (
        <div class="seg receive-seg" role="tablist">
          {types.map((x) => <button class={shown === x ? 'on' : ''} onClick={() => setType(x)}>{TYPES[x].label}</button>)}
        </div>
      )}
      <div class="small muted">{t(shown === 'p2tr' ? 'btc.receive.taprootHint' : shown === 'p2wpkh' ? 'btc.receive.segwitHint' : 'btc.receive.legacyHint')}</div>
      {!single && <Btn kind="secondary" class="sm" loading={busy} onClick={fresh}>{t('btc.receive.new')}</Btn>}
    </div>
  );
  return <ReceiveView address={cur?.address} missing={addr.missing} extra={extra} />;
}
