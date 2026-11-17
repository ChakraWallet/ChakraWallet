// /ton-connect (ton-connect.html): the request in the link, the site that sends it (from the manifest it declares)
// and the ribbon that ties it to Chakra. Nothing is sent anywhere: the request goes to the app only if the user taps
// "Open in Chakra" (chakra-tc:// with the same query string).
import '@fontsource/bricolage-grotesque/700.css';
import '@fontsource/bricolage-grotesque/800.css';
import '@fontsource/instrument-sans/400.css';
import '@fontsource/instrument-sans/500.css';
import '@fontsource/instrument-sans/600.css';
import './tonconnect.css';

const $ = (id) => document.getElementById(id);
const q = new URLSearchParams(location.search);
$('tc-open').href = `chakra-tc://${location.search}`;

// ---------------------------------------------------------------- the ribbon
// Woven sine lines, as on the border of a banknote: they meet at the two seals and open up in between.
function ribbon(svg, lines = 9) {
  const W = 320, H = 96, mid = H / 2, amp = H * 0.4;
  const ns = 'http://www.w3.org/2000/svg';
  for (let k = 0; k < lines; k++) {
    const ph = (k / lines) * Math.PI * 2;
    let d = '';
    for (let x = 0; x <= W; x += 2) {
      const t = x / W;
      const env = Math.sin(Math.PI * t) ** 0.7;
      const y = mid + amp * env * (0.6 * Math.sin(t * Math.PI * 5 + ph) + 0.4 * Math.sin(t * Math.PI * 11 - 2 * ph));
      d += `${x ? 'L' : 'M'}${x},${y.toFixed(2)}`;
    }
    const p = document.createElementNS(ns, 'path');
    p.setAttribute('d', d);
    p.setAttribute('pathLength', '1');
    p.style.setProperty('--i', k);
    svg.appendChild(p);
  }
}
ribbon($('tc-ribbon'));

// ---------------------------------------------------------------- the request
let request = null;
try { request = JSON.parse(q.get('r') || 'null'); } catch { request = null; }
const hostOf = (u) => { try { return new URL(u).host; } catch { return ''; } };

if (!request || typeof request !== 'object') {
  // no request: the site only brings the wallet up (a transaction or a signature waits there)
  $('tc-title').textContent = 'Continue in Chakra';
  $('tc-host').textContent = 'A TON site is waiting for you to confirm in Chakra.';
} else {
  $('tc-host').textContent = hostOf(request.manifestUrl);
  manifest(request.manifestUrl).then((m) => {
    if (!m) return;
    $('tc-title').textContent = `${m.name} wants to connect to your Chakra wallet`;
    $('tc-host').textContent = m.host;
    if (m.icon) {
      const img = $('tc-site-icon');
      img.onload = () => { img.hidden = false; $('tc-site-globe').style.display = 'none'; };
      img.src = m.icon;
    }
  });
}

/** The site's tonconnect-manifest.json: { name, host, icon } as it declares them, or null. Shown as text only. */
async function manifest(url) {
  try {
    if (!/^https:\/\//.test(url)) return null;
    const res = await fetch(url, { signal: AbortSignal.timeout(5000), credentials: 'omit' });
    const j = await res.json();
    const name = typeof j?.name === 'string' ? j.name.trim().slice(0, 48) : '';
    const host = hostOf(j?.url);
    if (!name || !host) return null;
    return { name, host, icon: typeof j.iconUrl === 'string' && /^https:\/\//.test(j.iconUrl) ? j.iconUrl : '' };
  } catch { return null; }
}
