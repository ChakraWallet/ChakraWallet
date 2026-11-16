// Solidity studio (Android app): templates on OpenZeppelin, projects with an editor, compilation in a worker,
// deployment with constructor arguments and libraries, verification on Sourcify, and a viewer for verified sources.
import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import { Icon, Spinner, Btn, Sheet, Switch, ChainIcon, useApp } from '../../components.jsx';
import { getChain, isEvm } from '../../../shared/chains.js';
import {
  TEMPLATES, generate, DEFAULT_EVM, EVM_VERSIONS, MAX_RUNTIME, MAX_INITCODE, pickVersion, collectSources, parseRemappings,
  standardInput, parseOutput, librariesOf, linkBytecode, verifySourcify, OZ_VERSION,
} from '../../../shared/solidity.js';
import { safeInterface } from '../../../shared/contracts.js';
import { emptyValue, toArgs, parseInteger } from '../../../shared/abiInput.js';
import { t } from '../../../shared/i18n.js';
import { CodeEditor, langOf } from './codeEditor.jsx';
import { NetworkSheet } from '../home.jsx';
import { ParamInput, argMessage } from './abiForm.jsx';
import { releases, loadCompiler, compile, isDownloaded } from '../../solcClient.js';
import { getProject, putProject, deleteProject, newProjectId, saveContract } from '../../contractsStore.js';

export const DEFAULT_SETTINGS = { version: 'auto', optimizer: true, runs: 200, evmVersion: DEFAULT_EVM, viaIR: false, deps: `@openzeppelin/contracts@${OZ_VERSION}`, remappings: '' };
const sourceCache = new Map(); // library sources downloaded in this session, by URL
const fetchText = async (url) => { const r = await fetch(url); if (!r.ok) throw new Error(`HTTP ${r.status}`); return r.text(); };
/** "pkg@1.2.3" lines -> { pkg: '1.2.3' } */
const parseDeps = (text) => Object.fromEntries(String(text || '').split('\n').map((l) => l.trim()).filter(Boolean).map((l) => { const i = l.lastIndexOf('@'); return i > 0 ? [l.slice(0, i), l.slice(i + 1)] : [l, 'latest']; }));
const kb = (n) => `${(n / 1024).toFixed(1)} KB`;

function Bar({ title, onBack, right }) {
  return (
    <div class="topbar">
      <button class="iconbtn" onClick={onBack} title={t('common.back')}><Icon name="back" /></button>
      <h1 class="ellipsis">{title}</h1>
      {right}
    </div>
  );
}

/**
 * A new project, not saved yet: the studio saves it at the first change, compilation or deployment. Opened and left
 * as it was (e.g. by mistake), it leaves nothing behind.
 */
export const draftProject = ({ name, files, main, mainContract }) => ({ id: newProjectId(), name, files, main, mainContract, settings: { ...DEFAULT_SETTINGS } });

// ------------------------------------------------------------ templates
const OPTS = {
  erc20: ['mintable', 'burnable', 'pausable', 'permit'],
  erc721: ['mintable', 'autoIncrement', 'burnable', 'pausable', 'enumerable', 'uriStorage'],
  erc1155: ['mintable', 'burnable', 'pausable', 'supply', 'updatableUri'],
  empty: [],
};

