// Authenticated cloud-runtime fault/concurrency verification. All inference is a
// labeled TEST DOUBLE; these results must never be called real-model throughput.
// CANARY_SECRETS_FILE must point to a private JSON containing CANARY_TOKEN.
// Usage: node canary-run.mjs [--faults] [--output=/absolute/evidence.json]
import fs from 'node:fs';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
const config = JSON.parse(fs.readFileSync(new URL('./canary.jsonc', import.meta.url), 'utf8'));
assert.equal(config.ai, undefined, 'Canary must have NO AI binding');
const origin = config.vars.PUBLIC_ORIGIN;
const secrets = JSON.parse(fs.readFileSync(process.env.CANARY_SECRETS_FILE, 'utf8'));
assert.ok(secrets.CANARY_TOKEN?.length >= 32);
const run = 'canary-' + randomUUID();
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
const report = {mode: 'TEST_DOUBLE_NOT_LIVE', run_id: run, started_at: new Date().toISOString(), url: origin, provider_calls: 'NO_REAL_AI_BINDING', results: {}};
async function call(path, {visitor, body, ip, headers = {}, anonymous = false} = {}) {
  const response = await fetch(origin + path, {method: body === undefined ? 'GET' : 'POST', headers: {
    ...(!anonymous ? {Authorization: 'Bearer ' + secrets.CANARY_TOKEN} : {}),
    ...(visitor ? {Cookie: visitor.cookie, 'X-CSRF-Token': visitor.csrf} : {}),
    'X-Canary-IP': ip || visitor?.ip || '198.18.99.1',
    ...(body === undefined ? {} : {'Content-Type': 'application/json', Origin: origin}), ...headers,
  }, ...(body === undefined ? {} : {body: JSON.stringify(body)}), signal: AbortSignal.timeout(15_000)});
  const raw = await response.text(); let data; try {data = JSON.parse(raw);} catch {data = null;}
  if (!anonymous) assert.equal(response.headers.get('X-Canary-Mode'), 'TEST_DOUBLE_NOT_LIVE');
  return {status: response.status, data, cookie: response.headers.get('set-cookie')?.split(';')[0]};
}
async function visitor(n) {
  const ip = `198.18.${Math.floor(n / 200)}.${n % 200 + 1}`, session = await call('/api/session', {ip});
  assert.equal(session.status, 200);
  const v = {ip, cookie: session.cookie, csrf: session.data.csrf}, chat = await call('/api/local/chats', {visitor: v, body: {}});
  assert.equal(chat.status, 201); v.chat = chat.data.id; return v;
}
const turnPath = v => `/api/local/chats/${v.chat}/turns`;
async function terminal(v, tid, timeout = 45_000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    const r = await call('/api/local/chats/' + v.chat, {visitor: v}); assert.equal(r.status, 200);
    const t = r.data.turns.find(x => x.id === tid);
    if (t?.status !== 'RUNNING') return {turn: t, conversation: r.data};
    await wait(1200);
  }
  throw new Error('CANARY_TERMINAL_TIMEOUT');
}
try {
  assert.equal((await call('/health', {anonymous: true})).status, 403);
  report.results.protected_all_routes = true;
  const visitors = await Promise.all(Array.from({length: 11}, (_, n) => visitor(n + 1)));
  const requests = visitors.slice(0, 10).map((v, i) => ({request_id: 'test-' + randomUUID(), text: `TEST_DOUBLE_SET_${10000 + i} TEST_DOUBLE_HOLD`}));
  const starts = await Promise.all(visitors.slice(0, 10).map((v, i) => call(turnPath(v), {visitor: v, body: requests[i]})));
  assert.ok(starts.every(x => x.status === 202));
  const eleventh = await call(turnPath(visitors[10]), {visitor: visitors[10], body: {request_id: 'test-' + randomUUID(), text: 'TEST_DOUBLE_SET_50000'}});
  assert.equal(eleventh.status, 429); assert.equal(eleventh.data.error.code, 'CONCURRENCY_LIMIT');
  const duplicate = await call(turnPath(visitors[0]), {visitor: visitors[0], body: requests[0]});
  assert.equal(duplicate.status, 202); assert.equal(duplicate.data.id, starts[0].data.id);
  const foreign = await call('/api/local/chats/' + visitors[0].chat, {visitor: visitors[1]}); assert.equal(foreign.status, 404);
  const active = await call('/api/admin/status'); assert.equal(active.data.budget.active_count, 10);
  report.results.ten_active = {admitted: 10, active_snapshot: active.data.budget.active_count, eleventh_status: eleventh.status, duplicate_same_turn: true, foreign_status: foreign.status};
  const completed = await Promise.all(visitors.slice(0, 10).map((v, i) => terminal(v, starts[i].data.id)));
  for (let i = 0; i < completed.length; i++) {
    assert.equal(completed[i].turn.status, 'COMPLETE');
    assert.ok(completed[i].turn.assistant.includes('TEST_DOUBLE_NOT_LIVE'));
    assert.equal(completed[i].conversation.state.actual[0].amount_cents, (10000 + i) * 100);
    assert.ok(completed[i].turn.risk.auth.verified);
    assert.equal(completed[i].turn.receipts.length, 2);
  }
  report.results.ten_complete = {completed: 10, isolated_distinct_amounts: true, independent_risk_verified: true, model: 'TEST_DOUBLE_NOT_LIVE',
    turns: completed.map(x => ({conversation_id: x.conversation.id, turn_id: x.turn.id, synthetic_cash_cents: x.conversation.state.actual[0].amount_cents, risk_verified: x.turn.risk.auth.verified, provider_ids: x.turn.receipts.map(r => r.provider_response_id)}))};
  const stopVisitor = visitors[10];
  const stopStart = await call(turnPath(stopVisitor), {visitor: stopVisitor, body: {request_id: 'test-' + randomUUID(), text: 'TEST_DOUBLE_SET_20000 TEST_DOUBLE_HOLD'}});
  assert.equal(stopStart.status, 202); await wait(1600);
  const stop = await call(`${turnPath(stopVisitor)}/${stopStart.data.id}/stop`, {visitor: stopVisitor, body: {}});
  assert.equal(stop.status, 200);
  const stopped = await terminal(stopVisitor, stopStart.data.id); assert.equal(stopped.turn.status, 'STOPPED');
  // Give the production run's finally block time to release its global lease.
  await wait(1200);
  const retry = await call(turnPath(stopVisitor), {visitor: stopVisitor, body: {request_id: 'test-' + randomUUID(), retry_turn_id: stopStart.data.id}});
  assert.equal(retry.status, 202);
  const retried = await terminal(stopVisitor, retry.data.id); assert.equal(retried.turn.status, 'COMPLETE');
  assert.equal(retried.conversation.state.version, 1); assert.equal(retried.turn.receipts.length, 1);
  report.results.stop_retry = {stopped: true, retry_complete: true, committed_version: 1, retry_model_steps: 1};

  const quotaCall = (operation, body = {}) => call('/canary/quota/' + operation, {body, headers: {'X-Canary-Run': run}});
  const begin = async n => (await quotaCall('begin', {owner: 'quota-owner-' + n, ip_hash: 'a'.repeat(64), turn_id: 'turn-' + n, request_id: 'quota-' + n})).data.lease;
  const leases = await Promise.all([begin(1), begin(2), begin(3)]);
  const charged = await Promise.all(leases.map((lease, n) => quotaCall('reserve', {lease, request_id: 'charge-' + n, phase: 'plan', request_hash: 'b'.repeat(64)})));
  assert.equal(charged.filter(x => x.status === 200).length, 2); assert.equal(charged.filter(x => x.data.code === 'DEMO_BUDGET_EXHAUSTED').length, 1);
  const quotaStatus = (await quotaCall('status')).data; assert.equal(quotaStatus.used_micro_cny, 200_000);
  report.results.quota = {accepted: 2, denied: 1, full_unknown_reservations_retained: true, fake_used_micro_cny: quotaStatus.used_micro_cny, real_ai_calls: 0};

  if (process.argv.includes('--faults')) {
    report.results.faults = [];
    for (const fault of ['RATE_LIMIT', 'TRUNCATED', 'INTERRUPTED', 'TIMEOUT']) {
      const v = await visitor(100 + report.results.faults.length), start = await call(turnPath(v), {visitor: v, body: {request_id: 'test-' + randomUUID(), text: 'TEST_DOUBLE_' + fault}});
      assert.equal(start.status, 202);
      const result = await terminal(v, start.data.id, fault === 'TIMEOUT' ? 85_000 : 20_000);
      assert.equal(result.turn.status, 'ERROR');
      if (fault === 'TIMEOUT') assert.equal(result.turn.error.code, 'MODEL_TIMEOUT');
      const recorded = await call('/api/admin/status');
      const receipts = recorded.data.budget.recent_receipts;
      assert.ok(receipts.some(r => r.error_code && r.status !== 'COMPLETE'));
      report.results.faults.push({fault: 'TEST_DOUBLE_' + fault, status: result.turn.status, code: result.turn.error.code, automatic_retry: false});
    }
  }
  report.results.final_status = (await call('/api/admin/status')).data.budget;
  report.completed_at = new Date().toISOString(); report.passed = true;
} catch (error) {
  report.completed_at = new Date().toISOString(); report.passed = false;
  report.failure = {code: String(error.code || error.message).slice(0, 160), actual: typeof error.actual === 'string' || typeof error.actual === 'number' ? error.actual : undefined, expected: typeof error.expected === 'string' || typeof error.expected === 'number' ? error.expected : undefined};
  process.exitCode = 1;
}
const output = process.argv.find(arg => arg.startsWith('--output='))?.slice(9);
if (output) fs.writeFileSync(output, JSON.stringify(report, null, 2) + '\n', {mode: 0o600});
console.log(JSON.stringify(report, null, 2));
