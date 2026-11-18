// Tron vanity address (Accounts > Add account): an account with a key of its own whose Tron address has a short word
// right after the T or at its end. Same three phases as the Ethereum and Solana ones: setup, search (Web Workers, one
// per core), found (checked again, then saved as a Tron account, like a wallet imported from another app).
import { useState, useEffect, useMemo, useRef } from 'preact/hooks';
import { bg } from '../../shared/ext.js';
import { t, locale } from '../../shared/i18n.js';
import { keyOfPrivate } from '../../shared/tron/core.js';
import { toTronPattern, tronMatches, tronDifficulty, tronProbability, tronExample, tronPart, TRON_MAX_VANITY } from '../../shared/tron/vanity.js';
import { TRON_MAINNET } from '../../shared/tron/api.js';
import { Btn, Icon, KeepAwake, SuccessMark, Switch, useApp } from '../components.jsx';

const WORKER_URL = 'tron-vanity-worker.js';
const threads = () => Math.max(1, Math.min(8, (globalThis.navigator?.hardwareConcurrency || 2) - 1));
const compact = (n) => new Intl.NumberFormat(locale(), { notation: 'compact', maximumFractionDigits: 1 }).format(n);
const clock = (s) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
function duration(s) {
  if (!isFinite(s)) return '…';
  if (s < 1) return t('vanity.time.instant');
  if (s < 90) return t('vanity.time.s', { n: Math.round(s) });
  if (s < 5400) return t('vanity.time.min', { n: Math.round(s / 60) });
  if (s < 3 * 86400) return t('vanity.time.h', { n: (s / 3600).toLocaleString(locale(), { maximumFractionDigits: 1 }) });
  return t('sol.vanity.days', { n: Math.round(s / 86400).toLocaleString(locale()) });
}

/** Keys/s on all threads: one thread measured a moment, x0.5 for the slower cores of phones. */
function measureRate(ms = 700) {
  return new Promise((resolve, reject) => {
    let w;
    try { w = new Worker(WORKER_URL); } catch (e) { reject(e); return; }
    w.onmessage = (e) => { if (e.data?.type === 'bench') { w.terminate(); resolve(e.data.rate * threads() * 0.5); } };
    w.onerror = (e) => { w.terminate(); reject(new Error(e.message || 'worker')); };
    w.postMessage({ type: 'bench', ms });
  });
}

/** Starts the workers; returns stop(). onFound gets { privateKey, address } checked again here. */
function startSearch({ pattern, where, anyCase, onProgress, onFound, onError }) {
  const workers = [];
  const t0 = performance.now();
  const recent = [{ t: t0, n: 0 }];
  let tried = 0, sample = '', done = false, tick = null;
  const stop = () => { if (done) return; done = true; clearInterval(tick); for (const w of workers) w.terminate(); };
  const fail = (e) => { if (done) return; stop(); onError?.(e instanceof Error ? e : new Error(String(e?.message || e))); };
  const report = () => {
    const now = performance.now();
    recent.push({ t: now, n: tried });
    while (recent.length > 2 && now - recent[0].t > 4000) recent.shift();
    const rate = now > recent[0].t ? ((tried - recent[0].n) * 1000) / (now - recent[0].t) : 0;
    onProgress?.({ tried, rate, sample, elapsed: (now - t0) / 1000 });
  };
  const found = (f) => {
    if (done) return;
    let k;
    try { k = keyOfPrivate(f.privateKey); } catch (e) { fail(e); return; }
    if (k.address !== f.address || !tronMatches(k.address, pattern, where, anyCase)) { fail(new Error('vanity: verification failed')); return; }
    stop();
    onFound?.({ privateKey: f.privateKey.replace(/^0x/, ''), address: k.address, tried, elapsed: (performance.now() - t0) / 1000 });
  };
  try {
    for (let i = 0; i < threads(); i++) {
      const w = new Worker(WORKER_URL);
      w.onmessage = (e) => { const m = e.data || {}; if (m.type === 'progress') { tried += m.tried; sample = m.sample; } else if (m.type === 'found') found(m); };
      w.onerror = (e) => fail(new Error(e.message || 'worker'));
      w.postMessage({ type: 'start', pattern, where, anyCase });
      workers.push(w);
    }
  } catch (e) { fail(e); return stop; }
  tick = setInterval(report, 100);
  return stop;
}

