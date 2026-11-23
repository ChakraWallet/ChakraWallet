// Before signing on EVM networks: what a transaction does once simulated (shared/simulate.js), what a typed-data
// signature gives away (shared/typedData.js), and the EIP-7702 delegations of an account.
import { useEffect, useState } from 'preact/hooks';
import { simulateTx, analyzeCall, explainCall, riskOf, addressKind, wrappedNative, delegateOf } from '../shared/simulate.js';
import { BUILTIN_CHAINS } from '../shared/chains.js';
import { rpc, getTokenInfo, multiCall, erc20 } from '../shared/rpc.js';
import { fmtAmount, shortAddr } from '../shared/format.js';
import { Spinner, rich, explorerAddr, ChainIcon, Icon } from './components.jsx';
import { t } from '../shared/i18n.js';

const date = (sec) => new Date(sec * 1000).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });

/** The contracts EIP-7702 accounts usually delegate to, by name (any other one is shown by its address). */
const KNOWN_DELEGATES = {
  '0x63c0c19a282a1b52b07dd5a65b58948a07dae32b': 'MetaMask Smart Account', // EIP7702StatelessDeleGator
};

/** The line under a permission given to an ordinary account (no contract: how drainers collect). */
function SpenderNote({ kind }) {
  if (kind !== 'account' && kind !== 'delegated') return null;
  return <div style={{ marginTop: '0.25rem' }}>{rich(kind === 'delegated' ? 'sim.spender.delegated' : 'sim.spender.account')}</div>;
}

function ApprovalLine({ a }) {
  const spender = shortAddr(a.spender, 6);
  const sym = a.symbol || shortAddr(a.token);
  const coll = a.collection || shortAddr(a.token);
  if (a.revoke) return <div class="info small">{rich('sim.revoke', { spender, what: a.kind === 'all' || a.kind === 'nft' ? coll : sym })}</div>;
  const amount = a.unlimited || a.decimals == null ? null : `${fmtAmount(a.amount, a.decimals)} ${sym}`;
  let body;
  if (a.kind === 'all') body = rich('sim.approve.all', { spender, collection: coll });
  else if (a.kind === 'nft') body = rich('sim.approve.nft', { spender, collection: coll, id: String(a.id) });
  else if (a.unlimited) body = rich(a.kind === 'permit2' ? 'sim.approve.permit2Unlimited' : 'sim.approve.unlimited', { spender, symbol: sym });
  else body = rich(a.kind === 'permit2' ? 'sim.approve.permit2' : 'sim.approve.amount', { spender, amount: amount || String(a.amount), symbol: sym });
  const until = a.kind === 'permit2' && a.expiration > Date.now() / 1000 && a.expiration < Date.now() / 1000 + 10 * 365 * 86400 ? ` ${t('sim.until', { date: date(a.expiration) })}` : '';
  const strong = a.spenderKind === 'account' || a.spenderKind === 'delegated' || a.unlimited || a.kind === 'all';
  return <div class={`${strong ? 'error' : 'warn'} small`}>{body}{until}<SpenderNote kind={a.spenderKind} /></div>;
}

function ChangeRow({ c }) {
  const plus = c.delta > 0n;
  const abs = plus ? c.delta : -c.delta;
  const label = c.kind === 'nft'
    ? `${abs > 1n ? `${abs} × ` : ''}${t('sim.nft', { collection: c.collection || shortAddr(c.token), id: String(c.id) })}`
    : `${fmtAmount(abs, c.decimals ?? 0)} ${c.symbol || shortAddr(c.token)}`;
  return (
    <div class="row between small" style={{ gap: '0.5rem' }}>
      <span class={`bold ${plus ? 'green' : 'red'}`} style={{ overflowWrap: 'anywhere' }}>{plus ? '+' : '−'}{label}</span>
      {c.all && <span class="badge red">{t('sim.allBadge')}</span>}
      {c.most && <span class="badge red">{t('sim.mostBadge')}</span>}
    </div>
  );
}

/**
 * The simulated effects of a transaction a site asks for: balance changes, permissions it leaves, or that it would
 * fail. onRisk(level): 'ack' (a permission to an ordinary account: the user confirms), 'danger', or null.
 */
