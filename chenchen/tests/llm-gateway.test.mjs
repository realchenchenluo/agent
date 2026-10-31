import test from 'node:test';
import assert from 'node:assert/strict';
import {ChatGate} from '../integration/public-chat/gate.mjs';
import {createModelGateway} from '../integration/public-chat/llm-gateway.mjs';
import {gatewayPolicy, reservationForInput} from '../integration/public-chat/gateway-policy.mjs';
import {validateAnswer} from '../integration/public-chat/shared.mjs';
import {routeProviders} from '../integration/public-chat/provider-adapter.mjs';

class Storage {
  data = new Map();
  async transaction(work) {
    const copy = structuredClone(this.data);
    const result = await work({get: async key => structuredClone(copy.get(key)), put: async (key, value) => copy.set(key, structuredClone(value)), delete: async key => copy.delete(key)});
    this.data = copy;
    return result;
  }
}
const base = {
  MODEL_ENABLED: 'true', LLM_GATEWAY_MODE: 'external', LLM_PAID_PROVIDER_APPROVED: 'true', LLM_PRIMARY: 'A',
  DEMO_BUDGET_CENTS: '100', DAILY_BUDGET_CENTS: '50', DEMO_START_AT: '2026-10-23T00:00:00Z', DEMO_END_AT: '2026-11-09T00:00:00Z',
  LLM_CNY_PER_USD_CAP: '10',
  LLM_A_PROVIDER: 'openai', LLM_A_PROTOCOL: 'chat-completions', LLM_A_BASE_URL: 'https://api.openai.com/v1', LLM_A_MODEL: 'synthetic-a', LLM_A_API_KEY: 'test-only-a',
  LLM_A_PROTOCOL_VERIFIED: 'true', LLM_A_JSON_VERIFIED: 'true', LLM_A_STREAM_VERIFIED: 'true', LLM_A_BILLING_BOUNDS_VERIFIED: 'true', LLM_A_INPUT_USD_PER_MILLION: '0.08', LLM_A_OUTPUT_USD_PER_MILLION: '0.2', LLM_A_DAILY_MAX_CALLS: '20', LLM_A_DAILY_CAP_CENTS: '50',
  LLM_B_PROVIDER: 'deepseek', LLM_B_PROTOCOL: 'chat-completions', LLM_B_BASE_URL: 'https://api.deepseek.com', LLM_B_MODEL: 'synthetic-b', LLM_B_API_KEY: 'test-only-b',
  LLM_B_PROTOCOL_VERIFIED: 'true', LLM_B_JSON_VERIFIED: 'true', LLM_B_STREAM_VERIFIED: 'true', LLM_B_BILLING_BOUNDS_VERIFIED: 'true', LLM_B_INPUT_USD_PER_MILLION: '0.08', LLM_B_OUTPUT_USD_PER_MILLION: '0.2', LLM_B_DAILY_MAX_CALLS: '20', LLM_B_DAILY_CAP_CENTS: '50',
};
const ip = 'a'.repeat(64);
function fixture(extra = {}) {
  const env = {...base, ...extra}, storage = new Storage(), gate = new ChatGate({storage}, env);
  gate.now = () => Date.parse('2026-10-24T08:00:00Z');
  env.CHAT_GATE = {idFromName: value => value, get: () => ({fetch: request => gate.fetch(request)})};
  const send = async (route, body = {}) => {const response = await gate.fetch(new Request('https://gate/' + route, {method: 'POST', body: JSON.stringify(body)}));return {status: response.status, ...await response.json()};};
  const begin = async () => {const result = await send('begin', {owner: 'synthetic-owner', ip_hash: ip, turn_id: 'turn-1', request_id: 'user-request-1'});assert.equal(result.ok, true);return result.lease;};
  return {env, storage, send, begin};
}
const binding = phase => ({phase, trace_id: 'trace-test', conversation_id: 'chat-test', turn_id: 'turn-test', input_hash: 'b'.repeat(64)});
const options = phase => ({signal: new AbortController().signal, binding: binding(phase)});
const response = (model, content) => Response.json({id: 'provider-response-1', model, choices: [{message: {content}, finish_reason: 'stop'}], usage: {prompt_tokens: 100, completion_tokens: 20}});

