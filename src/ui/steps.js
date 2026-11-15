// Operations made of steps (approval + swap, approval + bridge, or one transaction): the chain drivers describe the
// steps (src/ui/chains/driver.d.md), the screens run them. One authorization covers every step of the operation: the
// password is kept only in the screen's memory between its transactions and dropped after the last one or on exit.
import { useEffect, useRef } from 'preact/hooks';
import { useApp } from './components.jsx';
import { WRONG_PASSWORD } from './auth.jsx';

/** auth(fn, keep): runs fn(password) with the wallet password; keep = more steps follow, keep it for them. */
export function useOperationAuth(title) {
  const { authorize } = useApp();
  const pw = useRef(null);
  useEffect(() => () => { pw.current = null; }, []);
  return async (fn, keep = false) => {
    if (pw.current) {
      try { const r = await fn(pw.current); if (!keep) pw.current = null; return r; } catch (e) { pw.current = null; if (e.key !== WRONG_PASSWORD) throw e; }
    }
    return authorize(async (password) => { const r = await fn(password); if (keep) pw.current = password; return r; }, title);
  };
}

/**
 * Sends step i and, when another follows, waits for it if the step asks (an approval must be mined first).
 * Returns the step's result: { hash?, wait?: Promise<{ hash | txHash }> }.
 */
export async function runStep(steps, i, review, { speed, auth, onWaiting }) {
  const last = i === steps.length - 1;
  const r = await steps[i].send(review, { speed, auth: (fn) => auth(fn, !last) });
  if (!last && steps[i].waitBeforeNext && r.wait) { onWaiting?.(); await r.wait; }
  return r;
}
