// Contract page on TON: what it is (interfaces, state, balance, verified sources), then Read (get methods) / Write
// (messages) / Inspect (code, data, cells) / Activity (latest transactions).
import { useEffect, useState } from 'preact/hooks';
import { Icon, Spinner, Btn, ChainIcon, useApp, explorerAddr } from '../../../components.jsx';
import { getChain } from '../../../../shared/chains.js';
import { fmtAmount, fmtDateTime, shortAddr } from '../../../../shared/format.js';
import { t } from '../../../../shared/i18n.js';
import { loadTonContract, readTonOverview, runGetter, interpret, showAddress, contractData, GETTERS } from '../../../../shared/ton/contracts.js';
import { ARG_TYPES, describeCell, parseBoc, opName, opHex } from '../../../../shared/ton/cells.js';
import { tonTransactions, tonTxUrl } from '../../../../shared/ton/api.js';
import { knownCode } from '../../../../shared/ton/templates.js';
import { addRecent, saveContract, unsaveContract, savedEntry } from '../../../contractsStore.js';
import { TonValue, CellTree, AddrValue, useTonWalletFor, exitText, copyText, opLabel, outLabel } from './parts.jsx';
import { TonWriteTab, errText } from './write.jsx';
import { TactGetterCard, TactReceiverCard, receiverCards } from './tactForm.jsx';

const TABS = ['read', 'write', 'inspect', 'activity'];

