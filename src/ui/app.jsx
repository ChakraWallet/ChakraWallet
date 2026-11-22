import { useEffect, useLayoutEffect, useState, useCallback, useMemo, useRef } from 'preact/hooks';
import { setAlchemy } from '../shared/alchemy.js';
import { ext, bg } from '../shared/ext.js';
import { getChain, BUILTIN_CHAINS } from '../shared/chains.js';
import { AppCtx, Spinner, MASK } from './components.jsx';
import { Onboarding } from './screens/onboarding.jsx';
import { TermsGate, needsTerms } from './terms.jsx';
import { Predict } from './screens/predict.jsx';
import { Unlock } from './screens/unlock.jsx';
import { Home } from './screens/home.jsx';
import { Send } from './screens/send.jsx';
import { Receive } from './screens/receive.jsx';
import { Swap } from './screens/swap.jsx';
import { History } from './screens/history.jsx';
import { Accounts, AccountDetails } from './screens/accounts.jsx';
import { Settings } from './screens/settings.jsx';
import { Approvals } from './screens/approve.jsx';
import { TokenDetails } from './screens/token.jsx';
import { Browser } from './screens/browser.jsx';
import { Wallets } from './screens/wallets.jsx';
import { Bridge } from './screens/bridge.jsx';
import { Donate } from './screens/donate.jsx';
import { useBridgeTracker, useBackgroundWatch } from './hooks.js';
import { Icon } from './components.jsx';
import { useAuthorizer } from './auth.jsx';
import { t, setLang, locale } from '../shared/i18n.js';
import { setDisplayCurrency } from '../shared/fx.js';
import { accountFamily, familyOf, driverOf, isEvmAccount, driverScreens } from './chains/index.js';
import { NftDetail } from './screens/nfts.jsx';
import { MmCard } from './screens/mmcard.jsx';
import { ReplaceTx } from './screens/replaceTx.jsx';
import { ConnectQrHost } from './connectQr.jsx';
import { setCrashScreen, crashToAsk } from '../shared/crash.js';
import { CrashAsk } from './crash.jsx';

/** Storage keys background getState() is built from (vault, session unlock, wallets, network, settings, sites). */
const STATE_KEYS = new Set(['vault', 'wallet', 'wallets', 'accounts', 'activeWallet', 'selected', 'chainId', 'customChains', 'settings', 'permissions', 'tonConnect']);

const SCREENS = { home: Home, send: Send, receive: Receive, swap: Swap, history: History, accounts: Accounts, account: AccountDetails, settings: Settings, approvals: Approvals, token: TokenDetails, wallets: Wallets, bridge: Bridge, nft: NftDetail, mmcard: MmCard, replaceTx: ReplaceTx };

const scanStart = location.hash === '#full-scan'; // extension: QR scanning continues in a tab (camera)
const mode = globalThis.__CK_MOBILE__ ? 'mobile' : scanStart ? 'full' : location.hash.replace('#', '') || 'popup';
if (mode === 'onboarding' || mode === 'full') document.body.classList.add('wide');
if (mode === 'mobile') { document.body.classList.add('mobile'); document.documentElement.classList.add('mobile'); }

// Theme: 'system' follows the OS, 'light'/'dark' override it. Cached locally to avoid a flash on open.
const darkQuery = globalThis.matchMedia?.('(prefers-color-scheme: dark)');
function applyTheme(theme) {
  const t = theme || 'system';
  try { localStorage.setItem('ck-theme', t); } catch { /* ignore */ }
  if (t === 'system') delete document.documentElement.dataset.theme; else document.documentElement.dataset.theme = t;
  const dark = t === 'dark' || (t === 'system' && !!darkQuery?.matches);
  globalThis.__CK_SYSUI__?.setTheme({ dark, background: getComputedStyle(document.documentElement).getPropertyValue('--bg').trim() }).catch(() => {});
}
try { applyTheme(localStorage.getItem('ck-theme') || 'system'); } catch { /* ignore */ }

