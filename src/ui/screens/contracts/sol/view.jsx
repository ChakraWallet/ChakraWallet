// Contract page on Solana: what the address is (a program, a token, an NFT, a program's account, a wallet), then
// Read (its data, decoded with the program's IDL) / Write (the IDL's instructions, or guided operations for tokens,
// NFTs and programs the user has authority on) / Inspect (raw data, the program's loader and authority, the IDL) /
// Activity (latest transactions).
import { useEffect, useState } from 'preact/hooks';
import { Icon, Spinner, Btn, ChainIcon, useApp } from '../../../components.jsx';
import { getChain } from '../../../../shared/chains.js';
import { fmtAmount, fmtDateTime, parseAmount, shortAddr } from '../../../../shared/format.js';
import { t } from '../../../../shared/i18n.js';
import { isAddress, keyOfSeed, toHex } from '../../../../shared/solana/core.js';
import { rpc, rentExempt, solAddrUrl, solTxUrl, accountInfo } from '../../../../shared/solana/api.js';
import { system } from '../../../../shared/solana/tx.js';
import { loadSolAccount, fetchOnchainIdl, loader, programName } from '../../../../shared/solana/programs.js';
import { normalizeIdl, decodeAccount } from '../../../../shared/solana/idl.js';
import { tokenMetas } from '../../../../shared/solana/tokens.js';
import { tokenAdmin, metadataIx, readMintMetadata, mintSpace, readCore, core, CORE, LIMITS } from '../../../../shared/solana/templates.js';
import * as b58 from '../../../../shared/solana/base58.js';
import { addRecent, saveContract, unsaveContract, savedEntry, customAbi, setCustomAbi } from '../../../contractsStore.js';
import { Shell, Loading, AddrValue, SolValue, copyText, solText, useSolWalletFor } from './parts.jsx';
import { IxCard, RawIxCard, OpCard } from './form.jsx';
import { PdaCalc } from './tools.jsx';

const TABS = ['read', 'write', 'inspect', 'activity'];
const randomSeed = () => crypto.getRandomValues(new Uint8Array(32));

/** The IDL that describes an address: its own (a program) or its owner's (an account of a program). */
async function loadIdl(chain, c) {
  const pid = c.kind === 'program' ? c.address : c.kind === 'data' ? c.owner : null;
  if (!pid) return null;
  const mine = await customAbi(chain.id, pid);
  if (typeof mine === 'string') { try { return { idl: normalizeIdl(mine, pid), raw: mine, source: 'device', programId: pid }; } catch { /* a broken saved IDL: ignore */ } }
  const r = await fetchOnchainIdl(chain, pid).catch(() => null);
  return r ? { ...r, programId: pid } : { none: true, programId: pid };
}

