// Review of a message to a TON contract (a call or a deployment): emulation first (every transaction of the chain,
// bounces, cost), warnings, signature with the usual authorisation, then the chain of transactions followed until
// it ends - on TON the wallet accepting the message isn't enough to know how it went.
import { useEffect, useState } from 'preact/hooks';
import { Icon, Spinner, Btn, ChainIcon, SuccessMark, useApp } from '../../../components.jsx';
import { bg } from '../../../../shared/ext.js';
import { fmtAmount, shortAddr } from '../../../../shared/format.js';
import { t } from '../../../../shared/i18n.js';
import { emulateMessages, followSend, showAddress } from '../../../../shared/ton/contracts.js';
import { tonTxUrl } from '../../../../shared/ton/api.js';
import { saveContract } from '../../../contractsStore.js';
import { StepsView, useTonWalletFor, Loading } from './parts.jsx';

const FEE_MARGIN = 20_000_000n; // 0.02 GRAM for the wallet's own fees when the emulation can't say

/**
 * req: { title, messages: [{ to, value, bounce, body?, init? }], summary: [[label, value]], risks: [],
 *        contract?: { address, name }, deploy?: { address, name, kind } }
 */
export function TonTxReview({ chain, req, onBack, onMined, onOpenContract }) {
  const { account, authorize, setPortfolioCache } = useApp();
  const wallet = useTonWalletFor(chain);
  const [sim, setSim] = useState(null);
  const [simErr, setSimErr] = useState('');
  const [ack, setAck] = useState(false);
  const [sending, setSending] = useState(false);
  const [err, setErr] = useState('');
  const [sent, setSent] = useState(null); // { phase, trace, txHash }

  useEffect(() => {
    if (!wallet) return;
    emulateMessages(chain, wallet, req.messages).then(setSim).catch((e) => setSimErr(e.message || 'emulation'));
  }, [!!wallet]);

  const total = req.messages.reduce((s, m) => s + BigInt(m.value), 0n);
  const cost = sim && sim.net < 0n ? -sim.net : total + FEE_MARGIN;
  const insufficient = sim && sim.balance < total + FEE_MARGIN;
  const risks = [...(req.risks || [])];
  if (sim?.risk?.transfer_all_remaining_balance) risks.push('drain');
  if (sim && sim.balance > 0n && total * 2n > sim.balance) risks.push('bigValue');
  const simFailed = !!simErr || (sim && !sim.ok);
  const red = risks.some((r) => r === 'renounce' || r === 'drain' || r === 'burn');

  const confirm = async () => {
    setErr(''); setSending(true);
    try {
      const r = await authorize((password) => bg('tonSend', { from: account.address, chainId: chain.id, messages: req.messages, password }), t('tonc.review.confirmTitle'));
      setSent({ phase: 'sent' });
      // the wallet home reloads this network's balances next time (shared cache, same key as usePortfolio)
      setPortfolioCache((c) => { const n = { ...c }; delete n[`${chain.id}:${account.address}`]; return n; });
      followSend(chain, r, (u) => setSent((s) => ({ ...s, ...u })))
        .then(async (res) => {
          const ok = res.trace ? res.trace.ok && !res.trace.bounced : true;
          setSent((s) => ({ ...s, phase: res.trace?.complete ? 'done' : 'late', txHash: res.txHash, trace: res.trace || s.trace }));
          if (ok && req.deploy) await saveContract({ chainId: chain.id, address: req.deploy.address, name: req.deploy.name, mine: true, kind: req.deploy.kind, ...(req.deploy.tact ? { tact: req.deploy.tact } : {}) });
          if (ok) onMined?.();
        })
        .catch(() => setSent((s) => ({ ...s, phase: 'late' })));
    } catch (e) { if (!e.cancelled) setErr(e.message); }
    setSending(false);
  };

  if (sent) return <Done chain={chain} req={req} sent={sent} wallet={wallet} onBack={onBack} onOpenContract={onOpenContract} />;

  return (
    <div class="screen">
      <div class="topbar"><button class="iconbtn" onClick={onBack} title={t('common.back')}><Icon name="back" /></button><h1>{t('contracts.tx.reviewTitle')}</h1></div>
      <div class="content">
        <div class="card col ct-what">
          <span class="small muted">{req.deploy ? t('contracts.tx.deploying') : t('tonc.review.sending')}</span>
          <b class="ct-what-name">{req.title}</b>
          {req.summary?.length > 0 && <div class="ct-args">{req.summary.map(([k, v]) => <div class="tiny"><span class="muted">{k}</span> <span class="mono" style={{ wordBreak: 'break-all' }}>{String(v)}</span></div>)}</div>}
        </div>
        <div class="card kv">
          <span class="k">{t('contracts.tx.from')}</span><span class="v">{account.name}{wallet ? ` (${shortAddr(wallet.address, 4)})` : ''}</span>
          <span class="k">{req.deploy ? t('contracts.tx.address') : t('contracts.tx.contract')}</span><span class="v mono tiny" style={{ wordBreak: 'break-all' }}>{showAddress(req.deploy?.address || req.messages[0].to, { testnet: chain.testnet })}</span>
          <span class="k">{t('contracts.tx.network')}</span><span class="v"><span class="row" style={{ justifyContent: 'flex-end', gap: '.375rem' }}><ChainIcon chain={chain} size={18} />{chain.name}</span></span>
          <span class="k">{t('tonc.review.attached')}</span><span class="v bold">{fmtAmount(total, 9, 6)} {chain.native.symbol}</span>
          {req.messages.length > 1 && <><span class="k">{t('tonc.review.messages')}</span><span class="v">{req.messages.length}</span></>}
          {sim && <><span class="k">{t('tonc.review.cost')}</span><span class="v">≈ {fmtAmount(cost, 9, 6)} {chain.native.symbol}</span></>}
          {sim && <><span class="k">{t('tonc.balance')}</span><span class="v">{fmtAmount(sim.balance, 9, 4)} {chain.native.symbol}</span></>}
        </div>
        {sim && <div class="tiny muted">{t('tonc.review.costHint')}</div>}
        {risks.map((k) => <div class={k === 'renounce' || k === 'drain' || k === 'burn' ? 'error' : 'warn'}><b>{t('common.attention')}</b> {t(`tonc.risk.${k}`)}</div>)}
        {wallet === null && <div class="error">{t('tonc.write.noKey')}</div>}
        {wallet && !sim && !simErr && <Loading text={t('tonc.review.emulating')} />}
        {simErr && <div class="warn">{t('tonc.review.simUnavailable')}</div>}
        {sim && (
          <div class="card col">
            <div class={sim.bounced ? 'warn' : sim.ok ? 'success' : 'error'}>{sim.bounced ? t('tonc.review.simBounced') : sim.ok ? t('tonc.review.simOk') : t('tonc.review.simFailed')}</div>
            <StepsView steps={sim.steps} wallet={sim.wallet} chain={chain} />
          </div>
        )}
        {insufficient && <div class="error">{t('send.insufficientNative', { symbol: chain.native.symbol })}</div>}
        {simFailed && wallet && (
          <label class="ack row small"><input type="checkbox" checked={ack} onChange={(e) => setAck(e.target.checked)} /> {t('contracts.tx.sendAnyway')}</label>
        )}
        {err && <div class="error">{err}</div>}
      </div>
      <div class="footer">
        <Btn kind="secondary" onClick={onBack}>{t('common.back')}</Btn>
        <Btn kind={simFailed || red ? 'danger' : 'primary'} loading={sending}
          disabled={!wallet || (!sim && !simErr) || insufficient || (simFailed && !ack)} onClick={confirm}>
          {req.deploy ? t('contracts.tx.deploy') : t('contracts.tx.sign')}
        </Btn>
      </div>
    </div>
  );
}

