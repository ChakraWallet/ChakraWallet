// Errors, on screen. The reports themselves are made and kept by shared/crash.js; here:
//   - CrashBoundary: a screen that fails to draw shows an error page instead of a blank one ("Try again", "Send a
//     report"). If it fails again right after "Try again", the next try reloads the whole page;
//   - ReportView: the full text of a report, then e-mail / GitHub / copy. Nothing leaves the device unless the user
//     taps one of them, and the text they see is exactly what is sent;
//   - CrashAsk: after a crash that closed the app (native, collected at the next start), asked once;
//   - CrashList: Settings > Report a problem: the saved errors, and a way to write to us without one.
// Console test (any build): __CK_crashTest('render' | 'js' | 'java' | 'renderer') - the last two only in the Android
// debug app (CrashPlugin.test).
import { Component } from 'preact';
import { useEffect, useState } from 'preact/hooks';
import { makeReport, recordReport, reportText, emailParts, mailtoUrl, githubIssueUrl, markAsked, crashLog, clearCrashLog } from '../shared/crash.js';
import { t, locale } from '../shared/i18n.js';
import { Icon, Sheet, Btn } from './components.jsx';

const RELOAD_WITHIN_MS = 5000; // a second failure this soon after "Try again": reload instead

// ---------------------------------------------------------------- sending
function sendEmail(r) {
  // Android (and iOS): the mail app through the system, with the whole report; extension: a mailto: link
  if (globalThis.__CK_email) return globalThis.__CK_email(emailParts(r)).catch(() => { location.href = mailtoUrl(r); });
  const a = document.createElement('a');
  a.href = mailtoUrl(r);
  a.click();
}

/** A report (or, with report = null, a message without one: only the app and device line) and the ways to send it. */
export function ReportView({ report, onSent }) {
  const [copied, setCopied] = useState(false);
  const text = reportText(report);
  const sent = () => onSent?.();
  const copy = async () => {
    try { await navigator.clipboard.writeText(text); setCopied(true); sent(); } catch { /* no clipboard */ }
  };
  return (
    <div class="col crash-report">
      <p class="small muted">{report ? t('crash.report.note') : t('crash.contact.note')}</p>
      <pre class="data">{text}</pre>
      <button class="btn primary block" onClick={() => { sendEmail(report); sent(); }}><Icon name="mail" size={18} /> {t('crash.report.email')}</button>
      <a class="btn secondary block" href={githubIssueUrl(report)} target="_blank" rel="noopener" data-external onClick={sent}>
        <Icon name="code" size={18} /> {t('crash.report.github')}
      </a>
      {report && <button class="btn ghost" onClick={copy}><Icon name={copied ? 'check' : 'copy'} size={16} /> {copied ? t('crash.report.copied') : t('crash.report.copy')}</button>}
      <p class="tiny muted center">{t('crash.report.how')}</p>
    </div>
  );
}

// ---------------------------------------------------------------- a screen that failed to draw
let testRender = null; // __CK_crashTest('render'): the boundary on screen draws a component that throws
const Boom = () => { throw new Error('Crash test (render)'); };

export class CrashBoundary extends Component {
  state = { error: null, report: null, send: false, boom: false };
  retriedAt = 0;

  componentDidMount() { testRender = () => this.setState({ boom: true }); }
  componentWillUnmount() { testRender = null; }

  componentDidCatch(error) {
    const report = makeReport(error, { kind: 'render' });
    recordReport(report);
    this.setState({ error, report, send: false, boom: false });
  }

  retry = () => {
    if (Date.now() - this.retriedAt < RELOAD_WITHIN_MS) return location.reload();
    this.retriedAt = Date.now();
    this.setState({ error: null, report: null, send: false });
  };

  render({ children }, { error, report, send, boom }) {
    if (!error) return <>{children}{boom && <Boom />}</>;
    return (
      <div class="screen crash-screen" role="alert">
        <svg class="crash-ic" viewBox="0 0 24 24" width="40" height="40" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          <path d="M12 3 2.5 20h19L12 3z" /><path d="M12 10v4.5" /><path d="M12 17.5v.01" />
        </svg>
        <h2>{t('crash.title')}</h2>
        <p class="small muted">{t('crash.text')}</p>
        <button class="btn primary block" onClick={this.retry}>{t('crash.retry')}</button>
        {send ? <ReportView report={report} />
          : <button class="btn secondary block" onClick={() => this.setState({ send: true })}>{t('crash.send')}</button>}
      </div>
    );
  }
}

// ---------------------------------------------------------------- after a crash that closed the app
export function CrashAsk({ report, onClose }) {
  const [send, setSend] = useState(false);
  const done = () => { markAsked(report.sig); onClose(); };
  return (
    <Sheet title={send ? t('crash.report.title') : t('crash.ask.title')} onClose={done}>
      {send ? <ReportView report={report} onSent={() => markAsked(report.sig)} /> : (
        <div class="col" style={{ gap: '0.75rem' }}>
          <p class="small muted">{t('crash.ask.text')}</p>
          <Btn class="block" onClick={() => setSend(true)}>{t('crash.send')}</Btn>
          <Btn kind="secondary" class="block" onClick={done}>{t('crash.ask.later')}</Btn>
        </div>
      )}
    </Sheet>
  );
}

// ---------------------------------------------------------------- Settings > Report a problem
const LIST = undefined; // `open` below: undefined = the list, null = a message without a report, else that report

export function CrashList({ onClose }) {
  const [log, setLog] = useState(null);
  const [open, setOpen] = useState(LIST);
  useEffect(() => { crashLog().then(setLog).catch(() => setLog([])); }, []);
  const date = (ms) => new Date(ms).toLocaleString(locale(), { dateStyle: 'medium', timeStyle: 'short' });
  const title = open === LIST ? t('crash.list.title') : open ? t('crash.report.title') : t('crash.contact.title');
  return (
    <Sheet title={title} onClose={onClose}>
      {open !== LIST ? (
        <div class="col" style={{ gap: '0.5rem' }}>
          <ReportView report={open} />
          <button class="btn ghost" onClick={() => setOpen(LIST)}><Icon name="back" size={16} /> {t('common.back')}</button>
        </div>
      ) : (
        <div class="col" style={{ gap: '0.75rem' }}>
          <p class="small muted">{log?.length ? t('crash.list.intro') : t('crash.list.empty')}</p>
          {!!log?.length && (
            <div class="list crash-list">
              {log.map((r) => (
                <button class="item" key={r.sig} onClick={() => setOpen(r)}>
                  <div class="grow" style={{ minWidth: 0 }}>
                    <div class="small bold ellipsis">{r.message || r.kind}</div>
                    <div class="tiny muted">{date(r.lastAt)} · {r.kind}{r.count > 1 ? ` · ×${r.count}` : ''}</div>
                  </div>
                  <span class="muted"><Icon name="forward" size={16} /></span>
                </button>
              ))}
            </div>
          )}
          <Btn kind="secondary" class="block" onClick={() => setOpen(null)}><Icon name="mail" size={18} /> {t('crash.contact')}</Btn>
          {!!log?.length && <button class="btn ghost" onClick={async () => { await clearCrashLog(); setLog([]); }}>{t('crash.list.clear')}</button>}
        </div>
      )}
    </Sheet>
  );
}

// ---------------------------------------------------------------- console test
globalThis.__CK_crashTest = (kind = 'render') => {
  if (kind === 'render') return testRender?.();
  if (kind === 'js') return setTimeout(() => { throw new Error('Crash test (JavaScript)'); });
  return globalThis.__CK_CRASH__?.test({ kind }); // 'java' | 'renderer' (Android debug app)
};
