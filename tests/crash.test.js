import { resetStorage } from './helpers/chrome.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { scrub, makeReport, reportError, recordReport, crashLog, clearCrashLog, collectNativeCrashes, deviceInfo, reportText, emailParts, mailtoUrl, githubIssueUrl, crashToAsk, markAsked, SUPPORT_EMAIL } from '../src/shared/crash.js';

const PHRASE = 'abandon ability able about above absent absorb abstract absurd abuse access accident';

test('scrub: addresses, keys, hashes and phrases never stay in a report', () => {
  const cases = [
    ['send to 0x1234567890abcdef1234567890abcdef12345678 failed', '0x1234567890abcdef'],
    ['key 4c0883a69102937d6231471b5dbb6204fe5129617082792ae468d01a3f362318', '4c0883a69102'],
    ['tx 0x88df016429689c079f3b2f6ad39fa052532c56795b733da78a91ebe6a713944b', '88df0164'],
    ['raw 0:83dfd552e63729b472fcbcc8c45ebcc6691702558b68ec7527e1ba403a0f31a8', '83dfd552'],
    ['bitcoin bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq', 'bc1qar0s'],
    ['tron TLa2f6VPqDgRE67v1736s7bJ8Ray5wYjU7', 'TLa2f6VP'],
    ['solana 7EcDhSYGxXyscszYEp35KHN8vvw3svAuLKTzXwCFLtV', '7EcDhSYG'],
    ['ton EQCD39VS5jcptHL8vMjEXrzGaRcCVYto7HUn4bpAOg8xqB2N', 'EQCD39VS'],
    ['xpub6CUGRUonZSQ4TWtTMmzXdrXDtypWKiKrhko4egpiMZbpiaQL2jkwSB1icqYh2cfDfVxdx4df189oLKnC5fSwqPfgyP3hooxujYzAu3fDVmz', 'xpub6CUG'],
    [`phrase ${PHRASE}`, 'abandon ability'],
    ['https://api.example.com/v1/balance?address=0xabc&key=secret#frag', 'secret'],
    ['contact me at someone@example.org', 'someone@'],
  ];
  for (const [text, secret] of cases) assert.ok(!scrub(text).includes(secret), `${text} -> ${scrub(text)}`);
});

test('scrub: ordinary messages and stack frames stay readable', () => {
  assert.equal(scrub('could not find any route for this swap'), 'could not find any route for this swap');
  assert.equal(scrub('    at Ab (chrome-extension://abcdefghijklmnopabcdefghijklmnop/popup.js:1:48213)'), '    at Ab (chrome-extension://<ext>/popup.js:1:48213)');
  assert.equal(scrub('at https://localhost/app.js:1:93021'), 'at https://localhost/app.js:1:93021');
  // amounts only in messages
  assert.equal(scrub('insufficient balance: have 1234567 need 42', { numbers: true }), 'insufficient balance: have <n> need 42');
});

test('makeReport: kind, version, device and a signature for duplicates', () => {
  const r = makeReport(new TypeError('x is undefined at 0x1234567890abcdef1234'), { kind: 'render' });
  assert.equal(r.kind, 'render');
  assert.equal(r.message, 'TypeError: x is undefined at 0x…');
  assert.ok(!r.stack.split('\n').some((l) => l.includes('x is undefined')), 'the message is not repeated in the stack');
  const plain = makeReport(new Error('plain'));
  assert.equal(plain.message, 'plain');
  assert.ok(!plain.stack.includes('Error: plain'));
  assert.equal(r.count, 1);
  assert.ok(r.sig.startsWith('render|'));
  assert.deepEqual(deviceInfo('Mozilla/5.0 (Linux; Android 14; Pixel 7 Build/UQ1A.240205.004; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/131.0.6778.135 Mobile Safari/537.36'),
    { os: 'Android 14; Pixel 7', engine: 'Chrome 131' });
  assert.deepEqual(deviceInfo('Mozilla/5.0 (X11; Linux x86_64; rv:133.0) Gecko/20100101 Firefox/133.0'), { os: 'Linux x86_64', engine: 'Firefox 133' });
});

test('the log: the same error counts again, noise is left out, at most 20 kept', async () => {
  resetStorage();
  const err = new Error('boom');
  await reportError(err);
  await reportError(err);
  await reportError(new TypeError('Failed to fetch'));
  await reportError(Object.assign(new Error('stopped'), { name: 'AbortError' }));
  let log = await crashLog();
  assert.equal(log.length, 1);
  assert.equal(log[0].count, 2);
  const now = Date.now();
  for (let i = 0; i < 30; i++) await recordReport(makeReport(new Error(`e${i}`), { at: now + 1000 + i }));
  log = await crashLog();
  assert.equal(log.length, 20);
  assert.equal(log[0].message, 'e29'); // newest first
  await clearCrashLog();
  assert.equal((await crashLog()).length, 0);
});

test('native crashes are moved into the log, cleaned, and the plugin is cleared', async () => {
  resetStorage();
  let cleared = false;
  const plugin = {
    pending: async () => ({ reports: [{ kind: 'java', at: 5, message: 'java.lang.IllegalStateException: bad 0x1234567890abcdef1234567890abcdef12345678', stack: 'java.lang.IllegalStateException\n\tat dev.chakrawallet.X.y(X.java:10)', thread: 'main' }] }),
    clear: async () => { cleared = true; },
  };
  await collectNativeCrashes(plugin);
  const [r] = await crashLog();
  assert.equal(r.kind, 'java');
  assert.equal(r.thread, 'main');
  assert.ok(!r.message.includes('1234567890abcdef'));
  assert.ok(r.stack.includes('X.java:10'));
  assert.ok(cleared);
});

test('sending: the text shown is the text sent, links stay within their limits', () => {
  const err = new Error('boom');
  err.stack = 'Error: boom\n' + Array.from({ length: 400 }, (_, i) => `    at f${i} (https://localhost/app.js:1:${10000 + i})`).join('\n');
  const r = makeReport(err, { kind: 'render' });
  const text = reportText(r);
  assert.ok(text.includes('render') && text.includes('boom') && text.includes('app.js:1:10000'));
  const mail = emailParts(r);
  assert.equal(mail.to, SUPPORT_EMAIL);
  assert.ok(mail.subject.includes('boom'));
  assert.ok(mail.body.includes(text)); // the app's mail intent: the whole report
  const mailto = mailtoUrl(r);
  assert.ok(mailto.startsWith(`mailto:${SUPPORT_EMAIL}?`) && mailto.length <= 2000);
  const gh = githubIssueUrl(r);
  assert.ok(gh.startsWith('https://github.com/ChakraWallet/ChakraWallet/issues/new?') && gh.length <= 7000);
  assert.ok(decodeURIComponent(gh).includes('app.js:1:10000')); // cut from the end, the top of the stack stays
  // a message without a report: only the app and device line
  assert.ok(!emailParts(null).body.includes('undefined'));
  assert.ok(githubIssueUrl(null).includes('title=&'));
});

test('a crash that closed the app is asked about once', async () => {
  resetStorage();
  await collectNativeCrashes({ pending: async () => ({ reports: [{ kind: 'anr', at: Date.now(), message: 'App not responding', stack: '' }] }), clear: async () => {} });
  await reportError(new Error('not fatal')); // JavaScript errors are only listed, never asked about
  const r = await crashToAsk();
  assert.equal(r.kind, 'anr');
  await markAsked(r.sig);
  assert.equal(await crashToAsk(), null);
  assert.equal((await crashLog()).length, 2);
});
