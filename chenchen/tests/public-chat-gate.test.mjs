import test from 'node:test';
import assert from 'node:assert/strict';
import {ChatGate} from '../integration/public-chat/gate.mjs';
import {reservationForInput, gatewayPolicy} from '../integration/public-chat/gateway-policy.mjs';

// Explicit storage test double, with serialized transactions and rollback. These
// tests make no Cloudflare/model calls and are not evidence of live AI throughput.
class Storage {
  data = new Map(); queue = Promise.resolve();
  transaction(work) {
    const run = this.queue.then(async () => {
      const copy = structuredClone(this.data);
      const result = await work({get: async key => structuredClone(copy.get(key)), put: async (key, value) => {copy.set(key, structuredClone(value));}, delete: async keys => {for (const key of Array.isArray(keys) ? keys : [keys]) copy.delete(key);}});
      this.data = copy;
      return result;
    });
    this.queue = run.catch(() => {});
    return run;
  }
}
const start = Date.parse('2026-10-24T10:00:00+08:00');
const baseEnv = {DEMO_BUDGET_CENTS: '1000', DAILY_BUDGET_CENTS: '1000', DEMO_START_AT: '2026-10-24T10:00:00+08:00', DEMO_END_AT: '2026-11-08T10:00:00+08:00'};
const ip = 'a'.repeat(64), digest = 'b'.repeat(64);
function fixture(env = {}, storage = new Storage()) {
  let now = start;
  const gate = new ChatGate({storage}, {...baseEnv, ...env}); gate.now = () => now;
  const send = async (route, body = {}) => {
    const response = await gate.fetch(new Request(`https://gate/${route}`, {method: 'POST', body: JSON.stringify(body)}));
    return {...await response.json(), http_status: response.status};
  };
  let sequence = 0;
  return {gate, storage, send, time: value => {now = value;},
    begin: (owner = `visitor-${++sequence}`, extra = {}) => send('begin', {owner, ip_hash: ip, turn_id: `turn-${++sequence}`, request_id: `begin-${++sequence}`, ...extra}),
    reserve: (lease, request_id = `call-${++sequence}`, phase = 'plan', extra = {}) => send('reserve', {lease, request_id, phase, request_hash: digest, ...extra}),
  };
}
const complete = (lease, request_id, extra = {}) => ({lease, request_id, provider: 'cloudflare_workers_ai', model: '@cf/meta/llama-3.3-70b-instruct-fp8-fast', status: 'COMPLETE', duration_ms: 9000, provider_response_id: 'provider-request-1', attempt_count: 1, usage: {prompt_tokens: 1000, completion_tokens: 100}, ...extra});

test('ten concurrent independent sessions are admitted, eleventh blocked; no storage races', async () => {
  const f = fixture();
  const results = await Promise.all(Array.from({length: 11}, (_, i) => f.begin(`visitor-${i}`)));
  assert.equal(results.filter(x => x.ok).length, 10);
  assert.equal(results.filter(x => x.code === 'CONCURRENCY_LIMIT').length, 1);
  const calls = await Promise.all(results.filter(x => x.ok).map(x => f.reserve(x.lease)));
  assert.equal(calls.filter(x => x.call_allowed).length, 10);
  const status = await f.send('status');
  assert.equal(status.active_count, 10); assert.equal(status.used_micro_cny, 1_000_000); assert.equal(status.call_count, 10);
  assert.equal(JSON.stringify(status).includes('visitor-'), false);
});

test('concurrent budget reservations include all in-flight requests and never overshoot', async () => {
  const f = fixture({DEMO_BUDGET_CENTS: '50', DAILY_BUDGET_CENTS: '50'});
  const leases = await Promise.all(Array.from({length: 10}, (_, i) => f.begin(`visitor-${i}`)));
  const calls = await Promise.all(leases.map(x => f.reserve(x.lease)));
  assert.equal(calls.filter(x => x.call_allowed).length, 5);
  assert.equal(calls.filter(x => x.code === 'DEMO_BUDGET_EXHAUSTED').length, 5);
  const status = await f.send('status'); assert.equal(status.used_micro_cny, 500_000); assert.equal(status.accepting_calls, false);
});

