// TON studio (Android app): Tact projects with the editor, compilation in a worker (ui/tactWorker.js), and deployment
// with the init arguments typed in a form generated from the ABI. The ABI is kept with the deployed contract, so its
// page shows typed getters and messages.
import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import { Cell, contractAddress } from '@ton/core';
import { Icon, Spinner, Btn, Sheet, ChainIcon, useApp } from '../../../components.jsx';
import { getChain } from '../../../../shared/chains.js';
import { parseAmount } from '../../../../shared/format.js';
import { t } from '../../../../shared/i18n.js';
import { isTon, tonAddressStatus } from '../../../../shared/ton/api.js';
import { showAddress } from '../../../../shared/ton/contracts.js';
import { tactInitData, tactMessageBody, tactReceivers, typeLabel, DEFAULT_TACT } from '../../../../shared/ton/tact.js';
import { stateInitB64 } from '../../../../shared/ton/templates.js';
import { toB64 } from '../../../../shared/ton/cells.js';
import { CodeEditor } from '../codeEditor.jsx';
import { NetworkSheet } from '../../home.jsx';
import { compileTact } from '../../../tactClient.js';
import { getProject, putProject, deleteProject, newProjectId } from '../../../contractsStore.js';
import { useTonWalletFor } from './parts.jsx';
import { TactFields, emptyValues } from './tactForm.jsx';
import { errText } from './write.jsx';

const MAX_CODE = 64 * 1024; // a contract's code must fit TON's limits comfortably; above this it's surely too big

function Bar({ title, onBack, right }) {
  return (
    <div class="topbar">
      <button class="iconbtn" onClick={onBack} title={t('common.back')}><Icon name="back" /></button>
      <h1 class="ellipsis">{title}</h1>
      {right}
    </div>
  );
}

/** Line/column (1-based) -> character offset in a text. */
const offsetOf = (text, line, col) => {
  const lines = text.split('\n');
  let o = 0;
  for (let i = 0; i < Math.min(line - 1, lines.length); i++) o += lines[i].length + 1;
  return o + Math.max(0, col - 1);
};

