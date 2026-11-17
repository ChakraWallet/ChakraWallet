// Solana tools of the Contracts tab: the address a program derives from seeds (PDA), and a transaction reader (a
// transaction's bytes, or a signature on the network) with its instructions in words where the program is known.
import { useState } from 'preact/hooks';
import { Icon, Spinner, Sheet, useApp } from '../../../components.jsx';
import { t } from '../../../../shared/i18n.js';
import { fmtDateTime } from '../../../../shared/format.js';
import { isAddress, addressBytes, findProgramAddress, fromBase64, utf8 } from '../../../../shared/solana/core.js';
import * as b58 from '../../../../shared/solana/base58.js';
import { parseTransaction, messageInstructions, PROGRAMS } from '../../../../shared/solana/tx.js';
import { encode, toBytes } from '../../../../shared/solana/idl.js';
import { parsedTransaction, lookupTables } from '../../../../shared/solana/api.js';
import { programName } from '../../../../shared/solana/programs.js';
import { describeIx as known } from '../../../../shared/solana/inspect.js';
import { AddrValue, copyText, SolValue } from './parts.jsx';

const SEED_KINDS = ['string', 'pubkey', 'u8', 'u16', 'u32', 'u64', 'bytes'];
function seedBytes(s) {
  if (s.kind === 'string') return utf8(s.value);
  if (s.kind === 'pubkey') return addressBytes(s.value.trim());
  if (s.kind === 'bytes') return toBytes(s.value.trim());
  return encode(s.kind, s.value.trim());
}

/** Program-derived address of a program from typed seeds. */
export function PdaCalc({ programId: fixed = null }) {
  const { toast } = useApp();
  const [program, setProgram] = useState(fixed || '');
  const [seeds, setSeeds] = useState([{ kind: 'string', value: '' }]);
  const pid = fixed || program.trim();
  let res = null, err = '';
  try {
    if (isAddress(pid) && seeds.length) {
      const [address, bump] = findProgramAddress(seeds.map(seedBytes), pid);
      res = { address, bump };
    }
  } catch (e) { err = e.message === 'invalid seeds' ? t('solc.pda.tooLong') : t('solc.pda.bad'); }
  const set = (i, patch) => setSeeds(seeds.map((s, j) => (j === i ? { ...s, ...patch } : s)));
  return (
    <div class="card col" style={{ gap: '.5rem' }}>
      <b class="small">{t('solc.pda.title')}</b>
      <span class="tiny muted">{t('solc.pda.hint')}</span>
      {!fixed && <input class="input mono" value={program} placeholder={t('solc.pda.program')} spellcheck={false} autocapitalize="off" onInput={(e) => setProgram(e.target.value)} />}
      {seeds.map((s, i) => (
        <div class="row" style={{ gap: '.375rem' }}>
          <select class="input" style={{ maxWidth: '6.5rem' }} value={s.kind} onChange={(e) => set(i, { kind: e.target.value })}>{SEED_KINDS.map((k) => <option value={k}>{k}</option>)}</select>
          <input class={`input ${s.kind === 'string' ? '' : 'mono'}`} value={s.value} spellcheck={false} autocapitalize="off" placeholder={s.kind === 'bytes' ? '0x…' : s.kind === 'pubkey' ? t('solc.form.address') : ''} onInput={(e) => set(i, { value: e.target.value })} />
          <button class="iconbtn sm" title={t('solc.form.remove')} onClick={() => setSeeds(seeds.filter((_, j) => j !== i))}><Icon name="trash" size={14} /></button>
        </div>
      ))}
      <button class="link small" onClick={() => setSeeds([...seeds, { kind: 'string', value: '' }])}><Icon name="plus" size={12} /> {t('solc.pda.addSeed')}</button>
      {err && <div class="tiny red">{err}</div>}
      {res && (
        <div class="col" style={{ gap: '.125rem' }}>
          <span class="mono small" style={{ wordBreak: 'break-all' }} onClick={() => copyText(res.address, toast)}>{res.address}</span>
          <span class="tiny muted">bump {res.bump}</span>
        </div>
      )}
    </div>
  );
}