test('40.0203 fen legacy balance admits a bounded call and settles its actual usage without resetting history', async () => {
  const f = fixture({DEMO_BUDGET_CENTS: '100', DAILY_BUDGET_CENTS: '50'});
  await f.send('status');
  const meta = f.storage.data.get('meta');
  meta.used_micro_cny = 400_203;
  meta.by_day['2026-10-24'] = 400_203;
  f.storage.data.set('meta', meta);
  assert.equal(400_203 + 100_000 > 500_000, true);
  const {lease} = await f.begin();
  const expected = reservationForInput(gatewayPolicy({}), 2_000).micro;
  const first = await f.reserve(lease, 'bounded-plan', 'plan', {input_bound_tokens: 2_000});
  assert.equal(first.call_allowed, true);
  assert.equal(first.reserved_micro_cny, expected);
  assert.ok(expected < 99_797);
  assert.equal((await f.reserve(lease, 'bounded-plan', 'plan', {input_bound_tokens: 2_000})).duplicate, true);
  assert.equal((await f.reserve(lease, 'bounded-plan', 'plan', {input_bound_tokens: 2_001})).code, 'IDEMPOTENCY_CONFLICT');
  const settled = await f.send('receipt', complete(lease, 'bounded-plan'));
  assert.equal(settled.charged_micro_cny, 5_183);
  const status = await f.send('status');
  assert.equal(status.today_used_cents, 40.5386);
  assert.equal(status.used_micro_cny, 405_386);
  assert.equal(status.call_count, 1);
});

test('bounded reservations remain atomic across concurrent users and original-day settlement', async () => {
  const f = fixture({DEMO_BUDGET_CENTS: '100', DAILY_BUDGET_CENTS: '50'});
  await f.send('status');
  const meta = f.storage.data.get('meta');
  meta.used_micro_cny = 400_203;
  meta.by_day['2026-10-24'] = 400_203;
  f.storage.data.set('meta', meta);
  const leases = await Promise.all(Array.from({length: 4}, (_, n) => f.begin(`bounded-${n}`)));
  const reservations = await Promise.all(leases.map(({lease}, n) => f.reserve(lease, `bounded-${n}`, 'plan', {input_bound_tokens: 2_000})));
  assert.equal(reservations.filter(x => x.call_allowed).length, 3);
  assert.equal(reservations.filter(x => x.code === 'DAILY_BUDGET_EXHAUSTED').length, 1);
  const admittedIndex = reservations.findIndex(x => x.call_allowed);
  f.time(Date.parse('2026-10-24T16:00:00Z'));
  await f.send('receipt', complete(leases[admittedIndex].lease, `bounded-${admittedIndex}`));
  assert.equal((await f.send('status')).today_used_cents, 0);
  assert.equal(f.storage.data.get('meta').by_day['2026-10-24'], 400_203 + 2 * reservations[admittedIndex].reserved_micro_cny + 5_183);
});

test('missing or anomalous usage never refunds a dynamic reservation as precise cost', async () => {
  for (const usage of [null, {prompt_tokens: 2_001, completion_tokens: 1}, {prompt_tokens: 100, completion_tokens: 1_025},
    {prompt_tokens: 100, completion_tokens: 20, total_tokens: 1000},
    {prompt_tokens: 100, completion_tokens: 20, input_tokens: 200},
    {prompt_tokens: 100, completion_tokens: 20, output_tokens: 200}]) {
    const f = fixture(), {lease} = await f.begin();
    const held = await f.reserve(lease, 'uncertain', 'plan', {input_bound_tokens: 2_000});
    const result = await f.send('receipt', complete(lease, 'uncertain', {usage}));
    assert.equal(result.charged_micro_cny, held.reserved_micro_cny);
    const recent = (await f.send('status')).recent_receipts[0];
    assert.equal(recent.usage_estimate_verified, false);
    assert.equal(recent.cost_basis, 'CONSERVATIVE_RESERVATION_NOT_INVOICE');
  }
});