test('external routing requires approval, verified capabilities, official hosts and a bound worst-case cost', () => {
  for (const env of [
    {...base, LLM_PAID_PROVIDER_APPROVED: 'false'},
    {...base, LLM_A_JSON_VERIFIED: 'false'},
    {...base, LLM_A_BILLING_BOUNDS_VERIFIED: 'false'},
    {...base, LLM_A_BASE_URL: 'https://elsewhere.example/v1'},
    {...base, LLM_A_INPUT_USD_PER_MILLION: '5'},
  ]) assert.throws(() => gatewayPolicy(env));
  assert.ok(gatewayPolicy(base).max_micro_cny <= 100_000);
  const higherPrices = {...base, LLM_A_INPUT_USD_PER_MILLION: '0.3', LLM_A_OUTPUT_USD_PER_MILLION: '1.2', LLM_B_INPUT_USD_PER_MILLION: '0.1', LLM_B_OUTPUT_USD_PER_MILLION: '0.5'};
  assert.throws(() => gatewayPolicy(higherPrices), {code: 'GATEWAY_POLICY_INVALID'});
  assert.ok(gatewayPolicy({...higherPrices, LLM_A_MAX_MESSAGE_CHARS: '6500', LLM_B_MAX_MESSAGE_CHARS: '6500'}).max_micro_cny <= 100_000);
});

test('hybrid policy exposes a finite conservative quote including the Workers AI attempt', () => {
  const policy = gatewayPolicy({...base, LLM_GATEWAY_MODE: 'hybrid'});
  assert.equal(Number.isSafeInteger(policy.max_micro_cny), true);
  assert.ok(policy.max_micro_cny > 0);
  assert.ok(policy.max_micro_cny >= reservationForInput(policy, 2000, 'A').micro);
  assert.notEqual(JSON.parse(JSON.stringify(policy)).max_micro_cny, null);
});

test('quota 429 falls back once within one reservation; admin stats distinguish calls, attempts, usage and conservative cost', async () => {
  const f = fixture(), lease = await f.begin(), calls = [], events = [];
  const model = createModelGateway(f.env, lease, {fetchImpl: async (url, request) => {
    calls.push(String(url));
    assert.equal(request.headers['X-Client-Request-Id'].startsWith('chat-ai-'), true);
    return calls.length === 1 ? Response.json({error: {code: 'insufficient_quota'}}, {status: 429}) : response('synthetic-b', JSON.stringify({operation: 'explain', focus: 'actual'}));
  }});
  const result = await model.plan({message: '你好', state: {}, history: []}, {...options('plan'), onEvent: event => events.push(event)});
  assert.equal(result.value.operation, 'explain');
  assert.equal(result.receipt.provider, 'deepseek');
  assert.deepEqual(calls, ['https://api.openai.com/v1/chat/completions', 'https://api.deepseek.com/chat/completions']);
  assert.equal(events.at(-1).attempts[0].error_code, 'MODEL_QUOTA_EXHAUSTED');
  const status = await f.send('status');
  assert.deepEqual({calls: status.today_model_stats.reserved_calls, attempts: status.today_model_stats.provider_attempts, failed: status.today_model_stats.failed_calls, tokens: status.today_model_stats.input_tokens},
    {calls: 1, attempts: 2, failed: 0, tokens: 100});
  assert.equal(status.today_model_stats.estimated_micro_cny, status.recent_receipts[0].reserved_micro_cny);
  assert.ok(status.today_model_stats.estimated_micro_cny < 100_000);
  assert.equal(status.recent_receipts[0].attempts.length, 2);
  assert.equal(JSON.stringify([...f.storage.data]).includes('test-only-a'), false);
});