export function TonStudio({ projectId, newProject, chainId, onBack, open }) {
  const [p, setP] = useState(null);
  const [file, setFile] = useState(null);
  const [build, setBuild] = useState(null); // null | { busy } | { ok, errors, contracts } | { error }
  const [panel, setPanel] = useState(false);
  const [sheet, setSheet] = useState(null);
  const [jump, setJump] = useState(null);
  const pRef = useRef(null);
  const timer = useRef(0);
  const gone = useRef(false);
  const dirty = useRef(false); // changed since opened: saved on exit (a new project only looked at leaves nothing behind)
  pRef.current = p;

  useEffect(() => {
    (async () => {
      let pr = projectId ? await getProject(projectId) : null;
      // a new project lives in memory until its first change, compilation or deployment
      if (!pr && newProject) pr = { id: newProjectId(), name: 'Counter', lang: 'tact', files: { 'main.tact': DEFAULT_TACT }, main: 'main.tact' };
      if (!pr) return;
      setP(pr); setFile(pr.main || Object.keys(pr.files)[0]);
    })();
    return () => { clearTimeout(timer.current); if (pRef.current && dirty.current && !gone.current) putProject(pRef.current); };
  }, []);
  const update = (fn) => setP((prev) => {
    const n = fn(prev);
    dirty.current = true;
    clearTimeout(timer.current);
    timer.current = setTimeout(() => { if (!gone.current) putProject(n); }, 700);
    return n;
  });
  const fileRef = useRef(file);
  fileRef.current = file;
  const onEdit = (text) => update((prev) => ({ ...prev, files: { ...prev.files, [fileRef.current]: text } }));

  const run = async () => {
    const proj = pRef.current;
    await putProject(proj);
    setPanel(true); setBuild({ busy: true });
    try { setBuild(await compileTact(proj.files, proj.main)); } catch (e) { setBuild({ error: e.message }); }
  };

  const errs = build?.errors || [];
  const diags = useMemo(() => (p && file ? errs.filter((e) => e.file === file && e.line).map((e) => {
    const from = offsetOf(p.files[file] || '', e.line, e.col || 1);
    return { from, to: from + 1, severity: 'error', message: e.message };
  }) : []), [build, file]);
  if (!p) return <div class="screen"><Bar title="" onBack={onBack} /><div class="ct-loading"><Spinner lg /></div></div>;
  const files = Object.keys(p.files);

  return (
    <div class="screen ct-studio">
      <Bar title={p.name} onBack={onBack} right={<>
        <button class="iconbtn" title={t('contracts.studio.settings')} onClick={() => setSheet('settings')}><Icon name="settings" size={18} /></button>
        <button class="btn primary sm ct-run" disabled={build?.busy} onClick={run}>{build?.busy ? <Spinner /> : <><Icon name="flash" size={14} /> {t('contracts.studio.compile')}</>}</button>
      </>} />
      <div class="ct-files">
        {files.map((f) => <button class={`chip ct-file ${f === file ? 'on' : ''}`} onClick={() => (f === file ? setSheet({ file: f }) : setFile(f))}>{f.split('/').pop()}{f === p.main ? ' •' : ''}</button>)}
        <button class="chip ct-file" title={t('contracts.studio.newFile')} onClick={() => setSheet({ newFile: true })}><Icon name="plus" size={14} /></button>
      </div>
      {file && p.files[file] != null && <CodeEditor key={file} value={p.files[file]} onChange={onEdit} diagnostics={diags} jump={jump} lang="tact" />}
      <div class={`ct-panel ${panel ? 'open' : ''}`}>
        <button class="ct-panel-head" onClick={() => setPanel(!panel)}>
          {build?.busy && <Spinner />}
          <span class="grow small">
            {!build ? t('tonc.studio.ready') : build.busy ? t('tonc.studio.compiling') : build.error ? <span class="red">{t('contracts.studio.failed')}</span>
              : build.ok ? t('tonc.studio.compiled', { n: build.contracts.length }) : <span class="red">{t('tonc.studio.errors', { n: errs.length })}</span>}
          </span>
          <Icon name="chevron" size={14} />
        </button>
        {panel && (
          <div class="ct-panel-body">
            {build?.error && <div class="error small">{build.error}</div>}
            {errs.map((e) => (
              <button class="ct-diag error" onClick={() => { if (e.file && p.files[e.file] != null) { setFile(e.file); setJump({ line: e.line, n: Date.now() }); } }}>
                <span class="badge red">{t('contracts.studio.error')}</span>
                <span class="grow tiny"><b class="mono">{e.file ? `${e.file.split('/').pop()}:${e.line}` : ''}</b> <span class="ct-diag-msg">{e.message}</span></span>
              </button>
            ))}
            {build?.ok && build.contracts.map((c) => {
              const size = Cell.fromBase64(c.code).toBoc().length;
              return (
                <div class="ct-out">
                  <span class="grow"><b class="small mono">{c.name}</b><span class={`tiny ${size > MAX_CODE ? 'red' : 'muted'}`}> · {(size / 1024).toFixed(1)} KB · {t('tonc.studio.summary', { g: c.abi.getters?.length || 0, r: (c.abi.receivers || []).length })}</span></span>
                  <button class="iconbtn sm" title="ABI" onClick={() => navigator.clipboard.writeText(JSON.stringify(c.abi, null, 2))}><Icon name="copy" size={14} /></button>
                  <button class="btn primary sm" onClick={() => open({ name: 'tondeploy', build: c, project: { id: p.id, name: p.name }, chainId })}>{t('contracts.studio.deploy')}</button>
                </div>
              );
            })}
          </div>
        )}
      </div>
      {sheet === 'settings' && <ProjectSheet p={p} onChange={(s) => update((prev) => ({ ...prev, ...s }))} onDelete={async () => { gone.current = true; clearTimeout(timer.current); await deleteProject(p.id); onBack(); }} onClose={() => setSheet(null)} />}
      {sheet?.newFile && <FileSheet title={t('contracts.studio.newFile')} initial="contract.tact" exists={files} onDone={(name) => { update((prev) => ({ ...prev, files: { ...prev.files, [name]: '' } })); setFile(name); setSheet(null); }} onClose={() => setSheet(null)} />}
      {sheet?.file && (
        <FileSheet title={sheet.file} initial={sheet.file} exists={files.filter((f) => f !== sheet.file)} rename isMain={p.main === sheet.file} canDelete={files.length > 1}
          onMain={() => { update((prev) => ({ ...prev, main: sheet.file })); setSheet(null); }}
          onDelete={() => { update((prev) => { const f = { ...prev.files }; delete f[sheet.file]; return { ...prev, files: f, main: prev.main === sheet.file ? Object.keys(f)[0] : prev.main }; }); setFile(files.find((f) => f !== sheet.file)); setSheet(null); }}
          onDone={(name) => { if (name !== sheet.file) { update((prev) => { const f = {}; for (const [k, v] of Object.entries(prev.files)) f[k === sheet.file ? name : k] = v; return { ...prev, files: f, main: prev.main === sheet.file ? name : prev.main }; }); setFile(name); } setSheet(null); }}
          onClose={() => setSheet(null)} />
      )}
    </div>
  );
}

