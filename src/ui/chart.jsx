// Line chart shared by Predictions (probabilities, profit) and the token details (price), with a touch crosshair.
import { useLayoutEffect, useRef, useState } from 'preact/hooks';
import { locale } from '../shared/i18n.js';

/** Smooth path through points (Catmull-Rom as cubic Béziers). */
export function smooth(xy) {
  let d = `M${xy[0][0].toFixed(1)} ${xy[0][1].toFixed(1)}`;
  for (let i = 0; i < xy.length - 1; i++) {
    const [p0, p1, p2, p3] = [xy[i - 1] || xy[i], xy[i], xy[i + 1], xy[i + 2] || xy[i + 1]];
    const c1 = [p1[0] + (p2[0] - p0[0]) / 6, p1[1] + (p2[1] - p0[1]) / 6], c2 = [p2[0] - (p3[0] - p1[0]) / 6, p2[1] - (p3[1] - p1[1]) / 6];
    d += `C${c1[0].toFixed(1)} ${c1[1].toFixed(1)} ${c2[0].toFixed(1)} ${c2[1].toFixed(1)} ${p2[0].toFixed(1)} ${p2[1].toFixed(1)}`;
  }
  return d;
}

/**
 * Single-series line chart. points: [{ t (ms), p }].
 *   kind 'prob'  : 0..1 shown as %, axis snapped to 10% steps
 *   kind 'money' : a zero line, green above it, red below (profit and loss)
 *   kind 'price' : the data range, green when the period ends up, red when it ends down
 * fmtY(v): axis labels; tipValue(v): the value shown with the date of the touched point (money / price).
 */
export function LineChart({ points, onHover, label, kind = 'prob', fmtY, tipValue }) {
  const box = useRef(null);
  const [w, setW] = useState(320);
  const [hi, setHi] = useState(null);
  const H = 168, PAD = 8;
  useLayoutEffect(() => {
    const el = box.current; if (!el) return undefined;
    const ro = new ResizeObserver(() => setW(el.clientWidth || 320)); ro.observe(el); setW(el.clientWidth || 320);
    return () => ro.disconnect();
  }, []);
  const ps = points.map((x) => x.p);
  let lo, top;
  if (kind === 'prob') { // the data range padded and snapped to 10% steps, never outside 0..100%
    lo = Math.max(0, Math.floor((Math.min(...ps) - 0.03) * 10) / 10); top = Math.min(1, Math.ceil((Math.max(...ps) + 0.03) * 10) / 10);
    if (top - lo < 0.2) { const mid = (lo + top) / 2; lo = Math.max(0, mid - 0.1); top = Math.min(1, lo + 0.2); }
  } else if (kind === 'money') { // always include zero
    lo = Math.min(0, ...ps); top = Math.max(0, ...ps);
    const pad = Math.max(1, (top - lo) * 0.12); if (lo < 0) lo -= pad; top += pad;
  } else { // price: the range of the period, a little air above and below (a flat line stays in the middle)
    lo = Math.min(...ps); top = Math.max(...ps);
    const pad = (top - lo) * 0.12 || Math.abs(top) * 0.01 || 1; lo -= pad; top += pad;
    // at least ±0.5% of the price on the axis: a stablecoin's tiny moves stay a nearly flat line
    const mid = (lo + top) / 2, min = Math.abs(mid) * 0.01;
    if (top - lo < min) { lo = mid - min / 2; top = mid + min / 2; }
  }
  const t0 = points[0].t, t1 = points[points.length - 1].t || t0 + 1;
  const X = (tm) => ((tm - t0) / Math.max(1, t1 - t0)) * w;
  const Y = (p) => PAD + (1 - (p - lo) / (top - lo)) * (H - PAD * 2);
  const step = Math.max(1, Math.ceil(points.length / 160));
  const xy = points.filter((_, i) => i % step === 0 || i === points.length - 1).map((x) => [X(x.t), Y(x.p)]);
  const line = smooth(xy);
  const baseY = kind === 'money' ? Y(0) : H;
  const area = `${line}L${w} ${baseY}L0 ${baseY}Z`;
  const span = top - lo;
  const grid = kind === 'prob' ? [lo, (lo + top) / 2, top] : kind === 'money' ? [0] : [lo + span * 0.12, top - span * 0.12];
  const fmt = fmtY || ((v) => `${Math.round(v * 100)}%`);
  const last = points[points.length - 1];
  const neg = (kind === 'money' && last.p < 0) || (kind === 'price' && last.p < points[0].p);
  const id = `ck-area-${kind}${neg ? '-neg' : ''}`;

  const pick = (e) => {
    const r = box.current.getBoundingClientRect();
    const x = Math.max(0, Math.min(w, (e.touches?.[0]?.clientX ?? e.clientX) - r.left));
    const tm = t0 + (x / w) * (t1 - t0);
    let best = 0; for (let i = 1; i < points.length; i++) if (Math.abs(points[i].t - tm) < Math.abs(points[best].t - tm)) best = i;
    setHi(best); onHover?.(points[best]);
  };
  const leave = () => { setHi(null); onHover?.(null); };
  const hp = hi != null ? points[hi] : null;

  return (
    <div class={`pm-chart ${kind} ${neg ? 'neg' : ''}`} ref={box} onPointerDown={pick} onPointerMove={(e) => (e.buttons || e.pointerType === 'mouse') && pick(e)} onPointerUp={leave} onPointerLeave={leave} onPointerCancel={leave}
      role="img" aria-label={label}>
      <svg width={w} height={H} viewBox={`0 0 ${w} ${H}`}>
        <defs><linearGradient id={id} x1="0" y1="0" x2="0" y2="1"><stop offset="0" class="stop-a" /><stop offset="1" class="stop-b" /></linearGradient></defs>
        {grid.map((g) => <line x1="0" x2={w} y1={Y(g)} y2={Y(g)} class={`pm-grid ${kind === 'money' ? 'zero' : ''}`} />)}
        <path d={area} fill={`url(#${id})`} />
        <path d={line} class="pm-line" />
        {hp ? <><line x1={X(hp.t)} x2={X(hp.t)} y1="0" y2={H} class="pm-cross" /><circle cx={X(hp.t)} cy={Y(hp.p)} r="5" class="pm-dot" /></>
          : <circle cx={X(last.t)} cy={Y(last.p)} r="4.5" class="pm-dot live" />}
      </svg>
      {grid.map((g) => <span class="pm-ylab" style={{ top: `${Y(g)}px` }}>{fmt(g)}</span>)}
      {hp && (
        // value / date of the touched point, above the crosshair and kept inside the chart
        <span class="pm-tip" style={{ left: `${Math.max(64, Math.min(w - 64, X(hp.t)))}px` }}>
          {tipValue && <b>{tipValue(hp.p)} · </b>}
          {new Date(hp.t).toLocaleString(locale(), { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}
        </span>
      )}
    </div>
  );
}
