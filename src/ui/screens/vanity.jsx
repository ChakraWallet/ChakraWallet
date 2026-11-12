// Vanity address: an account with a separate key whose address starts OR ends with a word of up to 6 characters.
// Three phases inside the "Add account" sheet: setup (text -> pattern, preview), search (workers), found (name + create).
import { useState, useEffect, useMemo, useRef } from 'preact/hooks';
import { bg } from '../../shared/ext.js';
import { t, locale } from '../../shared/i18n.js';
import { toPattern, probability, expectedSeconds, exampleParts, splitAddress, MAX_VANITY } from '../../shared/vanity.js';
import { measureRate, startSearch } from '../vanityClient.js';
import { Avatar, Btn, Icon, KeepAwake, SuccessMark, useApp } from '../components.jsx';

const randomHex = (chars) => [...crypto.getRandomValues(new Uint8Array(chars / 2))].map((b) => b.toString(16).padStart(2, '0')).join('');
const compact = (n) => new Intl.NumberFormat(locale(), { notation: 'compact', maximumFractionDigits: 1 }).format(n);
const whole = (n) => Math.round(n).toLocaleString(locale());
const clock = (s) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;

function duration(s) {
  if (!isFinite(s)) return '…';
  if (s < 1) return t('vanity.time.instant');
  if (s < 90) return t('vanity.time.s', { n: Math.round(s) });
  if (s < 5400) return t('vanity.time.min', { n: Math.round(s / 60) });
  return t('vanity.time.h', { n: (s / 3600).toLocaleString(locale(), { maximumFractionDigits: 1 }) });
}
const exact = (s) => (s < 60 ? t('vanity.time.s', { n: Math.max(1, Math.round(s)) }) : t('vanity.time.minSec', { m: Math.floor(s / 60), s: Math.round(s % 60) }));

// One line: SIDE hex characters on the pattern's side (pattern included), OTHER on the opposite side, "…" in between.
const SIDE = 10;
const OTHER = 6;
const tail = (s, n) => s.slice(Math.max(0, s.length - n));

/** The address on one line: the pattern in colour, the rest in grey; without a pattern, a caret marks where it goes. */
function Address({ parts, where, live }) {
  const n = parts.pattern.length;
  const pat = n ? <span class="vz-pat">{parts.pattern}</span> : <span class="vz-caret" />;
  const gap = <span class="vz-gap">…</span>;
  return (
    <div class={`vz-addr ${live ? 'live' : ''}`} dir="ltr" title={`0x${parts.before}${parts.pattern}${parts.after}`}>
      <span class="vz-0x">0x</span>
      {where === 'end' ? (
        <><span class="vz-rest">{parts.before.slice(0, OTHER)}</span>{gap}<span class="vz-rest">{tail(parts.before, SIDE - n)}</span>{pat}</>
      ) : (
        <>{pat}<span class="vz-rest">{parts.after.slice(0, SIDE - n)}</span>{gap}<span class="vz-rest">{tail(parts.after, OTHER)}</span></>
      )}
    </div>
  );
}

/** What the user typed -> what will be searched, one tile per character. */
function Mapping({ chars }) {
  if (!chars.length) return null;
  const has = (k) => chars.some((c) => c.kind === k);
  return (
    <div class="vz-mapping">
      <div class="vz-map" aria-hidden="true">
        {chars.map((c) => (
          <span class={`vz-ch ${c.kind}`}>
            <span class="vz-from">{c.from}</span>
            <span class="vz-to">{c.kind === 'drop' ? '×' : c.to}</span>
          </span>
        ))}
      </div>
      {(has('sub') || has('drop') || has('over')) && (
        <div class="vz-legend tiny muted">
          {has('sub') && <span><i class="vz-dot sub" />{t('vanity.legend.sub')}</span>}
          {has('drop') && <span><i class="vz-dot drop" />{t('vanity.legend.drop')}</span>}
          {has('over') && <span><i class="vz-dot over" />{t('vanity.legend.over', { max: MAX_VANITY })}</span>}
        </div>
      )}
    </div>
  );
}

function Meter({ n }) {
  return <span class="vz-meter" aria-hidden="true">{Array.from({ length: MAX_VANITY }, (_, i) => <i class={i < n ? 'on' : ''} />)}</span>;
}

