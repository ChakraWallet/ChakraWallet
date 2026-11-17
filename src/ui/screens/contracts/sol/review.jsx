// Review of a Solana transaction from the Contracts tab (a program's instruction, a token or NFT created or managed):
// simulation first (does it succeed, what it costs, how the wallet's SOL changes), warnings, the signature with the
// usual authorisation, then the confirmation.
import { useEffect, useState } from 'preact/hooks';
import { Icon, Spinner, Btn, ChainIcon, SuccessMark, useApp } from '../../../components.jsx';
import { shortAddr } from '../../../../shared/format.js';
import { t } from '../../../../shared/i18n.js';
import { solTxUrl, solBalance } from '../../../../shared/solana/api.js';
import { saveContract } from '../../../contractsStore.js';
import { plan, sendInstructions } from '../../../solana/tx.js';
import { useSolWalletFor, solText, Loading } from './parts.jsx';
import { SimView } from './form.jsx';

/**
 * req: { title, instructions, summary: [[label, value]], risks: [], extraSeeds?: [32-byte keys of new accounts],
 *        idl?, deploy?: { address, name, kind, idl? } (saved as the user's own once confirmed), extraCost?: lamports }
 */
export function SolTxReview({ chain, req, onBack, onMined, onOpenContract }) {
  const { account, authorize, setPortfolioCache } = useApp();
  const wallet = useSolWalletFor(chain);
  const [sim, setSim] = useState(null);
  const [balance, setBalance] = useState(null);
  const [ack, setAck] = useState(false);
  const [sending, setSending] = useState(false);
  const [err, setErr] = useState('');
  const [sent, setSent] = useState(null); // { hash, phase: 'sent' | 'ok' | 'failed' | 'late', error }

  useEffect(() => {
    if (!wallet) return;
    const signers = 1 + (req.extraSeeds?.length || 0);
    plan(chain, { payer: wallet.raw, instructions: req.instructions, signers, accounts: [wallet.raw] })
      .then(setSim).catch((e) => setSim({ problem: e.message, logs: [], fee: null }));
    solBalance(chain, wallet.raw).then(setBalance).catch(() => {});
  }, [!!wallet]);

  // the wallet's SOL after the transaction (the simulation's state of the account), fees apart
  const after = sim?.sim?.accounts?.[0]?.lamports != null ? BigInt(sim.sim.accounts[0].lamports) : null;
  const spent = after != null && balance != null ? balance - after : null;
  const insufficient = balance != null && sim?.fee != null && balance < sim.fee + (req.extraCost || 0n);
  const failed = !!sim?.problem;
  const risks = req.risks || [];
  const red = risks.some((r) => r === 'renounce' || r === 'close' || r === 'burn');

  const confirm = async () => {
    setErr(''); setSending(true);
    try {
      const r = await sendInstructions(chain, {
        account, payer: wallet.raw, instructions: req.instructions, limit: sim.limit, price: sim.price, extraSeeds: req.extraSeeds || [],
        auth: (fn) => authorize(fn, t('solc.review.confirmTitle')), title: req.title,
      });
      setSent({ hash: r.hash, phase: 'sent' });
      setPortfolioCache((c) => { const n = { ...c }; delete n[`${chain.id}:${account.address}`]; return n; });
      r.wait.then(async () => {
        setSent((s) => ({ ...s, phase: 'ok' }));
        if (req.deploy) await saveContract({ chainId: chain.id, address: req.deploy.address, name: req.deploy.name, mine: true, kind: req.deploy.kind, ...(req.deploy.idl ? { abi: req.deploy.idl } : {}) });
        onMined?.();
      }).catch((e) => setSent((s) => ({ ...s, phase: e.code === 'late' ? 'late' : 'failed', error: e.message })));
    } catch (e) { if (!e.cancelled) setErr(e.message); }
    setSending(false);
  };

  if (sent) return <Done chain={chain} req={req} sent={sent} onBack={onBack} onOpenContract={onOpenContract} />;

  const target = req.deploy?.address || req.instructions[req.instructions.length - 1]?.programId;
  return (
    <div class="screen">
      <div class="topbar"><button class="iconbtn" onClick={onBack} title={t('common.back')}><Icon name="back" /></button><h1>{t('contracts.tx.reviewTitle')}</h1></div>
      <div class="content">
        <div class="card col ct-what">
          <span class="small muted">{req.deploy ? t('solc.review.creating') : t('solc.review.calling')}</span>
          <b class="ct-what-name">{req.title}</b>
          {req.summary?.length > 0 && <div class="ct-args">{req.summary.map(([k, v]) => <div class="tiny"><span class="muted">{k}</span> <span class="mono" style={{ wordBreak: 'break-all' }}>{String(v)}</span></div>)}</div>}
        </div>
        <div class="card kv">
          <span class="k">{t('contracts.tx.from')}</span><span class="v">{account.name}{wallet ? ` (${shortAddr(wallet.address, 4)})` : ''}</span>
          <span class="k">{req.deploy ? t('contracts.tx.address') : t('solc.review.program')}</span><span class="v mono tiny" style={{ wordBreak: 'break-all' }}>{target}</span>
          <span class="k">{t('contracts.tx.network')}</span><span class="v"><span class="row" style={{ justifyContent: 'flex-end', gap: '.375rem' }}><ChainIcon chain={chain} size={18} />{chain.name}</span></span>
          {sim?.fee != null && <><span class="k">{t('solc.review.fee')}</span><span class="v">{solText(sim.fee, chain, 6)}</span></>}
          {spent != null && spent > 0n && <><span class="k">{t('solc.review.spent')}</span><span class="v bold">{solText(spent, chain, 6)}</span></>}
          {spent != null && spent < 0n && <><span class="k">{t('solc.review.received')}</span><span class="v bold">{solText(-spent, chain, 6)}</span></>}
          {balance != null && <><span class="k">{t('solc.balance')}</span><span class="v">{solText(balance, chain, 4)}</span></>}
        </div>
        {spent != null && spent > (sim?.fee || 0n) && <div class="tiny muted">{t('solc.review.rentHint')}</div>}
        {risks.map((k) => <div class={k === 'renounce' || k === 'close' || k === 'burn' ? 'error' : 'warn'}><b>{t('common.attention')}</b> {t(`solc.risk.${k}`)}</div>)}
        {wallet === null && <div class="error">{t('solc.noKey')}</div>}
        {wallet && !sim && <Loading text={t('solc.review.simulating')} />}
        {sim && <div class="card col"><SimView sim={sim} idl={req.idl} /></div>}
        {insufficient && <div class="error">{t('send.insufficientNative', { symbol: chain.native.symbol })}</div>}
        {failed && wallet && <label class="ack row small"><input type="checkbox" checked={ack} onChange={(e) => setAck(e.target.checked)} /> {t('contracts.tx.sendAnyway')}</label>}
        {err && <div class="error">{err}</div>}
      </div>
      <div class="footer">
        <Btn kind="secondary" onClick={onBack}>{t('common.back')}</Btn>
        <Btn kind={failed || red ? 'danger' : 'primary'} loading={sending} disabled={!wallet || !sim || sim.limit == null || insufficient || (failed && !ack)} onClick={confirm}>
          {req.deploy ? t('solc.review.create') : t('contracts.tx.sign')}
        </Btn>
      </div>
    </div>
  );
}

