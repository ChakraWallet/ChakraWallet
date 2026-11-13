// Contract page: who it is (verification, proxy, standard), then Read / Write / Inspect / Activity.
import { useEffect, useMemo, useState } from 'preact/hooks';
import { Icon, Spinner, Btn, ChainIcon, useApp, explorerAddr, explorerTx } from '../../components.jsx';
import { getChain } from '../../../shared/chains.js';
import { loadContract, readOverview, recentLogs, recentTxs } from '../../../shared/contracts.js';
import { display, toJson } from '../../../shared/abiInput.js';
import { shortAddr, fmtDateTime } from '../../../shared/format.js';
import { t } from '../../../shared/i18n.js';
import { FnCard, ValueNode, ResultView } from './abiForm.jsx';
import { DecoderBox, StorageBox } from './tools.jsx';
import { addRecent, saveContract, unsaveContract, savedEntry, customAbi, setCustomAbi } from '../../contractsStore.js';
import { MAX_RUNTIME } from '../../../shared/solidity.js';

const TABS = ['read', 'write', 'inspect', 'activity'];
const STD = { erc20: 'ERC-20', erc721: 'ERC-721', erc1155: 'ERC-1155', erc4626: 'ERC-4626' };
const CUSTOM_CALL = { key: '__custom', custom: true, name: null, selector: '', inputs: [], outputs: [], read: false, payable: true, unknown: false, fragment: null };

