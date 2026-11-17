// Deploying a compiled Solana program (.so, built on a computer: `anchor build` / `cargo build-sbf`) with the
// upgradeable loader, or upgrading one the account has authority on. The program is written into a buffer account a
// thousand bytes per transaction (hundreds of transactions, signed with one authorisation), then deployed from it.
// An interrupted deploy leaves its buffer: listed here, it can be closed to recover its SOL.
import { useEffect, useState } from 'preact/hooks';
import { Icon, Btn, ChainIcon, Spinner, useApp } from '../../../components.jsx';
import { getChain } from '../../../../shared/chains.js';
import { bg } from '../../../../shared/ext.js';
import { t } from '../../../../shared/i18n.js';
import { keyOfSeed, seedFromSecret, toBase64, fromBase64 } from '../../../../shared/solana/core.js';
import { buildTransaction, system, computeBudget, PROGRAMS, MAX_TX_SIZE } from '../../../../shared/solana/tx.js';
import { rentExempt, latestBlockhash, sendRaw, rpc, priorityPrice, isSolana, SOL_DEVNET, solBalance } from '../../../../shared/solana/api.js';
import { loader, chunksOf, isElf, BUFFER_META, PROGRAMDATA_META, PROGRAM_SPACE, buffersOf, loadSolAccount } from '../../../../shared/solana/programs.js';
import { normalizeIdl } from '../../../../shared/solana/idl.js';
import { saveContract } from '../../../contractsStore.js';
import { useOperationAuth } from '../../../steps.js';
import { sendInstructions, plan } from '../../../solana/tx.js';
import { NetworkSheet } from '../../home.jsx';
import { useSolWalletFor, solText, AddrValue } from './parts.jsx';

const CHUNK = 900; // program bytes per write transaction (with its compute budget, under the 1232-byte limit)
const MIN_EXTEND = 10240; // the smallest extension of a program's data the loader accepts
const WRITE_UNITS = 20_000;
const BATCH = 20; // write transactions signed and sent together
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Sends signed transactions and waits for them: returns the indexes that didn't land. */
async function landAll(chain, signed) {
  const sigs = [];
  await Promise.all(signed.map(async (b, i) => { try { sigs[i] = await sendRaw(chain, b, { skipPreflight: true }); } catch { sigs[i] = null; } }));
  const done = new Set();
  for (let round = 0; round < 20 && done.size < signed.length; round++) {
    await sleep(2000);
    const todo = sigs.map((s, i) => (s && !done.has(i) ? i : -1)).filter((i) => i >= 0);
    if (!todo.length) break;
    const st = (await rpc(chain, 'getSignatureStatuses', [todo.map((i) => sigs[i])]).catch(() => null))?.value || [];
    todo.forEach((i, k) => {
      const s = st[k];
      if (s && !s.err && (s.confirmationStatus === 'confirmed' || s.confirmationStatus === 'finalized')) done.add(i);
      else if (s?.err) sigs[i] = null; // failed: written again in the next round
    });
    if (round % 3 === 2) signed.forEach((b, i) => { if (!done.has(i) && sigs[i]) sendRaw(chain, b, { skipPreflight: true }).catch(() => {}); });
  }
  return signed.map((_, i) => i).filter((i) => !done.has(i));
}