test('consistent usage totals and aliases allow one verified settlement, never a second refund', async () => {
  const f = fixture(), {lease} = await f.begin();
  await f.reserve(lease, 'consistent', 'plan', {input_bound_tokens: 2000});
  const body = complete(lease, 'consistent', {usage: {prompt_tokens: 1000, completion_tokens: 100, total_tokens: 1100, input_tokens: 1000, output_tokens: 100}});
  assert.equal((await f.send('receipt', body)).charged_micro_cny, 5183);
  assert.equal((await f.send('receipt', body)).duplicate, true);
  const status = await f.send('status');
  assert.equal(status.used_micro_cny, 5183);
  assert.equal(status.receipt_count, 1);
  assert.equal(status.recent_receipts[0].usage_estimate_verified, true);
});

test('identical request is charged once and cannot authorize a second provider call', async () => {
  const f = fixture(), body = {owner: 'visitor', turn_id: 'turn', request_id: 'user-request'};
  const first = await f.begin('visitor', body), duplicate = await f.begin('visitor', body);
  assert.equal(first.lease, duplicate.lease); assert.equal(duplicate.duplicate, true);
  const results = await Promise.all([f.reserve(first.lease, 'call'), f.reserve(first.lease, 'call')]);
  assert.equal(results.filter(x => x.call_allowed).length, 1);
  assert.equal(results.filter(x => x.duplicate && !x.call_allowed).length, 1);
  assert.equal((await f.reserve(first.lease, 'call', 'plan', {request_hash: 'c'.repeat(64)})).code, 'IDEMPOTENCY_CONFLICT');
  assert.equal((await f.begin('attacker', {...body, owner: 'attacker'})).code, 'IDEMPOTENCY_CONFLICT');
  assert.equal((await f.send('status')).used_micro_cny, 100_000);
});

test('one owner active, two allowlisted phases maximum, and explicit release', async () => {
  const f = fixture(), {lease} = await f.begin('owner');
  assert.equal((await f.begin('owner')).code, 'OWNER_BUSY');
  assert.equal((await f.reserve(lease, 'plan')).call_allowed, true);
  assert.equal((await f.reserve(lease, 'duplicate-phase')).code, 'AGENT_STEP_LIMIT');
  assert.equal((await f.reserve(lease, 'wrong-tool', 'trade')).code, 'PHASE_NOT_ALLOWED');
  assert.equal((await f.reserve(lease, 'answer', 'answer')).call_allowed, true);
  assert.equal((await f.reserve(lease, 'third', 'answer')).code, 'AGENT_STEP_LIMIT');
  await f.send('release', {lease, status: 'COMPLETE'});
  assert.equal((await f.begin('owner')).ok, true);
  assert.equal((await f.reserve(lease, 'after-release', 'answer')).code, 'LEASE_EXPIRED');
});

test('owner and hashed IP minute limits survive fast completions', async () => {
  const f = fixture();
  for (let n = 0; n < 6; n++) {const {lease} = await f.begin('owner'); await f.send('release', {lease, status: 'COMPLETE'});}
  assert.equal((await f.begin('owner')).code, 'RATE_LIMIT');
  for (let n = 0; n < 14; n++) {const {lease} = await f.begin(); await f.send('release', {lease, status: 'COMPLETE'});}
  assert.equal((await f.begin()).code, 'RATE_LIMIT');
  f.time(start + 60_001); assert.equal((await f.begin('owner')).ok, true);
});

test('expired leases restore concurrency without refunding uncertain provider calls', async () => {
  const f = fixture(), {lease} = await f.begin('owner'); await f.reserve(lease, 'unknown');
  f.time(start + 180_001);
  assert.equal((await f.begin('owner')).ok, true);
  assert.equal((await f.reserve(lease, 'late', 'answer')).code, 'LEASE_EXPIRED');
  const status = await f.send('status'); assert.equal(status.active_count, 1); assert.equal(status.incomplete_count, 1); assert.equal(status.used_micro_cny, 100_000);
});

