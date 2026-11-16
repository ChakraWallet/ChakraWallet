// Support tab (Android app): Chakra is free and open source; a small donation of anything, from any account, on any
// network. The donation itself goes through the normal Send screen, with the recipient filled in.
import { useState } from 'preact/hooks';
import { bg } from '../../shared/ext.js';
import { shortAddr } from '../../shared/format.js';
import { DONATE } from '../../shared/donate.js';
import { t } from '../../shared/i18n.js';
import { Icon, Btn, Sheet, Avatar, ChainIcon, AppIcon, Guilloche, CopyBtn, useApp } from '../components.jsx';
import { familyOf } from '../chains/index.js';
import { NetworkSheet } from './home.jsx';

function AccountSheet({ onClose }) {
  const { state, account } = useApp();
  const pick = async (a) => { await bg('selectAccount', { address: a.address }); onClose(); };
  return (
    <Sheet title={t('donate.fromAccount')} onClose={onClose}>
      <div class="list">
        {state.accounts.map((a) => (
          <button class="item" onClick={() => pick(a)}>
            <Avatar address={a.address} />
            <div class="grow" style={{ minWidth: 0 }}><div class="bold ellipsis">{a.name}</div><div class="tiny muted">{shortAddr(a.address)}</div></div>
            {a.address === account.address && <span class="green"><Icon name="check" /></span>}
          </button>
        ))}
      </div>
    </Sheet>
  );
}

export function Donate() {
  const { chain, account, nav, toast } = useApp();
  const [sheet, setSheet] = useState(null);
  const to = DONATE[familyOf(chain)] || ''; // one address per family of networks
  const repo = DONATE.repo;
  const share = async () => {
    const text = t('donate.shareText');
    const data = { title: 'Chakra', text, ...(repo ? { url: repo } : {}) };
    // Android: the system share sheet (the WebView has no navigator.share); elsewhere the browser's; else a copy
    if (globalThis.__CK_share) { try { await globalThis.__CK_share(data); return; } catch { /* no app to share with: copy */ } }
    else if (navigator.share) { try { await navigator.share(data); } catch { /* closed */ } return; }
    await navigator.clipboard.writeText(repo ? `${text} ${repo}` : text); toast(t('common.copied'));
  };

  return (
    <div class="screen">
      <div class="topbar"><h1>{t('donate.title')}</h1></div>
      <div class="content dn-content">
        <div class="hero dn-hero">
          <Guilloche seed="chakra-support" draw />
          <AppIcon size={52} />
          <div class="dn-hero-title">{t('donate.heroTitle')}</div>
          <p class="dn-hero-text">{t('donate.heroText')}</p>
          {repo && <a class="ct-hero-chip dn-repo" href={repo} target="_blank" rel="noopener" data-external><Icon name="code" size={14} /><span>{t('donate.repo')}</span><Icon name="external" size={12} /></a>}
        </div>

        <div class="card dn-card">
          <div class="dn-label">{t('donate.from')}</div>
          <button class="dn-row" onClick={() => setSheet('account')}>
            <Avatar address={account.address} />
            <span class="grow" style={{ minWidth: 0 }}><b class="ellipsis">{account.name}</b><small class="muted">{shortAddr(account.address)}</small></span>
            <Icon name="chevron" size={14} />
          </button>
          <button class="dn-row" onClick={() => setSheet('network')}>
            <ChainIcon chain={chain} size={32} />
            <span class="grow" style={{ minWidth: 0 }}><b class="ellipsis">{chain.name}</b><small class="muted">{t('donate.anyToken')}</small></span>
            <Icon name="chevron" size={14} />
          </button>
          <div class="dn-label">{t('donate.to')}</div>
          <div class="dn-row static">
            <span class="dn-to-ic"><Icon name="heart" size={18} /></span>
            <span class="grow" style={{ minWidth: 0 }}><b>{t('donate.toName')}</b><small class="muted mono">{to ? shortAddr(to, 6) : t('donate.soon')}</small></span>
            {to && <CopyBtn text={to} />}
          </div>
        </div>

        <Btn disabled={!to} onClick={() => nav('send', { to })}><Icon name="heart" size={18} /> {t('donate.cta')}</Btn>
        <div class="tiny muted center">{to ? t('donate.howItWorks') : t('donate.soonHint')}</div>

        <div class="card dn-more">
          <b class="small">{t('donate.moreTitle')}</b>
          {repo && <a class="dn-more-row" href={repo} target="_blank" rel="noopener" data-external><Icon name="star" size={16} /><span class="grow">{t('donate.star')}</span><Icon name="external" size={14} /></a>}
          {repo && <a class="dn-more-row" href={`${repo.replace(/\/$/, '')}/issues`} target="_blank" rel="noopener" data-external><Icon name="warn" size={16} /><span class="grow">{t('donate.issue')}</span><Icon name="external" size={14} /></a>}
          <button class="dn-more-row" onClick={share}><Icon name="send" size={16} /><span class="grow">{t('donate.share')}</span><Icon name="forward" size={14} /></button>
        </div>
      </div>
      {sheet === 'account' && <AccountSheet onClose={() => setSheet(null)} />}
      {sheet === 'network' && <NetworkSheet onClose={() => setSheet(null)} />}
    </div>
  );
}