test('fallback answer receives deterministic holding facts and passes numeric validation', async () => {
  const f = fixture({LLM_A_MODEL: 'synthetic-a-facts', LLM_B_MODEL: 'synthetic-b-facts'}), lease = await f.begin(), calls = [];
  const context = {question: '请解释占比', operation: 'analyze', actual: [{name: '股票 A', amount_cents: 3_000_000}, {name: '基金 B', amount_cents: 2_000_000}, {name: '现金', amount_cents: 2_000_000}],
    actual_tool: {total_cents: 7_000_000, rows: [{name: '股票 A', weight_pct: 42.86}, {name: '基金 B', weight_pct: 28.57}, {name: '现金', weight_pct: 28.57}]}, execution_allowed: false};
  const stream = new ReadableStream({start(c) {c.enqueue(new TextEncoder().encode('data: {"id":"facts-response","choices":[{"delta":{"content":"总额 70,000 元；股票 A 占 42.86%。"}}]}\n\ndata: {"usage":{"prompt_tokens":120,"completion_tokens":30},"choices":[{"delta":{}}]}\n\ndata: [DONE]\n\n'));c.close();}});
  const model = createModelGateway(f.env, lease, {fetchImpl: async (url, request) => {
    calls.push(String(url));
    const body = JSON.parse(request.body), facts = JSON.parse(body.messages[1].content);
    assert.equal(facts.original_holdings.total_yuan, 70000);
    assert.equal(facts.original_holdings.rows[0].weight_pct, 42.86);
    return calls.length === 1 ? new Response(null, {status: 402}) : new Response(stream, {status: 200});
  }});
  const result = await model.answer(context, options('answer'));
  assert.equal(calls.length, 2);
  assert.doesNotThrow(() => validateAnswer(result.text, context));
  assert.equal((await f.send('status')).today_model_stats.provider_attempts, 2);
});

test('external streaming returns usage and never claims a receipt without terminal marker', async () => {
  const f = fixture({LLM_PRIMARY: 'B', LLM_A_PROVIDER: undefined}), lease = await f.begin(), deltas = [];
  const stream = new ReadableStream({start(c) {c.enqueue(new TextEncoder().encode('data: {"id":"stream-1","model":"synthetic-b","choices":[{"delta":{"content":"已核对"}}]}\n\ndata: {"usage":{"prompt_tokens":100,"completion_tokens":20},"choices":[{"delta":{}}]}\n\ndata: [DONE]\n\n'));c.close();}});
  const model = createModelGateway(f.env, lease, {fetchImpl: async () => new Response(stream, {status: 200})});
  const result = await model.answer({question: '解释计算', actual: [], operation: 'explain'}, {...options('answer'), onDelta: x => deltas.push(x)});
  assert.equal(result.text, '已核对');assert.deepEqual(deltas, ['已核对']);
  const status = await f.send('status');
  assert.equal(status.today_model_stats.provider_attempts, 1);
  assert.equal(status.recent_receipts[0].usage_estimate_verified, true);
  assert.equal(status.recent_receipts[0].charged_micro_cny, 120);
});

test('a daily budget rejection happens before any external network request', async () => {
  const f = fixture({DAILY_BUDGET_CENTS: '10'}), lease = await f.begin();
  const first = await f.send('reserve', {lease, request_id: 'first', request_hash: 'c'.repeat(64), phase: 'plan'});
  assert.equal(first.call_allowed, true);
  let calls = 0;
  const model = createModelGateway(f.env, lease, {fetchImpl: async () => {calls++;return response('synthetic-a', 'unused');}});
  await assert.rejects(model.answer({question: '你好'}, options('answer')), {code: 'DAILY_BUDGET_EXHAUSTED'});
  assert.equal(calls, 0);
});

test('per-model daily call caps are enforced by the durable gate before an upstream attempt', async () => {
  const f = fixture({LLM_A_DAILY_MAX_CALLS: '1', LLM_B_DAILY_MAX_CALLS: '1'}), lease = await f.begin();
  assert.equal((await f.send('reserve', {lease, request_id: 'first-model', request_hash: 'c'.repeat(64), phase: 'plan'})).call_allowed, true);
  const denied = await f.send('reserve', {lease, request_id: 'second-model', request_hash: 'd'.repeat(64), phase: 'answer'});
  assert.equal(denied.code, 'MODEL_DAILY_LIMIT');
  const status = await f.send('status');
  assert.equal(status.today_model_stats.reserved_calls, 1);
  assert.equal(status.today_provider_usage.length, 2);
});

