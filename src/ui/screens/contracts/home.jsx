// Contracts tab home: open a contract (address + network, or QR), create one, projects, saved and recent contracts,
// tools.
import { useState } from 'preact/hooks';
import { Icon, Btn, Sheet, ChainIcon, useApp, Seal, cardStyle } from '../../components.jsx';
import { getChain, isEvm } from '../../../shared/chains.js';
import { shortAddr } from '../../../shared/format.js';
import { parsePaymentQr } from '../../../shared/eip681.js';
import { parseArtifact } from '../../../shared/solidity.js';
import { t } from '../../../shared/i18n.js';
import { isAddress } from 'ethers';
import { QrScanner } from '../../scanner.jsx';
import { useContractsStore, clearRecent } from '../../contractsStore.js';
import { NetworkSheet } from '../home.jsx';
import { DecoderBox } from './tools.jsx';

const KINDS = [['erc20', 'coins'], ['erc721', 'sparkle'], ['erc1155', 'grid'], ['empty', 'code']];

export function ContractsHome({ open }) {
  const { state, chain: active, account } = useApp();
  const store = useContractsStore();
  const [chainId, setChainId] = useState(isEvm(active) ? active.id : 1); // contracts: EVM networks only
  const [addr, setAddr] = useState('');
  const [pick, setPick] = useState(false);
  const [scan, setScan] = useState(false);
  const [sheet, setSheet] = useState(null);
  const chain = getChain(chainId, state.customChains) || active;
  const v = addr.trim();
  const valid = isAddress(v);
  const go = () => valid && open({ name: 'contract', chainId: chain.id, address: v });
  const onQr = (text) => {
    setScan(false);
    const p = parsePaymentQr(text);
    const a = p?.address || (/0x[0-9a-fA-F]{40}/.exec(text) || [])[0];
    if (!a) return;
    const c = p?.chainId && getChain(p.chainId, state.customChains);
    if (c) setChainId(c.id);
    setAddr(a);
  };
  const chainName = (id) => getChain(id, state.customChains);
  const row = (x) => {
    const c = chainName(x.chainId);
    return (
      <button class="item" onClick={() => open({ name: 'contract', chainId: x.chainId, address: x.address })}>
        {c ? <ChainIcon chain={c} size={28} /> : <Icon name="code" />}
        <div class="grow"><div class="bold ellipsis">{x.label || x.name || shortAddr(x.address)}</div><div class="tiny muted mono">{shortAddr(x.address, 6)}{c ? ` · ${c.name}` : ''}</div></div>
        {x.mine && <span class="badge green">{t('contracts.mine')}</span>}
      </button>
    );
  };

  return (
    <div class="screen">
      <div class="topbar"><h1>{t('contracts.title')}</h1></div>
      <div class="content ct-content">
        {/* the one expressive element, as in the wallet home: the account's card, with a seal instead of the guilloche band */}
        <div class="hero ct-hero" style={cardStyle(account.address)}>
          <Seal seed={account.address} draw key={account.address} />
          <div class="row between">
            <span class="label">{t('contracts.home.open')}</span>
            <button class="ct-hero-chip" onClick={() => setPick(true)}><ChainIcon chain={chain} size={18} /><span>{chain.name}</span><Icon name="chevron" size={13} /></button>
          </div>
          <div class="ct-hero-field">
            <input placeholder={t('contracts.home.placeholder')} value={addr} spellcheck={false} autocapitalize="off"
              onInput={(e) => setAddr(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && go()} />
            <button class="ct-hero-scan" onClick={() => setScan(true)} title={t('scan.title')}><Icon name="qr" size={18} /></button>
          </div>
          <div class="row between hero-foot">
            <span class="small ct-hero-note">{v && !valid ? t('contracts.err.badAddress') : t('contracts.home.hint')}</span>
            <button class="ct-hero-go" disabled={!valid} onClick={go}>{t('contracts.home.go')} <Icon name="forward" size={14} /></button>
          </div>
        </div>

        <div class="group-title">{t('contracts.home.create')}</div>
        <div class="actions">
          {KINDS.map(([k, ic]) => <button class="action" onClick={() => open({ name: 'create', kind: k })}><span class="ic"><Icon name={ic} /></span>{t(`contracts.tpl.${k}.short`)}</button>)}
        </div>
        <button class="link" onClick={() => setSheet('artifact')}><Icon name="receive" size={14} /> {t('contracts.home.import')}</button>

        {store.projects.length > 0 && (
          <>
            <div class="group-title">{t('contracts.home.projects')}</div>
            <div class="card flat list ct-list">
              {store.projects.map((p) => (
                <button class="item" onClick={() => open({ name: 'studio', projectId: p.id })}>
                  <span class="ct-kind-ic sm"><Icon name="code" size={16} /></span>
                  <div class="grow"><div class="bold ellipsis">{p.name}</div><div class="tiny muted">{t('contracts.home.files', { n: Object.keys(p.files).length })} · {new Date(p.updated).toLocaleDateString()}</div></div>
                  <Icon name="forward" size={16} />
                </button>
              ))}
            </div>
          </>
        )}

        {store.saved.length > 0 && (
          <>
            <div class="group-title">{t('contracts.home.saved')}</div>
            <div class="card flat list ct-list">{store.saved.map(row)}</div>
          </>
        )}
        {store.recent.length > 0 && (
          <>
            <div class="row between"><div class="group-title">{t('contracts.home.recent')}</div><button class="link tiny" onClick={clearRecent}>{t('contracts.home.clear')}</button></div>
            <div class="card flat list ct-list">{store.recent.map(row)}</div>
          </>
        )}

        <div class="group-title">{t('contracts.home.tools')}</div>
        <div class="card flat list ct-list">
          <button class="item" onClick={() => setSheet('decoder')}><span class="ct-kind-ic sm"><Icon name="search" size={16} /></span><div class="grow"><div class="bold">{t('contracts.inspect.decoder')}</div><div class="tiny muted">{t('contracts.home.decoderSub')}</div></div></button>
        </div>
      </div>
      {pick && <NetworkSheet current={chainId} onPick={setChainId} only={isEvm} onClose={() => setPick(false)} />}
      {scan && <QrScanner onResult={onQr} onClose={() => setScan(false)} />}
      {sheet === 'decoder' && <Sheet title={t('contracts.inspect.decoder')} onClose={() => setSheet(null)}><DecoderBox onOpenAddress={(a) => { setSheet(null); open({ name: 'contract', chainId: chain.id, address: a }); }} /></Sheet>}
      {sheet === 'artifact' && <ArtifactSheet onClose={() => setSheet(null)} onLoaded={(artifact) => { setSheet(null); open({ name: 'deploy', chainId: chain.id, artifact, compilation: null }); }} />}
    </div>
  );
}

/** JSON artifact from Remix / Hardhat / Foundry / Truffle (pasted or from a file). */
function ArtifactSheet({ onClose, onLoaded }) {
  const [text, setText] = useState('');
  const [err, setErr] = useState('');
  const load = (s) => {
    setErr('');
    try { onLoaded(parseArtifact(s)); } catch { setErr(t('contracts.artifact.bad')); }
  };
  const onFile = async (e) => { const f = e.target.files?.[0]; if (f) { const s = await f.text(); setText(s); load(s); } };
  return (
    <Sheet title={t('contracts.home.import')} onClose={onClose}>
      <span class="small muted">{t('contracts.artifact.hint')}</span>
      <textarea class="input mono" rows={6} value={text} placeholder='{ "abi": [...], "bytecode": "0x…" }' spellcheck={false} autocapitalize="off" onInput={(e) => setText(e.target.value)} />
      {err && <div class="error">{err}</div>}
      <div class="row" style={{ gap: '.5rem' }}>
        <label class="btn secondary sm grow ct-filebtn"><Icon name="receive" size={14} /> {t('contracts.artifact.file')}<input type="file" accept=".json,application/json" onChange={onFile} /></label>
        <Btn class="grow" disabled={!text.trim()} onClick={() => load(text)}>{t('common.continue')}</Btn>
      </div>
    </Sheet>
  );
}
