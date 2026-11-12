// Developer tools of the Contracts tab: calldata decoder, storage slot reader (with EIP-1967 slots and the slot of a
// mapping entry).
import { useState } from 'preact/hooks';
import { Spinner, useApp } from '../../components.jsx';
import { decodeCalldata, readSlot, SLOTS, mappingSlot, wordToAddress, slotHex } from '../../../shared/contracts.js';
import { display } from '../../../shared/abiInput.js';
import { t } from '../../../shared/i18n.js';
import { ValueNode } from './abiForm.jsx';

/** Paste transaction input -> function and arguments (with the contract's ABI, else the public databases). */
export function DecoderBox({ fns = [], onOpenAddress }) {
  const [data, setData] = useState('');
  const [res, setRes] = useState(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const run = async () => {
    setErr(''); setRes(null); setBusy(true);
    try { setRes(await decodeCalldata(data, fns)); } catch { setErr(t('contracts.decoder.bad')); }
    setBusy(false);
  };
  return (
    <div class="col" style={{ gap: '.5rem' }}>
      <textarea class="input mono" rows={4} value={data} placeholder="0xa9059cbb…" spellcheck={false} autocapitalize="off" onInput={(e) => setData(e.target.value)} />
      <button class="btn secondary sm" disabled={busy || !data.trim()} onClick={run}>{busy ? <Spinner /> : t('contracts.decoder.decode')}</button>
      {err && <div class="error">{err}</div>}
      {res?.unknown && <div class="warn">{t('contracts.decoder.unknown', { sel: res.selector })}</div>}
      {res && !res.unknown && (
        <div class="ct-result">
          <div class="mono small bold">{res.signature}</div>
          {res.guessed && <span class="tiny muted">{t('contracts.decoder.guessed')}</span>}
          {res.inputs.map((p, i) => <ValueNode n={display(p, res.args[i])} onOpenAddress={onOpenAddress} />)}
        </div>
      )}
    </div>
  );
}

const KNOWN = [['eip1967Implementation', SLOTS.eip1967Implementation], ['eip1967Admin', SLOTS.eip1967Admin], ['eip1967Beacon', SLOTS.eip1967Beacon]];
const KEY_TYPES = ['address', 'uint256', 'bytes32', 'int256', 'bool'];

/** Reads storage slots: by number, the known proxy slots, or the slot of mapping[key]. */
export function StorageBox({ chain, address, onOpenAddress }) {
  const { toast } = useApp();
  const [slot, setSlot] = useState('0');
  const [mode, setMode] = useState('slot');
  const [keyType, setKeyType] = useState('address');
  const [key, setKey] = useState('');
  const [base, setBase] = useState('0');
  const [res, setRes] = useState(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const read = async (s) => {
    setErr(''); setRes(null); setBusy(true);
    try {
      let target = s ?? slot;
      if (mode === 'mapping' && s == null) {
        const k = keyType === 'bool' ? key === 'true' : keyType.startsWith('uint') || keyType.startsWith('int') ? BigInt(key.trim()) : key.trim();
        target = mappingSlot(keyType, k, base);
      }
      const hex = slotHex(target);
      setRes({ slot: hex, word: await readSlot(chain, address, hex) });
    } catch (e) { setErr(e.message?.includes('slot') || e.code === 'INVALID_ARGUMENT' ? t('contracts.storage.bad') : e.message); }
    setBusy(false);
  };
  const addr = res ? wordToAddress(res.word) : null;
  return (
    <div class="col" style={{ gap: '.5rem' }}>
      <div class="seg">
        <button class={mode === 'slot' ? 'on' : ''} onClick={() => setMode('slot')}>{t('contracts.storage.bySlot')}</button>
        <button class={mode === 'mapping' ? 'on' : ''} onClick={() => setMode('mapping')}>{t('contracts.storage.byMapping')}</button>
      </div>
      {mode === 'slot' ? (
        <>
          <input class="input mono" value={slot} placeholder="0 / 0x…" spellcheck={false} autocapitalize="off" onInput={(e) => setSlot(e.target.value)} />
          <div class="pills">{KNOWN.map(([k, s]) => <button class="pill" onClick={() => { setSlot(s); read(s); }}>{t(`contracts.storage.${k}`)}</button>)}</div>
        </>
      ) : (
        <>
          <div class="row" style={{ gap: '.375rem' }}>
            <select class="input ct-unit" value={keyType} onChange={(e) => setKeyType(e.target.value)}>{KEY_TYPES.map((k) => <option value={k}>{k}</option>)}</select>
            <input class="input mono" value={key} placeholder={t('contracts.storage.key')} spellcheck={false} autocapitalize="off" onInput={(e) => setKey(e.target.value)} />
          </div>
          <input class="input mono" value={base} placeholder={t('contracts.storage.base')} spellcheck={false} onInput={(e) => setBase(e.target.value)} />
          <span class="tiny muted">{t('contracts.storage.mappingHint')}</span>
        </>
      )}
      <button class="btn secondary sm" disabled={busy} onClick={() => read()}>{busy ? <Spinner /> : t('contracts.storage.read')}</button>
      {err && <div class="error">{err}</div>}
      {res && (
        <div class="ct-result">
          <span class="tiny muted">slot <span class="mono">{res.slot}</span></span>
          <span class="mono small" onClick={() => { navigator.clipboard.writeText(res.word); toast(t('common.copied')); }}>{res.word}</span>
          <span class="tiny muted">uint256 = <span class="mono">{BigInt(res.word).toString()}</span></span>
          {addr && <ValueNode n={{ type: 'address', name: '', text: addr, mono: true, address: addr }} onOpenAddress={onOpenAddress} />}
        </div>
      )}
    </div>
  );
}