export function App() {
  const [state, setState] = useState(null);
  const [stack, setStack] = useState(scanStart ? [{ name: 'home', params: {} }, { name: 'send', params: { scan: true } }] : [{ name: 'home', params: {} }]);
  const [toastMsg, setToastMsg] = useState(null);
  const [portfolioCache, setPortfolioCache] = useState({});
  // privacy mode: balances hidden until the eye is tapped. With the setting on, hidden again at every unlock and
  // whenever the app goes to the background (so it opens hidden); without it, the eye still hides them for a while
  const [hidden, setHidden] = useState(false);
  const privacyOn = !!state?.settings?.privacyMode;
  useEffect(() => { if (state?.unlocked) setHidden(privacyOn); }, [state?.unlocked]);
  useEffect(() => {
    if (!privacyOn) return undefined;
    const away = () => { if (document.visibilityState === 'hidden') setHidden(true); };
    document.addEventListener('visibilitychange', away);
    return () => document.removeEventListener('visibilitychange', away);
  }, [privacyOn]);
  const privacy = useMemo(() => ({ hidden, toggle: () => setHidden((h) => !h), m: (x) => (hidden ? MASK : x) }), [hidden]);
  // mobile only
  const [tab, setTab] = useState('wallet');
  const [predictDeep, setPredictDeep] = useState(false); // a market or the portfolio is open over the predictions list
  const [siteOpen, setSiteOpen] = useState(false); // the browser shows a site: the tab pill steps aside
  const [browserUsed, setBrowserUsed] = useState(false);
  const [predictUsed, setPredictUsed] = useState(false);
  const [contractsUsed, setContractsUsed] = useState(false);
  const [donateUsed, setDonateUsed] = useState(false);
  const [contractsDeep, setContractsDeep] = useState(false); // a contract, a project... is open over the Contracts home
  const [predictReq, setPredictReq] = useState(null); // a Predictions screen to open from the wallet: { name }
  const [openUrl, setOpenUrl] = useState(null);
  const [approvalOpen, setApprovalOpen] = useState(false);
  const [onboarding, setOnboarding] = useState(false); // stays on screen until its last step, after the vault exists
  const [crashAsk, setCrashAsk] = useState(null); // a crash that closed the app last time: asked once, after unlocking
  const [authorize, authEl] = useAuthorizer();

  const refresh = useCallback(async () => {
    try {
      const st = await bg('getState');
      setAlchemy(st?.settings); // the Alchemy key and its networks, for the reads made from the screens
      setState(st);
    } catch (e) { console.error(e); }
  }, []);

  useEffect(() => {
    refresh();
    // only the keys getState is made of: caches, browser history, tabs... must not reload and redraw the whole app
    const onChange = (changes) => { if (Object.keys(changes || {}).some((k) => STATE_KEYS.has(k))) refresh(); };
    ext.storage.onChanged.addListener(onChange);
    const onMsg = (m) => { if (m?.type === 'pendingChanged') refresh(); };
    ext.runtime.onMessage.addListener(onMsg);
    // keep the background alive while the UI is open
    const port = ext.runtime.connect({ name: 'chakra-ui' });
    // auto-lock counts from the last tap: a tap only sets a flag; the background hears about it at once if it hasn't
    // for 20 s, else at the next tick (at most one message every 20 s while in use, none when idle). The dapp
    // browser of the Android app reports the taps on its pages through globalThis.__CK_activity (see mobile/shim.js).
    let last = 0, pending = false;
    const touch = () => { last = Date.now(); pending = false; bg('touch').catch(() => {}); };
    const activity = () => { if (Date.now() - last >= 20000) touch(); else pending = true; };
    const iv = setInterval(() => { try { port.postMessage('ping'); } catch { /* */ } if (pending) touch(); }, 20000);
    // back in the foreground: if the time ran out while the phone slept, lock before showing anything
    const onVisible = () => { if (document.visibilityState === 'visible') bg('checkLock').catch(() => {}); };
    globalThis.__CK_activity = activity;
    document.addEventListener('pointerdown', activity, { capture: true, passive: true });
    document.addEventListener('keydown', activity, { capture: true, passive: true });
    document.addEventListener('visibilitychange', onVisible);
    touch();
    return () => {
      ext.storage.onChanged.removeListener(onChange); ext.runtime.onMessage.removeListener(onMsg); clearInterval(iv);
      document.removeEventListener('pointerdown', activity, { capture: true });
      document.removeEventListener('keydown', activity, { capture: true });
      document.removeEventListener('visibilitychange', onVisible);
      delete globalThis.__CK_activity;
    };
  }, []);

  // toast(message, kind?): kind 'warn' (e.g. network problems) shows a different icon and colour
  const toastTimer = useRef(null);
  const toast = useCallback((msg, kind = 'info') => {
    clearTimeout(toastTimer.current);
    setToastMsg({ msg, kind, id: Date.now() });
    toastTimer.current = setTimeout(() => setToastMsg(null), kind === 'warn' ? 4000 : 2600);
  }, []);
  globalThis.__CK_toast = toast; // for code outside components (e.g. failed balance scans)
  useBridgeTracker(toast);
  useBackgroundWatch(state);
  const [dir, setDir] = useState('');
  // wallet screens live in the Wallet tab: opening one from the Browser (e.g. "Add network") switches to it
  // switching tab: the new tab slides in from the side of the pill it comes from. The stack's own navigation
  // animation is cleared, or it would play again when the tab is shown (display none -> flex restarts it)
  const tabRef = useRef(tab);
  tabRef.current = tab;
  const [paneAnim, setPaneAnim] = useState('');
  const paneTimer = useRef(0);
  const goTab = useCallback((k) => {
    const from = TABS.findIndex((x) => x.k === tabRef.current), to = TABS.findIndex((x) => x.k === k);
    if (from === to) { window.dispatchEvent(new CustomEvent('ck-tab-reselect', { detail: k })); return; } // e.g. back to the top of the list
    tabRef.current = k;
    setDir('');
    setPaneAnim(to > from ? 'tab-in-r' : 'tab-in-l');
    clearTimeout(paneTimer.current); // the animation may not run (reduced motion, hidden): never leave it pending
    paneTimer.current = setTimeout(() => setPaneAnim(''), 450);
    setTab(k);
    if (k === 'browser') setBrowserUsed(true);
    if (k === 'predict') setPredictUsed(true);
    if (k === 'contracts') setContractsUsed(true);
    if (k === 'donate') setDonateUsed(true);
  }, []);
  const openPredict = useCallback((name) => { setPredictReq({ name }); goTab('predict'); }, []);
  const endPane = (e) => { if (e.target === e.currentTarget) setPaneAnim(''); };
  // the screen under a new one is rebuilt when coming back: remember where its lists were scrolled, and put them back
  const screenRef = useRef(null);
  const scrollsOf = () => [...(screenRef.current?.querySelectorAll('.content') || [])].map((e) => e.scrollTop);
  const nav = useCallback((name, params = {}) => {
    const scroll = scrollsOf();
    goTab('wallet'); setDir('nav-fwd');
    setStack((s) => [...s.slice(0, -1), { ...s[s.length - 1], scroll }, { name, params }]);
  }, []);
  const back = useCallback(() => { setDir('nav-back'); setStack((s) => (s.length > 1 ? s.slice(0, -1) : s)); }, []);
  const reset = useCallback((name = 'home', params = {}) => { setDir('nav-back'); setStack([{ name, params }]); }, []);
  const prevDepth = useRef(stack.length);
  useLayoutEffect(() => {
    const went = stack.length < prevDepth.current;
    prevDepth.current = stack.length;
    const want = went ? stack[stack.length - 1].scroll : null;
    if (!want?.some((y) => y > 0)) return undefined;
    // the lists may still be growing (data from cache, async rows): retry briefly until each one reaches its place
    const apply = () => {
      const els = [...(screenRef.current?.querySelectorAll('.content') || [])];
      return want.every((y, i) => { const e = els[i]; if (!e) return false; e.scrollTop = y; return Math.abs(e.scrollTop - y) < 2; });
    };
    if (apply()) return undefined;
    let n = 0; const id = setInterval(() => { if (apply() || ++n > 20) stop(); }, 50);
    const el = screenRef.current;
    const stop = () => { clearInterval(id); el?.removeEventListener('touchstart', stop); };
    el?.addEventListener('touchstart', stop, { passive: true }); // the user scrolls: leave the list alone
    return stop;
  }, [stack]);

  // language: follows the setting; a settings change re-renders the whole app (t() reads the current language)
  const lang = setLang(state?.settings?.language || 'system');
  useEffect(() => { document.documentElement.lang = locale(); }, [lang]); // zh-CN: the Simplified Chinese glyphs

  // display currency: re-render once its exchange rate is known
  const currency = state?.settings?.currency || 'USD';
  const [, setFxTick] = useState(0);
  useEffect(() => { setDisplayCurrency(currency).then(() => setFxTick((x) => x + 1)); }, [currency]);

  const theme = state?.settings?.theme;
  useEffect(() => {
    applyTheme(theme);
    if (theme && theme !== 'system') return;
    const onChange = () => applyTheme('system');
    darkQuery?.addEventListener('change', onChange);
    return () => darkQuery?.removeEventListener('change', onChange);
  }, [theme]);

  // ---- mobile: approvals overlay, links, Android back button
  useEffect(() => {
    if (mode !== 'mobile') return;
    const onApproval = (e) => { setApprovalOpen(e.detail.open); refresh(); };
    const onOpen = (e) => { goTab('browser'); setOpenUrl({ url: e.detail, t: Date.now() }); };
    // a request that came before the app was drawn (e.g. a link that started the app): show it now
    if (globalThis.__CK_approvalOpen?.()) setApprovalOpen(true);
    window.addEventListener('ck-approval', onApproval);
    window.addEventListener('ck-open-url', onOpen);
    return () => { window.removeEventListener('ck-approval', onApproval); window.removeEventListener('ck-open-url', onOpen); };
  }, []);
  useEffect(() => {
    if (mode !== 'mobile') return;
    const onBack = async () => {
      if (approvalOpen) return globalThis.__CK_closeApproval?.();
      if (globalThis.__CK_obBack?.()) return; // onboarding: previous step
      if (document.querySelector('.overlay')) return document.querySelector('.overlay')?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      if (tab === 'browser') {
        // the browser handles its own history (site pages, then its start page)
        if (globalThis.__CK_browserBack?.()) return;
        return goTab('wallet');
      }
      if (tab === 'predict') {
        if (globalThis.__CK_predictBack?.()) return; // its own screens (market, portfolio)
        return goTab('wallet');
      }
      if (tab === 'contracts') {
        if (globalThis.__CK_contractsBack?.()) return; // contract, studio, transaction...
        return goTab('wallet');
      }
      if (tab === 'donate') return goTab('wallet');
      if (globalThis.__CK_screenBack?.()) return; // a screen with its own sub-pages (settings: networks, sites)
      if (stack.length > 1) return back();
      globalThis.__CK_exitApp?.();
    };
    window.addEventListener('ck-back', onBack);
    return () => window.removeEventListener('ck-back', onBack);
  }, [approvalOpen, tab, stack.length]);

  const chain = useMemo(() => (state ? getChain(state.chainId, state.customChains) || BUILTIN_CHAINS[0] : BUILTIN_CHAINS[0]), [state?.chainId, state?.customChains]);
  const account = useMemo(() => state?.accounts?.find((a) => a.address === state.selected) || state?.accounts?.[0], [state?.selected, state?.accounts]);
  // an account of one family only (e.g. imported from another TON app) lives on that family's networks:
  // selecting it shows its family's default network
  const accFam = accountFamily(account);
  const wrongFamily = !!account && accFam !== 'evm' && accFam !== familyOf(chain);
  useEffect(() => {
    const id = wrongFamily && driverOf(accFam)?.defaultChainId;
    if (id != null) bg('setChain', { chainId: id }).catch(() => {});
  }, [account?.address, chain.id]);

  // a crash closed the app last time (Android, later iOS): once the wallet is open, ask whether to send the report
  const walletOpen = !!state?.initialized && !!state?.unlocked && !onboarding && !needsTerms(state?.settings) && mode !== 'approve';
  useEffect(() => { if (walletOpen) crashToAsk().then(setCrashAsk).catch(() => {}); }, [walletOpen]);

  const ctx = { state, refresh, chain, account, nav, back, reset, toast, mode: approvalOpen ? 'approve' : mode, portfolioCache, setPortfolioCache, authorize, privacy,
    openPredict: mode === 'mobile' ? openPredict : null }; // Predictions exists only in the app

  let body;
  const top = stack[stack.length - 1];
  setCrashScreen(mode === 'mobile' ? `${tab}:${tab === 'wallet' ? top.name : ''}` : top.name); // recorded with an error report
  // one set of screens for every network: TON (Android app) feeds them through its driver (src/ui/ton/driver.js)
  const C = wrongFamily ? Switching // the account's own network is being selected
    : SCREENS[top.name] || driverScreens()[top.name] || Home;
  if (!state) body = <div class="screen" style={{ alignItems: 'center', justifyContent: 'center' }}><Spinner lg /></div>;
  else if (!state.initialized || onboarding) body = <Onboarding onActive={setOnboarding} />;
  else if (!state.unlocked) body = <Unlock />;
  else if (needsTerms(state.settings)) body = <TermsGate />; // terms of use not accepted yet (a wallet from before, or new terms)
  else if (mode === 'approve') body = <Approvals standalone />;
  else if (mode === 'mobile') {
    // the mobile layout stays mounted under the approval screen, so the browser keeps its page;
    // its native WebView is hidden while an approval is shown (it would otherwise cover the app)
    body = (
      <>
        {approvalOpen && <Approvals standalone />}
        <div class={`screen pane ${tab === 'wallet' ? paneAnim : ''}`} onAnimationEnd={endPane} style={{ display: !approvalOpen && tab === 'wallet' ? 'flex' : 'none' }}>
          <div class={`screen ${dir}`} ref={screenRef} key={stack.length + top.name + JSON.stringify(top.params)}><C {...top.params} /></div>
        </div>
        {(browserUsed || tab === 'browser') && (
          <div class={`screen pane ${tab === 'browser' ? paneAnim : ''}`} onAnimationEnd={endPane} style={{ display: !approvalOpen && tab === 'browser' ? 'flex' : 'none' }}>
            <Browser visible={!approvalOpen && tab === 'browser'} entering={tab === 'browser' && !!paneAnim} openUrl={openUrl} onSiteOpen={setSiteOpen} onExit={() => goTab('wallet')} />
          </div>
        )}
        {(predictUsed || tab === 'predict') && (
          <div class={`screen pane ${tab === 'predict' ? paneAnim : ''}`} onAnimationEnd={endPane} style={{ display: !approvalOpen && tab === 'predict' ? 'flex' : 'none' }}>
            {account && !isEvmAccount(account) ? <EvmOnly /> : <Predict visible={!approvalOpen && tab === 'predict'} onDeep={setPredictDeep} openReq={predictReq} />}
          </div>
        )}
        {ContractsTab && (contractsUsed || tab === 'contracts') && (
          <div class={`screen pane ${tab === 'contracts' ? paneAnim : ''}`} onAnimationEnd={endPane} style={{ display: !approvalOpen && tab === 'contracts' ? 'flex' : 'none' }}>
            <ContractsTab visible={!approvalOpen && tab === 'contracts'} onDeep={setContractsDeep} />
          </div>
        )}
        {mode === 'mobile' && (donateUsed || tab === 'donate') && (
          <div class={`screen pane ${tab === 'donate' ? paneAnim : ''}`} onAnimationEnd={endPane} style={{ display: !approvalOpen && tab === 'donate' ? 'flex' : 'none' }}>
            <Donate />
          </div>
        )}
        <ConnectQrHost />
        <TabPill tab={tab} onPick={goTab} hidden={approvalOpen || (tab === 'browser' && siteOpen) // only on the main page of each tab
          || (tab === 'wallet' && (stack.length > 1 || top.name !== 'home')) || (tab === 'predict' && predictDeep) || (tab === 'contracts' && contractsDeep)} />
      </>
    );
  } else body = <div class={`screen ${dir}`} ref={screenRef} key={stack.length + top.name + JSON.stringify(top.params)}><C {...top.params} /></div>;

  return (
    <AppCtx.Provider value={ctx}>
      {body}
      {authEl}
      {crashAsk && <CrashAsk report={crashAsk} onClose={() => setCrashAsk(null)} />}
      {toastMsg && (
        <div class={`toast ${toastMsg.kind}`} key={toastMsg.id} role="status" onClick={() => setToastMsg(null)}>
          <Icon name={toastMsg.kind === 'warn' ? 'wifiOff' : 'check'} size={18} />
          <span>{toastMsg.msg}</span>
        </div>
      )}
    </AppCtx.Provider>
  );
}