/** The address on one line, the pattern in colour (after the T, or at the end). */
function Address({ address, pattern, where, live }) {
  const n = pattern.length;
  const pat = n ? <span class="vz-pat">{tronPart(address, n, where)}</span> : <span class="vz-caret" />;
  if (where === 'end') {
    const rest = address.slice(0, address.length - n);
    return <div class={`vz-addr ${live ? 'live' : ''}`} dir="ltr" title={address}><span class="vz-rest">{rest.slice(0, 6)}</span><span class="vz-gap">…</span><span class="vz-rest">{rest.slice(-Math.max(0, 10 - n))}</span>{pat}</div>;
  }
  const rest = address.slice(1 + n);
  return <div class={`vz-addr ${live ? 'live' : ''}`} dir="ltr" title={address}><span class="vz-rest">T</span>{pat}<span class="vz-rest">{rest.slice(0, Math.max(0, 9 - n))}</span><span class="vz-gap">…</span><span class="vz-rest">{rest.slice(-6)}</span></div>;
}

function Mapping({ chars }) {
  if (!chars.some((c) => c.kind !== 'same')) return null;
  return (
    <div class="vz-mapping">
      <div class="vz-map" aria-hidden="true">
        {chars.map((c) => <span class={`vz-ch ${c.kind}`}><span class="vz-from">{c.from}</span><span class="vz-to">{c.kind === 'drop' ? '×' : c.to}</span></span>)}
      </div>
      <div class="vz-legend tiny muted">
        {chars.some((c) => c.kind === 'sub') && <span><i class="vz-dot sub" />{t('vanity.legend.sub')}</span>}
        {chars.some((c) => c.kind === 'drop') && <span><i class="vz-dot drop" />{t('vanity.legend.drop')}</span>}
        {chars.some((c) => c.kind === 'over') && <span><i class="vz-dot over" />{t('vanity.legend.over', { max: TRON_MAX_VANITY })}</span>}
      </div>
    </div>
  );
}

