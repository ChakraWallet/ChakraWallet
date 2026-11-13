// Wallets (tenants): each one is an isolated profile with its own recovery phrase and accounts.
import { useState, useMemo } from 'preact/hooks';
import { bg } from '../../shared/ext.js';
import { TopBar, Icon, Btn, Sheet, useApp, SecureScreen, CopyPhrase, WalletMark } from '../components.jsx';
import { t, tn } from '../../shared/i18n.js';

export function Wallets() {
  const { state, refresh, toast, reset } = useApp();
  const [sheet, setSheet] = useState(null); // 'add' | { edit: wallet }

  const open = async (w) => {
    if (w.id !== state.activeWallet) { await bg('switchWallet', { id: w.id }); await refresh(); toast(t('wallets.switched', { name: w.name })); }
    reset('home');
  };

  return (
    <div class="screen">
      <TopBar title={t('wallets.title')} right={<button class="iconbtn" title={t('wallets.new')} onClick={() => setSheet('add')}><Icon name="plus" /></button>} />
      <div class="content">
        <div class="small muted">{t('wallets.intro')}</div>
        <div class="card" style={{ padding: '0.375rem' }}>
          {state.wallets.map((w) => (
            <div class="item">
              <button class="row grow" style={{ textAlign: 'left', minWidth: 0 }} onClick={() => open(w)}>
                <WalletMark id={w.id} />
                <div class="grow" style={{ minWidth: 0 }}>
                  <div class="bold ellipsis">{w.name}</div>
                  <div class="tiny muted">{tn('wallets.accounts', w.count)} · {w.hasSeed ? t('wallets.kind.seed') : t('wallets.kind.keys')}</div>
                </div>
                {w.id === state.activeWallet && <span class="badge">{t('wallets.active')}</span>}
              </button>
              <button class="iconbtn" title={t('wallets.manage')} onClick={() => setSheet({ edit: w })}><Icon name="edit" size={16} /></button>
            </div>
          ))}
        </div>
        <Btn kind="secondary" onClick={() => setSheet('add')}><Icon name="plus" /> {t('wallets.new')}</Btn>
      </div>
      {sheet === 'add' && <AddWallet onClose={() => setSheet(null)} />}
      {sheet?.edit && <EditWallet w={sheet.edit} onClose={() => setSheet(null)} />}
    </div>
  );
}