export function TonContractView({ chainId, address, onBack, open }) {
  const { state, toast } = useApp();
  const chain = getChain(chainId, state.customChains);
  const wallet = useTonWalletFor(chain);
  const [c, setC] = useState(null);
  const [err, setErr] = useState('');
  const [tab, setTab] = useState('read');
  const [saved, setSaved] = useState(null);
  const [reload, setReload] = useState(0);
  const [ov, setOv] = useState(null);

  useEffect(() => {
    let alive = true;
    setErr(''); if (reload) { setC(null); setOv(null); }
    (async () => {
      const r = await loadTonContract(chain, address);
      if (!alive) return;
      setC(r);
      addRecent(chainId, r.address, r.name || r.jetton?.symbol || null);
      if (r.status === 'active') readTonOverview(chain, r).then((o) => alive && setOv(o)).catch(() => alive && setOv({ rows: [], token: null }));
    })().catch((e) => alive && setErr(e.message));
    savedEntry(chainId, address).then((s) => alive && setSaved(s));
    return () => { alive = false; };
  }, [reload]);

  if (!chain) return <Shell onBack={onBack}><div class="error">{t('contracts.unknownChain')}</div></Shell>;
  if (err) return <Shell onBack={onBack}><div class="error">{err}</div><Btn kind="secondary" onClick={() => setReload((x) => x + 1)}>{t('contracts.retry')}</Btn></Shell>;
  if (!c) return <Shell onBack={onBack}><div class="ct-loading"><Spinner lg /><span class="small muted">{t('contracts.loading')}</span></div></Shell>;

  const friendly = showAddress(c.address, { testnet: chain.testnet, wallet: c.kind === 'wallet' });
  const openAddr = (a) => open({ name: 'contract', chainId, address: a });
  const token = ov?.token || (c.jetton ? { decimals: c.jetton.decimals, symbol: c.jetton.symbol } : null);

  if (c.status !== 'active') {
    return (
      <Shell onBack={onBack} title={shortAddr(friendly, 6)}>
        <div class="card col" style={{ gap: '.5rem' }}>
          <b>{t(`tonc.status.${c.status}.title`)}</b>
          <span class="small muted">{t(`tonc.status.${c.status}.body`, { chain: chain.name })}</span>
          <span class="mono tiny" onClick={() => copyText(friendly, toast)}>{friendly}</span>
          {c.balance > 0n && <span class="small">{t('tonc.balance')}: <b>{fmtAmount(c.balance, 9, 4)} {chain.native.symbol}</b></span>}
        </div>
        <Btn kind="secondary" onClick={() => setReload((x) => x + 1)}><Icon name="refresh" size={16} /> {t('contracts.refresh')}</Btn>
      </Shell>
    );
  }

  const name = c.name || c.jetton?.name || null;
  const toggleSave = async () => {
    if (saved) { await unsaveContract(chainId, c.address); setSaved(null); toast(t('contracts.unsaved')); }
    else { const s = { chainId, address: c.address, name }; await saveContract(s); setSaved(s); toast(t('contracts.saved')); }
  };
  const refreshOv = () => { setOv(null); readTonOverview(chain, c).then(setOv).catch(() => setOv({ rows: [], token: null })); };
  const onSend = (req) => open({ name: 'tontx', chainId, req: { ...req, contract: { address: c.address, name } }, onMined: refreshOv });
  const known = knownCode(c.codeHash);

  return (
    <Shell onBack={onBack} title={name || t('contracts.unnamed')} right={<button class="iconbtn" title={saved ? t('contracts.unsave') : t('contracts.save')} onClick={toggleSave}><Icon name={saved ? 'bookmark' : 'star'} size={18} /></button>}>
      <div class="card col ct-head">
        <div class="row" style={{ gap: '.5rem' }}>
          <ChainIcon chain={chain} size={22} />
          <span class="mono small grow" style={{ wordBreak: 'break-all' }} onClick={() => copyText(friendly, toast)}>{friendly}</span>
        </div>
        <div class="pills">
          {c.kind && <span class="badge primary">{t(`tonc.kind.${c.kind}`)}{c.walletVersion ? ` ${c.walletVersion}` : ''}{c.kind === 'jetton_master' && c.jetton?.symbol ? ` · ${c.jetton.symbol}` : ''}</span>}
          {c.sources ? <span class="badge green"><Icon name="check" size={12} stroke={3} /> {t('tonc.verified')}</span> : <span class="badge amber">{t('tonc.unverified')}</span>}
          {c.compiler && <span class="badge">{c.compiler}</span>}
          {known && <span class="badge green">{t(`tonc.code.${known}`)}</span>}
          {saved?.mine && <span class="badge green">{t('contracts.mine')}</span>}
          {c.isScam && <span class="badge red">{t('tonc.scam')}</span>}
        </div>
        <span class="small">{t('tonc.balance')}: <b>{fmtAmount(c.balance, 9, 4)} {chain.native.symbol}</b></span>
        {c.partial && <span class="tiny muted">{t('tonc.partial')}</span>}
      </div>
      {c.isScam && <div class="error small">{t('tonc.scamBody')}</div>}
      <div class="seg seg-full" role="tablist">
        {TABS.map((k) => <button role="tab" aria-selected={tab === k} class={tab === k ? 'on' : ''} onClick={() => setTab(k)}>{t(`contracts.tab.${k}`)}</button>)}
      </div>
      {tab === 'read' && <ReadTab c={c} chain={chain} ov={ov} token={token} me={wallet?.raw} tact={saved?.tact} onOpenAddress={openAddr} onRefresh={refreshOv} />}
      {tab === 'write' && <TonWriteTab c={c} chain={chain} ov={ov} token={token} wallet={wallet} onSend={onSend}
        extra={saved?.tact && wallet ? receiverCards(saved.tact).map((r) => <TactReceiverCard r={r} tact={saved.tact} c={c} chain={chain} wallet={wallet} onSend={onSend} />) : null} />}
      {tab === 'inspect' && <InspectTab c={c} chain={chain} open={open} name={name} />}
      {tab === 'activity' && <ActivityTab c={c} chain={chain} />}
    </Shell>
  );
}

function Shell({ onBack, title, right, children }) {
  return (
    <div class="screen">
      <div class="topbar">
        <button class="iconbtn" onClick={onBack} title={t('common.back')}><Icon name="back" /></button>
        <h1 class="ellipsis">{title || t('contracts.title')}</h1>
        {right}
      </div>
      <div class="content ct-content">{children}</div>
    </div>
  );
}