test('durable ledger survives instance replacement; config cannot reset period or raise caps', async () => {
  const f = fixture({DEMO_BUDGET_CENTS: '100', DAILY_BUDGET_CENTS: '100'}), {lease} = await f.begin(); await f.reserve(lease, 'persist');
  const again = fixture({DEMO_BUDGET_CENTS: '100', DAILY_BUDGET_CENTS: '100'}, f.storage);
  assert.equal((await again.send('status')).used_micro_cny, 100_000);
  assert.equal((await again.reserve(lease, 'persist')).call_allowed, false);
  assert.equal((await fixture({}, f.storage).send('status')).code, 'BUDGET_CONFIG_CHANGED');
  assert.equal((await fixture({DEMO_BUDGET_CENTS: '100', DAILY_BUDGET_CENTS: '100', DEMO_START_AT: '2026-10-25T10:00:00+08:00', DEMO_END_AT: '2026-11-09T10:00:00+08:00'}, f.storage).send('status')).code, 'BUDGET_CONFIG_CHANGED');
});

test('daily limit resets at Beijing midnight while total remains charged', async () => {
  const f = fixture({DEMO_BUDGET_CENTS: '100', DAILY_BUDGET_CENTS: '10'});
  f.time(Date.parse('2026-10-24T15:59:59Z')); const {lease} = await f.begin(); await f.reserve(lease, 'day1');
  assert.equal((await f.reserve(lease, 'day1-answer', 'answer')).code, 'DAILY_BUDGET_EXHAUSTED');
  f.time(Date.parse('2026-10-24T16:00:00Z')); assert.equal((await f.reserve(lease, 'day2-answer', 'answer')).call_allowed, true);
  const status = await f.send('status'); assert.equal(status.day, '2026-10-25'); assert.equal(status.today_used_cents, 10); assert.equal(status.used_cents, 20);
});

test('before start and at end paid calls stop while status remains readable', async () => {
  const f = fixture(); f.time(start - 1); assert.equal((await f.begin()).code, 'DEMO_NOT_STARTED');
  f.time(start); const {lease} = await f.begin(); await f.reserve(lease, 'first');
  f.time(Date.parse(baseEnv.DEMO_END_AT)); assert.equal((await f.begin()).code, 'DEMO_ENDED');
  assert.equal((await f.send('status')).ok, true); assert.equal((await f.send('status')).accepting_calls, false);
});

test('missing, excessive, unzoned or too-short deployment config fails closed', async () => {
  for (const env of [{DEMO_BUDGET_CENTS: undefined}, {DEMO_BUDGET_CENTS: '1001'}, {DAILY_BUDGET_CENTS: '1001'}, {DEMO_START_AT: '2026-10-24T10:00:00'}, {DEMO_END_AT: '2026-11-08T09:59:59+08:00'}]) {
    assert.equal((await fixture(env).begin()).code, 'BUDGET_CONFIG_INVALID');
  }
});

test('verified usage settles in integer micro-CNY and duplicate receipt never double refunds', async () => {
  const f = fixture(), {lease} = await f.begin(); await f.reserve(lease, 'settle');
  const data = complete(lease, 'settle');
  const first = await f.send('receipt', data), duplicate = await f.send('receipt', data);
  assert.equal(first.charged_micro_cny, 5183); assert.equal(duplicate.duplicate, true);
  const status = await f.send('status'); assert.equal(status.used_micro_cny, 5183); assert.equal(status.used_cents, .5183); assert.equal(status.receipt_count, 1); assert.equal(status.complete_count, 1); assert.equal(status.usage_settled_count, 1); assert.equal(status.full_reservation_count, 0);
  assert.equal((await f.send('receipt', {...data, usage: {prompt_tokens: 1, completion_tokens: 1}})).code, 'RECEIPT_CONFLICT');
  assert.equal((await f.send('status')).used_micro_cny, 5183);
});

