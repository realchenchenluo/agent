// Run on the network being evaluated: node probe-public.mjs [--full].
// Never log cookies, CSRF tokens, request bodies or raw model text.
import dns from 'node:dns/promises';
import tls from 'node:tls';
import {randomUUID} from 'node:crypto';

const origin = process.env.FUND_ORIGIN || 'https://personal-ai-fund-chat.ai-banking-agent.workers.dev';
const url = new URL(origin);
if (url.protocol !== 'https:' || url.pathname !== '/' || url.search || url.hash) throw Error('FUND_ORIGIN must be an HTTPS origin');
const report = {at: new Date().toISOString(), origin: url.origin, mode: process.argv.includes('--full') ? 'synthetic-full' : 'network-only', steps: {}};
const step = async (name, fn) => {
  const start = Date.now();
  try { report.steps[name] = {...await fn(), ms: Date.now() - start}; }
  catch (error) { report.steps[name] = {ok: false, code: error.code || error.name || 'ERROR', ms: Date.now() - start}; }
};
const request = async (path, options = {}) => fetch(url.origin + path, {redirect: 'error', signal: AbortSignal.timeout(15000), ...options});
let cookie, csrf, chatId;
await step('dns', async () => ({ok: true, a: (await dns.resolve4(url.hostname)).length, aaaa: (await dns.resolve6(url.hostname).catch(() => [])).length}));
await step('tls', async () => new Promise((resolve, reject) => {
  const socket = tls.connect({host: url.hostname, port: 443, servername: url.hostname, rejectUnauthorized: true, timeout: 10000}, () => {
    const cert = socket.getPeerCertificate();
    resolve({ok: socket.authorized, protocol: socket.getProtocol(), valid_to: cert.valid_to});
    socket.end();
  });
  socket.once('error', reject); socket.once('timeout', () => { socket.destroy(); reject(Object.assign(Error('timeout'), {code: 'TLS_TIMEOUT'})); });
}));
for (const path of ['/', '/health.js', '/health.css', '/health']) await step('GET ' + path, async () => {
  const response = await request(path), bytes = (await response.arrayBuffer()).byteLength;
  return {ok: response.ok, status: response.status, bytes, release: response.headers.get('X-App-Release') || null};
});
await step('session', async () => {
  const response = await request('/api/session');
  const body = await response.json();
  cookie = response.headers.get('set-cookie')?.split(';')[0]; csrf = body.csrf;
  return {ok: response.ok && Boolean(cookie && csrf), status: response.status, cookie_secure: /Secure/i.test(response.headers.get('set-cookie') || ''), cookie_http_only: /HttpOnly/i.test(response.headers.get('set-cookie') || '')};
});
if (process.argv.includes('--full') && cookie && csrf) {
  const headers = {'Content-Type': 'application/json', Origin: url.origin, Cookie: cookie, 'X-CSRF-Token': csrf};
  await step('new_chat', async () => {
    const response = await request('/api/local/chats', {method: 'POST', headers, body: '{}'});
    const body = await response.json(); chatId = body.id;
    return {ok: response.status === 201 && Boolean(chatId), status: response.status};
  });
  if (chatId) {
    await step('synthetic_turn', async () => {
      const response = await request(`/api/local/chats/${chatId}/turns`, {method: 'POST', headers,
        body: JSON.stringify({request_id: randomUUID(), text: '这是演示数据：股票 A 当前市值 30000 元、基金 B 当前市值 20000 元、现金 20000 元，均为人民币。请核对比例；没有历史价格时说明无法计算过去一年最大回撤。'})});
      const turn = await response.json();
      if (response.status !== 202) return {ok: false, status: response.status, code: turn.error?.code || 'TURN_REJECTED'};
      for (let n = 0; n < 30; n++) {
        await new Promise(resolve => setTimeout(resolve, 1000));
        const state = await (await request(`/api/local/chats/${chatId}`, {headers: {Cookie: cookie}})).json();
        const completed = state.turns?.find(t => t.id === turn.id);
        if (completed?.status && completed.status !== 'RUNNING') {
          const rows = completed.tool?.output?.rows || [];
          return {ok: completed.status === 'COMPLETE' && completed.source === 'LIVE_MODEL', status: completed.status,
            source: completed.source || null, error_code: completed.error?.code || null,
            total_cents: completed.tool?.output?.total_cents || null,
            weights: rows.map(r => r.weight_pct), model_receipts: completed.receipts?.length || 0};
        }
      }
      return {ok: false, code: 'TURN_POLL_TIMEOUT'};
    });
    await step('refresh_chat', async () => {
      const response = await request(`/api/local/chats/${chatId}`, {headers: {Cookie: cookie}});
      const body = await response.json();
      return {ok: response.ok && body.id === chatId, status: response.status, turn_count: body.turns?.length || 0};
    });
  }
}
console.log(JSON.stringify(report, null, 2));
if (Object.values(report.steps).some(s => !s.ok)) process.exitCode = 1;
