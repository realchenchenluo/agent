// Local workerd verification only. There is NO real model binding and no API
// request to a paid provider. All credentials are generated test-only values.
// Usage: node local-runtime-verify.mjs --wrangler=/path/to/wrangler.js --output=/path/to/report.json
import assert from 'node:assert/strict';
import {mkdtemp, readFile, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {randomBytes, randomUUID} from 'node:crypto';
import {spawn} from 'node:child_process';
import {createServer} from 'node:net';

const argument = name => process.argv.find(arg => arg.startsWith(`--${name}=`))?.slice(name.length + 3);
const wrangler = argument('wrangler');
if (!wrangler) throw Error('Supply the installed Wrangler JS path with --wrangler= (no installation or deployment is performed).');
const root = fileURLToPath(new URL('.', import.meta.url));
const privateDir = await mkdtemp(join(tmpdir(), 'paifm-local-verify-'));
const listener = createServer();
await new Promise(resolve => listener.listen(0, '127.0.0.1', resolve));
const port = listener.address().port;
await new Promise(resolve => listener.close(resolve));
const origin = `http://127.0.0.1:${port}`;
const token = randomBytes(32).toString('hex');
const riskSecret = randomBytes(32).toString('hex');
const canary = JSON.parse(await readFile(join(root, 'canary.jsonc'), 'utf8'));
delete canary.account_id;
canary.name = 'paifm-local-test-chat';
canary.workers_dev = false;
canary.main = join(root, 'canary.mjs');
canary.assets.directory = join(root, 'public');
canary.services = [{binding: 'AMOUNT_RISK', service: 'paifm-local-test-risk'}];
const now = Date.now();
canary.vars = {...canary.vars, PUBLIC_ORIGIN: origin, LLM_GATEWAY_MODE: 'cloudflare', LLM_PAID_PROVIDER_APPROVED: 'false',
  DEMO_START_AT: new Date(now - 60_000).toISOString(), DEMO_END_AT: new Date(now + 16 * 86400_000).toISOString(),
  RELEASE_ID: 'TEST_DOUBLE_NOT_LIVE-local-20261024'};
const risk = {name: 'paifm-local-test-risk', main: join(root, 'risk.mjs'), compatibility_date: canary.compatibility_date,
  compatibility_flags: ['nodejs_compat'], workers_dev: false, preview_urls: false};
assert.equal(canary.ai, undefined);
await writeFile(join(privateDir, 'chat.jsonc'), JSON.stringify(canary));
await writeFile(join(privateDir, 'risk.jsonc'), JSON.stringify(risk));
await writeFile(join(privateDir, '.dev.vars'), [
  `CANARY_TOKEN=${token}`, `RISK_HMAC_SECRET=${riskSecret}`, `SESSION_SECRET=${randomBytes(32).toString('hex')}`,
].join('\n') + '\n', {mode: 0o600});

let runtimeLog = '';
const child = spawn(process.execPath, [resolve(wrangler), 'dev', '--local', '--ip', '127.0.0.1', '--port', String(port),
  '--config', join(privateDir, 'chat.jsonc'), '--config', join(privateDir, 'risk.jsonc'),
  '--persist-to', join(privateDir, 'state')], {cwd: root, windowsHide: true,
  env: {...process.env, CI: 'true', WRANGLER_SEND_METRICS: 'false', CLOUDFLARE_LOAD_DEV_VARS_FROM_DOT_ENV: 'false'},
  stdio: ['ignore', 'pipe', 'pipe']});
const recordLog = data => { runtimeLog = (runtimeLog + data.toString()).slice(-20000); };
child.stdout.on('data', recordLog); child.stderr.on('data', recordLog);
let launchError;
child.on('error', error => { launchError = error; });
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const report = {mode: 'LOCAL_WORKERD_TEST_DOUBLE_NOT_LIVE', started_at: new Date().toISOString(),
  real_model_calls: 0, paid_api_calls: 0, results: {}};
async function call(path, {visitor, body, anonymous = false, ip = '198.18.50.1'} = {}) {
  return fetch(origin + path, {method: body === undefined ? 'GET' : 'POST', headers: {
    ...(!anonymous ? {Authorization: 'Bearer ' + token} : {}), 'X-Canary-IP': ip,
    ...(visitor ? {Cookie: visitor.cookie, 'X-CSRF-Token': visitor.csrf} : {}),
    ...(body === undefined ? {} : {Origin: origin, 'Content-Type': 'application/json'}),
  }, ...(body === undefined ? {} : {body: JSON.stringify(body)}), signal: AbortSignal.timeout(5000)});
}
async function json(path, options) {
  const response = await call(path, options);
  return {status: response.status, data: await response.json(), cookie: response.headers.get('set-cookie')?.split(';')[0]};
}
async function visitor(ip) {
  const session = await json('/api/session', {ip}); assert.equal(session.status, 200);
  const v = {cookie: session.cookie, csrf: session.data.csrf};
  const created = await json('/api/local/chats', {visitor: v, body: {}, ip});
  assert.equal(created.status, 201); return {...v, id: created.data.id};
}
async function terminal(v, id) {
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    const response = await json('/api/local/chats/' + v.id, {visitor: v});
    assert.equal(response.status, 200);
    const turn = response.data.turns.find(turn => turn.id === id);
    if (turn && turn.status !== 'RUNNING') return {turn, conversation: response.data};
    await delay(100);
  }
  throw Error('LOCAL_TERMINAL_TIMEOUT');
}
try {
  const readyDeadline = Date.now() + 45000;
  while (true) {
    if (launchError) throw launchError;
    if (child.exitCode !== null) throw Error('LOCAL_RUNTIME_EXITED');
    try { if ((await call('/health')).status === 200) break; } catch {}
    if (Date.now() > readyDeadline) throw Error('LOCAL_RUNTIME_START_TIMEOUT');
    await delay(250);
  }
  assert.equal((await call('/health', {anonymous: true})).status, 403);
  const first = await visitor('198.18.50.1'), second = await visitor('198.18.50.2');
  // Keep the test-control label out of the cash amount evidence: an extra
  // numeric control suffix is correctly rejected by the source-grounding code.
  const body = {request_id: 'local-' + randomUUID(), text: '这是合成测试；现金10000元。'};
  const path = `/api/local/chats/${first.id}/turns`;
  const started = await json(path, {visitor: first, body}); assert.equal(started.status, 202);
  const repeated = await json(path, {visitor: first, body});
  assert.equal(repeated.status, 202); assert.equal(repeated.data.id, started.data.id);
  const finished = await terminal(first, started.data.id);
  assert.equal(finished.turn.status, 'COMPLETE');
  assert.equal(finished.conversation.state.actual[0]?.amount_cents, 1000000);
  assert.equal(finished.conversation.state.version, 1);
  assert.equal(finished.turn.risk.auth.verified, true);
  assert.equal(finished.turn.risk.result.execution_allowed, false);
  assert.equal(finished.turn.receipts.length, 2);
  assert.ok(finished.turn.assistant.includes('TEST_DOUBLE_NOT_LIVE'));
  report.results.chinese_plan_business_tools_risk = {status: 'PASS', model: 'TEST_DOUBLE', actual_cash_cents: 1000000,
    risk_verified: true, execution_allowed: false, committed_version: 1, duplicate_same_turn: true,
    receipts: finished.turn.receipts.map(r => ({phase: r.phase, provider_response_id: r.provider_response_id, usage: r.usage}))};
  const foreign = await call('/api/local/chats/' + first.id, {visitor: second}); assert.equal(foreign.status, 404);
  report.results.visitor_isolation = {foreign_status: 404};
  const events = await call(`/api/local/chats/${first.id}/turns/${started.data.id}/events`, {visitor: first});
  assert.equal(events.status, 200); assert.match(events.headers.get('content-type'), /text\/event-stream/);
  const reader = events.body.getReader(); let eventText = '';
  try {
    while (!eventText.includes('COMPLETE')) {
      const chunk = await reader.read(); if (chunk.done) break;
      eventText += new TextDecoder().decode(chunk.value);
      assert.ok(eventText.length < 200000);
    }
  } finally { await reader.cancel(); }
  assert.match(eventText, /TEST_DOUBLE_NOT_LIVE/); assert.match(eventText, /COMPLETE/);
  report.results.sse_replay = {status: 'PASS', content_type: 'text/event-stream', completed_turn_replayed: true};
  for (const fault of ['RATE_LIMIT', 'TRUNCATED', 'INTERRUPTED']) {
    const user = await visitor(`198.18.51.${Object.keys(report.results).length}`);
    const start = await json(`/api/local/chats/${user.id}/turns`, {visitor: user,
      body: {request_id: 'fault-' + randomUUID(), text: '合成异常测试 TEST_DOUBLE_' + fault}});
    assert.equal(start.status, 202);
    const result = await terminal(user, start.data.id);
    assert.equal(result.turn.status, 'ERROR');
    report.results[fault.toLowerCase()] = {status: result.turn.status, code: result.turn.error.code, real_model_calls: 0};
  }
  const admin = await json('/api/admin/status'); assert.equal(admin.status, 200);
  assert.equal(admin.data.budget.active_count, 0);
  assert.ok(admin.data.budget.receipt_count >= 8);
  report.results.audit_and_budget = {status: 'PASS', active_count: 0, receipt_count: admin.data.budget.receipt_count,
    used_micro_cny: admin.data.budget.used_micro_cny, test_ledger_only: true};
  report.passed = true;
} catch (error) {
  report.passed = false; report.failure = {code: String(error.code || error.message).slice(0, 160)};
  // Do not persist stdout/headers/credentials. Only include a redacted diagnostic.
  const sanitized = [token, riskSecret].reduce((s, secret) => s.replaceAll(secret, '[REDACTED]'), runtimeLog);
  console.error(sanitized.slice(-5000));
  process.exitCode = 1;
} finally {
  report.completed_at = new Date().toISOString();
  child.kill('SIGTERM');
  // Local test values are invalidated without touching any production Secret.
  await writeFile(join(privateDir, '.dev.vars'), '# Local test finished; generated credentials invalidated.\n', {mode: 0o600});
}
if (argument('output')) await writeFile(resolve(argument('output')), JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify(report, null, 2));