// ------------------------------------------------------------ read
function ReadTab({ c, chain, ov, token, me, tact, onOpenAddress, onRefresh }) {
  const [q, setQ] = useState('');
  const shown = new Set([...(ov?.rows || []).map((r) => r.method.name), ...(tact?.abi?.getters || []).map((g) => g.name)]);
  const rest = c.methods.filter((m) => !shown.has(m.name) && (!q || String(m.name ?? m.id).toLowerCase().includes(q.toLowerCase())));
  return (
    <>
      <div class="card col ct-overview">
        <div class="row between"><b class="small">{t('contracts.read.overview')}</b><button class="iconbtn sm" title={t('contracts.refresh')} onClick={onRefresh}><Icon name="refresh" size={14} /></button></div>
        {!ov ? <Spinner /> : !ov.rows.length ? <span class="small muted">{t('contracts.read.noOverview')}</span> : ov.rows.map((r) => (
          <div class="col" style={{ gap: '.125rem' }}>
            <span class="tiny muted mono">{r.method.name}</span>
            {r.values ? r.values.map((v) => <TonValue v={v} name={outLabel(v.name)} chain={chain} onOpenAddress={onOpenAddress} me={me} />)
              : <span class="tiny red">{r.exitCode != null ? `${t('tonc.step.exit', { code: r.exitCode })}: ${exitText(r.exitCode)}` : r.error}</span>}
          </div>
        ))}
      </div>
      {c.methods.length > 8 && <input class="input" placeholder={t('contracts.searchFn')} value={q} onInput={(e) => setQ(e.target.value)} />}
      {(tact?.abi?.getters || []).map((g) => <TactGetterCard g={g} c={c} chain={chain} me={me} onOpenAddress={onOpenAddress} />)}
      {rest.map((m) => <GetterCard key={m.name ?? m.id} m={m} c={c} chain={chain} token={token} me={me} onOpenAddress={onOpenAddress} />)}
      {!c.methods.length && !tact && <div class="tiny muted">{t('tonc.read.noMethods')}</div>}
      <GetterCard m={{ name: null, id: null, custom: true }} c={c} chain={chain} token={token} me={me} onOpenAddress={onOpenAddress} />
    </>
  );
}

const emptyArg = (type = 'int', name = '') => ({ type, value: '', name });