// ------------------------------------------------------------ tab pill
const Switching = () => <div class="screen" style={{ alignItems: 'center', justifyContent: 'center' }}><Spinner lg /></div>;

/** A tab that needs an Ethereum account (Predictions) while a TON-only account is selected. */
function EvmOnly() {
  return (
    <div class="screen"><div class="content" style={{ justifyContent: 'center' }}>
      <div class="card col" style={{ gap: '.5rem' }}><b>{t('accounts.evmOnly.title')}</b><span class="small muted">{t('accounts.evmOnly.body')}</span></div>
    </div></div>
  );
}

// Contracts: Android app only, registered by src/mobile/contractsTab.js (not part of the extension)
const ContractsTab = globalThis.__CK_CONTRACTS__ || null;
const TABS = [{ k: 'wallet', icon: 'wallet' }, { k: 'browser', icon: 'globe' }, { k: 'predict', icon: 'predict' }, ...(ContractsTab ? [{ k: 'contracts', icon: 'code' }] : []), { k: 'donate', icon: 'heart' }];

/**
 * Floating tab bar: the active tab is a light inner pill with its label, sliding between the icons
 * (transform only: it stays smooth while a heavy site keeps the renderer busy). Hidden while the browser shows a site.
 */
function TabPill({ tab, hidden, onPick }) {
  const i = Math.max(0, TABS.findIndex((x) => x.k === tab));
  useEffect(() => {
    document.body.classList.toggle('pill-on', !hidden);
    return () => document.body.classList.remove('pill-on');
  }, [hidden]);
  return (
    <nav class={`tabpill ${hidden ? 'away' : ''}`} style={{ '--i': i, '--n': TABS.length }} aria-hidden={hidden ? 'true' : undefined}>
      <span class="tabpill-hl" aria-hidden="true" />
      {TABS.map((x, n) => (
        <button key={x.k} class={n === i ? 'on' : ''} tabIndex={hidden ? -1 : 0} aria-label={t(`tabs.${x.k}`)} aria-current={n === i ? 'page' : undefined} onClick={() => onPick(x.k)}>
          <Icon name={x.icon} size={19} /><span class="lbl">{t(`tabs.${x.k}`)}</span>
        </button>
      ))}
    </nav>
  );
}

