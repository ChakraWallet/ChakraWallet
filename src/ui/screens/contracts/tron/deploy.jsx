// Deploying a compiled Solidity contract on Tron (Contracts tab, from the studio's Deploy screen): a CreateSmartContract
// with the bytecode, the constructor's arguments and the ABI (so it can be read later), the callers paying the
// energy of their own calls. Deployments cost a lot of energy: the estimate and the TRX it would burn are shown before
// signing; then the new contract is saved and opened.
import { useEffect, useState } from 'preact/hooks';
import { Icon, Spinner, Btn, ChainIcon, useApp } from '../../../components.jsx';
import { getChain } from '../../../../shared/chains.js';
import { fmtNum, fmtAmount } from '../../../../shared/format.js';
import { t } from '../../../../shared/i18n.js';
import { chainParams } from '../../../../shared/tron/api.js';
import { encodeRawData } from '../../../../shared/tron/proto.js';
import { resourceState, costOf, bandwidthBytes } from '../../../../shared/tron/fees.js';
import { deployContract, deployEnergy } from '../../../../shared/tron/contracts.js';
import { saveContract } from '../../../contractsStore.js';
import { sendContract } from '../../../tron/tx.js';
import { useTronAccounts } from '../../../tron/hooks.js';

export function TronDeploy({ chainId, bytecode, abi, contractName: name, value = 0n, runtimeSize, initSize, onBack, open }) {
  const { state, account, authorize, toast } = useApp();
  const chain = getChain(chainId, state.customChains);
  const map = useTronAccounts();
  const me = map ? map[account.address]?.address || null : undefined;
  const [plan, setPlan] = useState(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const contract = me ? deployContract(me, { bytecode, abi, name, callValue: value }) : null;
  useEffect(() => {
    if (!me) return;
    (async () => {
      const [res, params] = await Promise.all([resourceState(chain, me), chainParams(chain)]);
      const energy = deployEnergy(runtimeSize || (bytecode.length - 2) / 2, initSize || (bytecode.length - 2) / 2);
      const draft = encodeRawData({ contract, ref: { ref_block_bytes: '0000', ref_block_hash: '0000000000000000' }, expiration: Date.now(), timestamp: Date.now(), fee_limit: 1_000_000_000 });
      const cost = costOf({ res, params, bytes: bandwidthBytes(draft), energy });
      const balance = BigInt(res.account?.balance || 0);
      // room above the estimate, never more than the account has (the limit only caps what may be burnt)
      const max = BigInt(params.getMaxFeeLimit ?? 15_000_000_000);
      let feeLimit = cost.energy.burn * 2n + 50_000_000n;
      if (feeLimit > balance - value) feeLimit = balance - value;
      if (feeLimit > max) feeLimit = max;
      setPlan({ energy, cost, balance, feeLimit: Number(feeLimit > 0n ? feeLimit : 0n), activated: res.activated });
    })().catch((e) => setErr(e.message));
  }, [me]);
  const go = async () => {
    setErr(''); setBusy(true);
    try {
      const r = await sendContract(chain, { account, contract, feeLimit: plan.feeLimit, auth: (fn) => authorize(fn, t('contracts.tx.deployTitle', { name })) });
      const w = await r.wait;
      const address = w.info?.contract;
      if (!address) throw new Error(t('tronc.deployNoAddress'));
      await saveContract({ chainId, address, name, mine: true, abi, txHash: w.hash });
      toast(t('tronc.deployed', { name }));
      open({ name: 'contract', chainId, address }, { replace: true });
    } catch (e) { if (!e.cancelled) setErr(e.message); setBusy(false); }
  };
  const short = plan && plan.cost.total + value > plan.balance;
  return (
    <div class="screen">
      <div class="topbar">
        <button class="iconbtn" onClick={onBack} title={t('common.back')}><Icon name="back" /></button>
        <h1 class="ellipsis">{t('contracts.deploy.title', { name })}</h1>
      </div>
      <div class="content ct-content">
        <div class="card row" style={{ gap: '.5rem' }}><ChainIcon chain={chain} size={26} /><b class="grow">{chain.name}</b><span class="small muted">{fmtNum((bytecode.length - 2) / 2 / 1024, 1)} KB</span></div>
        {me === null && <div class="error small">{t('tronc.noTronKey')}</div>}
        {me && !plan && !err && <div class="row small muted"><Spinner /> {t('tronc.estimating')}</div>}
        {plan && (
          <>
            {!plan.activated && <div class="error small">{t('tron.send.notActivated')}</div>}
            <div class="card">
              <div class="row between small"><span class="muted">{t('tronc.deployEnergy')}</span><span>≈ {fmtNum(plan.energy, 0)}{plan.cost.energy.burn ? '' : ` · ${t('tron.res.covered')}`}</span></div>
              <div class="row between small"><span class="muted">{t('tron.fee.label')}</span><b>≈ {fmtAmount(plan.cost.total, 6, 2)} TRX</b></div>
              {value > 0n && <div class="row between small"><span class="muted">{t('contracts.fn.value')}</span><span>{fmtAmount(value, 6, 6)} TRX</span></div>}
            </div>
            <div class="info small">{t('tronc.deployInfo')}</div>
            {short && <div class="warn small">{t('tron.send.noTrxFee', { amount: `${fmtAmount(plan.cost.total + value, 6, 2)} TRX` })}</div>}
          </>
        )}
        {err && <div class="error small">{err}</div>}
      </div>
      <div class="footer"><Btn loading={busy} disabled={!plan || short || !plan.activated} onClick={go}>{t('tronc.deploy')}</Btn></div>
    </div>
  );
}