/** A get method: arguments (typed for the known ones, free otherwise), Run, results. */
function GetterCard({ m, c, chain, token, me, onOpenAddress }) {
  const known = m.known || (m.name && GETTERS[m.name]) || null;
  const [open, setOpen] = useState(false);
  const [method, setMethod] = useState('');
  const [args, setArgs] = useState(() => (known ? known.args.map(([n, ty]) => emptyArg(ty, n)) : []));
  const [busy, setBusy] = useState(false);
  const [res, setRes] = useState(null);
  const [err, setErr] = useState('');
  const run = async () => {
    setErr(''); setRes(null);
    const target = m.custom ? method.trim() : m.name || String(m.id);
    if (!target) { setErr(t('tonc.err.method')); return; }
    setBusy(true);
    try {
      setRes(await runGetter(chain, c.address, target, args));
    } catch (e) { setErr(errText(e)); }
    setBusy(false);
  };
  const setArg = (i, patch) => setArgs(args.map((a, j) => (j === i ? { ...a, ...patch } : a)));
  const sig = known ? known.args.map(([n, ty]) => `${ty} ${n}`).join(', ') || '—' : m.custom ? t('tonc.read.customSub') : t('tonc.read.unknownSig');
  return (
    <div class={`ct-fn ${open ? 'open' : ''}`}>
      <button class="ct-fn-head" onClick={() => setOpen(!open)}>
        <span class="grow">
          <span class="ct-fn-name">{m.custom ? t('tonc.read.custom') : m.name || `#${m.id}`}</span>
          <span class="ct-fn-sig">{sig}</span>
        </span>
        <Icon name="chevron" size={14} />
      </button>
      {open && (
        <div class="ct-fn-body">
          {m.custom && (
            <div class="ct-field">
              <span class="ct-label"><span>{t('tonc.read.method')}</span></span>
              <input class="input mono" value={method} placeholder="get_something / 85143" spellcheck={false} autocapitalize="off" onInput={(e) => setMethod(e.target.value)} />
            </div>
          )}
          {args.map((a, i) => (
            <div class="ct-field">
              <span class="ct-label">
                <span>{a.name || `#${i}`}</span>
                {known ? <span class="ct-type">{a.type}</span> : (
                  <select class="input ct-unit" value={a.type} onChange={(e) => setArg(i, { type: e.target.value })}>{ARG_TYPES.map((x) => <option value={x}>{x}</option>)}</select>
                )}
                {!known && <button class="iconbtn sm" title={t('common.delete')} onClick={() => setArgs(args.filter((_, j) => j !== i))}><Icon name="close" size={13} /></button>}
              </span>
              {a.type === 'cell' || a.type === 'slice' ? <textarea class="input mono" rows={2} value={a.value} placeholder={t('tonc.ft.bocHint')} spellcheck={false} autocapitalize="off" onInput={(e) => setArg(i, { value: e.target.value })} />
                : <input class="input mono" value={a.value} placeholder={a.type === 'address' ? 'UQ… / EQ…' : '0'} spellcheck={false} autocapitalize="off" onInput={(e) => setArg(i, { value: e.target.value })} />}
              {a.type === 'address' && me && <button class="link tiny" style={{ alignSelf: 'flex-start' }} onClick={() => setArg(i, { value: showAddress(me, { testnet: chain.testnet, wallet: true }) })}>{t('tonc.f.me')}</button>}
            </div>
          ))}
          {!known && <button class="link ct-add" onClick={() => setArgs([...args, emptyArg()])}><Icon name="plus" size={14} /> {t('tonc.read.addArg')}</button>}
          {err && <div class="error">{err}</div>}
          {res && !res.ok && <div class="error">{t('tonc.step.exit', { code: res.exitCode })}: {exitText(res.exitCode)}</div>}
          {res?.ok && (
            <div class="ct-result">
              {!res.items.length && <span class="small muted">{t('contracts.result.noData')}</span>}
              {res.items.map((it, i) => {
                const [n, ty] = known?.out?.[i] || [`#${i}`, null];
                return <TonValue v={interpret(it, ty, token || {})} name={outLabel(n)} chain={chain} onOpenAddress={onOpenAddress} me={me} />;
              })}
              <span class="tiny muted">{t('tonc.read.gas', { n: res.gasUsed })}</span>
            </div>
          )}
          <div class="row ct-fn-actions"><span class="grow" /><button class="btn primary sm" disabled={busy} onClick={run}>{busy ? <Spinner /> : t('contracts.fn.read')}</button></div>
        </div>
      )}
    </div>
  );
}

