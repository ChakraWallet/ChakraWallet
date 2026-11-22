import { useEffect, useMemo, useRef, useState } from 'react';
import { rosette } from './guilloche.js';
import { ChainLogo } from './chainLogos.jsx';
import gb from 'flag-icons/flags/1x1/gb.svg';
import it from 'flag-icons/flags/1x1/it.svg';
import es from 'flag-icons/flags/1x1/es.svg';
import fr from 'flag-icons/flags/1x1/fr.svg';
import de from 'flag-icons/flags/1x1/de.svg';
import ru from 'flag-icons/flags/1x1/ru.svg';
import cn from 'flag-icons/flags/1x1/cn.svg';

// Store / download links: replace with the real ones before publishing.
const LINKS = {
  ios: '#download',
  android: '#download',
  chrome: '#download',
  firefox: '#download',
  github: 'https://github.com/ChakraWallet/ChakraWallet', // the GitHub repository
};

const shot = (name) => `${import.meta.env.BASE_URL}shots/${name}.jpg`;

/* ------------------------------------------------------------------ icons */
const I = {
  apple: <path d="M16.37 12.6c-.02-2.3 1.88-3.4 1.96-3.46-1.07-1.56-2.73-1.78-3.32-1.8-1.41-.14-2.76.83-3.48.83-.72 0-1.82-.81-3-.79-1.54.02-2.96.9-3.76 2.27-1.6 2.78-.41 6.9 1.15 9.16.76 1.1 1.67 2.34 2.86 2.3 1.15-.05 1.58-.74 2.97-.74 1.38 0 1.77.74 2.98.72 1.23-.02 2.01-1.12 2.76-2.23.87-1.28 1.23-2.52 1.25-2.58-.03-.01-2.4-.92-2.37-3.68zM14.1 5.86c.63-.77 1.06-1.83.94-2.89-.91.04-2.01.61-2.66 1.37-.58.67-1.1 1.76-.96 2.8 1.01.08 2.05-.52 2.68-1.28z" fill="currentColor" />,
  play: <path d="M4.6 2.9c-.3.3-.5.8-.5 1.4v15.4c0 .6.2 1.1.5 1.4l8.6-9.1L4.6 2.9zm9.6 10.2 2.6 2.7-10.4 6c-.5.3-1 .3-1.3.1l9.1-8.8zm3.7-3.9 2.9 1.7c.9.5.9 1.4 0 1.9l-2.9 1.7-2.8-2.7 2.8-2.6zM6.4 2.2l10.4 6-2.6 2.7-9.1-8.8c.3-.2.8-.2 1.3.1z" fill="currentColor" />,
  puzzle: <path d="M10 3.5a2 2 0 0 1 4 0V5h3.5A1.5 1.5 0 0 1 19 6.5V10h-1.5a2 2 0 0 0 0 4H19v3.5a1.5 1.5 0 0 1-1.5 1.5H14v-1.5a2 2 0 0 0-4 0V19H6.5A1.5 1.5 0 0 1 5 17.5V14h1.5a2 2 0 0 0 0-4H5V6.5A1.5 1.5 0 0 1 6.5 5H10V3.5z" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinejoin="round" />,
  key: <><circle cx="8" cy="15" r="4" /><path d="m11 12 8-8m-3 3 2.5 2.5M14 9l2 2" /></>,
  finger: <path d="M12 11v3a8 8 0 0 1-1.2 4.2M8.5 8.6A4 4 0 0 1 16 11v1.5m-.3 4.2c-.3 1-.7 2-1.2 2.8M5.6 7.7A8 8 0 0 1 20 11v1M4.2 12a7.8 7.8 0 0 0 .3-3M8 11v1a10 10 0 0 1-1.6 5.4" />,
  check: <path d="m5 12.5 4.5 4.5L19 7.5" />,
  shield: <><path d="M12 3 5 6v5.5c0 4.3 2.9 8.2 7 9.5 4.1-1.3 7-5.2 7-9.5V6l-7-3z" /><path d="m9 12 2 2 4-4" /></>,
  file: <><path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8l-5-5z" /><path d="M14 3v5h5M9 13h6M9 17h4" /></>,
  eyeOff: <><path d="M3 3l18 18M10.6 5.1A9.9 9.9 0 0 1 12 5c5 0 9 5 9 7a9.4 9.4 0 0 1-2.4 3.3M6.6 6.6C4.4 8 3 10.4 3 12c0 2 4 7 9 7a9.3 9.3 0 0 0 5.4-1.6" /><path d="M9.9 9.9a3 3 0 0 0 4.2 4.2" /></>,
  sparkle: <path d="M12 3v4m0 10v4M3 12h4m10 0h4M6 6l2.5 2.5m7 7L18 18M6 18l2.5-2.5m7-7L18 6" />,
  arrow: <path d="M5 12h14m-6-6 6 6-6 6" />,
  github: <path fill="currentColor" stroke="none" d="M12 2a10 10 0 0 0-3.16 19.49c.5.09.68-.22.68-.48v-1.7c-2.78.6-3.37-1.34-3.37-1.34-.45-1.16-1.11-1.47-1.11-1.47-.91-.62.07-.6.07-.6 1 .07 1.53 1.03 1.53 1.03.9 1.52 2.34 1.08 2.91.83.09-.65.35-1.09.63-1.34-2.22-.25-4.55-1.11-4.55-4.94 0-1.09.39-1.98 1.03-2.68-.1-.25-.45-1.27.1-2.64 0 0 .84-.27 2.75 1.02a9.6 9.6 0 0 1 5 0c1.91-1.29 2.75-1.02 2.75-1.02.55 1.37.2 2.39.1 2.64.64.7 1.03 1.59 1.03 2.68 0 3.84-2.34 4.68-4.57 4.93.36.31.68.92.68 1.85v2.74c0 .27.18.58.69.48A10 10 0 0 0 12 2z" />,
  heart: <path d="M19 14c1.49-1.46 3-3.21 3-5.5A5.5 5.5 0 0 0 16.5 3c-1.76 0-3 .5-4.5 2-1.5-1.5-2.74-2-4.5-2A5.5 5.5 0 0 0 2 8.5c0 2.3 1.5 4.05 3 5.5l7 7z" />,
};
function Icon({ name, size = 22, stroke = true }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden="true"
      fill="none" stroke={stroke ? 'currentColor' : 'none'} strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
      {I[name]}
    </svg>
  );
}