function Done({ chain, req, sent, wallet, onBack, onOpenContract }) {
  const tr = sent.trace;
  const link = tonTxUrl(chain, sent.txHash);
  const finished = sent.phase === 'done';
  const state = !finished ? 'pending' : !tr ? 'ok' : tr.bounced ? 'bounced' : tr.ok ? 'ok' : 'failed';
  return (
    <div class="screen">
      <div class="topbar"><button class="iconbtn" onClick={onBack} title={t('common.back')}><Icon name="back" /></button><h1>{req.title}</h1></div>
      <div class="content">
        <div class="card col ct-done">
          {state === 'pending' ? (
            <>
              {sent.phase === 'late' ? <Icon name="history" size={28} /> : <Spinner lg />}
              <b>{sent.phase === 'late' ? t('tonc.done.late') : sent.phase === 'trace' ? t('tonc.done.tracing') : t('contracts.tx.pending')}</b>
              <span class="small muted">{sent.phase === 'late' ? t('tonc.done.lateSub') : t('tonc.done.pendingSub')}</span>
            </>
          ) : state === 'ok' ? <><SuccessMark /><b>{req.deploy ? t('contracts.tx.deployed') : t('tonc.done.ok')}</b></>
            : state === 'bounced' ? <><span class="ct-fail amber"><Icon name="back" size={28} /></span><b>{t('tonc.done.bounced')}</b><span class="small muted">{t('tonc.done.bouncedSub')}</span></>
              : <><span class="ct-fail"><Icon name="close" size={28} /></span><b>{t('contracts.tx.failed')}</b><span class="small muted">{t('tonc.done.failedSub')}</span></>}
          {link && <a href={link} target="_blank" class="btn secondary sm"><Icon name="external" size={14} /> {t('send.viewOnExplorer')}</a>}
        </div>
        {tr && <div class="card col"><b class="small">{t('tonc.done.steps')}</b><StepsView steps={tr.steps} wallet={wallet?.raw} chain={chain} /></div>}
        {state === 'ok' && req.deploy && onOpenContract && <Btn onClick={() => onOpenContract(req.deploy.address)}><Icon name="code" size={18} /> {t('contracts.tx.openContract')}</Btn>}
      </div>
      <div class="footer"><Btn kind="secondary" onClick={onBack}>{t('contracts.tx.close')}</Btn></div>
    </div>
  );
}