export function CreateTemplate({ kind, onBack, open }) {
  const [o, setO] = useState({ ...TEMPLATES[kind] });
  const [busy, setBusy] = useState(false);
  const set = (k, v) => setO({ ...o, [k]: v });
  let gen = null, genErr = '';
  try { gen = generate(kind, o); } catch { genErr = t('contracts.tpl.invalid'); }
  const go = (autoDeploy) => {
    setBusy(true);
    const draft = draftProject({ name: o.name || t(`contracts.tpl.${kind}`), files: { [gen.fileName]: gen.source }, main: gen.fileName, mainContract: gen.contractName });
    open({ name: 'studio', draft, autoDeploy }, { replace: true });
  };
  const text = (k, extra = {}) => (
    <div class="field">
      <label>{t(`contracts.tpl.f.${k}`)}</label>
      <input class="input" value={o[k]} spellcheck={false} autocapitalize="off" onInput={(e) => set(k, e.target.value)} {...extra} />
    </div>
  );
  return (
    <div class="screen">
      <Bar title={t(`contracts.tpl.${kind}`)} onBack={onBack} />
      <div class="content ct-content">
        <div class="info small">{t(`contracts.tpl.${kind}.intro`)}</div>
        {text('name')}
        {(kind === 'erc20' || kind === 'erc721') && text('symbol')}
        {kind === 'erc20' && <div class="row" style={{ gap: '.5rem' }}><div class="grow">{text('premint', { inputMode: 'decimal' })}</div><div style={{ width: '6rem' }}>{text('decimals', { inputMode: 'numeric' })}</div></div>}
        {kind === 'erc721' && text('baseUri', { placeholder: 'ipfs://…/' })}
        {kind === 'erc1155' && text('uri', { placeholder: 'https://…/{id}.json' })}
        {OPTS[kind].length > 0 && (
          <div class="card col ct-opts">
            {OPTS[kind].map((k) => (
              <label class="ct-opt">
                <span class="grow"><b class="small">{t(`contracts.tpl.o.${k}`)}</b><span class="tiny muted">{t(`contracts.tpl.o.${k}.hint`)}</span></span>
                <Switch on={!!o[k]} onChange={(v) => set(k, v)} />
              </label>
            ))}
          </div>
        )}
        {kind !== 'empty' && <div class="tiny muted">{t('contracts.tpl.ownerNote', { v: OZ_VERSION })}</div>}
        {genErr && <div class="error">{genErr}</div>}
        {gen && <CodePreview title={t('contracts.tpl.preview')} file={gen.fileName} source={gen.source} />}
      </div>
      <div class="footer ct-foot">
        <Btn kind="secondary" class="ct-foot-alt" disabled={!gen || busy} onClick={() => go(false)}><Icon name="edit" size={16} /> {t('contracts.tpl.edit')}</Btn>
        <Btn loading={busy} disabled={!gen} onClick={() => go(true)}>{t('contracts.tpl.deploy')}</Btn>
      </div>
    </div>
  );
}

/** Expandable, highlighted, read-only view of a source (follows the source while it changes). */
function CodePreview({ title, file, source }) {
  const [open, setOpen] = useState(false);
  return (
    <div class={`card ct-preview ${open ? 'open' : ''}`}>
      <button class="ct-preview-head" onClick={() => setOpen(!open)} aria-expanded={open}>
        <span class="ct-kind-ic sm"><Icon name="code" size={16} /></span>
        <span class="grow"><b class="small">{title}</b><span class="tiny muted mono">{file}</span></span>
        <span class="ct-chev"><Icon name="chevron" size={16} /></span>
      </button>
      {open && <CodeEditor value={source} readOnly />}
    </div>
  );
}