function Done({ chain, req, sent, onBack, onOpenContract }) {
  const link = solTxUrl(chain, sent.hash);
  return (
    <div class="screen">
      <div class="topbar"><button class="iconbtn" onClick={onBack} title={t('common.back')}><Icon name="back" /></button><h1>{req.title}</h1></div>
      <div class="content">
        <div class="card col ct-done">
          {sent.phase === 'sent' ? <><Spinner lg /><b>{t('contracts.tx.pending')}</b><span class="small muted">{t('solc.done.pendingSub')}</span></>
            : sent.phase === 'ok' ? <><SuccessMark /><b>{req.deploy ? t('solc.done.created') : t('solc.done.ok')}</b></>
              : sent.phase === 'late' ? <><Icon name="history" size={28} /><b>{t('solc.done.late')}</b></>
                : <><span class="ct-fail"><Icon name="close" size={28} /></span><b>{t('contracts.tx.failed')}</b><span class="small muted">{sent.error}</span></>}
          {link && <a href={link} target="_blank" class="btn secondary sm"><Icon name="external" size={14} /> {t('send.viewOnExplorer')}</a>}
        </div>
        {sent.phase === 'ok' && req.deploy && onOpenContract && <Btn onClick={() => onOpenContract(req.deploy.address)}><Icon name="code" size={18} /> {t('solc.done.open')}</Btn>}
      </div>
      <div class="footer"><Btn kind="secondary" onClick={onBack}>{t('contracts.tx.close')}</Btn></div>
    </div>
  );
}
