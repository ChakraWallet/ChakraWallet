// Review of a contract transaction (a call, or a deployment): simulation first, warnings for risky functions,
// fees, signature through the usual authorisation, then the receipt with the decoded events.
import { useEffect, useState } from 'preact/hooks';
import { Icon, Spinner, Btn, FeeBox, useApp, explorerTx, explorerAddr, SuccessMark, ChainIcon } from '../../components.jsx';
import { prepareTx, finalizeTx } from '../../../shared/tx.js';
import { rpc, waitForReceipt } from '../../../shared/rpc.js';
import { simulate, decodeRevert } from '../../../shared/contracts.js';
import { toHex } from '../../../shared/chains.js';
import { bg } from '../../../shared/ext.js';
import { fmtAmount, shortAddr } from '../../../shared/format.js';
import { useNativePrice } from '../../hooks.js';
import { t } from '../../../shared/i18n.js';
import { RevertView, ValueNode } from './abiForm.jsx';
import { display } from '../../../shared/abiInput.js';

const MAX_HALF = 1n << 255n;

/** Warnings for what a call can do to the user's funds or to the contract. */
export function risksOf(req, account) {
  const out = [];
  const n = (req.fn?.name || '').toLowerCase();
  const a = req.args || [];
  if (req.fn?.guessed || req.fn?.unknown || req.fn?.custom) out.push(['amber', req.fn?.custom ? 'custom' : 'guessed']);
  if ((n === 'approve' || n === 'increaseallowance') && typeof a[1] === 'bigint') out.push(['red', a[1] >= MAX_HALF ? 'unlimited' : 'approve']);
  if (n === 'setapprovalforall' && a[1] === true) out.push(['red', 'approvalForAll']);
  if (n === 'permit') out.push(['red', 'permit']);
  if (n === 'transferownership' || n === 'renounceownership' || n === 'beginownershiptransfer' || n === 'changeadmin') {
    if (!(n === 'transferownership' && typeof a[0] === 'string' && a[0].toLowerCase() === account.toLowerCase())) out.push(['red', n === 'renounceownership' ? 'renounce' : 'ownership']);
  }
  if (/^upgrade(to|toandcall)?$/.test(n)) out.push(['red', 'upgrade']);
  if (/selfdestruct|destroy|kill/.test(n)) out.push(['red', 'destroy']);
  return out;
}

/**
 * req: { kind: 'call' | 'deploy', to?, data, value (bigint), title, fn?, args?, iface?, name? }
 * onMined(receipt, hash) after a successful receipt; renderDone(receipt) adds content to the final screen.
 */