// ------------------------------------------------------------ studio
export function Studio({ projectId, draft, autoDeploy, onBack, open }) {
  const { chain: active } = useApp();
  const [p, setP] = useState(null);
  const [file, setFile] = useState(null);
  const [build, setBuild] = useState(null);
  const [panel, setPanel] = useState(false);
  const [sheet, setSheet] = useState(null);
  const [jump, setJump] = useState(null);
  const [allOut, setAllOut] = useState(false);
  const pRef = useRef(null);
  const timer = useRef(0);
  const gone = useRef(false); // deleted: nothing must save it again
  const dirty = useRef(false); // changed since opened: saved on exit (a project only looked at isn't touched)
  pRef.current = p;

  useEffect(() => {
    const id = projectId || draft?.id;
    // a draft already saved (changed, then reopened from the stack) is loaded as saved
    getProject(id).then((pr) => { pr ||= draft; if (!pr) return; setP(pr); setFile(pr.main || Object.keys(pr.files)[0]); });
    return () => { clearTimeout(timer.current); if (pRef.current && dirty.current && !gone.current) putProject(pRef.current); };
  }, [projectId, draft?.id]);
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

  const run = async (deployAfter = false) => {
    const proj = pRef.current;
    await putProject(proj);
    setPanel(true);
    setBuild({ phase: 'versions' });
    try {
      const { releases: list } = await releases();
      const version = proj.settings.version === 'auto' ? pickVersion(list, proj.files) : proj.settings.version;
      if (!version) throw new Error(t('contracts.studio.noVersion'));
      const rel = list.find((r) => r.version === version);
      if (!rel) throw new Error(t('contracts.studio.noVersion'));
      const first = !(await isDownloaded(rel));
      setBuild({ phase: 'compiler', version, first, progress: null });
      await loadCompiler(rel, (loaded, total) => setBuild({ phase: 'compiler', version, first, progress: total ? loaded / total : null, loaded }));
      setBuild({ phase: 'imports', version });
      const { sources, missing } = await collectSources(proj.files, {
        deps: parseDeps(proj.settings.deps), remappings: parseRemappings(proj.settings.remappings), fetchText, cache: sourceCache,
        onFetch: (f) => setBuild({ phase: 'imports', version, file: f }),
      });
      if (missing.length) throw new Error(t('contracts.studio.missing', { files: missing.join(', ') }));
      setBuild({ phase: 'compiling', version });
      const input = standardInput(sources, proj.settings);
      const out = parseOutput(await compile(input), sources);
      const result = { done: true, version, long: rel.long, input, ...out };
      setBuild(result);
      const ok = !out.errors.some((e) => e.severity === 'error');
      if (ok && deployAfter) {
        const c = out.contracts.find((x) => x.file === proj.main && x.name === proj.mainContract) || out.contracts.find((x) => proj.files[x.file] != null);
        if (c) deploy(c, result);
      }
    } catch (e) { setBuild({ error: e.message }); }
  };
  const ran = useRef(false);
  useEffect(() => { if (p && autoDeploy && !ran.current) { ran.current = true; run(true); } }, [p]);

  const deploy = (c, b = build) => open({ name: 'deploy', chainId: isEvm(active) ? active.id : 1, artifact: { name: c.name, abi: c.abi, bytecode: c.bytecode, linkReferences: c.linkReferences, runtimeSize: c.runtimeSize, initSize: c.initSize }, compilation: { input: b.input, long: b.long, id: c.id } });

  const errs = build?.errors || [];
  const diags = useMemo(() => errs.filter((e) => e.file === file && e.start != null)
    .map((e) => ({ from: e.start, to: e.end ?? e.start, severity: e.severity === 'error' ? 'error' : 'warning', message: e.message })), [build, file]);
  if (!p) return <div class="screen"><Bar title="" onBack={onBack} /><div class="ct-loading"><Spinner lg /></div></div>;
  const files = Object.keys(p.files);
  const nErr = errs.filter((e) => e.severity === 'error').length, nWarn = errs.length - nErr;
  const busy = build && !build.done && !build.error;
  const own = (build?.contracts || []).filter((c) => allOut || p.files[c.file] != null);

  return (
    <div class="screen ct-studio">
      <Bar title={p.name} onBack={onBack} right={<>
        <button class="iconbtn" title={t('contracts.studio.settings')} onClick={() => setSheet('settings')}><Icon name="settings" size={18} /></button>
        <button class="btn primary sm ct-run" disabled={busy} onClick={() => run(false)}>{busy ? <Spinner /> : <><Icon name="flash" size={14} /> {t('contracts.studio.compile')}</>}</button>
      </>} />
      <div class="ct-files">
        {files.map((f) => <button class={`chip ct-file ${f === file ? 'on' : ''}`} onClick={() => (f === file ? setSheet({ file: f }) : setFile(f))}>{f.split('/').pop()}{f === p.main ? ' •' : ''}</button>)}
        <button class="chip ct-file" title={t('contracts.studio.newFile')} onClick={() => setSheet({ newFile: true })}><Icon name="plus" size={14} /></button>
      </div>
      {file && p.files[file] != null && <CodeEditor key={file} value={p.files[file]} onChange={onEdit} diagnostics={diags} jump={jump} />}
      <div class={`ct-panel ${panel ? 'open' : ''}`}>
        <button class="ct-panel-head" onClick={() => setPanel(!panel)}>
          {busy && <Spinner />}
          <span class="grow small">
            {!build ? t('contracts.studio.ready')
              : build.error ? <span class="red">{t('contracts.studio.failed')}</span>
                : build.done ? t('contracts.studio.compiled', { v: build.version, e: nErr, w: nWarn })
                  : build.phase === 'compiler' ? (build.first ? t('contracts.studio.downloading', { v: build.version, p: build.progress != null ? Math.round(build.progress * 100) + '%' : build.loaded ? `${(build.loaded / 1e6).toFixed(1)} MB` : '…' }) : t('contracts.studio.loadingCompiler', { v: build.version }))
                    : build.phase === 'imports' ? t('contracts.studio.imports', { f: build.file ? build.file.split('/').pop() : '…' })
                      : build.phase === 'compiling' ? t('contracts.studio.compiling', { v: build.version }) : t('contracts.studio.preparing')}
          </span>
          <Icon name="chevron" size={14} />
        </button>
        {panel && (
          <div class="ct-panel-body">
            {build?.error && <div class="error small">{build.error}</div>}
            {errs.map((e) => (
              <button class={`ct-diag ${e.severity}`} onClick={() => { if (e.file && p.files[e.file] != null) { setFile(e.file); setJump({ line: e.line, n: Date.now() }); } }}>
                <span class={`badge ${e.severity === 'error' ? 'red' : 'amber'}`}>{e.severity === 'error' ? t('contracts.studio.error') : t('contracts.studio.warning')}</span>
                <span class="grow tiny"><b class="mono">{e.file ? `${e.file.split('/').pop()}:${e.line}` : e.type}</b> {e.message}</span>
              </button>
            ))}
            {build?.done && !nErr && (
              <>
                {own.map((c) => (
                  <div class="ct-out">
                    <span class="grow"><b class="small mono">{c.name}</b><span class={`tiny ${c.runtimeSize > MAX_RUNTIME ? 'red' : 'muted'}`}> · {kb(c.runtimeSize)}{c.runtimeSize > MAX_RUNTIME ? ` · ${t('contracts.studio.tooBig')}` : ''}</span></span>
                    <button class="iconbtn sm" title="ABI" onClick={() => navigator.clipboard.writeText(JSON.stringify(c.abi, null, 2))}><Icon name="copy" size={14} /></button>
                    <button class="btn primary sm" onClick={() => deploy(c)}>{t('contracts.studio.deploy')}</button>
                  </div>
                ))}
                {!own.length && <span class="small muted">{t('contracts.studio.nothing')}</span>}
                {build.contracts.length > own.length || allOut ? <button class="link tiny" onClick={() => setAllOut(!allOut)}>{allOut ? t('contracts.studio.onlyMine') : t('contracts.studio.showAll')}</button> : null}
              </>
            )}
          </div>
        )}
      </div>
      {sheet === 'settings' && <ProjectSettings p={p} onChange={(s) => update((prev) => ({ ...prev, ...s }))} onDelete={async () => { gone.current = true; clearTimeout(timer.current); await deleteProject(p.id); onBack(); }} onClose={() => setSheet(null)} />}
      {sheet?.newFile && <FileSheet title={t('contracts.studio.newFile')} initial="Contract.sol" exists={files} onDone={(name) => { update((prev) => ({ ...prev, files: { ...prev.files, [name]: `// SPDX-License-Identifier: MIT\npragma solidity ^0.8.27;\n\n` } })); setFile(name); setSheet(null); }} onClose={() => setSheet(null)} />}
      {sheet?.file && (
        <FileSheet title={sheet.file} initial={sheet.file} exists={files.filter((f) => f !== sheet.file)} rename
          isMain={p.main === sheet.file} canDelete={files.length > 1}
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
  const bad = !/^[\w@.\-/]+\.sol$/.test(n) || /(^|\/)\.\.?(\/|$)/.test(n) ? t('contracts.studio.badName') : exists.includes(n) ? t('contracts.studio.exists') : '';
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

function ProjectSettings({ p, onChange, onDelete, onClose }) {
  const [list, setList] = useState(null);
  const [confirmDel, setConfirmDel] = useState(false);
  const s = p.settings;
  const set = (k, v) => onChange({ settings: { ...s, [k]: v } });
  useEffect(() => { releases().then((r) => setList(r.releases)).catch(() => setList([])); }, []);
  const auto = list?.length ? pickVersion(list, p.files) : null;
  return (
    <Sheet title={t('contracts.studio.settings')} onClose={onClose}>
      <div class="col ct-settings">
        <div class="field"><label>{t('contracts.studio.projectName')}</label><input class="input" value={p.name} onInput={(e) => onChange({ name: e.target.value })} /></div>
        <div class="field">
          <label>{t('contracts.studio.version')}</label>
          <select class="input" value={s.version} onChange={(e) => set('version', e.target.value)}>
            <option value="auto">{t('contracts.studio.versionAuto')}{auto ? ` (${auto})` : ''}</option>
            {(list || []).filter((r) => /^0\.(8|7|6|5)\./.test(r.version)).map((r) => <option value={r.version}>{r.version}</option>)}
          </select>
        </div>
        <label class="ct-opt"><span class="grow"><b class="small">{t('contracts.studio.optimizer')}</b><span class="tiny muted">{t('contracts.studio.optimizerHint')}</span></span><Switch on={s.optimizer} onChange={(v) => set('optimizer', v)} /></label>
        {s.optimizer && <div class="field"><label>{t('contracts.studio.runs')}</label><input class="input" inputMode="numeric" value={s.runs} onInput={(e) => set('runs', Number(e.target.value.replace(/\D/g, '')) || 0)} /></div>}
        <div class="field">
          <label>{t('contracts.studio.evm')}</label>
          <select class="input" value={s.evmVersion} onChange={(e) => set('evmVersion', e.target.value)}>{EVM_VERSIONS.map((v) => <option value={v}>{v}{v === DEFAULT_EVM ? ` · ${t('contracts.studio.recommended')}` : ''}</option>)}</select>
          <span class="tiny muted">{t('contracts.studio.evmHint')}</span>
        </div>
        <label class="ct-opt"><span class="grow"><b class="small">via-IR</b><span class="tiny muted">{t('contracts.studio.viaIrHint')}</span></span><Switch on={!!s.viaIR} onChange={(v) => set('viaIR', v)} /></label>
        <div class="field"><label>{t('contracts.studio.deps')}</label><textarea class="input mono" rows={3} value={s.deps} spellcheck={false} autocapitalize="off" onInput={(e) => set('deps', e.target.value)} /><span class="tiny muted">{t('contracts.studio.depsHint')}</span></div>
        <div class="field"><label>{t('contracts.studio.remappings')}</label><textarea class="input mono" rows={2} value={s.remappings} placeholder="forge-std/=https://github.com/foundry-rs/forge-std/blob/master/src/" spellcheck={false} autocapitalize="off" onInput={(e) => set('remappings', e.target.value)} /><span class="tiny muted">{t('contracts.studio.remapHint')}</span></div>
        {!confirmDel ? <Btn kind="secondary" onClick={() => setConfirmDel(true)}><Icon name="trash" size={16} /> {t('contracts.studio.deleteProject')}</Btn>
          : <Btn kind="danger" onClick={() => { onClose(); onDelete(); }}>{t('contracts.studio.deleteConfirm')}</Btn>}
      </div>
    </Sheet>
  );
}

// ------------------------------------------------------------ deploy

/** Verification of a contract just deployed (compiled here): runs once, can be retried. */
function VerifyStatus({ chainId, address, compilation, txHash }) {
  const [st, setSt] = useState({ status: 'running' });
  const go = async (delay) => {
    setSt({ status: 'running' });
    await new Promise((r) => setTimeout(r, delay));
    const r = await verifySourcify({ chainId, address, input: compilation.input, compilerVersion: compilation.long, contractId: compilation.id, txHash }).catch((e) => ({ status: 'failed', message: e.message }));
    setSt(r);
  };
  useEffect(() => { go(6000); }, []);
  return (
    <div class={st.status === 'failed' ? 'warn small' : st.status === 'running' ? 'info small row' : 'success small'}>
      {st.status === 'running' && <><Spinner /> {t('contracts.verify.running')}</>}
      {st.status === 'verified' && t('contracts.verify.done')}
      {st.status === 'already' && t('contracts.verify.already')}
      {st.status === 'failed' && <>{t('contracts.verify.failed', { msg: st.message || '' })} <button class="link" onClick={() => go(0)}>{t('contracts.retry')}</button></>}
    </div>
  );
}

export function Deploy({ artifact, compilation, chainId: initialChain, onBack, open }) {
  const { state, chain: active } = useApp();
  const [chainId, setChainId] = useState(initialChain || (isEvm(active) ? active.id : 1));
  const [pick, setPick] = useState(false);
  const chain = getChain(chainId, state.customChains) || active;
  const iface = useMemo(() => safeInterface(artifact.abi), [artifact]);
  const inputs = iface.deploy?.inputs || [];
  const payable = iface.deploy?.payable;
  const libs = librariesOf(artifact.linkReferences);
  const [vals, setVals] = useState(() => inputs.map(emptyValue));
  const [units, setUnits] = useState({});
  const [libAddr, setLibAddr] = useState({});
  const [value, setValue] = useState('');
  const [err, setErr] = useState('');
  const initSize = artifact.initSize || (artifact.bytecode.length - 2) / 2;
  const go = () => {
    setErr('');
    try {
      const bytecode = libs.length ? linkBytecode(artifact.bytecode, artifact.linkReferences, libAddr) : artifact.bytecode;
      if (!/^0x[0-9a-fA-F]+$/.test(bytecode)) throw new Error(t('contracts.deploy.unlinked'));
      const args = toArgs(inputs, vals, { units });
      const data = bytecode + iface.encodeDeploy(args).slice(2);
      const v = value.trim() ? parseInteger(value, chain.native.decimals) : 0n;
      const name = artifact.name || t('contracts.tx.newContract');
      open({
        name: 'tx', chainId: chain.id,
        req: { kind: 'deploy', data, value: v, title: t('contracts.tx.deployTitle', { name }), name, iface, args, fn: { inputs, name: 'constructor' } },
        onMined: (r, hash) => saveContract({ chainId: chain.id, address: r.contractAddress, name, mine: true, abi: artifact.abi, txHash: hash }),
        renderDone: compilation ? (r) => <VerifyStatus chainId={chain.id} address={r.contractAddress} compilation={compilation} txHash={r.transactionHash} /> : null,
      });
    } catch (e) { setErr(e.message?.startsWith('library') ? t('contracts.deploy.libMissing') : argMessage(e, inputs)); }
  };
  return (
    <div class="screen">
      <Bar title={t('contracts.deploy.title', { name: artifact.name || '' })} onBack={onBack} />
      <div class="content ct-content">
        <div class="card col" style={{ gap: '.5rem' }}>
          <span class="small muted">{t('contracts.deploy.network')}</span>
          <button class="chain-pick" onClick={() => setPick(true)}><ChainIcon chain={chain} size={22} /><span>{chain.name}</span><Icon name="chevron" size={14} /></button>
          <span class="tiny muted">{t('contracts.deploy.sizes', { init: kb(initSize), run: artifact.runtimeSize ? kb(artifact.runtimeSize) : '—' })}</span>
        </div>
        {artifact.runtimeSize > MAX_RUNTIME && <div class="error">{t('contracts.deploy.tooBig')}</div>}
        {initSize > MAX_INITCODE && <div class="error">{t('contracts.deploy.initTooBig')}</div>}
        {!compilation && <div class="warn small">{t('contracts.deploy.noVerify')}</div>}
        {inputs.length > 0 && (
          <div class="card col ct-fn-body">
            <b class="small">{t('contracts.deploy.constructor')}</b>
            {inputs.map((p, i) => <ParamInput p={p} idx={i} value={vals[i]} path={String(i)} units={units} setUnits={setUnits} chain={chain} onChange={(v) => { const n = [...vals]; n[i] = v; setVals(n); }} />)}
          </div>
        )}
        {payable && (
          <div class="ct-field"><span class="ct-label"><span>{t('contracts.fn.value')}</span><span class="ct-type">{chain.native.symbol}</span></span><input class="input mono" inputMode="decimal" value={value} placeholder="0" onInput={(e) => setValue(e.target.value)} /></div>
        )}
        {libs.length > 0 && (
          <div class="card col ct-fn-body">
            <b class="small">{t('contracts.deploy.libraries')}</b>
            <span class="tiny muted">{t('contracts.deploy.librariesHint')}</span>
            {libs.map((l) => <div class="ct-field"><span class="ct-label"><span>{l.name}</span><span class="ct-type">{l.file}</span></span><input class="input mono" value={libAddr[l.key] || ''} placeholder="0x…" spellcheck={false} autocapitalize="off" onInput={(e) => setLibAddr({ ...libAddr, [l.key]: e.target.value.trim() })} /></div>)}
          </div>
        )}
        {err && <div class="error">{err}</div>}
      </div>
      <div class="footer"><Btn onClick={go}>{t('common.continue')}</Btn></div>
      {pick && <NetworkSheet current={chainId} onPick={setChainId} only={isEvm} onClose={() => setPick(false)} />}
    </div>
  );
}

// ------------------------------------------------------------ verified sources
export function SourceView({ title, files, noProject, onBack, open }) {
  const [i, setI] = useState(() => Math.max(0, files.findIndex((f) => !f.path.startsWith('@') && !f.path.includes('node_modules'))));
  const [busy, setBusy] = useState(false);
  const f = files[i];
  const asProject = async () => {
    setBusy(true);
    const main = files[i].path;
    open({ name: 'studio', draft: draftProject({ name: title, files: Object.fromEntries(files.map((x) => [x.path, x.content])), main }) });
    setBusy(false);
  };
  return (
    <div class="screen ct-studio">
      <Bar title={title} onBack={onBack} right={<button class="iconbtn" title={t('common.copy')} onClick={() => navigator.clipboard.writeText(f.content)}><Icon name="copy" size={18} /></button>} />
      {files.length > 1 && <div class="ct-files">{files.map((x, k) => <button class={`chip ct-file ${k === i ? 'on' : ''}`} onClick={() => setI(k)}>{x.path.split('/').pop()}</button>)}</div>}
      <div class="tiny muted mono ct-path">{f.path}</div>
      <CodeEditor key={f.path} value={f.content} readOnly lang={langOf(f.path, noProject ? 'plain' : 'solidity')} />
      {__TARGET__ === 'android' && !noProject && <div class="footer"><Btn kind="secondary" loading={busy} onClick={asProject}><Icon name="edit" size={16} /> {t('contracts.source.asProject')}</Btn></div>}
    </div>
  );
}