test('unknown, aborted, failed, missing-usage and multi-attempt outcomes retain entire reserve', async () => {
  for (const extra of [{status: 'UNKNOWN'}, {status: 'ABORTED'}, {status: 'ERROR'}, {usage: null}, {usage: {prompt_tokens: 1000, completion_tokens: 1025}}, {attempt_count: 2}, {provider_response_id: null}]) {
    const f = fixture(), {lease} = await f.begin(); await f.reserve(lease, 'retain');
    assert.equal((await f.send('receipt', complete(lease, 'retain', extra))).charged_micro_cny, 100_000);
    assert.equal((await f.send('status')).used_micro_cny, 100_000);
    assert.equal((await f.send('status')).full_reservation_count, 1);
  }
});

test('late next-day usage receipt settles original reservation day only', async () => {
  const f = fixture(); f.time(Date.parse('2026-10-24T15:59:59Z')); const {lease} = await f.begin(); await f.reserve(lease, 'crossday');
  f.time(Date.parse('2026-10-24T16:00:01Z')); await f.send('receipt', complete(lease, 'crossday'));
  assert.equal((await f.send('status')).today_used_cents, 0);
  assert.equal(f.storage.data.get('meta').by_day['2026-10-24'], 5183);
});

test('identity, malformed receipt and missing reservation fail closed; sensitive extra fields discarded', async () => {
  const f = fixture(), {lease} = await f.begin(); await f.reserve(lease, 'private');
  assert.equal((await f.send('receipt', complete(lease, 'private', {model: 'expensive-model'}))).code, 'MODEL_IDENTITY_INVALID');
  assert.equal((await f.send('receipt', complete(lease, 'unknown-call'))).code, 'RESERVATION_NOT_FOUND');
  assert.equal((await f.send('receipt', complete(lease, 'private', {usage: {prompt_tokens: -1}}))).code, 'INVALID_REQUEST');
  await f.send('receipt', complete(lease, 'private', {api_key: 'SECRET-NOT-STORED', prompt: 'PRIVATE-HOLDINGS', ip: '203.0.113.7', response: 'PRIVATE-ANSWER'}));
  const stored = JSON.stringify([...f.storage.data.entries()]);
  for (const secret of ['SECRET-NOT-STORED', 'PRIVATE-HOLDINGS', '203.0.113.7', 'PRIVATE-ANSWER']) assert.equal(stored.includes(secret), false);
  const status = await f.send('status');
  assert.equal(status.recent_receipts.length, 1);
  assert.equal(status.recent_receipts[0].request_id, 'private');
  assert.equal(status.recent_receipts[0].usage.prompt_tokens, 1000);
  assert.equal(status.recent_receipts[0].owner, undefined);
});

test('gate transport validates JSON, limits body, and never accepts plaintext IP', async () => {
  const f = fixture(); assert.equal((await f.begin('owner', {ip_hash: '203.0.113.7'})).code, 'INVALID_REQUEST');
  assert.equal((await f.send('status', {x: 'a'.repeat(9000)})).http_status, 413);
  assert.equal((await f.gate.fetch(new Request('https://gate/status'))).status, 405);
  assert.equal((await f.gate.fetch(new Request('https://gate/status', {method: 'POST', body: '{bad'}))).status, 400);
});

test('API admission limits per IP without altering or requiring an AI ledger', async () => {
  const f = fixture({DEMO_BUDGET_CENTS: undefined});
  const admitted = await Promise.all(Array.from({length: 121}, () => f.send('admit', {ip_hash: ip, kind: 'read'})));
  assert.equal(admitted.filter(x => x.ok).length, 120);
  assert.equal(admitted.filter(x => x.code === 'RATE_LIMIT').length, 1);
  assert.equal(f.storage.data.has('meta'), false);
  assert.equal((await f.send('admit', {ip_hash: '203.0.113.1', kind: 'read'})).code, 'INVALID_REQUEST');
  assert.equal((await f.send('admit', {ip_hash: digest, kind: 'invalid'})).code, 'INVALID_REQUEST');
});