export function SolContractView({ chainId, address, onBack, open }) {
  const { state, toast } = useApp();
  const chain = getChain(chainId, state.customChains);
  const wallet = useSolWalletFor(chain);
  const [c, setC] = useState(null);
  const [idl, setIdl] = useState(undefined); // undefined: loading; null: not a program's
  const [err, setErr] = useState('');
  const [tab, setTab] = useState('read');
  const [saved, setSaved] = useState(null);
  const [reload, setReload] = useState(0);

  useEffect(() => {
    let alive = true;
    setErr(''); if (reload) setC(null);
    (async () => {
      const r = await loadSolAccount(chain, address);
      if (!alive) return;
      const coreData = r.owner === CORE ? readCore(r.data) : null;
      const md = r.kind === 'mint' ? readMintMetadata(r.data) : null;
      const full = { ...r, core: coreData, metadata: md };
      setC(full);
      addRecent(chainId, address, full.name || coreData?.name || md?.name || null);
      loadIdl(chain, full).then((x) => alive && setIdl(x)).catch(() => alive && setIdl(null));
    })().catch((e) => alive && setErr(e.message));
    savedEntry(chainId, address).then((s) => alive && setSaved(s));
    return () => { alive = false; };
  }, [reload]);

  if (!chain) return <Shell onBack={onBack}><div class="error">{t('contracts.unknownChain')}</div></Shell>;
  if (err) return <Shell onBack={onBack}><div class="error">{err}</div><Btn kind="secondary" onClick={() => setReload((x) => x + 1)}>{t('contracts.retry')}</Btn></Shell>;
  if (!c) return <Shell onBack={onBack}><Loading /></Shell>;

  const me = wallet?.raw || null;
  const openAddr = (a) => open({ name: 'contract', chainId, address: a });
  const onSend = (req) => open({ name: 'soltx', chainId, req, onMined: () => setReload((x) => x + 1) });
  const name = saved?.name || c.name || c.core?.name || c.metadata?.name || null;

  if (!c.exists) {
    return (
      <Shell onBack={onBack} title={shortAddr(address, 6)}>
        <div class="card col" style={{ gap: '.5rem' }}>
          <b>{t('solc.empty.title')}</b>
          <span class="small muted">{t('solc.empty.body', { chain: chain.name })}</span>
          <span class="mono tiny" onClick={() => copyText(address, toast)}>{address}</span>
        </div>
        <Btn kind="secondary" onClick={() => setReload((x) => x + 1)}><Icon name="refresh" size={16} /> {t('contracts.refresh')}</Btn>
      </Shell>
    );
  }

  const toggleSave = async () => {
    if (saved) { await unsaveContract(chainId, c.address); setSaved(null); toast(t('contracts.unsaved')); }
    else { const s = { chainId, address: c.address, name }; await saveContract(s); setSaved(s); toast(t('contracts.saved')); }
  };
  const kindKey = c.core ? (c.core.kind === 'asset' ? 'coreAsset' : 'coreCollection') : c.kind;
  return (
    <Shell onBack={onBack} title={name || t(`solc.kind.${kindKey}`)} right={<button class="iconbtn" title={saved ? t('contracts.unsave') : t('contracts.save')} onClick={toggleSave}><Icon name={saved ? 'bookmark' : 'star'} size={18} /></button>}>
      <div class="card col ct-head">
        <div class="row" style={{ gap: '.5rem' }}>
          <ChainIcon chain={chain} size={22} />
          <span class="mono small grow" style={{ wordBreak: 'break-all' }} onClick={() => copyText(c.address, toast)}>{c.address}</span>
        </div>
        <div class="pills">
          <span class="badge primary">{t(`solc.kind.${kindKey}`)}</span>
          {c.kind === 'program' && (c.upgradeable ? <span class="badge amber">{t('solc.upgradeable')}</span> : <span class="badge green">{t('solc.immutable')}</span>)}
          {c.kind === 'program' && c.authority && c.authority === me && <span class="badge green">{t('solc.yourProgram')}</span>}
          {idl?.idl && <span class="badge green"><Icon name="check" size={12} stroke={3} /> IDL {idl.idl.name || ''}</span>}
          {idl?.none && c.kind === 'program' && <span class="badge">{t('solc.noIdl')}</span>}
          {saved?.mine && <span class="badge green">{t('contracts.mine')}</span>}
          {c.kind !== 'program' && c.ownerName && <span class="badge">{c.ownerName}</span>}
        </div>
        <span class="small">{t('solc.balance')}: <b>{solText(c.lamports, chain, 4)}</b></span>
      </div>
      <div class="seg seg-full" role="tablist">
        {TABS.map((k) => <button role="tab" aria-selected={tab === k} class={tab === k ? 'on' : ''} onClick={() => setTab(k)}>{t(`contracts.tab.${k}`)}</button>)}
      </div>
      {tab === 'read' && <ReadTab c={c} chain={chain} idl={idl} me={me} onOpenAddress={openAddr} />}
      {tab === 'write' && <WriteTab c={c} chain={chain} idl={idl} wallet={wallet} onSend={onSend} open={open} />}
      {tab === 'inspect' && <InspectTab c={c} chain={chain} idl={idl} onOpenAddress={openAddr} onIdl={() => { setIdl(undefined); setReload((x) => x + 1); }} />}
      {tab === 'activity' && <ActivityTab c={c} chain={chain} />}
    </Shell>
  );
}

// ------------------------------------------------------------ read
const Row = ({ k, children }) => <><span class="k">{k}</span><span class="v">{children}</span></>;