export function SolDeploy({ chainId: initialChain, program: upgradeOf = null, onBack, open }) {
  const { state, account, setPortfolioCache } = useApp();
  const [chainId, setChainId] = useState(initialChain ?? SOL_DEVNET);
  const chain = getChain(chainId, state.customChains);
  const wallet = useSolWalletFor(chain);
  const auth = useOperationAuth(t('solc.deploy.authTitle'));
  const [elf, setElf] = useState(null); // { name, bytes }
  const [idlText, setIdlText] = useState('');
  const [programSeed, setProgramSeed] = useState(null); // a program keypair file (the address declared in the code)
  const [target, setTarget] = useState(null); // the program being upgraded (loadSolAccount)
  const [cost, setCost] = useState(null);
  const [balance, setBalance] = useState(null);
  const [pick, setPick] = useState(false);
  const [run, setRun] = useState(null); // { phase, written, total, buffer, error, program }
  const [err, setErr] = useState('');
  const [buffers, setBuffers] = useState(null);

  useEffect(() => { if (upgradeOf) loadSolAccount(chain, upgradeOf).then(setTarget).catch((e) => setErr(e.message)); }, [upgradeOf, chainId]);
  useEffect(() => { if (wallet) solBalance(chain, wallet.raw).then(setBalance).catch(() => {}); }, [wallet, chainId, run?.phase]);
  useEffect(() => {
    if (!wallet) return;
    setBuffers(null);
    buffersOf(chain, wallet.raw).then(setBuffers).catch(() => setBuffers([]));
  }, [wallet, chainId, run?.phase]);
  useEffect(() => {
    if (!elf) { setCost(null); return; }
    const len = elf.bytes.length;
    const extra = target && target.size != null && len > target.size ? Math.max(len - target.size, MIN_EXTEND) : 0;
    Promise.all([rentExempt(chain, BUFFER_META + len), rentExempt(chain, PROGRAMDATA_META + len), rentExempt(chain, PROGRAM_SPACE), extra ? rentExempt(chain, PROGRAMDATA_META + target.size + extra).then((r) => r - (target.programDataLamports || 0n)) : 0n])
      .then(([buffer, data, prog, ext]) => {
        const txs = Math.ceil(len / CHUNK) + 2;
        const fees = BigInt(txs) * 10_000n; // signature + a small priority fee each (estimate)
        setCost({ buffer, data: upgradeOf ? (ext > 0n ? ext : 0n) : data + prog, fees, txs, len });
      }).catch((e) => setErr(e.message));
  }, [elf, chainId, target]);

  const readFile = async (f, kind) => {
    setErr('');
    const bytes = new Uint8Array(await f.arrayBuffer());
    if (kind === 'so') { if (!isElf(bytes)) { setErr(t('solc.deploy.notElf')); return; } setElf({ name: f.name, bytes }); }
    if (kind === 'idl') { const s = new TextDecoder().decode(bytes); try { normalizeIdl(s); setIdlText(s); } catch (e) { setErr(t('solc.idl.bad', { reason: e.message })); } }
    if (kind === 'key') { try { setProgramSeed(seedFromSecret(new TextDecoder().decode(bytes))); } catch { setErr(t('solc.deploy.badKey')); } }
  };

  const start = async () => {
    setErr('');
    const me = wallet.raw, bytes = elf.bytes, len = bytes.length;
    const bufferSeed = crypto.getRandomValues(new Uint8Array(32));
    const buffer = keyOfSeed(bufferSeed).address;
    const pSeed = upgradeOf ? null : programSeed || crypto.getRandomValues(new Uint8Array(32));
    const programId = upgradeOf || keyOfSeed(pSeed).address;
    const chunks = chunksOf(bytes, CHUNK);
    const step = (patch) => setRun((r) => ({ ...r, ...patch }));
    setRun({ phase: 'buffer', written: 0, total: chunks.length, buffer, program: programId });
    let created = false; // the buffer exists: an interruption leaves it (to close)
    try {
      // 0) an upgrade larger than the program: more room first, in a transaction of its own (before anything is
      //    written: if the network refuses it, nothing has been spent on the buffer)
      const need = upgradeOf && target.size != null && len > target.size ? len - target.size : 0;
      if (need) {
        const extra = Math.max(need, MIN_EXTEND); // the loader refuses smaller extensions
        let ext = [loader.extend({ program: programId, payer: me, bytes: extra })];
        let p0 = await plan(chain, { payer: me, instructions: ext });
        if (p0.problem) { // networks that only accept the signed variant
          const ext2 = [loader.extendChecked({ program: programId, authority: me, payer: me, bytes: extra })];
          const p2 = await plan(chain, { payer: me, instructions: ext2 });
          if (!p2.problem) { ext = ext2; p0 = p2; }
        }
        if (p0.problem) throw new Error(p0.problem);
        const r0 = await sendInstructions(chain, { account, payer: me, instructions: ext, limit: p0.limit, price: p0.price, auth: (fn) => auth(fn, true), title: t('solc.deploy.authTitle') });
        await r0.wait;
      }
      // 1) the buffer
      const bufRent = await rentExempt(chain, BUFFER_META + len);
      const first = [system.createAccount(me, buffer, bufRent, BUFFER_META + len, PROGRAMS.loaderV3), loader.initializeBuffer(buffer, me)];
      const p1 = await plan(chain, { payer: me, instructions: first, signers: 2 });
      if (p1.problem) throw new Error(p1.problem);
      const r1 = await sendInstructions(chain, { account, payer: me, instructions: first, limit: p1.limit, price: p1.price, extraSeeds: [bufferSeed], auth: (fn) => auth(fn, true), title: t('solc.deploy.authTitle') });
      created = true;
      await r1.wait;
      // 2) the program's bytes, BATCH transactions at a time, again for those that didn't land
      step({ phase: 'write' });
      const price = Math.min(await priorityPrice(chain, [buffer]), 200_000);
      let todo = chunks.map((_, i) => i);
      for (let attempt = 0; attempt < 5 && todo.length; attempt++) {
        const failed = [];
        for (let i = 0; i < todo.length; i += BATCH) {
          const part = todo.slice(i, i + BATCH);
          const { blockhash } = await latestBlockhash(chain);
          const txs = part.map((k) => {
            const b = buildTransaction({ payer: me, recentBlockhash: blockhash, instructions: [computeBudget.unitLimit(WRITE_UNITS), computeBudget.unitPrice(price), loader.write(buffer, me, chunks[k].offset, chunks[k].bytes)] });
            if (b.length > MAX_TX_SIZE) throw new Error('write transaction too large');
            return toBase64(b);
          });
          const signed = await auth((password) => bg('solanaSign', { from: account.address, txs, password }), true);
          const missed = await landAll(chain, signed.txs.map(fromBase64));
          failed.push(...missed.map((m) => part[m]));
          setRun((r) => ({ ...r, written: r.written + part.length - missed.length }));
        }
        todo = failed;
      }
      if (todo.length) throw new Error(t('solc.deploy.writeFailed', { n: todo.length }));
      // 3) deploy (a new program) or upgrade (the same address, the new code)
      step({ phase: 'deploy' });
      let last;
      if (upgradeOf) {
        last = [loader.upgrade({ program: programId, buffer, spill: me, authority: me })];
      } else {
        const progRent = await rentExempt(chain, PROGRAM_SPACE);
        last = [system.createAccount(me, programId, progRent, PROGRAM_SPACE, PROGRAMS.loaderV3), loader.deploy({ payer: me, program: programId, buffer, authority: me, maxLen: len })];
      }
      const p3 = await plan(chain, { payer: me, instructions: last, signers: upgradeOf ? 1 : 2 });
      if (p3.problem) throw new Error(p3.problem);
      const r3 = await sendInstructions(chain, { account, payer: me, instructions: last, limit: p3.limit, price: p3.price, extraSeeds: upgradeOf ? [] : [pSeed], auth: (fn) => auth(fn, false), title: t('solc.deploy.authTitle') });
      await r3.wait;
      await saveContract({ chainId: chain.id, address: programId, name: elf.name.replace(/\.so$/, ''), mine: true, kind: 'program', ...(idlText ? { abi: idlText } : {}) });
      setPortfolioCache((c) => { const n = { ...c }; delete n[`${chain.id}:${account.address}`]; return n; });
      step({ phase: 'done', hash: r3.hash });
    } catch (e) {
      if (e.cancelled && !created) { setRun(null); return; } // nothing on chain yet
      setRun((r) => ({ ...r, failedAt: r.phase, phase: 'error', error: e.message }));
    }
  };

  const closeBuffer = (b) => open({ name: 'soltx', chainId, req: { title: t('solc.op.closeBuffer.title'), instructions: [loader.close({ account: b.address, recipient: wallet.raw, authority: wallet.raw })], summary: [[t('solc.f.recover'), solText(b.lamports, chain)]] } });
  const need = cost ? cost.buffer + cost.data + cost.fees : null;
  const busy = run && !['done', 'error'].includes(run.phase);

  return (
    <div class="screen">
      <div class="topbar"><button class="iconbtn" onClick={onBack} disabled={busy} title={t('common.back')}><Icon name="back" /></button><h1>{t(upgradeOf ? 'solc.deploy.upgradeTitle' : 'solc.deploy.title')}</h1></div>
      <div class="content ct-content">
        <div class="info small">{t(upgradeOf ? 'solc.deploy.upgradeIntro' : 'solc.deploy.intro')}</div>
        {!upgradeOf && (
          <button class="item card flat" disabled={busy} onClick={() => setPick(true)}>
            <ChainIcon chain={chain} size={24} /><div class="grow"><div class="bold">{chain.name}</div><div class="tiny muted">{t('solc.create.network')}</div></div><Icon name="chevron" size={14} />
          </button>
        )}
        {upgradeOf && <div class="card col" style={{ gap: '.25rem' }}><span class="tiny muted">{t('solc.deploy.upgrading')}</span><AddrValue address={upgradeOf} /></div>}
        {wallet === null && <div class="error">{t('solc.noKey')}</div>}
        <label class="btn secondary ct-filebtn"><Icon name="receive" size={16} /> {elf ? `${elf.name} · ${t('solc.bytes', { n: elf.bytes.length.toLocaleString() })}` : t('solc.deploy.pickSo')}<input type="file" accept=".so,application/octet-stream" disabled={busy} onChange={(e) => e.target.files?.[0] && readFile(e.target.files[0], 'so')} /></label>
        <label class="btn secondary sm ct-filebtn"><Icon name="code" size={14} /> {idlText ? t('solc.deploy.idlLoaded') : t('solc.deploy.pickIdl')}<input type="file" accept=".json,application/json" disabled={busy} onChange={(e) => e.target.files?.[0] && readFile(e.target.files[0], 'idl')} /></label>
        {!upgradeOf && (
          <>
            <label class="btn secondary sm ct-filebtn"><Icon name="key" size={14} /> {programSeed ? keyOfSeed(programSeed).address : t('solc.deploy.pickKey')}<input type="file" accept=".json,application/json" disabled={busy} onChange={(e) => e.target.files?.[0] && readFile(e.target.files[0], 'key')} /></label>
            <span class="tiny muted">{t('solc.deploy.keyHint')}</span>
          </>
        )}
        {cost && (
          <div class="card kv">
            <span class="k">{t('solc.deploy.txs')}</span><span class="v">{cost.txs}</span>
            <span class="k">{t('solc.deploy.rent')}</span><span class="v">{solText(cost.data, chain, 4)}</span>
            <span class="k">{t('solc.deploy.bufferRent')}</span><span class="v">{solText(cost.buffer, chain, 4)}</span>
            <span class="k">{t('solc.deploy.fees')}</span><span class="v">≈ {solText(cost.fees, chain, 4)}</span>
            {balance != null && <><span class="k">{t('solc.balance')}</span><span class="v">{solText(balance, chain, 4)}</span></>}
          </div>
        )}
        {cost && <span class="tiny muted">{t('solc.deploy.costHint')}</span>}
        {need != null && balance != null && balance < need && <div class="error">{t('solc.deploy.noSol', { amount: solText(need, chain, 4) })}</div>}
        {run && (
          <div class="card col" style={{ gap: '.5rem' }}>
            {['buffer', 'write', 'deploy'].map((ph, i) => {
              const order = ['buffer', 'write', 'deploy', 'done'];
              const at = order.indexOf(run.phase === 'error' ? run.failedAt || run.phase : run.phase);
              const state = run.phase === 'done' || at > i ? 'done' : at === i ? (run.phase === 'error' ? 'error' : 'now') : 'todo';
              return (
                <div class="row" style={{ gap: '.5rem' }}>
                  {state === 'done' ? <Icon name="check" size={16} /> : state === 'now' ? <Spinner /> : <span class="dot" />}
                  <span class="small grow">{t(`solc.deploy.step.${ph}`)}{ph === 'write' && run.total ? ` · ${run.written}/${run.total}` : ''}</span>
                </div>
              );
            })}
            {run.phase === 'write' && (
              <div style={{ height: '6px', borderRadius: '3px', background: 'var(--border)', overflow: 'hidden' }}>
                <div style={{ height: '100%', width: `${Math.round((run.written / run.total) * 100)}%`, background: 'var(--primary)', transition: 'width .3s' }} />
              </div>
            )}
            {run.phase === 'error' && <div class="error small">{run.error}<br />{t('solc.deploy.leftBuffer')}</div>}
            {run.phase === 'done' && (
              <>
                <div class="success">{t(upgradeOf ? 'solc.deploy.upgraded' : 'solc.deploy.done')}</div>
                <Btn onClick={() => open({ name: 'contract', chainId, address: run.program }, { replace: true })}><Icon name="code" size={16} /> {t('solc.done.open')}</Btn>
              </>
            )}
          </div>
        )}
        {buffers?.length > 0 && (
          <div class="card col" style={{ gap: '.375rem' }}>
            <b class="small">{t('solc.deploy.buffers')}</b>
            <span class="tiny muted">{t('solc.deploy.buffersHint')}</span>
            {buffers.map((b) => (
              <div class="row" style={{ gap: '.5rem' }}>
                <span class="grow"><AddrValue address={b.address} /><span class="tiny muted"> · {solText(b.lamports, chain, 4)}</span></span>
                <button class="btn secondary sm" disabled={busy} onClick={() => closeBuffer(b)}>{t('solc.deploy.close')}</button>
              </div>
            ))}
          </div>
        )}
        {err && <div class="error">{err}</div>}
      </div>
      <div class="footer">
        <Btn disabled={!wallet || !elf || !cost || busy || (upgradeOf && !target) || (need != null && balance != null && balance < need)} loading={busy} onClick={start}>
          {t(upgradeOf ? 'solc.deploy.upgradeGo' : 'solc.deploy.go')}
        </Btn>
      </div>
      {pick && <NetworkSheet current={chainId} onPick={setChainId} only={isSolana} onClose={() => setPick(false)} />}
    </div>
  );
}