export function TxSimulation({ chain, tx, onRisk }) {
  const [res, setRes] = useState(undefined); // undefined: running; null: not available
  const [delegate, setDelegate] = useState(null);
  useEffect(() => {
    let live = true;
    (async () => {
      const call = await simulateTx(chain, tx).catch(() => null);
      const explained = call ? await explainCall(chain, analyzeCall(call, tx.from, { wrapped: wrappedNative(chain) }), tx.from).catch(() => null) : null;
      if (!live) return;
      setRes(explained);
      onRisk?.(riskOf(explained));
    })();
    rpc(chain, 'eth_getCode', [tx.from, 'latest']).then((code) => live && setDelegate(delegateOf(code))).catch(() => {});
    return () => { live = false; };
  }, []);

  const delegated = delegate && (
    <div class={`${KNOWN_DELEGATES[delegate.toLowerCase()] ? 'info' : 'warn'} small`}>
      {rich('sim.fromDelegated', { chain: chain.name, contract: KNOWN_DELEGATES[delegate.toLowerCase()] || shortAddr(delegate, 6) })}
    </div>
  );
  if (res === undefined) return <>{delegated}<div class="row small muted"><Spinner /> {t('sim.running')}</div></>;
  if (res === null) return <>{delegated}<div class="small muted">{t('sim.unavailable')}</div></>;
  if (res.failed) {
    return (
      <>
        {delegated}
        <div class="error small">{rich('sim.failed')}{res.reason && <div style={{ marginTop: '0.25rem' }}>{t('sim.failedReason', { reason: res.reason })}</div>}</div>
      </>
    );
  }
  const out = res.changes.filter((c) => c.delta < 0n), inc = res.changes.filter((c) => c.delta > 0n);
  return (
    <>
      {delegated}
      <div class="section-title">{t('sim.title')}</div>
      <div class="card col" style={{ gap: '0.375rem' }}>
        {[...out, ...inc].map((c) => <ChangeRow c={c} />)}
        {!res.changes.length && <div class="small muted">{t('sim.nothing')}</div>}
        <div class="tiny muted">{t('sim.note')}</div>
      </div>
      {res.approvals.map((a) => <ApprovalLine a={a} />)}
    </>
  );
}

/** What an address is (shared/simulate.js addressKind), looked up once: undefined while loading. */
export function useAddressKind(chain, address) {
  const [kind, setKind] = useState(undefined);
  useEffect(() => {
    if (!address) { setKind(null); return; }
    addressKind(chain, address).then(setKind).catch(() => setKind(null));
  }, [chain?.id, address]);
  return kind;
}

/** Symbols and decimals of a few tokens: Map address -> info (missing while loading or unknown). */
function useTokens(chain, addresses) {
  const [map, setMap] = useState(new Map());
  const key = addresses.join(',');
  useEffect(() => {
    let live = true;
    Promise.all(addresses.map((a) => getTokenInfo(chain, a).catch(() => null))).then((list) => live && setMap(new Map(addresses.map((a, i) => [a, list[i]]))));
    return () => { live = false; };
  }, [chain?.id, key]);
  return map;
}

/** Names of NFT collections: Map address -> name. */
function useCollections(chain, addresses) {
  const [map, setMap] = useState(new Map());
  const key = addresses.join(',');
  useEffect(() => {
    let live = true;
    multiCall(chain, addresses.map((a) => ({ to: a, data: erc20.encodeFunctionData('name') }))).then((res) => {
      if (!live) return;
      setMap(new Map(addresses.map((a, i) => { try { return [a, res[i] ? erc20.decodeFunctionResult('name', res[i])[0] : null]; } catch { return [a, null]; } })));
    }).catch(() => {});
    return () => { live = false; };
  }, [chain?.id, key]);
  return map;
}

/** A spending permit signature (shared/typedData.js readPermit). onRisk as TxSimulation's. */
export function PermitDetails({ chain, permit, onRisk }) {
  const spenderKind = useAddressKind(chain, permit.spender);
  const tokens = useTokens(chain, permit.items.map((i) => i.token).filter(Boolean));
  useEffect(() => {
    if (spenderKind === undefined) return;
    if (!permit.revoke && (spenderKind === 'account' || spenderKind === 'delegated')) onRisk?.('ack');
    else onRisk?.(permit.revoke ? null : 'danger');
  }, [spenderKind]);
  const spender = permit.spender ? shortAddr(permit.spender, 6) : t('approve.typed.anAddress');
  if (permit.revoke) return <div class="info small">{rich('approve.typed.revoke', { spender })}</div>;
  return (
    <div class="error small">
      {rich(permit.kind === 'permit2transfer' ? 'approve.typed.transferOnce' : 'approve.typed.permitSpend', { spender })}
      <ul style={{ margin: '0.375rem 0', paddingLeft: '1.125rem' }}>
        {permit.items.map((i) => {
          const tk = tokens.get(i.token);
          const sym = tk?.symbol || shortAddr(i.token);
          return <li>{i.unlimited ? rich('approve.typed.unlimitedOf', { symbol: sym }) : <b>{tk ? fmtAmount(i.amount, tk.decimals) : String(i.amount)} {sym}</b>}</li>;
        })}
      </ul>
      {permit.at != null && <div>{t(permit.kind === 'permit2transfer' ? 'approve.typed.deadline' : 'approve.typed.until', { date: date(permit.at) })}</div>}
      {permit.never && <div>{t('approve.typed.never')}</div>}
      <div style={{ marginTop: '0.25rem' }}>{t('approve.typed.permitRisk')}</div>
      <SpenderNote kind={spenderKind} />
    </div>
  );
}

