// A TON Connect bridge for the end-to-end tests, in the format of the real one (TonAPI's; spec/bridge.md):
//   GET  /events?client_id=<id>,<id>[&last_event_id=<n>]   Server-Sent Events: "event: message", "id: <n>",
//                                                           "data: {"from": <sender id>, "message": <sealed, base64>}"
//   POST /message?client_id=<from>&to=<to>&ttl=<s>          body: the sealed message
// The bridge only relays: it can't read the messages (crypto_box between the two sides).
// For the tests only, GET /inbox?client_id=<id> lists every message sent to that id (the dapp's side reads them).
import http from 'node:http';

export async function startTcBridge({ port = 9302 } = {}) {
  const messages = []; // { id, from, to, message }
  const subs = new Set(); // { ids: Set, res }
  let seq = 0;
  const frame = (m) => `event: message\nid: ${m.id}\ndata: ${JSON.stringify({ from: m.from, message: m.message })}\n\n`;
  const json = (res, status, obj) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(obj)); };

  const server = http.createServer(async (req, res) => {
    const u = new URL(req.url, 'http://x');
    res.setHeader('access-control-allow-origin', '*');
    res.setHeader('access-control-allow-headers', '*');
    if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }
    if (u.pathname === '/events') {
      const ids = new Set(String(u.searchParams.get('client_id') || '').split(',').filter(Boolean));
      const last = Number(u.searchParams.get('last_event_id') || 0);
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
      res.write('event: heartbeat\ndata: heartbeat\n\n');
      for (const m of messages) if (ids.has(m.to) && m.id > last) res.write(frame(m)); // what arrived while away
      const sub = { ids, res };
      subs.add(sub);
      req.on('close', () => subs.delete(sub));
      return;
    }
    if (u.pathname === '/message' && req.method === 'POST') {
      const chunks = [];
      for await (const c of req) chunks.push(c);
      const m = { id: ++seq, from: u.searchParams.get('client_id'), to: u.searchParams.get('to'), message: Buffer.concat(chunks).toString().trim() };
      if (!m.from || !m.to || !m.message) return json(res, 400, { message: 'bad request', statusCode: 400 });
      messages.push(m);
      for (const s of subs) if (s.ids.has(m.to)) s.res.write(frame(m));
      return json(res, 200, { message: 'OK', statusCode: 200 });
    }
    if (u.pathname === '/inbox') return json(res, 200, messages.filter((m) => m.to === u.searchParams.get('client_id')));
    json(res, 404, { message: 'not found' });
  });
  await new Promise((r) => server.listen(port, '127.0.0.1', r));
  return { url: `http://127.0.0.1:${port}`, close: () => { for (const s of subs) s.res.end(); server.close(); } };
}