test('session and new-chat limits are persisted and independent of history access', async () => {
  const f = fixture();
  for (let n = 0; n < 5; n++) assert.equal((await f.send('admit', {ip_hash: ip, kind: 'create'})).ok, true);
  assert.equal((await f.send('admit', {ip_hash: ip, kind: 'create'})).code, 'RATE_LIMIT');
  const again = fixture({}, f.storage);
  assert.equal((await again.send('admit', {ip_hash: ip, kind: 'create'})).code, 'RATE_LIMIT');
  for (let n = 0; n < 15; n++) assert.equal((await again.send('admit', {ip_hash: ip, kind: 'session'})).ok, true);
  assert.equal((await again.send('admit', {ip_hash: ip, kind: 'session'})).code, 'RATE_LIMIT');
  assert.equal((await again.send('admit', {ip_hash: ip, kind: 'read'})).ok, true);
  assert.equal((await again.send('admit', {ip_hash: digest, kind: 'create'})).ok, true);
});

test('global API admission is atomic, cardinality bounded and old IP counters pruned', async () => {
  const f = fixture();
  const results = await Promise.all(Array.from({length: 1201}, (_, n) => f.send('admit', {ip_hash: n.toString(16).padStart(64, '0'), kind: 'read'})));
  assert.equal(results.filter(x => x.ok).length, 1200);
  assert.equal(results.filter(x => x.code === 'GLOBAL_RATE_LIMIT').length, 1);
  assert.equal(f.storage.data.get('admission').ips.length, 1200);
  assert.ok(JSON.stringify(f.storage.data.get('admission')).length < 128 * 1024);
  f.time(start + 60_000);
  assert.equal((await f.send('admit', {ip_hash: ip, kind: 'stream'})).ok, true);
  assert.equal([...f.storage.data.keys()].filter(key => key.startsWith('admit-ip:')).length, 1);
  assert.equal(f.storage.data.get('admission').count, 1);
});

test('admission leaves existing paid-call ledger unchanged through expiry and exhaustion', async () => {
  const f = fixture({DEMO_BUDGET_CENTS: '10', DAILY_BUDGET_CENTS: '10'});
  const {lease} = await f.begin(); await f.reserve(lease, 'existing');
  const original = structuredClone(f.storage.data.get('meta'));
  assert.equal((await f.begin()).code, 'DEMO_BUDGET_EXHAUSTED');
  for (const kind of ['session', 'create', 'read', 'mutation', 'stream']) assert.equal((await f.send('admit', {ip_hash: ip, kind})).ok, true);
  f.time(Date.parse(baseEnv.DEMO_END_AT));
  assert.equal((await f.send('admit', {ip_hash: ip, kind: 'read'})).ok, true);
  assert.deepEqual(f.storage.data.get('meta'), original);
});

test('admin recent receipts are capped at twenty and exclude repeated receipt submissions', async () => {
  const f = fixture();
  for (let n = 0; n < 21; n++) {
    f.time(start + n * 60_001);
    const {lease} = await f.begin(), requestId = `call-${n}`;
    await f.reserve(lease, requestId);
    const data = complete(lease, requestId);
    await f.send('receipt', data); await f.send('receipt', data);
    await f.send('release', {lease, status: 'COMPLETE'});
  }
  const status = await f.send('status');
  assert.equal(status.recent_receipts.length, 20);
  assert.equal(status.recent_receipts[0].request_id, 'call-1');
  assert.equal(status.recent_receipts.at(-1).request_id, 'call-20');
  assert.equal(status.call_count, 21); assert.equal(status.receipt_count, 21);
});

test('diagnostic error codes retain only bounded uppercase tokens, never raw errors', async () => {
  for (const [value, expected] of [['MODEL_STREAM_INTERRUPTED', 'MODEL_STREAM_INTERRUPTED'], ['provider said PRIVATE-HOLDINGS', null], ['A'.repeat(82), null], [null, null]]) {
    const f = fixture(), {lease} = await f.begin(); await f.reserve(lease, 'diagnostic');
    await f.send('receipt', complete(lease, 'diagnostic', {status: 'ERROR', error_code: value}));
    const status = await f.send('status'); assert.equal(status.recent_receipts[0].error_code, expected);
    assert.equal(JSON.stringify(status).includes('PRIVATE-HOLDINGS'), false);
  }
});