export function VanityAccount({ onBack, onCreated }) {
  const { mode } = useApp();
  const [where, setWhere] = useState('start');
  const [text, setText] = useState('');
  const [phase, setPhase] = useState('setup'); // setup | search | found
  const [rate, setRate] = useState(null);      // attempts/s, estimated then measured
  const [progress, setProgress] = useState({ tried: 0, rate: 0, sample: '', elapsed: 0 });
  const [result, setResult] = useState(null);  // { privateKey, address, tried, elapsed }
  const [name, setName] = useState('');
  const [err, setErr] = useState('');
  const [creating, setCreating] = useState(false);
  const stopRef = useRef(null);
  const filler = useMemo(() => randomHex(40), []);
  const { chars, pattern } = useMemo(() => toPattern(text), [text]);
  // the pattern and side of the running/finished search (the text can be edited only in setup)
  const [run, setRun] = useState({ pattern: '', where: 'start' });

  useEffect(() => {
    let alive = true;
    measureRate().then((r) => alive && setRate((x) => x ?? r)).catch(() => {});
    return () => { alive = false; stopRef.current?.(); };
  }, []);

  const start = () => {
    setErr(''); setResult(null);
    setRun({ pattern, where });
    setProgress({ tried: 0, rate: 0, sample: '', elapsed: 0 });
    setPhase('search');
    stopRef.current = startSearch({
      pattern, where,
      onProgress: setProgress,
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
      const acc = await bg('addAccount', { mode: 'vanity', privateKey: result.privateKey, name: name.trim() || undefined });
      await onCreated(acc); // closes the sheet: the key leaves the interface's memory with it
    } catch (e) { setErr(e.message); setCreating(false); }
  };

  if (phase === 'search') {
    const p = probability(progress.tried, run.pattern);
    const speed = progress.rate || rate || 0;
    const typical = expectedSeconds(run.pattern, speed);
    const sample = (progress.sample || filler).slice(0, 40);
    // the grey part shows the addresses being tried right now
    const parts = exampleParts(run.pattern, run.where, run.where === 'end' ? sample : sample.slice(run.pattern.length) + sample.slice(0, run.pattern.length));
    return (
      <>
        <KeepAwake />
        <div class="vz-card">
          <Address parts={parts} where={run.where} live />
          <div class="vz-bar" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(p * 100)}><span style={{ width: `${Math.max(2, p * 100)}%` }} /></div>
          <div class="vz-meta small"><span>{t('vanity.chance', { p: Math.floor(p * 100) })}</span><span class="muted vz-num">· {clock(progress.elapsed)}</span></div>
        </div>
        <div class="vz-stats">
          <div><span class="tiny muted">{t('vanity.tried')}</span><b class="vz-num">{compact(progress.tried)}</b></div>
          <div><span class="tiny muted">{t('vanity.speed')}</span><b class="vz-num">{t('vanity.perSec', { n: whole(speed) })}</b></div>
          <div><span class="tiny muted">{t('vanity.usually')}</span><b class="vz-num">{duration(typical)}</b></div>
        </div>
        {progress.elapsed > 30 && progress.elapsed > typical * 2 && <div class="info small center">{t('vanity.slow')}</div>}
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
          <div class="bold">{t('vanity.found', { time: exact(result.elapsed) })}</div>
          <div class="small muted">{t('vanity.foundAfter', { n: compact(result.tried) })}</div>
        </div>
        <div class="vz-card vz-result">
          <Avatar address={result.address} />
          <Address parts={splitAddress(result.address, run.pattern, run.where)} where={run.where} />
        </div>
        <div class="tiny muted center">{t('vanity.checksum')}</div>
        <div class="field"><label>{t('common.nameOptional')}</label><input class="input" value={name} onInput={(e) => setName(e.target.value)} placeholder={t('accounts.add.namePlaceholder')} maxLength={32} /></div>
        <div class="warn small">{t('accounts.add.randomWarn')}</div>
        {err && <div class="error">{err}</div>}
        <Btn loading={creating} onClick={create}>{t('vanity.create')}</Btn>
        <Btn kind="ghost" disabled={creating} onClick={() => { setResult(null); setPhase('setup'); }}><Icon name="refresh" size={16} />{t('vanity.again')}</Btn>
      </>
    );
  }

  const typical = rate ? expectedSeconds(pattern, rate) : null;
  return (
    <>
      <div class="seg seg-full" role="radiogroup" aria-label={t('vanity.where')}>
        {['start', 'end'].map((w) => (
          <button class={where === w ? 'on' : ''} role="radio" aria-checked={where === w} onClick={() => setWhere(w)}>{t(`vanity.where.${w}`)}</button>
        ))}
      </div>
      <input class="input vz-input" value={text} onInput={(e) => setText(e.target.value)} placeholder={t('vanity.placeholder')} aria-label={t('vanity.text')}
        maxLength={24} autoComplete="off" autoCapitalize="off" autoCorrect="off" spellcheck={false} />
      <div class="tiny muted center">{t('vanity.intro')}</div>
      <Mapping chars={chars} />
      <div class="vz-card">
        <Address parts={exampleParts(pattern, where, filler)} where={where} />
        <div class="vz-meta small">
          <span class="row vz-count"><Meter n={pattern.length} />{t('vanity.count', { n: pattern.length, max: MAX_VANITY })}</span>
          {pattern && <span class="muted">· {typical == null ? t('vanity.measuring') : t('vanity.typical', { time: duration(typical) })}</span>}
        </div>
        {!pattern && <div class="tiny muted center">{t('vanity.empty')}</div>}
      </div>
      {err && <div class="error">{err}</div>}
      <div class="row vz-actions">
        <Btn kind="secondary" onClick={onBack}>{t('common.back')}</Btn>
        <Btn class="grow" disabled={!pattern} onClick={start}><Icon name="search" size={16} />{t('vanity.start')}</Btn>
      </div>
    </>
  );
}
