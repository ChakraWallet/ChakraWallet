// Approval screen of WalletConnect's connection (Android app): who asks (what the dapp declares and what Verify says
// of it), the networks it gets, the account it sees. Its requests then use the shared screens (screens/approve.jsx,
// solana/, tron/), which show the dapp the same way. Registered by src/mobile/walletconnectPlugin.js; the session is
// settled in the background (src/background/walletconnect.js).
import { useState } from 'preact/hooks';
import { Btn, Avatar, useApp } from '../components.jsx';
import { RemoteSite } from '../screens/approve.jsx';
import { getChain } from '../../shared/chains.js';
import { shortAddr } from '../../shared/format.js';
import { chainIdOf } from '../../shared/walletconnect/namespaces.js';
import { t, tn } from '../../shared/i18n.js';

const FAMILY = { eip155: 'EVM', solana: 'Solana', tron: 'Tron' };

function WcConnect({ req, done }) {
  const { state } = useApp();
  const { plan, candidates, current } = req.params;
  const [sel, setSel] = useState(current);
  const [busy, setBusy] = useState(false);
  // the networks granted, by name (Solana's older ids name the same network)
  const names = [...new Set(Object.values(plan.namespaces).flatMap((n) => n.chains).map((c) => getChain(chainIdOf(c), state.customChains)?.name).filter(Boolean))];
  const go = async () => { setBusy(true); await done(true, { account: sel }); setBusy(false); };
  return (
    <>
      <div class="content">
        <RemoteSite remote={req.remote} unverified />
        <h3 style={{ margin: '0.25rem 0 0' }}>{t('wc.connect.title')}</h3>
        <div class="card kv small">
          <span class="k">{t('wc.connect.networks')}</span><span class="v">{names.join(', ')}</span>
        </div>
        {plan.unsupported.length > 0 && <div class="small muted">{tn('wc.connect.unsupported', plan.unsupported.length)}</div>}
        {!candidates.length && <div class="error small">{t('wc.connect.noAccount')}</div>}
        {candidates.length > 0 && (
          <>
            <div class="small muted">{t('wc.connect.choose')}</div>
            <div class="card" style={{ padding: '0.375rem' }}>
              {candidates.map((c) => {
                const a = state.accounts.find((x) => x.address === c.account);
                return (
                  <label class="item" style={{ cursor: 'pointer' }}>
                    <input type="radio" name="wcacc" checked={sel === c.account} onChange={() => setSel(c.account)} />
                    <Avatar address={c.account} />
                    <div class="grow" style={{ minWidth: 0 }}>
                      <div class="bold">{a?.name || t('approve.account')}</div>
                      {Object.entries(c.addresses).filter(([, x]) => x).map(([ns, x]) => (
                        <div class="tiny muted mono ellipsis">{FAMILY[ns] || ns} {shortAddr(x, 6)}</div>
                      ))}
                    </div>
                  </label>
                );
              })}
            </div>
          </>
        )}
        <div class="info small">{t('wc.connect.info')}</div>
      </div>
      <div class="footer">
        <Btn kind="secondary" onClick={() => done(false)}>{t('approve.reject')}</Btn>
        <Btn loading={busy} disabled={!sel || !candidates.length} onClick={go}>{t('approve.connect.button')}</Btn>
      </div>
    </>
  );
}

/** For screens/approve.jsx (registerApprovalViews): connecting needs no password (nothing is signed). */
export const walletConnectApprovalViews = {
  wcConnect: { View: WcConnect },
};