function FileSheet({ title, initial, exists, rename, isMain, canDelete, onMain, onDelete, onDone, onClose }) {
  const [name, setName] = useState(initial);
  const n = name.trim().replace(/^\/+/, '');
  const bad = !/^[\w.\-/]+\.tact$/.test(n) || /(^|\/)\.\.?(\/|$)/.test(n) ? t('tonc.studio.badName') : exists.includes(n) ? t('contracts.studio.exists') : '';
  return (
    <Sheet title={title} onClose={onClose}>
      <div class="field"><label>{t('contracts.studio.fileName')}</label><input class="input mono" value={name} spellcheck={false} autocapitalize="off" onInput={(e) => setName(e.target.value)} /></div>
      {bad && (!rename || n !== initial) && <span class="small red">{bad}</span>}
      <Btn disabled={!!bad && (!rename || n !== initial)} onClick={() => onDone(n)}>{rename ? t('contracts.studio.rename') : t('contracts.studio.create')}</Btn>
      {rename && !isMain && <Btn kind="secondary" onClick={onMain}>{t('contracts.studio.setMain')}</Btn>}
      {rename && canDelete && <Btn kind="secondary" class="red" onClick={onDelete}><Icon name="trash" size={16} /> {t('contracts.studio.deleteFile')}</Btn>}
    </Sheet>
  );
}

function ProjectSheet({ p, onChange, onDelete, onClose }) {
  const [confirmDel, setConfirmDel] = useState(false);
  return (
    <Sheet title={t('contracts.studio.settings')} onClose={onClose}>
      <div class="col ct-settings">
        <div class="field"><label>{t('contracts.studio.projectName')}</label><input class="input" value={p.name} onInput={(e) => onChange({ name: e.target.value })} /></div>
        <span class="tiny muted">{t('tonc.studio.about')}</span>
        {!confirmDel ? <Btn kind="secondary" onClick={() => setConfirmDel(true)}><Icon name="trash" size={16} /> {t('contracts.studio.deleteProject')}</Btn>
          : <Btn kind="danger" onClick={() => { onClose(); onDelete(); }}>{t('contracts.studio.deleteConfirm')}</Btn>}
      </div>
    </Sheet>
  );
}

// ------------------------------------------------------------ deploy
/** How a new contract gets its first message: empty body, Tact's Deploy message, or nothing it accepts. */
function deployBody(c) {
  const rs = tactReceivers(c.abi);
  if (rs.some((r) => r.kind === 'empty' || r.kind === 'any')) return { body: null };
  if (rs.some((r) => r.kind === 'typed' && r.type === 'Deploy') && c.types.Deploy) return { body: tactMessageBody('Deploy', { queryId: '0' }, c.types) };
  return { body: null, warn: true };
}