test('opt-in hybrid uses Workers AI first and one external backup for platform neuron exhaustion', async () => {
  const f = fixture({LLM_GATEWAY_MODE: 'hybrid', LLM_A_MODEL: 'hybrid-synthetic-a'}), lease = await f.begin();
  let cloudCalls = 0, externalCalls = 0;
  f.env.MODEL_NAME = '@cf/meta/llama-3.3-70b-instruct-fp8-fast';
  f.env.AI = {lastRequestId: 'cloud-request', async run() {
    cloudCalls++;
    throw Object.assign(Error('Workers AI 3036'), {code: 3036, status: 429});
  }};
  const model = createModelGateway(f.env, lease, {fetchImpl: async () => {
    externalCalls++;
    return response('hybrid-synthetic-a', JSON.stringify({operation: 'explain', focus: 'actual'}));
  }});
  const result = await model.plan({message: '你好', state: {}, history: []}, options('plan'));
  assert.equal(result.value.operation, 'explain');
  assert.equal(cloudCalls, 1);assert.equal(externalCalls, 1);
  const status = await f.send('status');
  assert.equal(status.recent_receipts[0].attempts.length, 2);
  assert.equal(status.recent_receipts[0].attempts[0].error_code, 'CLOUDFLARE_NEURONS_EXHAUSTED');
  assert.equal(status.today_model_stats.provider_attempts, 2);
});

test('hybrid never switches after partial Workers AI stream', async () => {
  const f = fixture({LLM_GATEWAY_MODE: 'hybrid'}), lease = await f.begin();
  f.env.MODEL_NAME = '@cf/meta/llama-3.3-70b-instruct-fp8-fast';
  f.env.AI = {lastRequestId: 'cloud-partial', async run() {
    return new ReadableStream({start(controller) {
      controller.enqueue(new TextEncoder().encode('data: {"response":"部分"}\n\n'));
      controller.close();
    }});
  }};
  let backupCalls = 0;
  const model = createModelGateway(f.env, lease, {fetchImpl: async () => {backupCalls++; return response('synthetic-a', '备用');}});
  await assert.rejects(model.answer({question: '解释', actual: [], operation: 'explain'}, options('answer')), {code: 'MODEL_STREAM_INTERRUPTED'});
  assert.equal(backupCalls, 0);
  const status = await f.send('status');
  assert.equal(status.recent_receipts[0].attempts.length, 1);
  assert.equal(status.recent_receipts[0].usage_estimate_verified, false);
});

test('hybrid selects B when A has reached its independent daily call cap', async () => {
  const f = fixture({LLM_GATEWAY_MODE: 'hybrid', LLM_A_MODEL: 'hybrid-cap-a', LLM_B_MODEL: 'hybrid-cap-b', LLM_A_DAILY_MAX_CALLS: '1'});
  await f.send('status');
  const meta = f.storage.data.get('meta');
  meta.provider_by_day['2026-10-24'] = {'openai:hybrid-cap-a': {calls: 1, micro_cny: 1}};
  f.storage.data.set('meta', meta);
  const lease = await f.begin();
  f.env.MODEL_NAME = '@cf/meta/llama-3.3-70b-instruct-fp8-fast';
  f.env.AI = {lastRequestId: 'cloud-limit', async run() {throw Object.assign(Error('3040'), {code: 3040, status: 429});}};
  const urls = [];
  const model = createModelGateway(f.env, lease, {fetchImpl: async url => {
    urls.push(String(url));
    return response('hybrid-cap-b', JSON.stringify({operation: 'explain'}));
  }});
  assert.equal((await model.plan({message: '你好', state: {}, history: []}, options('plan'))).value.operation, 'explain');
  assert.deepEqual(urls, ['https://api.deepseek.com/chat/completions']);
  const status = await f.send('status');
  assert.equal(status.recent_receipts[0].attempts[0].error_code, 'MODEL_UPSTREAM_CAPACITY');
  assert.equal(status.recent_receipts[0].attempts[1].model, 'hybrid-cap-b');
});