// ------------------------------------------------------------ transaction reader
/** A transaction pasted (base64 / base58 bytes) or fetched by its signature, instruction by instruction. */
export function TxDecoder({ chain, onOpenAddress }) {
  const [text, setText] = useState('');
  const [res, setRes] = useState(null);
  const [busy, setBusy] = useState(false);
  const run = async () => {
    setBusy(true); setRes(null);
    const s = text.trim();
    try {
      let bytes = null;
      if (/^[1-9A-HJ-NP-Za-km-z]{80,90}$/.test(s)) { // a signature: read it from the network
        const tx = await parsedTransaction(chain, s);
        if (!tx) throw new Error(t('solc.decoder.notFound'));
        setRes({ parsed: tx });
        setBusy(false);
        return;
      }
      try { bytes = fromBase64(s); parseTransaction(bytes); } catch { bytes = b58.decode(s); }
      const tx = parseTransaction(bytes);
      const tables = tx.msg.lookups.length ? await lookupTables(chain, tx.msg.lookups.map((l) => l.key)).catch(() => ({})) : {};
      setRes({ tx, ixs: messageInstructions(tx.msg, tables) });
    } catch (e) { setRes({ error: e.message || t('solc.decoder.bad') }); }
    setBusy(false);
  };
  return (
    <div class="col" style={{ gap: '.5rem' }}>
      <span class="small muted">{t('solc.decoder.hint')}</span>
      <textarea class="input mono" rows={4} value={text} spellcheck={false} autocapitalize="off" placeholder={t('solc.decoder.placeholder')} onInput={(e) => setText(e.target.value)} />
      <button class="btn primary sm" disabled={!text.trim() || busy} onClick={run}>{busy ? <Spinner /> : t('solc.decoder.do')}</button>
      {res?.error && <div class="error small">{res.error}</div>}
      {res?.tx && (
        <>
          <div class="tiny muted">{t('solc.decoder.summary', { version: String(res.tx.msg.version), signers: res.tx.msg.header.signatures, accounts: res.tx.msg.keys.length })}</div>
          {res.ixs.map((ix, i) => {
            const k = known(ix);
            return (
              <div class="card col" style={{ gap: '.25rem' }}>
                <span class="small"><b>{i + 1}. {k?.name || t('solc.decoder.instruction')}</b> · {programName(ix.programId) || ''}</span>
                <AddrValue address={ix.programId} onOpenAddress={onOpenAddress} />
                {k ? <SolValue v={k.fields} onOpenAddress={onOpenAddress} /> : <span class="mono tiny" style={{ wordBreak: 'break-all' }}>{Array.from(ix.data, (x) => x.toString(16).padStart(2, '0')).join('') || '—'}</span>}
                <details><summary class="tiny muted">{t('solc.decoder.accounts', { n: ix.keys.length })}</summary>
                  {ix.keys.map((x) => <div class="row" style={{ gap: '.375rem' }}><AddrValue address={x.pubkey} onOpenAddress={onOpenAddress} /><span class="tiny muted">{[x.isSigner && t('solc.form.signer'), x.isWritable && t('solc.form.writable')].filter(Boolean).join(' · ')}</span></div>)}
                </details>
              </div>
            );
          })}
        </>
      )}
      {res?.parsed && (
        <>
          <div class="tiny">{res.parsed.blockTime ? fmtDateTime(res.parsed.blockTime * 1000) : ''} · {res.parsed.meta?.err ? t('solc.activity.failed') : t('solc.decoder.ok')} · fee {Number(res.parsed.meta?.fee || 0) / 1e9} SOL</div>
          {(res.parsed.transaction.message.instructions || []).map((ix, i) => (
            <div class="card col" style={{ gap: '.25rem' }}>
              <span class="small"><b>{i + 1}. {ix.parsed?.type || ix.program || t('solc.decoder.instruction')}</b> · {programName(ix.programId) || ''}</span>
              <AddrValue address={ix.programId} onOpenAddress={onOpenAddress} />
              {ix.parsed ? <SolValue v={typeof ix.parsed === 'string' ? { text: ix.parsed } : ix.parsed.info || ix.parsed} onOpenAddress={onOpenAddress} /> : <span class="mono tiny" style={{ wordBreak: 'break-all' }}>{ix.data}</span>}
            </div>
          ))}
          {res.parsed.meta?.logMessages?.length > 0 && <details><summary class="tiny muted">{t('solc.sim.showLogs', { n: res.parsed.meta.logMessages.length })}</summary><pre class="ct-log mono tiny">{res.parsed.meta.logMessages.join('\n')}</pre></details>}
        </>
      )}
    </div>
  );
}

export function SolToolSheet({ kind, chain, onClose, onOpenAddress }) {
  return (
    <Sheet title={t(kind === 'pda' ? 'solc.pda.title' : 'solc.decoder.title')} onClose={onClose}>
      {kind === 'pda' ? <PdaCalc /> : <TxDecoder chain={chain} onOpenAddress={onOpenAddress} />}
    </Sheet>
  );
}