export function TonDeploy({ build: c, project, chainId: initialChain, onBack, open }) {
  const { state } = useApp();
  const [chainId, setChainId] = useState(initialChain ?? -239);
  const chain = getChain(chainId, state.customChains);
  const wallet = useTonWalletFor(chain);
  const args = c.init?.args || [];
  const [vals, setVals] = useState(() => emptyValues(args, c.types, c.abi.types));
  const [amount, setAmount] = useState('0.05');
  const [pick, setPick] = useState(false);
  const [exists, setExists] = useState(null);
  const filled = useRef(false);
  // the owner-like address arguments start as the account's address
  useEffect(() => {
    if (!wallet || filled.current) return;
    filled.current = true;
    setVals((v) => Object.fromEntries(Object.entries(v).map(([k, x]) => [k, x === '' && args.find((a) => a.name === k)?.type?.type === 'address' ? wallet.address : x])));
  }, [!!wallet]);

  const built = useMemo(() => {
    try {
      const code = Cell.fromBase64(c.code);
      const data = tactInitData(c.init, vals, c.types);
      const init = { code, data };
      return { address: contractAddress(0, init), init };
    } catch (e) { return { error: e.path ? `${e.path}: ${errText(e)}` : errText(e) }; }
  }, [vals]);
  const raw = built.address?.toRawString();
  useEffect(() => {
    if (!raw) { setExists(null); return undefined; }
    setExists('checking');
    const tm = setTimeout(() => tonAddressStatus(chain, raw).then(setExists).catch(() => setExists(null)), 900);
    return () => clearTimeout(tm);
  }, [raw, chainId]);
  const first = deployBody(c);
  const value = parseAmount(amount, 9);

  const go = () => {
    const body = first.body ? toB64(first.body) : undefined;
    open({
      name: 'tontx', chainId,
      req: {
        title: t('tonc.deploy.title', { name: c.name }), risks: first.warn ? ['noDeployReceiver'] : [],
        deploy: { address: raw, name: c.name, kind: 'tact', tact: { abi: c.abi, types: c.types } },
        summary: [[t('tonc.deploy.contract'), c.name], ...args.map((a) => [a.name, typeof vals[a.name] === 'object' ? JSON.stringify(vals[a.name]) : String(vals[a.name])])],
        messages: [{ to: raw, value: String(value), bounce: false, init: stateInitB64(built.init), ...(body ? { body } : {}) }],
      },
    });
  };

  return (
    <div class="screen">
      <Bar title={t('tonc.deploy.title', { name: c.name })} onBack={onBack} />
      <div class="content ct-content">
        <button class="item card flat" onClick={() => setPick(true)}>
          <ChainIcon chain={chain} size={24} /><div class="grow"><div class="bold">{chain.name}</div><div class="tiny muted">{t('tonc.create.network')}</div></div><Icon name="chevron" size={14} />
        </button>
        {wallet === null && <div class="error">{t('tonc.write.noKey')}</div>}
        {c.init?.unsupported && <div class="error">{t('tonc.tact.err.initUnsupported')}</div>}
        {args.length > 0 && (
          <div class="card col">
            <b class="small">{t('tonc.deploy.args')}</b>
            <span class="tiny muted mono">init({args.map((a) => `${a.name}: ${typeLabel(a.type)}`).join(', ')})</span>
            <TactFields fields={args} values={vals} onChange={setVals} types={c.types} abiTypes={c.abi.types} chain={chain} wallet={wallet} />
          </div>
        )}
        <div class="ct-field">
          <span class="ct-label"><span>{t('tonc.deploy.value')}</span><span class="ct-type">{chain.native.symbol}</span></span>
          <input class="input mono" inputMode="decimal" value={amount} onInput={(e) => setAmount(e.target.value)} />
          <span class="tiny muted">{t('tonc.deploy.valueHint')}</span>
        </div>
        {first.warn && <div class="warn small">{t('tonc.risk.noDeployReceiver')}</div>}
        {built.error && <div class="tiny red">{built.error}</div>}
        {raw && (
          <div class="card col" style={{ gap: '.25rem' }}>
            <span class="tiny muted">{t('tonc.create.address')}</span>
            <span class="mono tiny" style={{ wordBreak: 'break-all' }}>{showAddress(raw, { testnet: chain.testnet })}</span>
            {exists === 'checking' && <Spinner />}
            {exists === 'active' && (
              <div class="warn small col" style={{ gap: '.375rem' }}>
                {t('tonc.deploy.exists')}
                <button class="btn secondary sm" onClick={() => open({ name: 'contract', chainId, address: raw })}><Icon name="code" size={14} /> {t('contracts.tx.openContract')}</button>
              </div>
            )}
          </div>
        )}
        <span class="tiny muted">{t('tonc.deploy.project', { name: project?.name || '' })}</span>
      </div>
      <div class="footer">
        <Btn disabled={!raw || !wallet || value == null || value <= 0n || exists === 'checking' || exists === 'active'} onClick={go}>{t('contracts.tx.deploy')}</Btn>
      </div>
      {pick && <NetworkSheet current={chainId} onPick={setChainId} only={isTon} onClose={() => setPick(false)} />}
    </div>
  );
}