/** A Seaport order (shared/typedData.js readSeaport): what leaves, what comes back. */
export function SeaportDetails({ chain, order, onRisk }) {
  const all = [...order.give, ...order.get, ...order.toOthers];
  const tokens = useTokens(chain, [...new Set(all.filter((i) => i.type === 1).map((i) => i.token))]);
  const colls = useCollections(chain, [...new Set(all.filter((i) => i.nft).map((i) => i.token))]);
  useEffect(() => { onRisk?.(order.free ? 'ack' : 'danger'); }, []);
  const line = (i) => {
    if (i.nft) {
      const c = colls.get(i.token) || shortAddr(i.token);
      return i.criteria ? t('approve.seaport.anyOf', { collection: c }) : `${i.amount > 1n ? `${i.amount} × ` : ''}${t('sim.nft', { collection: c, id: String(i.id) })}`;
    }
    if (i.type === 0) return `${fmtAmount(i.amount, chain.native.decimals)} ${chain.native.symbol}`;
    const tk = tokens.get(i.token);
    return `${tk ? fmtAmount(i.amount, tk.decimals) : String(i.amount)} ${tk?.symbol || shortAddr(i.token)}`;
  };
  const list = (items) => (items.length ? items.map((i) => <div class="v">{line(i)}{i.recipient ? <span class="tiny muted"> → {shortAddr(i.recipient)}</span> : null}</div>) : <div class="v muted">{t('approve.seaport.nothing')}</div>);
  return (
    <>
      {order.free && <div class="error small">{rich('approve.seaport.free')}</div>}
      <div class="card kv small">
        <span class="k">{t('approve.seaport.give')}</span><div>{list(order.give)}</div>
        <span class="k">{t('approve.seaport.get')}</span><div>{list(order.get)}</div>
        {order.toOthers.length > 0 && <><span class="k">{t('approve.seaport.others')}</span><div>{list(order.toOthers)}</div></>}
      </div>
    </>
  );
}

/**
 * EIP-7702 delegations of an account on the main networks: the contract whose code it runs on each one. Nothing
 * shown when there are none (the usual case).
 */
export function Delegations({ address }) {
  const [list, setList] = useState([]);
  useEffect(() => {
    let live = true;
    const chains = BUILTIN_CHAINS.filter((c) => !c.testnet);
    Promise.all(chains.map((c) => rpc(c, 'eth_getCode', [address, 'latest']).then(delegateOf).catch(() => null)))
      .then((res) => live && setList(chains.map((c, i) => ({ chain: c, to: res[i] })).filter((x) => x.to)));
    return () => { live = false; };
  }, [address]);
  if (!list.length) return null;
  const unknown = list.some((x) => !KNOWN_DELEGATES[x.to.toLowerCase()]);
  return (
    <div class={`${unknown ? 'warn' : 'info'} small`} style={{ textAlign: 'left', width: '100%' }}>
      <div class="bold" style={{ marginBottom: '0.25rem' }}>{t('accounts.delegation.title')}</div>
      {list.map(({ chain, to }) => {
        const name = KNOWN_DELEGATES[to.toLowerCase()];
        const link = explorerAddr(chain, to);
        // the network, then the contract (by name, or its address); the explorer link on the right, never wrapped
        return (
          <div class="row" style={{ gap: '0.5rem', margin: '0.375rem 0' }}>
            <ChainIcon chain={chain} size={22} />
            <div class="grow" style={{ minWidth: 0 }}>
              <div class="bold">{chain.name}</div>
              <div class={name ? '' : 'mono'}>{name || shortAddr(to, 6)}</div>
            </div>
            {link && <a href={link} target="_blank" rel="noreferrer" class="row tiny" style={{ gap: '0.25rem', whiteSpace: 'nowrap', flexShrink: 0 }}><Icon name="external" size={12} /> {t('common.explorer')}</a>}
          </div>
        );
      })}
      <div style={{ marginTop: '0.25rem' }}>{t(unknown ? 'accounts.delegation.unknown' : 'accounts.delegation.known')}</div>
    </div>
  );
}