function TokenInfo({ c, chain, me, onOpenAddress }) {
  const [meta, setMeta] = useState(null);
  useEffect(() => { tokenMetas(chain, [c.address]).then((m) => setMeta(m.get(c.address))).catch(() => {}); }, []);
  const m = c.mint;
  const md = c.metadata;
  return (
    <div class="card kv">
      <Row k={t('solc.token.name')}>{md?.name || meta?.name || '—'}</Row>
      <Row k={t('solc.token.symbol')}>{md?.symbol || meta?.symbol || '—'}</Row>
      <Row k={t('solc.token.supply')}>{fmtAmount(BigInt(m.supply || 0), m.decimals, 4)}</Row>
      <Row k={t('solc.token.decimals')}>{m.decimals}</Row>
      <Row k={t('solc.token.mintAuthority')}>{m.mintAuthority ? <AddrValue address={m.mintAuthority} me={me} onOpenAddress={onOpenAddress} /> : t('solc.token.fixed')}</Row>
      <Row k={t('solc.token.freezeAuthority')}>{m.freezeAuthority ? <AddrValue address={m.freezeAuthority} me={me} onOpenAddress={onOpenAddress} /> : t('solc.token.noFreeze')}</Row>
      <Row k={t('solc.token.program')}>{programName(c.owner)}</Row>
      {md && <Row k={t('solc.token.metaAuthority')}>{md.updateAuthority ? <AddrValue address={md.updateAuthority} me={me} onOpenAddress={onOpenAddress} /> : t('solc.token.metaFixed')}</Row>}
      {md?.uri && <Row k={t('solc.token.uri')}><a class="link tiny" href={md.uri} target="_blank" rel="noopener" style={{ wordBreak: 'break-all' }}>{md.uri}</a></Row>}
      {meta && <Row k="Jupiter">{meta.known ? t('solc.token.verified') : t('solc.token.notVerified')}</Row>}
    </div>
  );
}

/** Decodes one account of the program with its IDL. */
function AccountReader({ idl, chain, me, onOpenAddress }) {
  const [addr, setAddr] = useState('');
  const [res, setRes] = useState(null);
  const [busy, setBusy] = useState(false);
  const read = async () => {
    setBusy(true); setRes(null);
    try {
      const a = await accountInfo(chain, addr.trim());
      if (!a) setRes({ error: t('solc.read.noAccount') });
      else if (a.owner !== idl.programId) setRes({ error: t('solc.read.otherOwner', { owner: programName(a.owner) || shortAddr(a.owner, 4) }) });
      else setRes(decodeAccount(idl.idl, a.data) || { error: t('solc.read.unknownType') });
    } catch (e) { setRes({ error: e.message }); }
    setBusy(false);
  };
  return (
    <div class="card col" style={{ gap: '.5rem' }}>
      <b class="small">{t('solc.read.account')}</b>
      <div class="row" style={{ gap: '.375rem' }}>
        <input class="input mono" value={addr} placeholder={t('solc.form.address')} spellcheck={false} autocapitalize="off" onInput={(e) => setAddr(e.target.value)} />
        <button class="btn primary sm" disabled={!isAddress(addr.trim()) || busy} onClick={read}>{busy ? <Spinner /> : t('contracts.fn.read')}</button>
      </div>
      {res?.error && <div class="error small">{res.error}</div>}
      {res?.type && <div class="col" style={{ gap: '.25rem' }}><span class="badge primary" style={{ alignSelf: 'flex-start' }}>{res.type}</span>{res.value ? <SolValue v={res.value} onOpenAddress={onOpenAddress} me={me} /> : <span class="tiny red">{t('solc.read.badData')}</span>}</div>}
    </div>
  );
}