function EditWallet({ w, onClose }) {
  const { refresh, toast, state } = useApp();
  const [name, setName] = useState(w.name);
  const [del, setDel] = useState(false);
  const [pw, setPw] = useState('');
  const [err, setErr] = useState('');
  const [loading, setLoading] = useState(false);
  const last = state.wallets.length === 1;

  const rename = async () => { await bg('renameWallet', { id: w.id, name }); await refresh(); toast(t('common.nameUpdated')); onClose(); };
  const remove = async () => {
    setLoading(true); setErr('');
    try {
      const r = await bg('removeWallet', { id: w.id, password: pw });
      if (r.empty) await globalThis.__CK_BIO__?.disable().catch(() => {});
      await refresh(); toast(t('wallets.deleted')); onClose();
    } catch (e) { setErr(e.message); setLoading(false); }
  };

  if (del) {
    return (
      <Sheet title={t('wallets.delete.title', { name: w.name })} onClose={onClose}>
        <div class="error small">
          {tn('wallets.delete.body', w.count, { seed: w.hasSeed ? t('wallets.delete.seedPart') : '' })}
          {' '}<b>{t('wallets.delete.bold')}</b>
          {last && <> {t('wallets.delete.last')}</>}
        </div>
        <div class="field"><label>{t('common.confirmWithPassword')}</label><input class="input" type="password" value={pw} onInput={(e) => setPw(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && pw && remove()} autoFocus /></div>
        {err && <div class="error">{err}</div>}
        <div class="row"><Btn kind="secondary" class="grow" onClick={() => setDel(false)}>{t('common.cancel')}</Btn><Btn kind="danger" class="grow" loading={loading} disabled={!pw} onClick={remove}>{t('common.delete')}</Btn></div>
      </Sheet>
    );
  }
  return (
    <Sheet title={t('wallets.manageTitle')} onClose={onClose}>
      <div class="field"><label>{t('common.name')}</label><input class="input" value={name} onInput={(e) => setName(e.target.value)} maxLength={32} /></div>
      <Btn disabled={!name.trim() || name.trim() === w.name} onClick={rename}>{t('wallets.saveName')}</Btn>
      <button class="btn ghost red" onClick={() => setDel(true)}><Icon name="trash" size={16} /> {t('wallets.delete')}</button>
    </Sheet>
  );
}

function AddWallet({ onClose }) {
  const { refresh, toast, reset } = useApp();
  const [mode, setMode] = useState(null); // new | seed | key
  const [step, setStep] = useState('form'); // new: show -> verify -> form
  const [name, setName] = useState('');
  const [mnemonic, setMnemonic] = useState('');
  const [phrase, setPhrase] = useState('');
  const [pk, setPk] = useState('');
  const [revealed, setRevealed] = useState(false);
  const [answers, setAnswers] = useState({});
  const [err, setErr] = useState('');
  const [loading, setLoading] = useState(false);

  const words = mnemonic.split(' ');
  const quiz = useMemo(() => {
    if (!mnemonic) return [];
    const idx = new Set();
    while (idx.size < 3) idx.add(Math.floor(Math.random() * words.length));
    return [...idx].sort((a, b) => a - b);
  }, [mnemonic]);

  const start = async (m) => {
    setErr(''); setMode(m);
    if (m === 'new') { setMnemonic(await bg('generateMnemonic')); setStep('show'); } else setStep('form');
  };
  const create = async () => {
    setLoading(true); setErr('');
    try {
      const w = await bg('createWallet', { name: name.trim() || undefined, mnemonic: mode === 'new' ? mnemonic : mode === 'seed' ? phrase : undefined, privateKey: mode === 'key' ? pk : undefined });
      await refresh(); toast(t('wallets.created', { name: w.name })); onClose(); reset('home');
    } catch (e) { setErr(e.message); setLoading(false); }
  };

  if (!mode) {
    return (
      <Sheet title={t('wallets.new')} onClose={onClose}>
        <div class="list">
          <button class="item" onClick={() => start('new')}><div class="tx-icon" style={{ background: 'var(--primary-soft)', color: 'var(--primary)' }}><Icon name="plus" /></div>
            <div><div class="bold">{t('wallets.add.new')}</div><div class="small muted">{t('wallets.add.new.sub')}</div></div></button>
          <button class="item" onClick={() => start('seed')}><div class="tx-icon" style={{ background: 'var(--green-soft)', color: 'var(--green)' }}><Icon name="phrase" /></div>
            <div><div class="bold">{t('wallets.add.seed')}</div><div class="small muted">{t('wallets.add.seed.sub')}</div></div></button>
          <button class="item" onClick={() => start('key')}><div class="tx-icon" style={{ background: 'var(--amber-soft)', color: 'var(--amber)' }}><Icon name="receive" /></div>
            <div><div class="bold">{t('wallets.add.key')}</div><div class="small muted">{t('wallets.add.key.sub')}</div></div></button>
        </div>
      </Sheet>
    );
  }

  if (mode === 'new' && step === 'show') {
    return (
      <Sheet title={t('wallets.seed.title')} onClose={onClose}>
        <div class="warn small"><b>{t('wallets.seed.warnBold')}</b> {t('wallets.seed.warn')}</div>
        <SecureScreen />
        <div class={`seed-grid ${revealed ? '' : 'blur'}`} onClick={() => setRevealed(true)}>
          {words.map((w, i) => <div class="seed-word"><span>{i + 1}.</span>{w}</div>)}
        </div>
        {revealed && <CopyPhrase phrase={mnemonic} />}
        {!revealed ? <Btn kind="secondary" onClick={() => setRevealed(true)}><Icon name="eye" /> {t('wallets.seed.reveal')}</Btn>
          : <Btn onClick={() => setStep('verify')}>{t('wallets.seed.saved')}</Btn>}
      </Sheet>
    );
  }

  if (mode === 'new' && step === 'verify') {
    const ok = quiz.every((i) => (answers[i] || '').trim().toLowerCase() === words[i]);
    return (
      <Sheet title={t('wallets.verify.title')} onClose={onClose}>
        <div class="muted small">{t('wallets.verify.intro')}</div>
        {quiz.map((i) => (
          <div class="field"><label>{t('wallets.verify.word', { n: i + 1 })}</label>
            <input class="input" value={answers[i] || ''} onInput={(e) => setAnswers({ ...answers, [i]: e.target.value })} autoCapitalize="off" spellcheck={false} /></div>
        ))}
        <div class="row"><Btn kind="secondary" class="grow" onClick={() => setStep('show')}>{t('common.back')}</Btn><Btn class="grow" disabled={!ok} onClick={() => setStep('form')}>{t('common.continue')}</Btn></div>
      </Sheet>
    );
  }

  const count = phrase.trim().split(/\s+/).filter(Boolean).length;
  const valid = mode === 'new' || (mode === 'seed' && [12, 15, 18, 21, 24].includes(count)) || (mode === 'key' && pk.trim());
  return (
    <Sheet title={t('wallets.new')} onClose={onClose}>
      <div class="field"><label>{t('wallets.form.name')}</label><input class="input" value={name} onInput={(e) => setName(e.target.value)} placeholder={t('wallets.form.namePlaceholder')} maxLength={32} /></div>
      {mode === 'seed' && (
        <div class="field"><label>{t('wallets.seed.title')}</label>
          <textarea class="input mono" rows={3} value={phrase} onInput={(e) => setPhrase(e.target.value)} placeholder={t('wallets.form.phrasePlaceholder')} spellcheck={false} autoCapitalize="off" />
          <span class="small muted">{tn('wallets.form.words', count)}</span></div>
      )}
      {mode === 'key' && (
        <div class="field"><label>{t('wallets.form.privateKey')}</label><input class="input mono" type="password" value={pk} onInput={(e) => setPk(e.target.value)} placeholder="0x…" /></div>
      )}
      {err && <div class="error">{err}</div>}
      <div class="row"><Btn kind="secondary" class="grow" onClick={() => { setMode(null); setStep('form'); }}>{t('common.back')}</Btn><Btn class="grow" loading={loading} disabled={!valid} onClick={create}>{t('wallets.form.create')}</Btn></div>
    </Sheet>
  );
}
