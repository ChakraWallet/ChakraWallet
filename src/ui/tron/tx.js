// Sending Tron transactions from the screens: built with a fresh reference to the latest block once the password is
// given (a review can stay open for minutes; a transaction expires two minutes after its block), signed in the
// background (src/background/tron.js checks it before signing), broadcast, then followed until it is in a block.
import { bg } from '../../shared/ext.js';
import { t } from '../../shared/i18n.js';
import { latestRef, broadcast, waitTx } from '../../shared/tron/api.js';
import { encodeRawData } from '../../shared/tron/proto.js';

/** A node's refusal in words the user understands. */
export function sendText(e) {
  const m = String(e?.code || '') + ' ' + String(e?.message || e || '');
  if (/BANDWITH_ERROR|bandwidth|balance is not sufficient|Account resource insufficient/i.test(m)) return t('tron.err.noTrxFee');
  if (/OUT_OF_ENERGY/i.test(m)) return t('tron.err.outOfEnergy');
  if (/REVERT/i.test(m)) return t('tron.err.reverted');
  if (/TAPOS|expired|TRANSACTION_EXPIRATION/i.test(m)) return t('tron.err.expired');
  if (/does not exist|not exist/i.test(m)) return t('tron.err.notActivated');
  if (/too many requests/i.test(m)) return t('tron.err.busy');
  return String(e?.message || e);
}

/**
 * Builds, signs and broadcasts one transaction. contract: { type, parameter } (src/shared/tron/proto.js);
 * auth(fn, title): the password, then fn(password). -> { hash, wait: Promise<{ hash, info }> }
 */
export async function sendContract(chain, { account, contract, feeLimit = 0, memo = '', auth, title }) {
  const signed = await auth(async (password) => {
    const ref = await latestRef(chain);
    const rawDataHex = encodeRawData({ contract, ref, expiration: ref.time + 120_000, timestamp: Date.now(), fee_limit: feeLimit, data: memo });
    const s = await bg('tronSign', { from: account.address, txs: [rawDataHex], password });
    return { rawDataHex, txID: s.txIDs[0], signature: s.signatures[0] };
  }, title);
  let hash;
  try { hash = await broadcast(chain, { rawDataHex: signed.rawDataHex, txID: signed.txID, signatures: [signed.signature] }); } catch (e) { throw new Error(sendText(e)); }
  const wait = waitTx(chain, hash).then((info) => ({ hash, info })).catch((e) => {
    const err = new Error(/not confirmed yet/.test(e.message) ? t('tx.late') : sendText(e));
    err.code = /not confirmed yet/.test(e.message) ? 'late' : 'failed';
    throw err;
  });
  return { hash, wait };
}