/* ------------------------------------------------------------------ guilloche (the app's motif, src/guilloche.js) */
function Guilloche({ className }) {
  const paths = useMemo(() => [rosette(29, 9, 0.62), rosette(31, 12, 0.48), rosette(23, 7, 0.8)], []);
  return (
    <svg className={className} viewBox="-520 -520 1040 1040" aria-hidden="true">
      {paths.map((d, i) => <path key={i} d={d} fill="none" stroke="currentColor" strokeWidth={0.7} opacity={0.55 - i * 0.12} />)}
    </svg>
  );
}

/* ------------------------------------------------------------------ phone */
function Phone({ src, dark, alt, className = '', eager }) {
  return (
    <div className={`phone ${dark ? 'dark' : ''} ${className}`}>
      <div className="phone-screen">
        <div className="status">
          <span>9:41</span>
          <span className="island" />
          <span className="status-r">
            <svg width="17" height="11" viewBox="0 0 17 11"><rect x="0" y="7" width="3" height="4" rx="1" /><rect x="4.5" y="5" width="3" height="6" rx="1" /><rect x="9" y="2.5" width="3" height="8.5" rx="1" /><rect x="13.5" y="0" width="3" height="11" rx="1" /></svg>
            <svg width="25" height="12" viewBox="0 0 25 12"><rect x=".5" y=".5" width="21" height="11" rx="3.2" fill="none" stroke="currentColor" opacity=".4" /><rect x="2" y="2" width="16" height="8" rx="2" /><rect x="22.6" y="4" width="1.6" height="4" rx=".8" opacity=".4" /></svg>
          </span>
        </div>
        <img src={src} alt={alt} loading={eager ? 'eager' : 'lazy'} decoding="async" />
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ store buttons */
function StoreButtons({ compact }) {
  const items = [
    { k: 'ios', icon: 'apple', top: 'Download on the', name: 'App Store', fill: true },
    { k: 'android', icon: 'play', top: 'Get it for', name: 'Android', fill: true },
    { k: 'chrome', icon: 'puzzle', top: 'Add to', name: 'Chrome', fill: false },
    { k: 'firefox', icon: 'puzzle', top: 'Add to', name: 'Firefox', fill: false },
  ];
  return (
    <div className={`stores ${compact ? 'compact' : ''}`}>
      {items.map((x) => (
        <a key={x.k} className="store" href={LINKS[x.k]}>
          <Icon name={x.icon} size={24} stroke={!x.fill} />
          <span><small>{x.top}</small><b>{x.name}</b></span>
        </a>
      ))}
    </div>
  );
}

/* ------------------------------------------------------------------ reveal on scroll */
function useReveal() {
  useEffect(() => {
    const els = document.querySelectorAll('.reveal');
    if (!('IntersectionObserver' in window)) { els.forEach((e) => e.classList.add('in')); return undefined; }
    const io = new IntersectionObserver((entries) => entries.forEach((e) => {
      if (e.isIntersecting) { e.target.classList.add('in'); io.unobserve(e.target); }
    }), { rootMargin: '0px 0px -10% 0px' });
    els.forEach((e) => io.observe(e));
    return () => io.disconnect();
  }, []);
}

/* ------------------------------------------------------------------ sections */
function Nav() {
  const [scrolled, setScrolled] = useState(false);
  useEffect(() => {
    const on = () => setScrolled(window.scrollY > 8);
    on(); window.addEventListener('scroll', on, { passive: true });
    return () => window.removeEventListener('scroll', on);
  }, []);
  return (
    <header className={`nav ${scrolled ? 'scrolled' : ''}`}>
      <div className="wrap nav-in">
        <a className="brand" href="#top"><img src={`${import.meta.env.BASE_URL}icon.png`} alt="" width="32" height="32" />Chakra</a>
        <nav className="nav-links">
          <a href="#features">Features</a>
          <a href="#security">Security</a>
          <a href="#networks">Networks</a>
          <a href="#open-source">Open source</a>
        </nav>
        <a className="btn btn-primary btn-sm" href="#download">Get Chakra</a>
      </div>
    </header>
  );
}

function Hero() {
  return (
    <section className="hero" id="top">
      <Guilloche className="hero-rosette" />
      <div className="wrap hero-in">
        <div className="hero-copy">
          <span className="eyebrow"><span className="dot" />Free &amp; open source · iPhone · Android · Chrome · Firefox</span>
          <h1>Your crypto,<br /><span className="ink">beautifully clear.</span></h1>
          <p className="lede">
            Chakra is a self-custodial wallet for Ethereum, every major EVM network, TON, Solana, Tron and Bitcoin. Send, swap at the best price,
            bridge and explore web3 — your keys never leave your device.
          </p>
          <StoreButtons />
          <ul className="hero-points">
            <li><Icon name="check" size={18} />Free &amp; open source</li>
            <li><Icon name="check" size={18} />No servers of our own</li>
            <li><Icon name="check" size={18} />No extra fees</li>
            <li><Icon name="check" size={18} />MetaMask compatible</li>
          </ul>
        </div>
        <div className="hero-phones">
          <Phone src={shot('home-dark')} dark alt="Chakra wallet home screen in dark mode" className="back" eager />
          <Phone src={shot('home')} alt="Chakra wallet home screen with balances on Ethereum" className="front" eager />
          <div className="float-card fc-1"><Icon name="shield" size={18} />Keys encrypted on device</div>
          <div className="float-card fc-2"><span className="pill-green">Best</span>4 swap aggregators compared</div>
        </div>
      </div>
    </section>
  );
}

const STATS = [
  { v: '11', l: 'networks built in, plus your own' },
  { v: '8', l: 'swap & bridge providers compared' },
  { v: '0', l: 'extra fees, ever' },
  { v: '600k', l: 'PBKDF2 rounds on your password' },
];
function Stats() {
  return (
    <section className="stats">
      <div className="wrap stats-in">
        {STATS.map((s) => <div key={s.l} className="stat reveal"><b>{s.v}</b><span>{s.l}</span></div>)}
      </div>
    </section>
  );
}

const FEATURES = [
  {
    id: 'accounts', kicker: 'Portfolio', title: 'Every account. Every network. One number.',
    text: 'Separate wallets, accounts from your recovery phrase or imported keys — all summed across Ethereum, Base, Arbitrum, Optimism, Polygon and more. Each account gets its own colours, the same everywhere.',
    points: ['Tokens found automatically, with USD value', 'Spam and look-alike tokens filtered out', 'Custom vanity addresses, generated on your device'],
    img: 'accounts',
  },
  {
    id: 'nfts', kicker: 'NFTs', title: 'Your collectibles, next to your tokens.',
    text: 'The NFTs you own on Ethereum, Base, Arbitrum, Optimism, Polygon, BNB Chain, Avalanche, Gnosis, TON, Solana and Tron appear right under your tokens, with their artwork, collection and details.',
    points: ['Scam airdrops and fake brand collections hidden', 'Spam artwork never loaded, so it can’t track you', 'Details and explorer link in one tap'],
    img: 'nfts',
  },
  {
    id: 'swap', kicker: 'Swap & Bridge', title: 'The best price, not the first price.',
    text: 'Chakra asks KyberSwap, Velora, OpenOcean and LI.FI at the same time and ranks routes by what you actually receive after network fees. On Solana, Jupiter compares every exchange for you; on Tron, SUN.io’s Smart Router. Bridges compare LI.FI, Relay, Across and deBridge the same way — Solana, Tron and Bitcoin included.',
    points: ['Approvals for the exact amount — never unlimited', 'MEV protection: Flashbots on Ethereum, Jito on Solana', 'Bridge transfers tracked until they arrive'],
    img: 'swap',
  },
  {
    id: 'mmcard', kicker: 'MetaMask Card', title: 'Your card, right behind your balance.',
    text: 'Have a MetaMask Card? On Linea and Base, Chakra finds it from the blockchain and puts it behind your balance card: what you can spend now, the payments you made, and a top-up from any network in a few taps. No sign-in, nothing shared.',
    points: ['Spending limits per token: change or revoke them', 'Card payments recognised in your history', 'Top up through the best bridge, to Linea or Base'],
    img: 'mmcard',
  },
  {
    id: 'predict', kicker: 'Predictions', title: 'Markets on what happens next.',
    text: 'Browse prediction markets, follow live probabilities and charts, and keep your positions right next to your tokens. A personal feed learns what you care about.',
    points: ['Live prices and history charts', 'Positions and P&L in your portfolio', 'Redeem all your winnings in one tap'],
    img: 'predict',
  },
  {
    id: 'tron', kicker: 'Tron', title: 'Tron, without the surprises.',
    text: 'On Tron fees are energy and bandwidth, not gas. Chakra shows what you have and what every send costs before you sign — then lets you stake TRX, rent energy from JustLend, vote for Super Representatives and delegate resources, from one page.',
    points: ['Energy and bandwidth at a glance, refilling in real time', 'Renting vs burning TRX compared before you pay', 'Account takeovers (permission changes) always blocked'],
    img: 'tron', // shots/capture.mjs tron
  },
  {
    id: 'bitcoin', kicker: 'Bitcoin', title: 'Bitcoin, the whole wallet.',
    text: 'Every account is a complete Bitcoin wallet: Native SegWit and Taproot addresses, a fresh one for every payment and change kept apart — restore the phrase in Sparrow or BlueWallet and the same funds are there. Coins that may carry an Ordinals inscription or Runes are kept out of ordinary sends.',
    points: ['Fees in sat/vB, or a rate of your own', 'Speed up or cancel a stuck payment — or one on its way in', 'Coin control, and watch-only export for other wallets'],
    img: 'bitcoin', // shots/capture.mjs bitcoin
  },
  {
    id: 'history', kicker: 'History', title: 'A history you can actually read.',
    text: 'Transactions grouped by day, with clear labels for sends, receives, swaps and bridges, fees paid and explorer links. Address-poisoning fakes and spam never make it to the list.',
    points: ['Filters for sent, received and swaps', 'Bridges recognised, even when made elsewhere', 'Pending transactions shown instantly'],
    img: 'activity',
  },
  {
    id: 'contracts', kicker: 'Builders', title: 'Deploy contracts from your pocket.',
    text: 'Create tokens, NFTs and multi-token contracts from templates, write your own in Solidity or Tact, deploy a Solana program you compiled, deploy Solidity on Tron too, or open any contract or program by address and call it with a form built from its ABI or IDL.',
    points: ['Solidity and Tact compilers on device', 'TON jettons and NFTs, Solana tokens and NFT collections', 'Decode any calldata or transaction before you sign'],
    img: 'contracts',
  },
  {
    id: 'browser', kicker: 'Dapp browser', title: 'All of web3, already connected.',
    text: 'Multiple tabs, previews and favicons, with Chakra built in. Sites find Chakra by name — and the older ones that only know MetaMask (or TronLink, on Tron) work too — so “Connect wallet” just works — and every connection, signature and transaction waits for your approval.',
    points: ['Certificate details behind the padlock', 'Disconnect a site and clear its data in a tap', 'Warnings on permits and unlimited approvals'],
    img: 'browser',
  },
];
/** The features one after another (no scroll pinning: reduced motion, very short screens). */
function FeatureList() {
  return (
    <section className="features" id="features">
      <div className="wrap">
        <div className="section-head reveal">
          <span className="kicker">Features</span>
          <h2>Everything a wallet should do.<br />Nothing it shouldn’t.</h2>
        </div>
        {FEATURES.map((f, i) => (
          <article key={f.id} className={`feature ${i % 2 ? 'flip' : ''}`}>
            <div className="feature-copy reveal">
              <span className="kicker">{f.kicker}</span>
              <h3>{f.title}</h3>
              <p>{f.text}</p>
              <ul>{f.points.map((p) => <li key={p}><Icon name="check" size={18} />{p}</li>)}</ul>
            </div>
            <div className="feature-visual reveal">
              <div className="glow" />
              <Phone src={shot(f.img)} alt={`${f.kicker} screen of the Chakra app`} />
            </div>
          </article>
        ))}
      </div>
    </section>
  );
}

const STEP_VH = 100; // page scroll per feature (% of the screen height)
const clamp01 = (x) => Math.min(1, Math.max(0, x));
const ease = (x) => x * x * (3 - 2 * x); // smoothstep

/**
 * Features, driven by the scroll like the gallery: the stage stays on screen and every movement follows the page.
 * Each feature's phone comes in from its own side (right, then left, then right...) with a slight turn, its text
 * from the other side; it holds while it floats a little; then it rises and fades as the next one comes in.
 */
function Features() {
  const outer = useRef(null), layers = useRef([]), bar = useRef(null), count = useRef(null);
  const [pinned, setPinned] = useState(false);
  const n = FEATURES.length;
  useEffect(() => {
    const reduce = window.matchMedia('(prefers-reduced-motion: reduce)');
    const check = () => setPinned(!reduce.matches && window.innerHeight >= 600);
    check();
    reduce.addEventListener?.('change', check); window.addEventListener('resize', check);
    return () => { reduce.removeEventListener?.('change', check); window.removeEventListener('resize', check); };
  }, []);
  useEffect(() => {
    if (!pinned) return undefined;
    let raf = 0;
    const update = () => {
      raf = 0;
      const el = outer.current, room = el.offsetHeight - window.innerHeight;
      const p = clamp01(-el.getBoundingClientRect().top / Math.max(1, room));
      const raw = p * (n - 1), k = Math.min(n - 2, Math.floor(raw)), u = raw - k;
      // in each stretch the change takes the middle 60%: a short hold before and after
      const s = k + ease(clamp01((u - 0.2) / 0.6));
      const vw = window.innerWidth, narrow = vw < 900;
      layers.current.forEach((L, i) => {
        if (!L) return;
        const o = s - i; // 0: on stage; -1: next (outside); +1: gone
        const side = i % 2 ? -1 : 1; // the phone's side: right, left, right...
        const vis = Math.abs(o) < 1;
        L.root.style.visibility = vis && Math.abs(o) < 0.6 ? 'visible' : 'hidden'; // a short overlap: never an empty stage
        if (!vis) return;
        const float = Math.sin((raw - i) * Math.PI) * 10; // a slight float while on stage
        let ph, tx;
        if (o <= 0) { // coming in, as the previous one is almost gone
          const e = clamp01(-o / 0.6);
          ph = `translate3d(${side * e * (narrow ? 70 : 42)}vw, ${e * 40 + float}px, 0) rotate(${side * e * 9}deg) scale(${1 - e * 0.06})`;
          tx = `translate3d(${-side * e * (narrow ? 40 : 16)}vw, 0, 0)`;
          L.phone.style.opacity = String(1 - e * 0.9);
          L.copy.style.opacity = String(1 - e * 1.4);
        } else { // leaving first: up and away
          const e = clamp01(o / 0.6);
          ph = `translate3d(0, ${-e * (narrow ? 30 : 38)}vh, 0) rotate(${-side * e * 4}deg) scale(${1 - e * 0.12})`;
          tx = `translate3d(0, ${-e * 120}px, 0)`;
          L.phone.style.opacity = String(1 - e);
          L.copy.style.opacity = String(1 - e * 1.4);
        }
        L.phone.style.transform = ph;
        L.copy.style.transform = tx;
        L.root.style.zIndex = String(o <= 0 ? 2 : 1);
      });
      if (bar.current) bar.current.style.transform = `scaleX(${p})`;
      if (count.current) count.current.textContent = String(Math.min(n, Math.round(s) + 1)).padStart(2, '0');
    };
    const onScroll = () => { if (!raf) raf = requestAnimationFrame(update); };
    update();
    window.addEventListener('scroll', onScroll, { passive: true });
    window.addEventListener('resize', onScroll);
    return () => { window.removeEventListener('scroll', onScroll); window.removeEventListener('resize', onScroll); cancelAnimationFrame(raf); };
  }, [pinned]);
  if (!pinned) return <FeatureList />;
  return (
    <section className="features fx" id="features">
      <div className="wrap section-head reveal">
        <span className="kicker">Features</span>
        <h2>Everything a wallet should do.<br />Nothing it shouldn’t.</h2>
      </div>
      <div className="fx-track" ref={outer} style={{ height: `calc(100vh + ${(n - 1) * STEP_VH}vh)` }}>
        <div className="fx-pin">
          <div className="wrap fx-stage">
            {FEATURES.map((f, i) => (
              <article key={f.id} className={`fx-layer ${i % 2 ? 'flip' : ''}`}
                ref={(r) => { if (r) layers.current[i] = { root: r, phone: r.querySelector('.fx-visual'), copy: r.querySelector('.fx-copy') }; }}>
                <div className="fx-copy">
                  <span className="kicker">{f.kicker}</span>
                  <h3>{f.title}</h3>
                  <p>{f.text}</p>
                  <ul>{f.points.map((x) => <li key={x}><Icon name="check" size={18} />{x}</li>)}</ul>
                </div>
                <div className="fx-visual">
                  <div className="glow" />
                  <Phone src={shot(f.img)} alt={`${f.kicker} screen of the Chakra app`} eager={i < 2} />
                </div>
              </article>
            ))}
          </div>
          <div className="wrap fx-foot" aria-hidden="true">
            <span className="fx-count"><b ref={count}>01</b> / {String(n).padStart(2, '0')}</span>
            <span className="fx-bar"><i ref={bar} /></span>
          </div>
        </div>
      </div>
    </section>
  );
}

const GALLERY = [
  ['home', false, 'Home'], ['mmcard-dark', true, 'MetaMask Card · dark'], ['nfts-dark', true, 'NFTs · dark'], ['predict-dark', true, 'Predictions · dark'], ['receive', false, 'Receive'], ['swap-dark', true, 'Swap · dark'],
  ['send', false, 'Send'], ['mmcardManage', false, 'Card limits'], ['activity', false, 'Activity'], ['accounts', false, 'Accounts'], ['contracts', false, 'Contracts'], ['donate-dark', true, 'Support · dark'],
];
/**
 * Light & dark: the screens move from right to left as the page scrolls down. The section stays pinned (sticky)
 * while the strip crosses it, then the page goes on. Without room to scroll (wide screens) or with reduced motion,
 * a plain horizontal strip.
 */
function Gallery() {
  const outer = useRef(null), track = useRef(null), bar = useRef(null);
  const [dist, setDist] = useState(0); // how far the strip travels (px); 0 = not pinned
  useEffect(() => {
    const reduce = window.matchMedia('(prefers-reduced-motion: reduce)');
    const measure = () => {
      const t = track.current;
      if (!t) return;
      // to the last screen's right edge plus the strip's end padding (scrollWidth leaves that padding out)
      const last = t.lastElementChild;
      const end = last ? last.offsetLeft + last.offsetWidth + parseFloat(getComputedStyle(t).paddingRight || 0) : t.scrollWidth;
      setDist(reduce.matches ? 0 : Math.max(0, Math.round(end - t.clientWidth)));
    };
    measure();
    const ro = new ResizeObserver(measure); ro.observe(track.current);
    reduce.addEventListener?.('change', measure);
    window.addEventListener('resize', measure);
    return () => { ro.disconnect(); reduce.removeEventListener?.('change', measure); window.removeEventListener('resize', measure); };
  }, []);
  useEffect(() => {
    if (!dist) { if (track.current) track.current.style.transform = ''; return undefined; }
    let raf = 0;
    const update = () => {
      raf = 0;
      const el = outer.current, room = el.offsetHeight - window.innerHeight;
      const p = Math.min(1, Math.max(0, -el.getBoundingClientRect().top / Math.max(1, room)));
      track.current.style.transform = `translate3d(${-p * dist}px, 0, 0)`;
      if (bar.current) bar.current.style.transform = `scaleX(${p})`;
    };
    const onScroll = () => { if (!raf) raf = requestAnimationFrame(update); };
    update();
    window.addEventListener('scroll', onScroll, { passive: true });
    return () => { window.removeEventListener('scroll', onScroll); cancelAnimationFrame(raf); };
  }, [dist]);
  // arrows: one screen further, by scrolling the page (pinned) or the strip itself
  const by = (d) => {
    const t = track.current, step = (t.firstElementChild?.offsetWidth || 280) + 28;
    if (!dist) { t.scrollBy({ left: d * step, behavior: 'smooth' }); return; }
    const room = outer.current.offsetHeight - window.innerHeight;
    window.scrollBy({ top: d * step * (room / dist), behavior: 'smooth' });
  };
  return (
    <section className={`gallery ${dist ? 'pinned' : ''}`} ref={outer} style={dist ? { height: `calc(100vh + ${dist}px)` } : undefined}>
      <div className="gallery-pin">
        <div className="wrap gallery-head">
          <div className="reveal">
            <span className="kicker">Light & dark</span>
            <h2>Designed down to the last pixel.</h2>
          </div>
          <div className="gallery-nav">
            <button onClick={() => by(-1)} aria-label="Previous screens"><span style={{ transform: 'scaleX(-1)', display: 'inline-flex' }}><Icon name="arrow" size={20} /></span></button>
            <button onClick={() => by(1)} aria-label="Next screens"><Icon name="arrow" size={20} /></button>
          </div>
        </div>
        <div className="gallery-track" ref={track}>
          {GALLERY.map(([img, dark, label]) => (
            <figure key={img}>
              <Phone src={shot(img)} dark={dark} alt={`${label} screen of the Chakra app`} />
              <figcaption>{label}</figcaption>
            </figure>
          ))}
        </div>
        {dist > 0 && <div className="wrap gallery-progress" aria-hidden="true"><i ref={bar} /></div>}
      </div>
    </section>
  );
}

const SECURITY = [
  { icon: 'key', title: 'One password, strong crypto', text: 'Every key is encrypted with PBKDF2-SHA256 (600,000 rounds) and AES-256-GCM. Decrypted keys live only in memory while unlocked.' },
  { icon: 'finger', title: 'Face ID & fingerprint', text: 'Unlock and approve with biometrics. Every send, swap and signature still needs your authorization.' },
  { icon: 'shield', title: 'Approvals that protect you', text: 'Exact-amount approvals only, clear warnings for permits and unlimited allowances, and raw signing off by default.' },
  { icon: 'file', title: 'Encrypted backup', text: 'Export a wallet as a single line of encrypted text and restore it on any device — phone or browser.' },
  { icon: 'eyeOff', title: 'No account, no tracking', text: 'No sign-up and no servers of our own. Balances, prices and quotes come straight from public services.' },
  { icon: 'sparkle', title: 'Auto-lock', text: 'Chakra locks itself after the time you choose, and again when your phone has been asleep too long.' },
];
function Security() {
  return (
    <section className="security" id="security">
      <Guilloche className="sec-rosette" />
      <div className="wrap">
        <div className="section-head reveal">
          <span className="kicker">Security</span>
          <h2>Self-custody, without the anxiety.</h2>
          <p>Your recovery phrase and keys are created and stored on your device. Nobody else — not even us — can move your funds.</p>
        </div>
        <div className="sec-grid">
          {SECURITY.map((s) => (
            <div key={s.title} className="sec-card reveal">
              <span className="sec-ic"><Icon name={s.icon} size={22} /></span>
              <h3>{s.title}</h3>
              <p>{s.text}</p>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}

// The wheel of networks: [name, id of its mark in chainLogos.jsx (the app's own ids), null: no mark]. Inner orbit: the
// EVM networks, everywhere; outer orbit: the other families (mobile apps) and the networks you add.
const INNER = [['Ethereum', 1], ['Base', 8453], ['Arbitrum', 42161], ['Optimism', 10], ['Polygon', 137], ['BNB Chain', 56], ['Avalanche', 43114], ['Gnosis', 100], ['Linea', 59144]];
const OUTER = [['TON', -239], ['Solana', -501], ['Tron', -195], ['Bitcoin', -8333], ['Your networks', null]];
function Orbit({ list, kind }) {
  return (
    <div className={`orbit ${kind}`} style={{ '--n': list.length }}>
      {list.map(([n, id], i) => (
        <div key={n} className="sat" style={{ '--i': i }}>
          <div className="sat-in">
            <span className={`sat-mark ${id == null ? 'ghost' : ''}`}>{id != null ? <ChainLogo id={id} size={56} /> : <span className="sat-plus" aria-hidden="true">+</span>}</span>
            <span className="sat-name">{n}</span>
          </div>
        </div>
      ))}
    </div>
  );
}
function Networks() {
  return (
    <section className="networks" id="networks">
      <div className="wrap">
        <div className="section-head reveal">
          <span className="kicker">Networks</span>
          <h2>One wallet, many chains.</h2>
          <p>All the major EVM networks built in, TON, Solana, Tron and Bitcoin in the mobile apps, and any EVM network you add yourself — or that a dapp asks for.</p>
        </div>
        <div className="wheel reveal" role="img" aria-label={[...INNER, ...OUTER].map(([n]) => n).join(', ')}>
          <Guilloche className="wheel-rosette" />
          <div className="wheel-hub"><img src={`${import.meta.env.BASE_URL}icon.png`} alt="" width="104" height="104" /></div>
          <Orbit list={INNER} kind="inner" />
          <Orbit list={OUTER} kind="outer" />
        </div>
      </div>
    </section>
  );
}

// The languages of the app, as in src/shared/i18n.js LANGUAGES: [code, name in the language itself, English name, flag]
const LANGUAGES = [
  ['en', 'English', 'English', gb], ['es', 'Español', 'Spanish', es], ['fr', 'Français', 'French', fr], ['it', 'Italiano', 'Italian', it],
  ['de', 'Deutsch', 'German', de], ['ru', 'Русский', 'Russian', ru], ['zh-CN', '简体中文', 'Chinese', cn],
];
function Languages() {
  return (
    <section className="langs" id="languages">
      <div className="wrap">
        <div className="section-head reveal">
          <span className="kicker">Languages</span>
          <h2>Speaks your language.</h2>
          <p>Chakra is translated into {LANGUAGES.length} languages. It follows your phone’s language on its own — or pick another one in Settings, any time.</p>
        </div>
        <ul className="lang-row reveal">
          {LANGUAGES.map(([code, name, en, flag]) => (
            <li key={code} className="lang-chip">
              <img src={flag} alt="" width="40" height="40" />
              <span><b lang={code}>{name}</b>{name !== en && <small>{en}</small>}</span>
            </li>
          ))}
        </ul>
      </div>
    </section>
  );
}

function OpenSource() {
  return (
    <section className="oss" id="open-source">
      <div className="wrap oss-in">
        <div className="oss-copy reveal">
          <span className="kicker">Open source</span>
          <h2>Free. Open source.<br />Built in the open.</h2>
          <p>
            Chakra costs nothing and never will: no fees on top, no ads, no account. The whole code is on GitHub, so anyone
            can read how your keys are handled, build it themselves, report a bug or suggest an idea.
          </p>
          <p>
            If Chakra is useful to you, the <b>Support</b> tab in the app lets you leave a small donation — any token, on any
            network, from any of your accounts. It opens the usual Send screen, with the fee shown before you confirm.
          </p>
          <div className="oss-btns">
            <a className="btn btn-dark" href={LINKS.github}><Icon name="github" size={20} stroke={false} />View on GitHub</a>
            <a className="btn btn-ghost" href="#download"><Icon name="heart" size={18} />Get the app</a>
          </div>
        </div>
        <div className="feature-visual reveal">
          <div className="glow" />
          <Phone src={shot('donate')} alt="Support screen of the Chakra app, for donations to the project" />
        </div>
      </div>
    </section>
  );
}

const PLATFORMS = [
  { k: 'ios', icon: 'apple', fill: true, name: 'iPhone', text: 'The full Chakra app for iOS, with Face ID.', cta: 'App Store' },
  { k: 'android', icon: 'play', fill: true, name: 'Android', text: 'Dapp browser, predictions, contracts and fingerprint unlock.', cta: 'Download for Android' },
  { k: 'chrome', icon: 'puzzle', name: 'Chrome & Chromium', text: 'Extension for Chrome, Edge, Brave and Opera.', cta: 'Add to Chrome' },
  { k: 'firefox', icon: 'puzzle', name: 'Firefox', text: 'Extension for Firefox 128 and later.', cta: 'Add to Firefox' },
];
function Download() {
  return (
    <section className="download" id="download">
      <div className="wrap">
        <div className="dl-card reveal">
          <Guilloche className="dl-rosette" />
          <div className="dl-head">
            <img src={`${import.meta.env.BASE_URL}icon.png`} alt="" width="88" height="88" />
            <h2>Get Chakra</h2>
            <p>Free on every platform, and open source. Restore the same wallet anywhere with your recovery phrase or an encrypted backup.</p>
          </div>
          <div className="dl-grid">
            {PLATFORMS.map((p) => (
              <a key={p.k} className="dl-item" href={LINKS[p.k]}>
                <Icon name={p.icon} size={28} stroke={!p.fill} />
                <b>{p.name}</b>
                <span>{p.text}</span>
                <em>{p.cta} <Icon name="arrow" size={16} /></em>
              </a>
            ))}
          </div>
        </div>
      </div>
    </section>
  );
}

function Footer() {
  return (
    <footer className="footer">
      <div className="wrap footer-in">
        <a className="brand" href="#top"><img src={`${import.meta.env.BASE_URL}icon.png`} alt="" width="28" height="28" />Chakra</a>
        <p>Free and open source. Self-custodial: you are responsible for your recovery phrase. Screenshots show demo data. MetaMask and MetaMask Card are trademarks of their respective owners: Chakra is not affiliated with, endorsed or sponsored by MetaMask, Consensys, Baanx or Mastercard, and shows the card only as a compatibility.</p>
        <a className="foot-link" href="terms.html">Terms</a>
        <a className="foot-link" href="privacy.html">Privacy</a>
        <a className="foot-gh" href={LINKS.github}><Icon name="github" size={18} stroke={false} />GitHub</a>
        <span>© {new Date().getFullYear()} Chakra</span>
      </div>
    </footer>
  );
}

export default function App() {
  useReveal();
  return (
    <>
      <Nav />
      <main>
        <Hero />
        <Stats />
        <Features />
        <Gallery />
        <Security />
        <Networks />
        <Languages />
        <OpenSource />
        <Download />
      </main>
      <Footer />
    </>
  );
}
