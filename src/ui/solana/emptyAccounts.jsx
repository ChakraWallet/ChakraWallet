// Solana's piece of the wallet home: the empty token accounts. Each one holds its rent (about 0.002 SOL) for a token
// the wallet no longer has; closing them gives that SOL back. A row appears when there are some; it opens a sheet
// that explains it and closes them, twenty per transaction, with one authorisation. An account that can't be closed
// (e.g. a Token-2022 account still holding withheld fees) is left as it is.
import { useState } from 'preact/hooks';
import { Icon, Btn, Sheet, useApp } from '../components.jsx';
import { t, tn } from '../../shared/i18n.js';
import { fmtNum } from '../../shared/format.js';
import { token as tokenIx } from '../../shared/solana/tx.js';
import { solBalance } from '../../shared/solana/api.js';
import { sol } from '../../shared/solana/core.js';
import { useOperationAuth } from '../steps.js';
import { plan, sendInstructions } from './tx.js';
import { useSolWallet } from './hooks.js';

const RENT = 2_039_280n; // a token account's rent (Token-2022 accounts with extensions hold a little more)
const PER_TX = 20;

export function SolHomeExtra({ chain, data, reload }) {
  const { account, toast, setPortfolioCache } = useApp();
  const wallet = useSolWallet();
  const auth = useOperationAuth(t('sol.empty.authTitle'));
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState('');
  const [err, setErr] = useState('');
  const list = data?.empty || [];
  if (!list.length || !wallet) return null;
  const about = fmtNum(sol(BigInt(list.length) * RENT), 4);

  const run = async () => {
    setErr('');
    const me = wallet.raw;
    const before = await solBalance(chain, me).catch(() => null);
    let closed = 0;
    try {
      const batches = [];
      for (let i = 0; i < list.length; i += PER_TX) batches.push(list.slice(i, i + PER_TX));
      for (let b = 0; b < batches.length; b++) {
        setBusy(t('sol.empty.progress', { done: closed, total: list.length }));
        let ixs = batches[b].map((e) => tokenIx.closeAccount({ account: e.account, destination: me, owner: me, program: e.program }));
        let p = await plan(chain, { payer: me, instructions: ixs });
        if (p.problem) { // some can't be closed: try them one by one and keep the others
          const ok = [];
          for (const ix of ixs) if (!(await plan(chain, { payer: me, instructions: [ix] })).problem) ok.push(ix);
          ixs = ok;
          if (!ixs.length) continue;
          p = await plan(chain, { payer: me, instructions: ixs });
          if (p.problem) continue;
        }
        const r = await sendInstructions(chain, {
          account, payer: me, instructions: ixs, limit: p.limit, price: p.price, title: t('sol.empty.authTitle'),
          auth: (fn) => auth(fn, b < batches.length - 1),
        });
        await r.wait;
        closed += ixs.length;
      }
      const after = await solBalance(chain, me).catch(() => null);
      const got = before != null && after != null && after > before ? after - before : null;
      toast(got != null ? tn('sol.empty.done', closed, { amount: fmtNum(sol(got), 4), symbol: chain.native.symbol }) : tn('sol.empty.doneCount', closed));
      setPortfolioCache((c) => { const n = { ...c }; delete n[`${chain.id}:${account.address}`]; return n; });
      setOpen(false);
      reload?.();
    } catch (e) {
      if (!e.cancelled) setErr(closed ? `${e.message} ${tn('sol.empty.partial', closed)}` : e.message);
    }
    setBusy('');
  };

  return (
    <>
      <button class="item card flat" onClick={() => setOpen(true)}>
        <Icon name="coins" size={18} />
        <div class="grow small">{tn('sol.empty.row', list.length, { amount: about, symbol: chain.native.symbol })}</div>
        <Icon name="chevron" size={14} />
      </button>
      {open && (
        <Sheet title={t('sol.empty.title')} onClose={() => !busy && setOpen(false)}>
          <div class="small">{tn('sol.empty.body', list.length, { amount: about, symbol: chain.native.symbol })}</div>
          <div class="info small">{t('sol.empty.info')}</div>
          {busy && <div class="small muted">{busy}</div>}
          {err && <div class="error">{err}</div>}
          <Btn loading={!!busy} onClick={run}>{tn('sol.empty.button', list.length)}</Btn>
        </Sheet>
      )}
    </>
  );
}