/** Lists the program's accounts of one type (getProgramAccounts by discriminator; some nodes refuse it). */
function AccountLister({ idl, chain, me, onOpenAddress }) {
  const types = idl.idl.accounts.filter((a) => a.discriminator);
  const [type, setType] = useState(types[0]?.name || '');
  const [list, setList] = useState(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  if (!types.length) return null;
  const load = async () => {
    setBusy(true); setErr(''); setList(null);
    try {
      const a = types.find((x) => x.name === type);
      const r = await rpc(chain, 'getProgramAccounts', [idl.programId, { encoding: 'base64', commitment: 'confirmed', filters: [{ memcmp: { offset: 0, bytes: b58.encode(a.discriminator) } }] }], { timeout: 30000 });
      setList(r.slice(0, 50).map((x) => {
        const data = Uint8Array.from(atob(x.account.data[0]), (ch) => ch.charCodeAt(0));
        return { address: x.pubkey, decoded: decodeAccount(idl.idl, data) };
      }));
      if (r.length > 50) setErr(t('solc.read.more', { n: r.length }));
    } catch (e) { setErr(t('solc.read.listFailed', { reason: e.message })); }
    setBusy(false);
  };
  return (
    <div class="card col" style={{ gap: '.5rem' }}>
      <b class="small">{t('solc.read.list')}</b>
      <div class="row" style={{ gap: '.375rem' }}>
        <select class="input" value={type} onChange={(e) => setType(e.target.value)}>{types.map((a) => <option value={a.name}>{a.name}</option>)}</select>
        <button class="btn secondary sm" disabled={busy} onClick={load}>{busy ? <Spinner /> : t('solc.read.listDo')}</button>
      </div>
      {err && <div class="tiny muted">{err}</div>}
      {list && !list.length && <span class="small muted">{t('solc.read.none')}</span>}
      {list?.map((x) => (
        <details class="sol-acc">
          <summary class="mono tiny">{shortAddr(x.address, 6)}</summary>
          <AddrValue address={x.address} onOpenAddress={onOpenAddress} me={me} />
          {x.decoded?.value && <SolValue v={x.decoded.value} onOpenAddress={onOpenAddress} me={me} />}
        </details>
      ))}
    </div>
  );
}

function ReadTab({ c, chain, idl, me, onOpenAddress }) {
  if (c.kind === 'mint') return <TokenInfo c={c} chain={chain} me={me} onOpenAddress={onOpenAddress} />;
  if (c.kind === 'tokenAccount') {
    const x = c.token;
    return (
      <div class="card kv">
        <Row k={t('solc.tokacc.mint')}><AddrValue address={x.mint} me={me} onOpenAddress={onOpenAddress} /></Row>
        <Row k={t('solc.tokacc.owner')}><AddrValue address={x.owner} me={me} onOpenAddress={onOpenAddress} /></Row>
        <Row k={t('solc.tokacc.amount')}>{x.tokenAmount?.uiAmountString ?? '—'}</Row>
        <Row k={t('solc.tokacc.state')}>{x.state}</Row>
        {x.delegate && <Row k={t('solc.tokacc.delegate')}><AddrValue address={x.delegate} me={me} onOpenAddress={onOpenAddress} /></Row>}
      </div>
    );
  }
  if (c.core) {
    const x = c.core;
    return (
      <div class="card kv">
        <Row k={t('solc.token.name')}>{x.name}</Row>
        {x.uri && <Row k={t('solc.token.uri')}><a class="link tiny" href={x.uri} target="_blank" rel="noopener" style={{ wordBreak: 'break-all' }}>{x.uri}</a></Row>}
        {x.kind === 'asset' && <Row k={t('solc.core.owner')}><AddrValue address={x.owner} me={me} onOpenAddress={onOpenAddress} /></Row>}
        {x.collection && <Row k={t('solc.core.collection')}><AddrValue address={x.collection} me={me} onOpenAddress={onOpenAddress} /></Row>}
        {x.updateAuthority && <Row k={t('solc.core.authority')}><AddrValue address={x.updateAuthority} me={me} onOpenAddress={onOpenAddress} /></Row>}
        {x.kind === 'collection' && <Row k={t('solc.core.minted')}>{x.minted}</Row>}
      </div>
    );
  }
  if (c.kind === 'program') {
    return (
      <>
        {idl === undefined && <Loading text={t('solc.idl.loading')} />}
        {idl?.idl && <AccountReader idl={idl} chain={chain} me={me} onOpenAddress={onOpenAddress} />}
        {idl?.idl && <AccountLister idl={idl} chain={chain} me={me} onOpenAddress={onOpenAddress} />}
        {idl && !idl.idl && <div class="card small muted">{idl.codama ? t('solc.idl.codama') : t('solc.idl.none')}</div>}
        <PdaCalc programId={c.address} />
      </>
    );
  }
  if (c.kind === 'data') {
    const d = idl?.idl ? decodeAccount(idl.idl, c.data) : null;
    return (
      <div class="card col" style={{ gap: '.375rem' }}>
        <span class="small">{t('solc.data.owner')} <AddrValue address={c.owner} me={me} onOpenAddress={onOpenAddress} /></span>
        {idl === undefined ? <Spinner /> : d?.value ? <><span class="badge primary" style={{ alignSelf: 'flex-start' }}>{d.type}</span><SolValue v={d.value} onOpenAddress={onOpenAddress} me={me} /></>
          : <span class="small muted">{t('solc.data.raw', { n: c.space })}</span>}
      </div>
    );
  }
  if (c.kind === 'programdata' || c.kind === 'buffer') {
    return (
      <div class="card kv">
        <Row k={t('solc.prog.authority')}>{c.authority ? <AddrValue address={c.authority} me={me} onOpenAddress={onOpenAddress} /> : t('solc.immutable')}</Row>
        <Row k={t('solc.prog.size')}>{t('solc.bytes', { n: (c.size ?? 0).toLocaleString() })}</Row>
        {c.slot != null && <Row k={t('solc.prog.slot')}>{c.slot}</Row>}
      </div>
    );
  }
  return <div class="card small muted">{t('solc.wallet.body')}</div>;
}

// ------------------------------------------------------------ write: guided operations
const amountRaw = (text, decimals) => { const v = parseAmount(String(text || '').trim(), decimals); if (v == null || v <= 0n) throw new Error(t('solc.err.amount')); return v; };
const addr = (text, allowEmpty = false) => { const s = String(text || '').trim(); if (!s && allowEmpty) return null; if (!isAddress(s)) throw new Error(t('contracts.err.badAddress')); return s; };

function tokenOps(c, chain, me, onSend) {
  const m = c.mint, program = c.owner, mint = c.address, sym = c.metadata?.symbol || '';
  const ops = [];
  const send = (key, instructions, summary, risks = []) => onSend({ title: t(`solc.op.${key}.title`), instructions, summary, risks });
  if (m.mintAuthority === me) {
    ops.push({ key: 'mint', fields: [['to', 'address', me], ['amount', 'amount']], run: async (v) => send('mint', tokenAdmin.mint({ payer: me, mint, program, to: addr(v.to), amount: amountRaw(v.amount, m.decimals) }), [[t('solc.f.to'), v.to], [t('solc.f.amount'), `${v.amount} ${sym}`]]) });
    ops.push({ key: 'mintAuthority', risk: 'renounce', fields: [['next', 'address']], run: async (v) => { const next = addr(v.next, true); send('mintAuthority', tokenAdmin.authority({ current: me, mint, program, kind: 'mint', next }), [[t('solc.f.next'), next || t('solc.nobody')]], next ? ['authority'] : ['renounce']); } });
  }
  ops.push({ key: 'burn', risk: 'burn', fields: [['amount', 'amount']], run: async (v) => send('burn', tokenAdmin.burn({ owner: me, mint, program, amount: amountRaw(v.amount, m.decimals), decimals: m.decimals }), [[t('solc.f.amount'), `${v.amount} ${sym}`]], ['burn']) });
  if (m.freezeAuthority === me) {
    ops.push({ key: 'freeze', fields: [['holder', 'address']], run: async (v) => send('freeze', tokenAdmin.freeze({ authority: me, mint, program, holder: addr(v.holder) }), [[t('solc.f.holder'), v.holder]]) });
    ops.push({ key: 'thaw', fields: [['holder', 'address']], run: async (v) => send('thaw', tokenAdmin.thaw({ authority: me, mint, program, holder: addr(v.holder) }), [[t('solc.f.holder'), v.holder]]) });
    ops.push({ key: 'freezeAuthority', risk: 'renounce', fields: [['next', 'address']], run: async (v) => { const next = addr(v.next, true); send('freezeAuthority', tokenAdmin.authority({ current: me, mint, program, kind: 'freeze', next }), [[t('solc.f.next'), next || t('solc.nobody')]], next ? ['authority'] : ['renounce']); } });
  }
  const md = c.metadata;
  if (md && md.updateAuthority === me) {
    ops.push({
      key: 'metadata', fields: [['name', 'text', md.name], ['symbol', 'text', md.symbol], ['uri', 'text', md.uri]],
      run: async (v) => {
        const next = { name: v.name.trim(), symbol: v.symbol.trim(), uri: v.uri.trim(), extra: md.extra };
        if (next.name.length > LIMITS.name * 4 || next.symbol.length > LIMITS.symbol * 4 || next.uri.length > LIMITS.uri * 4) throw new Error(t('solc.err.tooLong'));
        const changed = ['name', 'symbol', 'uri'].filter((k) => next[k] !== md[k]);
        if (!changed.length) throw new Error(t('solc.err.nothing'));
        // the account grows with longer texts: it must keep the rent of its new size
        const need = await rentExempt(chain, mintSpace(next).full);
        const add = need > c.lamports ? need - c.lamports : 0n;
        send('metadata', [...(add > 0n ? [system.transfer(me, mint, add)] : []), ...changed.map((k) => metadataIx.updateField({ mint, authority: me, field: k, value: next[k] }))], changed.map((k) => [t(`solc.f.${k}`), next[k]]));
      },
    });
    ops.push({ key: 'metadataAuthority', risk: 'renounce', fields: [['next', 'address']], run: async (v) => { const next = addr(v.next, true); send('metadataAuthority', [metadataIx.updateAuthority({ mint, authority: me, next })], [[t('solc.f.next'), next || t('solc.nobody')]], next ? ['authority'] : ['renounce']); } });
  }
  return ops;
}

function coreOps(c, chain, me, onSend) {
  const x = c.core, ops = [];
  if (x.kind === 'collection' && x.updateAuthority === me) {
    ops.push({
      key: 'nftMint', fields: [['name', 'text', `${x.name} #${x.minted + 1}`], ['uri', 'text'], ['owner', 'address', me]],
      run: async (v) => {
        const seed = randomSeed(), asset = keyOfSeed(seed).address;
        if (!v.name.trim()) throw new Error(t('solc.err.name'));
        onSend({ title: t('solc.op.nftMint.title'), instructions: [core.createAsset({ payer: me, asset, collection: c.address, name: v.name.trim(), uri: v.uri.trim(), owner: addr(v.owner) })], extraSeeds: [seed],
          summary: [[t('solc.f.name'), v.name], [t('solc.f.owner'), v.owner], [t('solc.f.address'), asset]], deploy: { address: asset, name: v.name.trim(), kind: 'nft' } });
      },
    });
    ops.push({ key: 'collectionUpdate', fields: [['name', 'text', x.name], ['uri', 'text', x.uri]], run: async (v) => onSend({ title: t('solc.op.collectionUpdate.title'), instructions: [core.updateCollection({ payer: me, collection: c.address, name: v.name.trim() !== x.name ? v.name.trim() : null, uri: v.uri.trim() !== x.uri ? v.uri.trim() : null })], summary: [[t('solc.f.name'), v.name], [t('solc.f.uri'), v.uri]] }) });
  }
  if (x.kind === 'asset' && x.owner === me) {
    ops.push({ key: 'nftTransfer', fields: [['to', 'address']], run: async (v) => onSend({ title: t('solc.op.nftTransfer.title'), instructions: [core.transfer({ payer: me, asset: c.address, collection: x.collection, newOwner: addr(v.to) })], summary: [[t('solc.f.to'), v.to]], risks: ['transfer'] }) });
  }
  return ops;
}

function programOps(c, chain, me, onSend, open) {
  const ops = [];
  if (c.kind === 'program' && c.upgradeable && c.authority === me) {
    ops.push({ key: 'upgrade', fields: [], run: async () => open({ name: 'soldeploy', chainId: chain.id, program: c.address }) });
    ops.push({ key: 'upgradeAuthority', risk: 'renounce', fields: [['next', 'address']], run: async (v) => { const next = addr(v.next, true); onSend({ title: t('solc.op.upgradeAuthority.title'), instructions: [loader.setAuthority({ account: c.programData, current: me, next })], summary: [[t('solc.f.next'), next || t('solc.nobody')]], risks: [next ? 'authority' : 'immutable'] }); } });
    ops.push({ key: 'closeProgram', risk: 'close', fields: [], run: async () => onSend({ title: t('solc.op.closeProgram.title'), instructions: [loader.close({ account: c.programData, recipient: me, authority: me, program: c.address })], summary: [[t('solc.f.recover'), solText(c.programDataLamports || 0n, chain)]], risks: ['close'] }) });
  }
  if (c.kind === 'buffer' && c.authority === me) {
    ops.push({ key: 'closeBuffer', fields: [], run: async () => onSend({ title: t('solc.op.closeBuffer.title'), instructions: [loader.close({ account: c.address, recipient: me, authority: me })], summary: [[t('solc.f.recover'), solText(c.lamports, chain)]] }) });
  }
  return ops;
}

function WriteTab({ c, chain, idl, wallet, onSend, open }) {
  const [q, setQ] = useState('');
  const me = wallet?.raw || null;
  if (wallet === null) return <div class="error">{t('solc.noKey')}</div>;
  if (!wallet) return <Spinner />;
  const ops = [
    ...(c.kind === 'mint' ? tokenOps(c, chain, me, onSend) : []),
    ...(c.core ? coreOps(c, chain, me, onSend) : []),
    ...programOps(c, chain, me, onSend, open),
  ];
  const isProgram = c.kind === 'program';
  const ixs = idl?.idl && isProgram ? idl.idl.instructions.filter((ix) => !q || ix.name.toLowerCase().includes(q.toLowerCase())) : [];
  return (
    <>
      {ops.map((op) => <OpCard op={op} wallet={wallet} sym={c.metadata?.symbol} />)}
      {isProgram && idl === undefined && <Spinner />}
      {isProgram && idl?.idl && idl.idl.instructions.length > 8 && <input class="input" placeholder={t('contracts.searchFn')} value={q} onInput={(e) => setQ(e.target.value)} />}
      {ixs.map((ix) => <IxCard key={ix.name} idl={idl.idl} ix={ix} programId={c.address} chain={chain} wallet={wallet} onSend={(r) => onSend({ ...r, idl: idl.idl })} />)}
      {isProgram && idl && !idl.idl && <div class="tiny muted">{t('solc.write.noIdl')}</div>}
      {isProgram && <RawIxCard programId={c.address} chain={chain} wallet={wallet} onSend={onSend} />}
      {!ops.length && !isProgram && <div class="small muted">{t(c.kind === 'mint' ? 'solc.write.notAuthority' : 'solc.write.nothing')}</div>}
    </>
  );
}

// ------------------------------------------------------------ inspect
function IdlLoader({ chain, programId, onDone }) {
  const [text, setText] = useState('');
  const [err, setErr] = useState('');
  const save = async (s) => {
    setErr('');
    try { normalizeIdl(s, programId); await setCustomAbi(chain.id, programId, s); onDone(); } catch (e) { setErr(t('solc.idl.bad', { reason: e.message })); }
  };
  const onFile = async (e) => { const f = e.target.files?.[0]; if (f) { const s = await f.text(); setText(s); save(s); } };
  return (
    <div class="card col" style={{ gap: '.5rem' }}>
      <b class="small">{t('solc.idl.load')}</b>
      <span class="tiny muted">{t('solc.idl.loadHint')}</span>
      <textarea class="input mono" rows={4} value={text} placeholder='{ "instructions": [...] }' spellcheck={false} autocapitalize="off" onInput={(e) => setText(e.target.value)} />
      {err && <div class="error small">{err}</div>}
      <div class="row" style={{ gap: '.5rem' }}>
        <label class="btn secondary sm grow ct-filebtn"><Icon name="receive" size={14} /> {t('contracts.artifact.file')}<input type="file" accept=".json,application/json" onChange={onFile} /></label>
        <Btn class="grow" disabled={!text.trim()} onClick={() => save(text)}>{t('common.save')}</Btn>
      </div>
    </div>
  );
}

function InspectTab({ c, chain, idl, onOpenAddress, onIdl }) {
  const { toast } = useApp();
  const [rent, setRent] = useState(null);
  const [showIdl, setShowIdl] = useState(false);
  const [all, setAll] = useState(false);
  useEffect(() => { rentExempt(chain, c.space).then(setRent).catch(() => {}); }, []);
  const hex = toHex(c.data.slice(0, all ? 20000 : 256));
  const pid = idl?.programId;
  return (
    <>
      <div class="card kv">
        <Row k={t('solc.inspect.owner')}><AddrValue address={c.owner} onOpenAddress={onOpenAddress} /></Row>
        <Row k={t('solc.balance')}>{solText(c.lamports, chain, 9)}</Row>
        {rent != null && <Row k={t('solc.inspect.rent')}>{solText(rent, chain, 9)}</Row>}
        <Row k={t('solc.inspect.space')}>{t('solc.bytes', { n: c.space.toLocaleString() })}</Row>
        <Row k={t('solc.inspect.executable')}>{c.executable ? t('solc.yes') : t('solc.no')}</Row>
        {c.kind === 'program' && c.programData && <Row k={t('solc.prog.data')}><AddrValue address={c.programData} onOpenAddress={onOpenAddress} /></Row>}
        {c.kind === 'program' && <Row k={t('solc.prog.authority')}>{c.authority ? <AddrValue address={c.authority} onOpenAddress={onOpenAddress} /> : t('solc.immutable')}</Row>}
        {c.kind === 'program' && c.size != null && <Row k={t('solc.prog.size')}>{t('solc.bytes', { n: c.size.toLocaleString() })}</Row>}
        {c.kind === 'program' && c.slot != null && <Row k={t('solc.prog.slot')}>{c.slot}</Row>}
      </div>
      {c.space > 0 && !c.executable && (
        <div class="card col" style={{ gap: '.375rem' }}>
          <div class="row between"><b class="small">{t('solc.inspect.data')}</b><button class="iconbtn sm" title={t('common.copy')} onClick={() => copyText(toHex(c.data), toast)}><Icon name="copy" size={14} /></button></div>
          <span class="mono tiny ct-calldata" style={{ wordBreak: 'break-all' }}>{hex}{c.space > 256 && !all ? '…' : ''}</span>
          {c.space > 256 && !all && <button class="link tiny" onClick={() => setAll(true)}>{t('solc.inspect.all')}</button>}
        </div>
      )}
      {pid && idl?.idl && (
        <div class="card col" style={{ gap: '.375rem' }}>
          <div class="row between"><b class="small">IDL · {t(`solc.idl.src.${idl.source}`)}</b>
            <span class="row" style={{ gap: '.25rem' }}>
              <button class="iconbtn sm" title={t('common.copy')} onClick={() => copyText(idl.raw, toast)}><Icon name="copy" size={14} /></button>
              {idl.source === 'device' && <button class="iconbtn sm" title={t('solc.idl.remove')} onClick={async () => { await setCustomAbi(chain.id, pid, null); onIdl(); }}><Icon name="trash" size={14} /></button>}
            </span>
          </div>
          <span class="tiny muted">{t('solc.idl.summary', { ix: idl.idl.instructions.length, acc: idl.idl.accounts.length, format: idl.idl.format })}</span>
          <button class="link tiny" onClick={() => setShowIdl(!showIdl)}>{showIdl ? t('solc.idl.hide') : t('solc.idl.show')}</button>
          {showIdl && <pre class="ct-log mono tiny">{idl.raw.slice(0, 60000)}</pre>}
        </div>
      )}
      {pid && <IdlLoader chain={chain} programId={pid} onDone={onIdl} />}
      <a class="btn secondary sm" href={solAddrUrl(chain, c.address)} target="_blank" rel="noopener"><Icon name="external" size={14} /> {t('contracts.inspect.explorer')}</a>
    </>
  );
}

// ------------------------------------------------------------ activity
function ActivityTab({ c, chain }) {
  const [list, setList] = useState(null);
  const [err, setErr] = useState('');
  useEffect(() => { rpc(chain, 'getSignaturesForAddress', [c.address, { limit: 25 }]).then(setList).catch((e) => setErr(e.message)); }, []);
  if (err) return <div class="error">{err}</div>;
  if (!list) return <Loading />;
  if (!list.length) return <div class="small muted">{t('contracts.activity.none')}</div>;
  return (
    <div class="card flat list ct-list">
      {list.map((x) => (
        <a class="ct-act-row item" href={solTxUrl(chain, x.signature)} target="_blank" rel="noopener">
          <span class={`dot ${x.err ? 'red' : 'on'}`} />
          <div class="grow" style={{ minWidth: 0 }}>
            <div class="mono tiny ellipsis">{shortAddr(x.signature, 8)}</div>
            <div class="tiny muted">{x.blockTime ? fmtDateTime(x.blockTime * 1000) : '—'}{x.err ? ` · ${t('solc.activity.failed')}` : ''}{x.memo ? ` · ${x.memo}` : ''}</div>
          </div>
          <Icon name="external" size={14} />
        </a>
      ))}
    </div>
  );
}