export function ContractView({ chainId, address, onBack, open }) {
  const { state, toast } = useApp();
  const chain = getChain(chainId, state.customChains);
  const [c, setC] = useState(null);
  const [err, setErr] = useState('');
  const [tab, setTab] = useState('read');
  const [saved, setSaved] = useState(null);
  const [reload, setReload] = useState(0);

  useEffect(() => {
    let alive = true;
    setErr(''); if (reload) setC(null);
    (async () => {
      const abi = await customAbi(chainId, address);
      const r = await loadContract(chain, address, { etherscanKey: state.settings?.etherscanKey, fresh: reload > 0, customAbi: abi });
      if (!alive) return;
      setC(r);
      const name = r.proxy?.impl?.name || r.name || r.token?.symbol || null;
      addRecent(chainId, r.address, name);
      if (!r.hasCode || !r.fns?.some((f) => !f.read)) setTab((x) => (x === 'write' ? 'read' : x));
    })().catch((e) => alive && setErr(e.message));
    savedEntry(chainId, address).then((s) => alive && setSaved(s));
    return () => { alive = false; };
  }, [reload]);

  if (!chain) return <Shell onBack={onBack}><div class="error">{t('contracts.unknownChain')}</div></Shell>;
  if (err) return <Shell onBack={onBack}><div class="error">{err}</div><Btn kind="secondary" onClick={() => setReload((x) => x + 1)}>{t('contracts.retry')}</Btn></Shell>;
  if (!c) return <Shell onBack={onBack}><div class="ct-loading"><Spinner lg /><span class="small muted">{t('contracts.loading')}</span></div></Shell>;

  const openAddr = (a) => open({ name: 'contract', chainId, address: a });
  if (!c.hasCode) {
    return (
      <Shell onBack={onBack} title={shortAddr(c.address)}>
        <div class="card col" style={{ gap: '.5rem' }}>
          <b>{c.delegatedTo ? t('contracts.delegated.title') : t('contracts.eoa.title')}</b>
          <span class="small muted">{c.delegatedTo ? t('contracts.delegated.body') : t('contracts.eoa.body', { chain: chain.name })}</span>
          {c.delegatedTo && <Btn kind="secondary" onClick={() => openAddr(c.delegatedTo)}><Icon name="code" size={16} /> {shortAddr(c.delegatedTo, 6)}</Btn>}
        </div>
      </Shell>
    );
  }

  const name = c.proxy?.impl?.name || c.name || (c.token?.name ? c.token.name : null);
  const verified = c.verified || c.proxy?.impl?.verified;
  const src = c.proxy?.impl?.verified ? c.proxy.impl.source : c.source;
  const toggleSave = async () => {
    if (saved) { await unsaveContract(chainId, c.address); setSaved(null); toast(t('contracts.unsaved')); }
    else { const s = { chainId, address: c.address, name }; await saveContract(s); setSaved(s); toast(t('contracts.saved')); }
  };
  const onSend = (r) => open({
    name: 'tx', chainId, req: { kind: 'call', ...r, iface: c.iface, title: t('contracts.tx.callTitle', { fn: r.fn.custom ? t('contracts.custom.title') : r.fn.name || r.data.slice(0, 10), name: name || shortAddr(c.address) }) },
  });

  return (
    <Shell onBack={onBack} title={name || t('contracts.unnamed')} right={<button class="iconbtn" title={saved ? t('contracts.unsave') : t('contracts.save')} onClick={toggleSave}><Icon name={saved ? 'bookmark' : 'star'} size={18} /></button>}>
      <div class="card col ct-head">
        <div class="row" style={{ gap: '.5rem' }}>
          <ChainIcon chain={chain} size={22} />
          <span class="mono small grow" onClick={() => { navigator.clipboard.writeText(c.address); toast(t('common.copied')); }}>{c.address}</span>
        </div>
        <div class="pills">
          {verified ? <span class="badge green"><Icon name="check" size={12} stroke={3} /> {t('contracts.verified', { src: t(`contracts.src.${src}`) })}</span>
            : c.custom ? <span class="badge primary">{t('contracts.customAbi')}</span>
              : <span class="badge amber">{t('contracts.unverified')}</span>}
          {c.proxy && <span class="badge primary">{t('contracts.proxy', { kind: c.proxy.kind.replace(/ProxyResolver$|Resolver$/, '') })}</span>}
          {c.standards.filter((s) => STD[s]).map((s) => <span class="badge">{STD[s]}{s === 'erc20' && c.token?.symbol ? ` · ${c.token.symbol}` : ''}</span>)}
          {saved?.mine && <span class="badge green">{t('contracts.mine')}</span>}
        </div>
        {c.proxy?.implementation && (
          <button class="ct-impl" onClick={() => openAddr(c.proxy.implementation)}>
            <span class="ct-impl-txt">
              <span class="tiny muted">{t('contracts.implementation')}</span>
              <span class="mono small ellipsis">{shortAddr(c.proxy.implementation, 8)}</span>
            </span>
            <Icon name="forward" size={14} />
          </button>
        )}
        {!verified && !c.custom && <span class="tiny muted">{t('contracts.unverifiedHint')}</span>}
      </div>
      <div class="seg seg-full" role="tablist">
        {TABS.map((k) => <button role="tab" aria-selected={tab === k} class={tab === k ? 'on' : ''} onClick={() => setTab(k)}>{t(`contracts.tab.${k}`)}</button>)}
      </div>
      {tab === 'read' && <ReadTab c={c} chain={chain} onOpenAddress={openAddr} />}
      {tab === 'write' && <WriteTab c={c} chain={chain} onSend={onSend} onOpenAddress={openAddr} />}
      {tab === 'inspect' && <InspectTab c={c} chain={chain} open={open} onOpenAddress={openAddr} onReload={() => setReload((x) => x + 1)} />}
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
function ReadTab({ c, chain, onOpenAddress }) {
  const [ov, setOv] = useState(null);
  const [tick, setTick] = useState(0);
  const [q, setQ] = useState('');
  useEffect(() => { setOv(null); readOverview(chain, c.address, c.fns).then(setOv).catch(() => setOv({ list: [], values: new Map() })); }, [tick]);
  const withArgs = c.fns.filter((f) => f.read && !f.unknown && f.inputs.length > 0 && match(f, q));
  const reads = c.fns.filter((f) => f.read);
  if (!reads.length) return <div class="empty">{c.verified ? t('contracts.read.none') : t('contracts.read.noneGuessed')}</div>;
  return (
    <>
      <div class="card col ct-overview">
        <div class="row between"><b class="small">{t('contracts.read.overview')}</b><button class="iconbtn sm" title={t('contracts.refresh')} onClick={() => setTick((x) => x + 1)}><Icon name="refresh" size={14} /></button></div>
        {!ov ? <Spinner /> : !ov.list.length ? <span class="small muted">{t('contracts.read.noOverview')}</span> : ov.list.map((f) => {
          const v = ov.values.get(f.key);
          return (
            <div class="ct-ov-row">
              <span class="ct-ov-k">{f.name}</span>
              <div class="ct-ov-v">
                {!v?.ok ? <span class="tiny muted">{t('contracts.read.reverted')}</span>
                  : v.value ? f.outputs.map((p, i) => <ValueNode n={{ ...display(p, v.value[i], { decimals: c.token?.decimals, fn: f.name }), name: f.outputs.length > 1 ? p.name || `#${i}` : '' }} token={c.token} onOpenAddress={onOpenAddress} />)
                    : <ResultView fn={f} data={v.raw} />}
              </div>
            </div>
          );
        })}
      </div>
      {withArgs.length + (q ? 1 : 0) > 6 && <input class="input" placeholder={t('contracts.searchFn')} value={q} onInput={(e) => setQ(e.target.value)} />}
      {withArgs.map((f) => <FnCard key={f.key} fn={f} contract={c} chain={chain} onOpenAddress={onOpenAddress} />)}
    </>
  );
}

const match = (f, q) => !q || (f.name || f.selector).toLowerCase().includes(q.toLowerCase());

// ------------------------------------------------------------ write
function WriteTab({ c, chain, onSend, onOpenAddress }) {
  const { account, chain: active } = useApp();
  const [q, setQ] = useState('');
  const writes = c.fns.filter((f) => !f.read && match(f, q));
  return (
    <>
      {account.type === 'ton' ? <div class="warn small">{t('ton.evmOnly.body')}</div>
        : <div class="info small">{t('contracts.write.as', { name: account.name, chain: chain.name })}{active.id !== chain.id ? ` ${t('contracts.write.otherChain')}` : ''}</div>}
      {c.fns.filter((f) => !f.read).length > 6 && <input class="input" placeholder={t('contracts.searchFn')} value={q} onInput={(e) => setQ(e.target.value)} />}
      {writes.map((f) => <FnCard key={f.key} fn={f} contract={c} chain={chain} onSend={onSend} onOpenAddress={onOpenAddress} />)}
      <FnCard fn={CUSTOM_CALL} contract={c} chain={chain} onSend={onSend} onOpenAddress={onOpenAddress} />
    </>
  );
}

// ------------------------------------------------------------ inspect
function InspectTab({ c, chain, open, onOpenAddress, onReload }) {
  const { toast } = useApp();
  const [sources, setSources] = useState(null);
  const [abiText, setAbiText] = useState('');
  const [abiErr, setAbiErr] = useState('');
  const meta = c.proxy?.impl?.verified ? c.proxy.impl : c;
  const copy = (text) => { navigator.clipboard.writeText(text); toast(t('common.copied')); };
  const abiJson = useMemo(() => (c.abi?.length ? JSON.stringify(c.abi, null, 2) : null), [c]);
  const openSources = async () => {
    setSources('loading');
    try {
      const files = await meta.getSources();
      setSources(null);
      open({ name: 'source', title: meta.name || shortAddr(c.address), files: files.map((f, i) => ({ path: f.path || `${meta.name || 'Contract'}${files.length > 1 ? `-${i}` : ''}.sol`, content: f.content })) });
    } catch { setSources('error'); }
  };
  const saveAbi = async () => {
    setAbiErr('');
    try {
      const abi = JSON.parse(abiText);
      if (!Array.isArray(abi)) throw new Error();
      await setCustomAbi(chain.id, c.address, abi);
      setAbiText(''); onReload();
    } catch { setAbiErr(t('contracts.inspect.badAbi')); }
  };
  return (
    <>
      <div class="card kv">
        <span class="k">{t('contracts.inspect.verification')}</span><span class="v">{meta.verified ? t(`contracts.src.${meta.source}`) : c.custom ? t('contracts.customAbi') : t('contracts.unverified')}</span>
        {meta.compiler && <><span class="k">{t('contracts.inspect.compiler')}</span><span class="v mono">{meta.compiler}</span></>}
        {meta.evmVersion && <><span class="k">EVM</span><span class="v">{meta.evmVersion}</span></>}
        {meta.runs != null && <><span class="k">{t('contracts.inspect.runs')}</span><span class="v">{meta.runs}</span></>}
        <span class="k">{t('contracts.inspect.size')}</span>
        <span class="v">{t('contracts.bytes', { n: c.codeSize.toLocaleString() })}<span class="tiny muted"> · {Math.round((c.codeSize / MAX_RUNTIME) * 100)}%</span></span>
        <span class="k">{t('contracts.inspect.functions')}</span><span class="v">{c.fns.length}</span>
        {c.events.length > 0 && <><span class="k">{t('contracts.inspect.events')}</span><span class="v">{c.events.length}</span></>}
        {c.proxy && <><span class="k">Proxy</span><span class="v">{c.proxy.kind}</span></>}
        {c.isFactory && <><span class="k">{t('contracts.inspect.factory')}</span><span class="v">{t('contracts.inspect.factoryYes')}</span></>}
      </div>
      <div class="row ct-btns">
        {meta.getSources && <button class="btn secondary sm" disabled={sources === 'loading'} onClick={openSources}>{sources === 'loading' ? <Spinner /> : <><Icon name="code" size={14} /> {t('contracts.inspect.source')}</>}</button>}
        {abiJson && <button class="btn secondary sm" onClick={() => copy(abiJson)}><Icon name="copy" size={14} /> ABI</button>}
        <button class="btn secondary sm" onClick={() => copy(c.code)}><Icon name="copy" size={14} /> bytecode</button>
        {explorerAddr(chain, c.address) && <a class="btn secondary sm" href={explorerAddr(chain, c.address)} target="_blank"><Icon name="external" size={14} /> {t('contracts.inspect.explorer')}</a>}
      </div>
      {sources === 'error' && <div class="error">{t('contracts.inspect.sourceError')}</div>}
      {(!meta.verified || c.custom) && (
        <details class="card ct-details">
          <summary>{t('contracts.inspect.customAbi')}</summary>
          <span class="tiny muted">{t('contracts.inspect.customAbiHint')}</span>
          <textarea class="input mono" rows={4} value={abiText} placeholder='[{"type":"function", ...}]' spellcheck={false} autocapitalize="off" onInput={(e) => setAbiText(e.target.value)} />
          {abiErr && <div class="error">{abiErr}</div>}
          <div class="row">
            <button class="btn secondary sm" disabled={!abiText.trim()} onClick={saveAbi}>{t('common.save')}</button>
            {c.custom && <button class="link" onClick={async () => { await setCustomAbi(chain.id, c.address, null); onReload(); }}>{t('contracts.inspect.removeAbi')}</button>}
          </div>
        </details>
      )}
      <details class="card ct-details">
        <summary>{t('contracts.inspect.storage')}</summary>
        <StorageBox chain={chain} address={c.address} onOpenAddress={onOpenAddress} />
      </details>
      <details class="card ct-details">
        <summary>{t('contracts.inspect.decoder')}</summary>
        <DecoderBox fns={c.fns} onOpenAddress={onOpenAddress} />
      </details>
    </>
  );
}

// ------------------------------------------------------------ activity
function ActivityTab({ c, chain }) {
  const [txs, setTxs] = useState(undefined);
  const [logs, setLogs] = useState(undefined);
  const [err, setErr] = useState('');
  useEffect(() => {
    recentTxs(chain, c.address).then(setTxs).catch(() => setTxs(null));
    recentLogs(chain, c.address, c.iface).then(setLogs).catch((e) => { setLogs([]); setErr(e.message); });
  }, []);
  return (
    <>
      {txs !== null && (
        <div class="card col">
          <b class="small">{t('contracts.activity.txs')}</b>
          {txs === undefined ? <Spinner /> : !txs.length ? <span class="small muted">{t('contracts.activity.none')}</span> : txs.map((x) => (
            <a class="ct-act-row" href={explorerTx(chain, x.hash) || undefined} target="_blank">
              <span class={`badge ${x.ok ? '' : 'red'} mono`}>{x.method || x.hash.slice(0, 10)}</span>
              <span class="grow tiny muted mono">{shortAddr(x.from || '')}</span>
              <span class="tiny muted">{x.time ? fmtDateTime(x.time) : `#${x.block}`}</span>
            </a>
          ))}
        </div>
      )}
      <div class="card col">
        <b class="small">{t('contracts.activity.events')}</b>
        {logs === undefined ? <Spinner /> : !logs.length ? <span class="small muted">{err ? t('contracts.activity.eventsError') : t('contracts.activity.none')}</span> : logs.map((l) => (
          <details class="ct-log">
            <summary><span class="mono small bold">{l.decoded?.name || l.topics[0]?.slice(0, 10) || '—'}</span><span class="tiny muted"> #{l.block}</span></summary>
            {l.decoded?.inputs ? l.decoded.inputs.map((p, i) => <ValueNode n={display(p, l.decoded.args[i])} />)
              : l.decoded?.params ? l.decoded.params.map((p) => <div class="tiny"><b>{p.name}</b> <span class="mono">{typeof p.value === 'string' ? p.value : toJson(p.value)}</span></div>)
                : <>{l.topics.map((x) => <span class="mono tiny">{x}</span>)}<span class="mono tiny">{l.data}</span></>}
            {explorerTx(chain, l.tx) && <a class="link tiny" href={explorerTx(chain, l.tx)} target="_blank">{shortAddr(l.tx, 6)}</a>}
          </details>
        ))}
      </div>
    </>
  );
}