export function TxReview({ chain, req, onBack, onMined, renderDone, onOpenContract }) {
  const { account, authorize } = useApp();
  const price = useNativePrice(chain);
  const [prepared, setPrepared] = useState(null);
  const [speed, setSpeed] = useState('normal');
  const [sim, setSim] = useState(null);
  const [bal, setBal] = useState(null);
  const [err, setErr] = useState('');
  const [ack, setAck] = useState(false);
  const [sending, setSending] = useState(false);
  const [hash, setHash] = useState('');
  const [receipt, setReceipt] = useState(null);
  const value = req.value || 0n;

  useEffect(() => {
    prepareTx(chain, account.address, { to: req.to, value: toHex(value), data: req.data }).then(setPrepared).catch((e) => setErr(e.message));
    simulate(chain, { from: account.address, to: req.to, data: req.data, value })
      .then(async (r) => setSim(r.ok ? r : { ...r, decoded: r.revert != null ? await decodeRevert(r.revert, req.iface) : null }))
      .catch((e) => setSim({ ok: false, message: e.message }));
    rpc(chain, 'eth_getBalance', [account.address, 'latest']).then((b) => setBal(BigInt(b))).catch(() => {});
  }, []);

  const risks = risksOf(req, account.address);
  const need = prepared ? BigInt(prepared.speeds[speed].maxCost) + value : 0n;
  const insufficient = bal != null && prepared && need > bal;
  const simFailed = sim && !sim.ok;

  const confirm = async () => {
    setErr(''); setSending(true);
    try {
      const tx = finalizeTx(prepared, speed);
      const h = await authorize((password) => bg('sendTransaction', { from: account.address, tx, title: req.title, password }), t('contracts.tx.confirmTitle'));
      setHash(h);
      const r = await waitForReceipt(chain, h, 600000);
      setReceipt(r);
      if (r.status === '0x1') await onMined?.(r, h);
    } catch (e) { if (!e.cancelled) setErr(e.message); }
    setSending(false);
  };

  if (hash) {
    const ok = receipt?.status === '0x1';
    const link = explorerTx(chain, hash);
    const logs = receipt && req.iface ? receipt.logs.map((l) => { try { return req.iface.parseLog(l); } catch { return null; } }).filter(Boolean) : [];
    return (
      <div class="screen">
        <div class="topbar"><button class="iconbtn" onClick={onBack} title={t('common.back')}><Icon name="back" /></button><h1>{req.title}</h1></div>
        <div class="content">
          <div class="card col ct-done">
            {!receipt ? <><Spinner lg /><b>{t('contracts.tx.pending')}</b><span class="small muted">{t('contracts.tx.pendingSub')}</span></>
              : ok ? <><SuccessMark /><b>{req.kind === 'deploy' ? t('contracts.tx.deployed') : t('contracts.tx.done')}</b></>
                : <><span class="ct-fail"><Icon name="close" size={28} /></span><b>{t('contracts.tx.failed')}</b><span class="small muted">{t('contracts.tx.failedSub')}</span></>}
            {link && <a href={link} target="_blank" class="btn secondary sm"><Icon name="external" size={14} /> {t('send.viewOnExplorer')}</a>}
          </div>
          {receipt && (
            <div class="card kv">
              <span class="k">{t('contracts.tx.block')}</span><span class="v">{Number(BigInt(receipt.blockNumber))}</span>
              <span class="k">{t('contracts.tx.gasUsed')}</span><span class="v">{BigInt(receipt.gasUsed).toString()}</span>
              {receipt.contractAddress && <><span class="k">{t('contracts.tx.address')}</span><span class="v mono">{receipt.contractAddress}</span></>}
            </div>
          )}
          {ok && receipt.contractAddress && onOpenContract && <Btn onClick={() => onOpenContract(receipt.contractAddress)}><Icon name="code" size={18} /> {t('contracts.tx.openContract')}</Btn>}
          {ok && renderDone?.(receipt)}
          {logs.length > 0 && (
            <div class="card col">
              <b class="small">{t('contracts.tx.events')}</b>
              {logs.map((l) => (
                <div class="ct-event">
                  <span class="mono small bold">{l.name}</span>
                  {l.fragment.inputs.map((p, i) => <ValueNode n={display(p, l.args[i])} />)}
                </div>
              ))}
            </div>
          )}
          {err && <div class="error">{err}</div>}
        </div>
        <div class="footer"><Btn kind="secondary" onClick={onBack}>{t('contracts.tx.close')}</Btn></div>
      </div>
    );
  }

  return (
    <div class="screen">
      <div class="topbar"><button class="iconbtn" onClick={onBack} title={t('common.back')}><Icon name="back" /></button><h1>{t('contracts.tx.reviewTitle')}</h1></div>
      <div class="content">
        <div class="card col ct-what">
          <span class="small muted">{req.kind === 'deploy' ? t('contracts.tx.deploying') : t('contracts.tx.calling')}</span>
          <b class="ct-what-name mono">{req.kind === 'deploy' ? req.name || t('contracts.tx.newContract') : req.fn?.custom ? t('contracts.custom.title') : req.fn?.name || req.data.slice(0, 10)}</b>
          {req.args?.length > 0 && req.fn?.inputs && (
            <div class="ct-args">{req.fn.inputs.map((p, i) => <ValueNode n={display(p, req.args[i])} />)}</div>
          )}
        </div>
        <div class="card kv">
          <span class="k">{t('contracts.tx.from')}</span><span class="v">{account.name} ({shortAddr(account.address)})</span>
          {req.to && <><span class="k">{t('contracts.tx.contract')}</span><span class="v mono">{req.to}</span></>}
          <span class="k">{t('contracts.tx.network')}</span><span class="v"><span class="row" style={{ justifyContent: 'flex-end', gap: '.375rem' }}><ChainIcon chain={chain} size={18} />{chain.name}</span></span>
          {value > 0n && <><span class="k">{t('contracts.tx.value')}</span><span class="v bold">{fmtAmount(value, chain.native.decimals, 8)} {chain.native.symbol}</span></>}
          {req.kind === 'deploy' && <><span class="k">{t('contracts.tx.size')}</span><span class="v">{t('contracts.bytes', { n: ((req.data.length - 2) / 2).toLocaleString() })}</span></>}
        </div>
        {risks.map(([tone, k]) => <div class={tone === 'red' ? 'error' : 'warn'}><b>{t('common.attention')}</b> {t(`contracts.risk.${k}`)}</div>)}
        {sim == null ? <div class="info row"><Spinner /> {t('contracts.tx.simulating')}</div>
          : sim.ok ? <div class="success">{t('contracts.tx.simOk')}</div>
            : <RevertView r={sim.decoded} message={sim.message} />}
        <FeeBox chain={chain} prepared={prepared} speed={speed} setSpeed={setSpeed} nativePrice={price} valueWei={value} />
        {insufficient && <div class="error">{t('send.insufficientNative', { symbol: chain.native.symbol })}</div>}
        {simFailed && (
          <label class="ack row small"><input type="checkbox" checked={ack} onChange={(e) => setAck(e.target.checked)} /> {t('contracts.tx.sendAnyway')}</label>
        )}
        {err && <div class="error">{err}</div>}
      </div>
      <div class="footer">
        <Btn kind="secondary" onClick={onBack}>{t('common.back')}</Btn>
        <Btn kind={simFailed || risks.some(([x]) => x === 'red') ? 'danger' : 'primary'} loading={sending}
          disabled={!prepared || insufficient || sim == null || (simFailed && !ack)} onClick={confirm}>
          {req.kind === 'deploy' ? t('contracts.tx.deploy') : t('contracts.tx.sign')}
        </Btn>
      </div>
    </div>
  );
}

export { explorerAddr };
