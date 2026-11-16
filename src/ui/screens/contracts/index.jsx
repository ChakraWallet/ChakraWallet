// Contracts tab (Android app): open, read, inspect and call any contract; write, compile and deploy Solidity.
// Screens stack over the home (which stays mounted), like the Predictions tab.
import { useEffect, useState } from 'preact/hooks';
import { useApp } from '../../components.jsx';
import { getChain } from '../../../shared/chains.js';
import { ContractsHome } from './home.jsx';
import { ContractView } from './contract.jsx';
import { TxReview } from './txReview.jsx';
import { Studio, CreateTemplate, Deploy, SourceView } from './studio.jsx';
import { isTon } from '../../../shared/ton/api.js';
import { TonContractView } from './ton/view.jsx';
import { TonTxReview } from './ton/review.jsx';
import { TonCreate } from './ton/create.jsx';
import { TonStudio, TonDeploy } from './ton/studio.jsx';

let seq = 0;

export function Contracts({ visible, onDeep }) {
  const { state, chain: active } = useApp();
  const [stack, setStack] = useState([]);
  const [dir, setDir] = useState('nav-fwd');
  const top = stack[stack.length - 1];
  /** open(screen, { replace }) - replace swaps the screen on top (e.g. template -> its project). */
  const open = (v, { replace } = {}) => {
    setDir('nav-fwd');
    setStack((s) => {
      const tp = s[s.length - 1];
      if (!replace && tp && tp.name === v.name && tp.address && tp.address === v.address && tp.chainId === v.chainId) return s;
      const e = { ...v, k: ++seq };
      return replace ? [...s.slice(0, -1), e] : [...s, e];
    });
  };
  const back = () => {
    if (!stack.length) return false;
    setDir('nav-back'); setStack((s) => s.slice(0, -1)); return true;
  };
  useEffect(() => { if (!visible) setDir(''); }, [visible]);
  useEffect(() => { onDeep?.(stack.length > 0); }, [stack.length]);
  useEffect(() => { globalThis.__CK_contractsBack = back; return () => { delete globalThis.__CK_contractsBack; }; }, [stack.length]);

  // every screen of the stack stays mounted (hidden under the top one): coming back from a transaction, the
  // contract page still has its tab, its fields and its results; the studio its compilation
  const render = (e) => {
    const chain = getChain(e.chainId, state.customChains) || active;
    const common = { onBack: back, open };
    if (e.name === 'contract' && isTon(chain)) return <TonContractView chainId={e.chainId} address={e.address} {...common} />;
    if (e.name === 'tontx') {
      return <TonTxReview chain={chain} req={e.req} onBack={back} onMined={e.onMined}
        onOpenContract={(a) => open({ name: 'contract', chainId: chain.id, address: a }, { replace: true })} />;
    }
    if (e.name === 'toncreate') return <TonCreate kind={e.kind} chainId={e.chainId} {...common} />;
    if (e.name === 'tonstudio') return <TonStudio projectId={e.projectId} newProject={e.newProject} chainId={e.chainId} {...common} />;
    if (e.name === 'tondeploy') return <TonDeploy build={e.build} project={e.project} chainId={e.chainId} {...common} />;
    return e.name === 'contract' ? <ContractView chainId={e.chainId} address={e.address} {...common} />
      : e.name === 'tx' ? <TxReview chain={chain} req={e.req} onBack={back} onMined={e.onMined} renderDone={e.renderDone}
        onOpenContract={(a) => open({ name: 'contract', chainId: chain.id, address: a }, { replace: true })} />
        : e.name === 'create' ? <CreateTemplate kind={e.kind} {...common} />
          : e.name === 'studio' ? <Studio projectId={e.projectId} draft={e.draft} autoDeploy={e.autoDeploy} {...common} />
            : e.name === 'deploy' ? <Deploy artifact={e.artifact} compilation={e.compilation} chainId={e.chainId} {...common} />
              : e.name === 'source' ? <SourceView title={e.title} files={e.files} noProject={e.noProject} {...common} /> : null;
  };
  return (
    <div class="screen ct" style={{ display: visible ? 'flex' : 'none' }}>
      <div class="screen" style={{ display: top ? 'none' : 'flex' }}><ContractsHome open={open} /></div>
      {stack.map((e) => <div class={`screen ${e === top ? dir : ''}`} key={e.k} style={{ display: e === top ? 'flex' : 'none' }}>{render(e)}</div>)}
    </div>
  );
}