export function TronVanity({ onBack, onDone }) {
  const { mode, refresh, state } = useApp();
  const [where, setWhere] = useState('start');
  const [anyCase, setAnyCase] = useState(true);
  const [text, setText] = useState('');
  const [phase, setPhase] = useState('setup');
  const [rate, setRate] = useState(null);
  const [progress, setProgress] = useState({ tried: 0, rate: 0, sample: '', elapsed: 0 });
  const [result, setResult] = useState(null);
  const [name, setName] = useState('');
  const [err, setErr] = useState('');
  const [creating, setCreating] = useState(false);
  const [run, setRun] = useState({ pattern: '', where: 'start', anyCase: true });
  const stopRef = useRef(null);
  const { chars, pattern } = useMemo(() => toTronPattern(text), [text]);
  const example = useMemo(() => tronExample(pattern, where), [pattern, where]);

  useEffect(() => {
    let alive = true;
    measureRate().then((r) => alive && setRate((x) => x ?? r)).catch(() => {});
    return () => { alive = false; stopRef.current?.(); };
  }, []);

  const start = () => {
    setErr(''); setResult(null);
    setRun({ pattern, where, anyCase });
    setProgress({ tried: 0, rate: 0, sample: '', elapsed: 0 });
    setPhase('search');
    stopRef.current = startSearch({
      pattern, where, anyCase, onProgress: setProgress,
      onFound: (r) => { stopRef.current = null; setResult(r); if (r.elapsed > 2) setRate(r.tried / r.elapsed); setPhase('found'); },
      onError: (e) => { stopRef.current = null; setErr(t('vanity.error', { msg: e.message })); setPhase('setup'); },
    });
  };
  const cancel = () => {
    stopRef.current?.(); stopRef.current = null;
    if (progress.elapsed > 2 && progress.rate > 0) setRate(progress.rate);
    setPhase('setup');
  };
  const create = async () => {
    setCreating(true); setErr('');
    try {
      const acc = await bg('tronImport', { secret: result.privateKey, name: name.trim() || undefined });
      await bg('selectAccount', { address: acc.address });
      const off = state.settings.disabledChains || [];
      if (off.includes(TRON_MAINNET)) await bg('saveSettings', { settings: { disabledChains: off.filter((x) => x !== TRON_MAINNET) } });
      await bg('setChain', { chainId: TRON_MAINNET });
      await refresh();
      onDone(acc); // closes the sheet: the key leaves the interface's memory with it
    } catch (e) { setErr(e.message); setCreating(false); }
  };

  if (phase === 'search') {
    const d = tronDifficulty(run.pattern, run.where, run.anyCase);
    const p = tronProbability(progress.tried, d);
    const speed = progress.rate || rate || 0;
    const sample = progress.sample || example;
    return (
      <>
        <KeepAwake />
        <div class="vz-card">
          <Address address={sample} pattern={run.pattern} where={run.where} live />
          <div class="vz-bar" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(p * 100)}><span style={{ width: `${Math.max(2, p * 100)}%` }} /></div>
          <div class="vz-meta small"><span>{t('vanity.chance', { p: Math.floor(p * 100) })}</span><span class="muted vz-num">· {clock(progress.elapsed)}</span></div>
        </div>
        <div class="vz-stats">
          <div><span class="tiny muted">{t('vanity.tried')}</span><b class="vz-num">{compact(progress.tried)}</b></div>
          <div><span class="tiny muted">{t('vanity.speed')}</span><b class="vz-num">{t('vanity.perSec', { n: Math.round(speed).toLocaleString(locale()) })}</b></div>
          <div><span class="tiny muted">{t('vanity.usually')}</span><b class="vz-num">{duration(speed ? d / speed : Infinity)}</b></div>
        </div>
        <div class="small muted vz-hint"><Icon name={mode === 'mobile' ? 'eye' : 'warn'} size={14} /><span>{mode === 'mobile' ? t('vanity.keepApp') : t('vanity.keepOpen')}</span></div>
        <Btn kind="secondary" onClick={cancel}>{t('common.cancel')}</Btn>
      </>
    );
  }

  if (phase === 'found' && result) {
    return (
      <>
        <div class="vz-found">
          <SuccessMark />
          <div class="bold">{t('vanity.found', { time: t('vanity.time.s', { n: Math.max(1, Math.round(result.elapsed)) }) })}</div>
          <div class="small muted">{t('vanity.foundAfter', { n: compact(result.tried) })}</div>
        </div>
        <div class="vz-card vz-result"><Address address={result.address} pattern={run.pattern} where={run.where} /></div>
        <div class="mono tiny center" style={{ wordBreak: 'break-all' }}>{result.address}</div>
        <div class="field"><label>{t('common.nameOptional')}</label><input class="input" value={name} onInput={(e) => setName(e.target.value)} placeholder={t('accounts.add.namePlaceholder')} maxLength={32} /></div>
        <div class="warn small">{t('tron.vanity.tronOnly')}</div>
        {err && <div class="error">{err}</div>}
        <Btn loading={creating} onClick={create}>{t('vanity.create')}</Btn>
        <Btn kind="ghost" disabled={creating} onClick={() => { setResult(null); setPhase('setup'); }}><Icon name="refresh" size={16} />{t('vanity.again')}</Btn>
      </>
    );
  }

  const d = pattern ? tronDifficulty(pattern, where, anyCase) : 1;
  const impossible = !isFinite(d);
  const hardStart = where === 'start' && pattern && !impossible && d > 10 * tronDifficulty(pattern, 'end', anyCase);
  return (
    <>
      <div class="seg seg-full" role="radiogroup" aria-label={t('vanity.where')}>
        {['start', 'end'].map((w) => <button class={where === w ? 'on' : ''} role="radio" aria-checked={where === w} onClick={() => setWhere(w)}>{t(`vanity.where.${w}`)}</button>)}
      </div>
      <input class="input vz-input" value={text} onInput={(e) => setText(e.target.value)} placeholder={t('vanity.placeholder')} aria-label={t('vanity.text')}
        maxLength={16} autoComplete="off" autoCapitalize="off" autoCorrect="off" spellcheck={false} />
      <div class="row between small"><span>{t('sol.vanity.anyCase')}<br /><span class="tiny muted">{t('sol.vanity.anyCaseHint')}</span></span><Switch on={anyCase} onChange={setAnyCase} /></div>
      <div class="tiny muted center">{t('tron.vanity.intro')}</div>
      <Mapping chars={chars} />
      <div class="vz-card">
        <Address address={example} pattern={pattern} where={where} />
        <div class="vz-meta small">
          <span>{t('vanity.count', { n: pattern.length, max: TRON_MAX_VANITY })}</span>
          {pattern && !impossible && <span class="muted">· {rate == null ? t('vanity.measuring') : t('vanity.typical', { time: duration(d / rate) })}</span>}
        </div>
        {!pattern && <div class="tiny muted center">{t('vanity.empty')}</div>}
      </div>
      {impossible && <div class="warn small">{t('tron.vanity.impossible')}</div>}
      {hardStart && <div class="info small">{t('tron.vanity.hardStart')}</div>}
      {err && <div class="error">{err}</div>}
      <div class="row vz-actions">
        <Btn kind="secondary" onClick={onBack}>{t('common.back')}</Btn>
        <Btn class="grow" disabled={!pattern || impossible} onClick={start}><Icon name="search" size={16} />{t('vanity.start')}</Btn>
      </div>
    </>
  );
}