test('hybrid reserves the authorized backup path rather than an unused expensive backup', async () => {
  const f = fixture({LLM_GATEWAY_MODE: 'hybrid', LLM_A_MODEL: 'bounded-hybrid-a', LLM_B_MODEL: 'bounded-hybrid-b',
    LLM_B_OUTPUT_USD_PER_MILLION: '8'});
  const policy = gatewayPolicy(f.env), lease = await f.begin();
  assert.ok(reservationForInput(policy, 2_000).micro > 100_000);
  const selected = reservationForInput(policy, 2_000, 'A');
  const held = await f.send('reserve', {lease, request_id: 'selected-a', request_hash: 'c'.repeat(64), phase: 'plan',
    input_bound_tokens: 2_000, preferred_backup_slot: 'A'});
  assert.equal(held.call_allowed, true);
  assert.equal(held.backup_slot, 'A');
  assert.equal(held.reserved_micro_cny, selected.micro);
  assert.ok(held.reserved_micro_cny < 100_000);
});

test('hybrid skips a backup whose combined worst-case path breaches the per-call ceiling', async () => {
  const f = fixture({LLM_GATEWAY_MODE: 'hybrid', LLM_A_MODEL: 'over-cap-hybrid-a', LLM_B_MODEL: 'bounded-hybrid-b',
    LLM_A_OUTPUT_USD_PER_MILLION: '8'});
  const lease = await f.begin();
  const held = await f.send('reserve', {lease, request_id: 'selected-b', request_hash: 'd'.repeat(64), phase: 'plan',
    input_bound_tokens: 2_000, preferred_backup_slot: 'A'});
  assert.equal(held.call_allowed, true);
  assert.equal(held.backup_slot, 'B');
  assert.equal(held.reserved_micro_cny, reservationForInput(gatewayPolicy(f.env), 2_000, 'B').micro);
});

test('hybrid pre-reserves B when A is in failure cooldown', async () => {
  const overrides = {LLM_GATEWAY_MODE: 'hybrid', LLM_A_MODEL: 'hybrid-cool-a', LLM_B_MODEL: 'hybrid-cool-b'};
  await assert.rejects(routeProviders({...base, ...overrides, LLM_B_PROVIDER: undefined}, [{role:'system',content:'test'},{role:'user',content:'test'}],
    {fetchImpl: async () => new Response(null, {status: 503})}), {code: 'MODEL_PROVIDERS_UNAVAILABLE'});
  const f = fixture(overrides), lease = await f.begin();
  f.env.MODEL_NAME = '@cf/meta/llama-3.3-70b-instruct-fp8-fast';
  f.env.AI = {lastRequestId: 'cloud-cool', async run() {throw Object.assign(Error('3036'), {code:3036,status:429});}};
  const urls = [];
  const model = createModelGateway(f.env, lease, {fetchImpl: async url => {
    urls.push(String(url));
    return response('hybrid-cool-b', JSON.stringify({operation:'explain'}));
  }});
  await model.plan({message:'你好',state:{},history:[]},options('plan'));
  assert.deepEqual(urls,['https://api.deepseek.com/chat/completions']);
});

test('audit callback failure still writes a conservative receipt before any provider call', async () => {
  for (const mode of ['external','hybrid']) {
    const f = fixture({LLM_GATEWAY_MODE:mode,LLM_A_MODEL:`audit-failure-${mode}-a`,LLM_B_MODEL:`audit-failure-${mode}-b`}), lease = await f.begin();
    let calls = 0;
    const model = createModelGateway(f.env, lease, {fetchImpl: async () => {calls++;return response('unused','unused');}});
    await assert.rejects(model.plan({message:'你好',state:{},history:[]},{...options('plan'),onEvent:()=>{throw Error('synthetic audit callback failure');}}));
    assert.equal(calls,0);
    const status = await f.send('status');
    assert.equal(status.receipt_count,1);
    assert.equal(status.recent_receipts[0].usage_estimate_verified,false);
    assert.equal(status.used_micro_cny,status.recent_receipts[0].reserved_micro_cny);
  }
});