// ------------------------------------------------------------ inspect
function InspectTab({ c, chain, open, name }) {
  const { toast } = useApp();
  const [data, setData] = useState(null);
  const [boc, setBoc] = useState('');
  const [tree, setTree] = useState(null);
  const [cellErr, setCellErr] = useState('');
  const known = knownCode(c.codeHash);
  const loadData = async () => { setData('loading'); try { setData(await contractData(chain, c.address)); } catch { setData('error'); } };
  const sources = () => {
    const files = c.sources.filter((f) => !f.std).concat(c.sources.filter((f) => f.std));
    open({ name: 'source', title: name || shortAddr(c.address), files: files.map((f) => ({ path: f.name, content: f.content })), noProject: true });
  };
  const decode = () => {
    setCellErr(''); setTree(null);
    try { setTree(describeCell(parseBoc(boc))); } catch (e) { setCellErr(errText(e)); }
  };
  const link = explorerAddr(chain, showAddress(c.address, { testnet: chain.testnet }));
  return (
    <>
      <div class="card kv">
        <span class="k">{t('tonc.inspect.status')}</span><span class="v">{t(`tonc.status.${c.status}.short`)}</span>
        {c.kind && <><span class="k">{t('tonc.inspect.kind')}</span><span class="v">{t(`tonc.kind.${c.kind}`)}{c.walletVersion ? ` ${c.walletVersion}` : ''}</span></>}
        {c.interfaces.length > 0 && <><span class="k">{t('tonc.inspect.interfaces')}</span><span class="v mono tiny">{c.interfaces.join(', ')}</span></>}
        <span class="k">{t('tonc.inspect.verification')}</span><span class="v">{c.sources ? t('tonc.inspect.sourcesN', { n: c.sources.filter((f) => !f.std).length }) : t('tonc.unverified')}</span>
        {c.compiler && <><span class="k">{t('contracts.inspect.compiler')}</span><span class="v">{c.compiler}</span></>}
        {c.codeHash && <><span class="k">{t('tonc.inspect.codeHash')}</span><span class="v mono tiny" style={{ wordBreak: 'break-all' }} onClick={() => copyText(c.codeHash, toast)}>{c.codeHash}</span></>}
        {known && <><span class="k">{t('tonc.inspect.template')}</span><span class="v">{t(`tonc.code.${known}`)}</span></>}
        <span class="k">{t('contracts.inspect.functions')}</span><span class="v">{c.methods.length}</span>
      </div>
      <div class="row ct-btns">
        {c.sources && <button class="btn secondary sm" onClick={sources}><Icon name="code" size={14} /> {t('contracts.inspect.source')}</button>}
        {c.code && <button class="btn secondary sm" onClick={() => copyText(c.code, toast)}><Icon name="copy" size={14} /> {t('tonc.inspect.code')}</button>}
        {(data == null || data === 'error') && <button class="btn secondary sm" onClick={loadData}><Icon name="copy" size={14} /> {t('tonc.inspect.data')}</button>}
        {link && <a class="btn secondary sm" href={link} target="_blank"><Icon name="external" size={14} /> {t('contracts.inspect.explorer')}</a>}
      </div>
      {data === 'loading' && <Spinner />}
      {data === 'error' && <div class="error">{t('tonc.inspect.dataError')}</div>}
      {data && typeof data === 'object' && data.data && (
        <details class="card ct-details" open>
          <summary>{t('tonc.inspect.dataCell')}</summary>
          <span class="mono tiny ct-calldata">{data.data}</span>
          <div class="row"><button class="link tiny" onClick={() => copyText(data.data, toast)}>{t('common.copy')}</button></div>
          <CellTree node={describeCell(parseBoc(data.data))} />
        </details>
      )}
      {c.disassembled && (
        <details class="card ct-details">
          <summary>{t('tonc.inspect.disassembled')}</summary>
          <pre class="mono tiny ct-asm">{c.disassembled}</pre>
        </details>
      )}
      <details class="card ct-details">
        <summary>{t('tonc.inspect.cellReader')}</summary>
        <span class="tiny muted">{t('tonc.inspect.cellReaderHint')}</span>
        <textarea class="input mono" rows={3} value={boc} placeholder={t('tonc.ft.bocHint')} spellcheck={false} autocapitalize="off" onInput={(e) => setBoc(e.target.value)} />
        <button class="btn secondary sm" disabled={!boc.trim()} onClick={decode}>{t('tonc.cell.read')}</button>
        {cellErr && <div class="error">{cellErr}</div>}
        {tree && <CellTree node={tree} />}
      </details>
    </>
  );
}

// ------------------------------------------------------------ activity
function ActivityTab({ c, chain }) {
  const [txs, setTxs] = useState(undefined);
  useEffect(() => { tonTransactions(chain, c.address, 25).then(setTxs).catch(() => setTxs(null)); }, []);
  return (
    <div class="card col">
      <b class="small">{t('contracts.activity.txs')}</b>
      {txs === undefined ? <Spinner /> : txs === null ? <span class="small muted">{t('contracts.activity.eventsError')}</span> : !txs.length ? <span class="small muted">{t('contracts.activity.none')}</span> : txs.map((x) => (
        <a class="ct-act-row" href={tonTxUrl(chain, x.hash) || undefined} target="_blank">
          <span class={`badge ${x.ok ? '' : 'red'} mono`}>{x.external ? t('tonc.act.external') : x.op != null ? (opName(x.op) ? opLabel(opName(x.op)) : opHex(x.op)) : x.bounced ? t('tonc.step.bounced') : t('tonc.act.transfer')}</span>
          <span class="grow tiny muted">{x.value > 0n ? `${fmtAmount(x.value, 9, 4)} ${chain.native.symbol}` : ''}{x.from ? ` · ${shortAddr(showAddress(x.from, { testnet: chain.testnet }), 4)}` : ''}</span>
          <span class="tiny muted">{fmtDateTime(x.time)}</span>
        </a>
      ))}
    </div>
  );
}

export { AddrValue };
