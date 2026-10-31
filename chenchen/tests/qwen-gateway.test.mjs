// OFFLINE TEST DOUBLES ONLY. No vendor key, network call, invoice or live model.
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {callProvider, providerSlot, routeProviders} from '../integration/public-chat/provider-adapter.mjs';
import {estimatedMicroCny, gatewayPolicy, reservationForInput} from '../integration/public-chat/gateway-policy.mjs';
import {createModelGateway} from '../integration/public-chat/llm-gateway.mjs';
import worker, {ChatSession, ChatGate} from '../integration/public-chat/worker.mjs';
import riskWorker from '../integration/public-chat/risk.mjs';

const base = {
  MODEL_ENABLED: 'true', LLM_GATEWAY_MODE: 'external', LLM_PAID_PROVIDER_APPROVED: 'true', LLM_PRIMARY: 'A',
  LLM_A_PROVIDER: 'bailian', LLM_A_PROTOCOL: 'chat-completions', LLM_A_REGION: 'cn-beijing',
  LLM_A_BASE_URL: 'https://llm-offline.cn-beijing.maas.aliyuncs.com/compatible-mode/v1',
  LLM_A_MODEL: 'qwen3.8-flash', LLM_A_API_KEY: 'TEST_DOUBLE_NOT_A_REAL_KEY', LLM_A_ENABLE_THINKING: 'false',
  LLM_A_JSON_MODE: 'json_object', LLM_A_TEMPERATURE: 'omit', LLM_A_MAX_ATTEMPTS: '2',
  LLM_A_PROTOCOL_VERIFIED: 'true', LLM_A_JSON_VERIFIED: 'true', LLM_A_STREAM_VERIFIED: 'true',
  LLM_A_BILLING_BOUNDS_VERIFIED: 'true', LLM_A_PRICE_CURRENCY: 'CNY',
  LLM_A_INPUT_CNY_PER_MILLION: '0.8', LLM_A_OUTPUT_CNY_PER_MILLION: '2.7',
  LLM_A_DAILY_MAX_CALLS: '20', LLM_A_DAILY_CAP_CENTS: '50',
};
const messages = [{role: 'system', content: 'Return JSON.'}, {role: 'user', content: '请分析持仓'}];
const prices = {currency: 'CNY', input: 0.8, output: 2.7, fx: 1};
const usage = {prompt_tokens: 1000, completion_tokens: 100, total_tokens: 1100};
const json = (text, extra = {}) => Response.json({id: 'TEST_DOUBLE_NOT_LIVE-1', model: 'qwen3.8-flash',
  choices: [{message: {content: text}, finish_reason: 'stop'}], usage, ...extra});
function sse(text, {done = true, tokenUsage = usage, reasoning = false} = {}) {
  return new Response(new ReadableStream({start(controller) {
    const chunks = [
      {id: 'TEST_DOUBLE_NOT_LIVE-sse', model: 'qwen3.8-flash', choices: [{delta: reasoning ? {reasoning_content: text} : {content: text}}]},
      {id: 'TEST_DOUBLE_NOT_LIVE-sse', choices: [{delta: {}, finish_reason: 'stop'}]},
      {id: 'TEST_DOUBLE_NOT_LIVE-sse', choices: [], usage: tokenUsage},
    ];
    controller.enqueue(new TextEncoder().encode(chunks.map(chunk => 'data: ' + JSON.stringify(chunk) + '\r\n\r\n').join('') + (done ? 'data: [DONE]\r\n\r\n' : '')));
    controller.close();
  }}), {headers: {'Content-Type': 'text/event-stream'}});
}
// A separate official-shaped host per test keeps cooldown tests independent.
const config = extra => ({...base, ...extra});
const host = name => `https://llm-${name}.cn-beijing.maas.aliyuncs.com/compatible-mode/v1`;

class Storage {
  data = new Map();
  chain = Promise.resolve();
  async get(key) { return structuredClone(this.data.get(key)); }
  async put(key, value) {
    if (typeof key === 'object') for (const [k, v] of Object.entries(key)) this.data.set(k, structuredClone(v));
    else this.data.set(key, structuredClone(value));
  }
  async delete(key) { for (const k of Array.isArray(key) ? key : [key]) this.data.delete(k); }
  transaction(work) {
    const result = this.chain.then(() => work(this));
    this.chain = result.catch(() => {});
    return result;
  }
}
const context = () => ({storage: new Storage(), pending: [], blockConcurrencyWhile: work => work(),
  waitUntil(promise) { this.pending.push(promise); }});
function fixture(extra = {}) {
  const now = Date.now();
  const env = {...base, PUBLIC_ORIGIN: 'https://test.example', SESSION_SECRET: 's'.repeat(64), RISK_HMAC_SECRET: 'r'.repeat(64),
    DEMO_BUDGET_CENTS: '100', DAILY_BUDGET_CENTS: '50', DEMO_START_AT: new Date(now - 10000).toISOString(),
    DEMO_END_AT: new Date(now + 16 * 864e5).toISOString(), ...extra};
  const gateContext = context(), gate = new ChatGate(gateContext, env), sessions = new Map();
  env.CHAT_GATE = {idFromName: x => x, get: () => gate};
  env.AMOUNT_RISK = {fetch: request => riskWorker.fetch(request, env)};
  env.ASSETS = {fetch: async () => new Response('offline assets')};
  env.CHAT_SESSIONS = {idFromName: x => x, get: id => {
    if (!sessions.has(id)) { const ctx = context(); sessions.set(id, {ctx, object: new ChatSession(ctx, env)}); }
    return sessions.get(id).object;
  }};
  const send = async (route, body = {}) => {
    const result = await gate.fetch(new Request('https://gate/' + route, {method: 'POST', body: JSON.stringify(body)}));
    return {status: result.status, ...await result.json()};
  };
  return {env, gateContext, send, sessions,
    async begin() { const response = await send('begin', {owner: 'synthetic-owner', ip_hash: 'a'.repeat(64), turn_id: 'test-turn', request_id: 'test-request'}); assert.equal(response.ok, true); return response.lease; },
    async settle() { for (let i = 0; i < 5; i++) await Promise.all([...sessions.values()].flatMap(s => s.ctx.pending)); },
    async visitor() {
      const response = await worker.fetch(new Request(env.PUBLIC_ORIGIN + '/api/session', {headers: {'CF-Connecting-IP': '192.0.2.1'}}), env);
      const data = await response.json(), cookie = response.headers.get('set-cookie').split(';')[0];
      return {call: (path, body) => worker.fetch(new Request(env.PUBLIC_ORIGIN + path, {
        method: body === undefined ? 'GET' : 'POST', headers: {Cookie: cookie, Origin: env.PUBLIC_ORIGIN,
          'Content-Type': 'application/json', 'X-CSRF-Token': data.csrf, 'CF-Connecting-IP': '192.0.2.1'},
        ...(body === undefined ? {} : {body: JSON.stringify(body)}),
      }), env)};
    },
  };
}
const options = phase => ({signal: new AbortController().signal, binding: {phase, trace_id: 'offline-trace',
  conversation_id: 'offline-chat', turn_id: 'offline-turn', input_hash: 'b'.repeat(64)}});

test('Qwen profile only accepts the verified Beijing workspace and explicit non-thinking mode', () => {
  assert.equal(providerSlot(base, 'A').enableThinking, false);
  for (const extra of [
    {LLM_A_BASE_URL: 'https://trial.cn-beijing.maas.aliyuncs.com/compatible-mode/v1'},
    {LLM_A_BASE_URL: 'https://llm-offline.cn-beijing.maas.aliyuncs.com.evil.example/compatible-mode/v1'},
    {LLM_A_BASE_URL: host('offline') + '/chat/completions'},
    {LLM_A_BASE_URL: 'https://llm-offline.cn-beijing.maas.aliyuncs.com:8443/compatible-mode/v1'},
    {LLM_A_REGION: 'cn-hongkong'}, {LLM_A_ENABLE_THINKING: 'true'}, {LLM_A_ENABLE_THINKING: undefined},
    {LLM_A_MODEL: 'qwen3.8-max'}, {LLM_A_JSON_MODE: 'prompt'}, {LLM_A_PROTOCOL_VERIFIED: 'false'},
  ]) assert.throws(() => providerSlot(config(extra), 'A'));
});

test('Qwen HTTP planning sends top-level enable_thinking=false and JSON without reasoning or tools parameters', async () => {
  const result = await callProvider(providerSlot(base, 'A'), messages, {phase: 'plan', fetchImpl: async (url, request) => {
    assert.equal(String(url), host('offline') + '/chat/completions');
    const body = JSON.parse(request.body);
    assert.equal(body.enable_thinking, false);
    assert.deepEqual(body.response_format, {type: 'json_object'});
    assert.equal(body.max_tokens, 1024);
    for (const key of ['extra_body', 'reasoning_effort', 'thinking_budget', 'tools', 'stream_options', 'temperature']) assert.equal(key in body, false);
    return json('{"operation":"analyze"}');
  }});
  assert.equal(JSON.parse(result.text).operation, 'analyze');
});

test('Qwen SSE accepts an empty-choices usage chunk and returns Chinese text and usage', async () => {
  const deltas = [];
  const result = await callProvider(providerSlot(base, 'A'), messages, {stream: true, onDelta: text => deltas.push(text), fetchImpl: async (_url, request) => {
    const body = JSON.parse(request.body);
    assert.equal(body.enable_thinking, false);
    assert.deepEqual(body.stream_options, {include_usage: true});
    assert.equal('response_format' in body, false);
    return sse('先保留房租，再考虑投资。');
  }});
  assert.equal(result.text, '先保留房租，再考虑投资。');
  assert.deepEqual(result.usage, usage);
  assert.deepEqual(deltas, [result.text]);
});

test('unexpected thinking is rejected in both JSON and SSE without exposing it', async () => {
  await assert.rejects(callProvider(providerSlot(base, 'A'), messages, {fetchImpl: async () => json('answer', {
    choices: [{message: {content: 'answer', reasoning_content: 'not-user-visible'}, finish_reason: 'stop'}],
  })}), {code: 'MODEL_THINKING_UNEXPECTED'});
  const deltas = [];
  await assert.rejects(callProvider(providerSlot(base, 'A'), messages, {stream: true, onDelta: x => deltas.push(x),
    fetchImpl: async () => sse('not-user-visible', {reasoning: true})}), {code: 'MODEL_THINKING_UNEXPECTED'});
  assert.deepEqual(deltas, []);
});

test('CNY settlement uses no FX conversion and rounds up only after summing token costs', () => {
  assert.equal(estimatedMicroCny(usage, prices), 1070);
  assert.equal(estimatedMicroCny({prompt_tokens: 4000, completion_tokens: 1000}, prices), 5900);
  assert.equal(estimatedMicroCny({prompt_tokens: 3, completion_tokens: 0}, {...prices, input: 0.1}), 1);
  assert.equal(estimatedMicroCny({prompt_tokens: 1000000, completion_tokens: 0}, {...prices, input: 0.000001}), 1);
  assert.equal(estimatedMicroCny({prompt_tokens: 0, completion_tokens: 0}, prices), 0);
  assert.throws(() => estimatedMicroCny(usage, {...prices, fx: 10}), {code: 'GATEWAY_POLICY_INVALID'});
  assert.throws(() => estimatedMicroCny({prompt_tokens: NaN, completion_tokens: 10}, prices));
  assert.throws(() => estimatedMicroCny(usage, {...prices, input: -1}));
});

test('Qwen budgets reject missing CNY currency, mixed USD fields, absent approval and unverified bounds', () => {
  for (const extra of [{LLM_A_PRICE_CURRENCY: undefined}, {LLM_A_PRICE_CURRENCY: 'USD'},
    {LLM_A_INPUT_USD_PER_MILLION: '0.8'}, {LLM_PAID_PROVIDER_APPROVED: 'false'},
    {LLM_A_BILLING_BOUNDS_VERIFIED: 'false'}, {LLM_A_INPUT_CNY_PER_MILLION: '0'},
  ]) assert.throws(() => gatewayPolicy(config(extra)), {code: 'GATEWAY_POLICY_INVALID'});
  const policy = gatewayPolicy(base);
  assert.equal(policy.slots.length, 1);
  assert.deepEqual(policy.slots[0].prices, prices);
  assert.equal(policy.max_micro_cny, 63950);
  assert.equal(reservationForInput(policy, 2000).micro, 8730);
});

test('the shipped Qwen template is disabled and contains no key value or backup slot', async () => {
  const text = await readFile(new URL('../integration/public-chat/providers.qwen.env.example', import.meta.url), 'utf8');
  const entries = Object.fromEntries(text.split(/\r?\n/).filter(line => line && !line.startsWith('#')).map(line => {
    const at = line.indexOf('='); return [line.slice(0, at), line.slice(at + 1)];
  }));
  assert.equal(gatewayPolicy(entries).mode, 'cloudflare');
  assert.equal(entries.LLM_PAID_PROVIDER_APPROVED, 'false');
  assert.equal(entries.LLM_A_API_KEY, undefined);
  assert.equal(entries.LLM_B_PROVIDER, undefined);
  assert.throws(() => gatewayPolicy({...entries, LLM_GATEWAY_MODE: 'external'}), {code: 'GATEWAY_POLICY_INVALID'});
});

test('Arrearage (400) and HTTP 402 preserve a quota error without retrying a nonexistent backup', async () => {
  for (const status of [400, 402]) {
    let calls = 0;
    await assert.rejects(routeProviders(config({LLM_A_BASE_URL: host('quota-' + status)}), messages, {fetchImpl: async () => {
      calls++; return Response.json({error: {code: status === 400 ? 'Arrearage' : 'insufficient_balance'}}, {status});
    }}), {code: 'MODEL_QUOTA_EXHAUSTED'});
    assert.equal(calls, 1);
  }
});

test('Qwen 429 and connection timeout stop after two attempts with no successful answer', async () => {
  for (const kind of ['429', 'timeout']) {
    let calls = 0;
    await assert.rejects(routeProviders(config({LLM_A_BASE_URL: host('failure-' + kind)}), messages, {
      connectTimeoutMs: 5, fetchImpl: () => {calls++; return kind === '429' ? Promise.resolve(new Response(null, {status: 429})) : new Promise(() => {});},
    }), {code: 'MODEL_PROVIDERS_UNAVAILABLE'});
    assert.equal(calls, 2);
  }
});

test('a Qwen partial answer is never retried or replaced', async () => {
  let calls = 0;
  await assert.rejects(routeProviders(config({LLM_A_BASE_URL: host('partial')}), messages, {stream: true,
    fetchImpl: async () => {calls++; return sse('正在核对', {done: false});},
  }), {code: 'MODEL_PARTIAL_RESPONSE', partial: true});
  assert.equal(calls, 1);
});

test('Qwen gateway reserves before transport and records a CNY-only settled receipt', async () => {
  const f = fixture(), lease = await f.begin(), events = [];
  const model = createModelGateway(f.env, lease, {fetchImpl: async () => {
    assert.equal((await f.gateContext.storage.get('meta')).call_count, 1);
    return json('{"operation":"analyze"}');
  }});
  const plan = await model.plan({message: '帮我分析合成持仓', state: {}, history: []}, {...options('plan'), onEvent: event => events.push(event)});
  assert.equal(plan.value.operation, 'analyze');
  const status = await f.send('status'), receipt = status.recent_receipts[0];
  assert.equal(receipt.cost_basis, 'USAGE_ESTIMATE_CNY_NOT_INVOICE');
  assert.equal(receipt.charged_micro_cny, 1070);
  assert.equal(receipt.usage_estimate_verified, true);
  assert.ok(receipt.reserved_micro_cny > receipt.charged_micro_cny);
  assert.equal(events[0].configured_routes[0].enable_thinking, false);
  assert.equal(events[0].configured_routes[0].price_currency, 'CNY');
  assert.equal(JSON.stringify([...f.gateContext.storage.data]).includes(base.LLM_A_API_KEY), false);
});

test('Qwen budget denial makes zero upstream requests and does not clear the ledger', async () => {
  const f = fixture({DAILY_BUDGET_CENTS: '10'}), lease = await f.begin();
  assert.equal((await f.send('reserve', {lease, request_id: 'exhaust-budget', request_hash: 'c'.repeat(64), phase: 'plan'})).call_allowed, true);
  let calls = 0;
  const model = createModelGateway(f.env, lease, {fetchImpl: async () => {calls++; return json('unused');}});
  await assert.rejects(model.answer({question: '分析'}, options('answer')), {code: 'DAILY_BUDGET_EXHAUSTED'});
  assert.equal(calls, 0);
  assert.equal((await f.gateContext.storage.get('meta')).used_micro_cny, 100000);
});

test('unknown Qwen usage keeps the full reservation rather than inventing a zero cost', async () => {
  const f = fixture(), lease = await f.begin();
  const model = createModelGateway(f.env, lease, {fetchImpl: async () => json('{"operation":"explain"}', {usage: undefined})});
  await model.plan({message: '什么是基金', state: {}, history: []}, options('plan'));
  const receipt = (await f.send('status')).recent_receipts[0];
  assert.equal(receipt.cost_basis, 'CONSERVATIVE_RESERVATION_NOT_INVOICE');
  assert.equal(receipt.charged_micro_cny, receipt.reserved_micro_cny);
  assert.equal(receipt.usage_estimate_verified, false);
});

test('a successful Qwen retry retains both attempts and the full bound for unknown failed-attempt usage', async () => {
  const f = fixture({LLM_A_BASE_URL: host('retry-receipt')}), lease = await f.begin();
  let calls = 0;
  const model = createModelGateway(f.env, lease, {fetchImpl: async () => ++calls === 1 ?
    new Response(null, {status: 503}) : json('{"operation":"explain"}')});
  await model.plan({message: '基金是什么', state: {}, history: []}, options('plan'));
  const receipt = (await f.send('status')).recent_receipts[0];
  assert.equal(calls, 2);
  assert.equal(receipt.attempt_count, 2);
  assert.equal(receipt.attempts[0].http_status, 503);
  assert.equal(receipt.attempts[1].http_status, 200);
  assert.equal(receipt.usage_estimate_verified, false);
  assert.equal(receipt.charged_micro_cny, receipt.reserved_micro_cny);
});

test('Qwen cannot introduce native tool execution through a provider response', async () => {
  let calls = 0;
  await assert.rejects(routeProviders(config({LLM_A_BASE_URL: host('native-tools')}), messages, {fetchImpl: async () => {
    calls++;
    return json('', {choices: [{message: {content: null, tool_calls: [{id: 'unapproved-operation'}]}, finish_reason: 'tool_calls'}]});
  }}), {code: 'MODEL_TOOL_CALL_UNSUPPORTED'});
  assert.equal(calls, 1);
});

test('Qwen Worker cannot save holdings or generate a success answer when Risk blocks or cannot authenticate', async t => {
  for (const kind of ['block', 'bad-signature', 'unavailable']) await t.test(kind, async t => {
    const f = fixture({LLM_A_BASE_URL: host('risk-' + kind)}), visitor = await f.visitor();
    if (kind === 'bad-signature') f.env.AMOUNT_RISK.fetch = async () => Response.json({payload: '{}', signature: 'a'.repeat(64)});
    if (kind === 'unavailable') f.env.AMOUNT_RISK.fetch = async () => new Response(null, {status: 503});
    let calls = 0;
    t.mock.method(globalThis, 'fetch', async (url, request) => {
      calls++;
      assert.equal(String(url), host('risk-' + kind) + '/chat/completions');
      assert.equal(JSON.parse(request.body).stream, false, 'no answer request after Risk failure');
      return json(JSON.stringify({operation: 'set_holdings', changes: [{name: '现金', kind: 'cash', amount: '10000', unit: '元'}]}));
    });
    const chat = await (await visitor.call('/api/local/chats', {})).json(), path = `/api/local/chats/${chat.id}`;
    const response = await visitor.call(path + '/turns', {request_id: crypto.randomUUID(),
      text: '合成测试数据：我有现金10000元。' + (kind === 'block' ? '请买入。' : '帮我分析。')});
    assert.equal(response.status, 202);
    await f.settle();
    const result = await (await visitor.call(path)).json();
    assert.equal(result.turns[0].status, 'ERROR');
    if (kind === 'block') assert.equal(result.turns[0].error.code, 'RISK_BLOCKED');
    assert.deepEqual(result.state.actual, []);
    assert.equal(result.state.version, 0);
    assert.equal(calls, 1);
    assert.equal((await f.send('status')).recent_receipts.length, 1);
  });
});

test('offline Worker flow keeps deterministic holdings, signed Risk, idempotence and no real execution', async t => {
  const f = fixture({LLM_A_BASE_URL: host('full-flow')}), visitor = await f.visitor();
  let calls = 0, riskCalls = 0;
  const originalRisk = f.env.AMOUNT_RISK.fetch;
  f.env.AMOUNT_RISK.fetch = request => {riskCalls++; return originalRisk(request);};
  t.mock.method(globalThis, 'fetch', async (url, request) => {
    assert.equal(String(url), host('full-flow') + '/chat/completions', 'all external traffic must be intercepted');
    calls++;
    const body = JSON.parse(request.body);
    assert.equal(body.enable_thinking, false);
    if (!body.stream) return json(JSON.stringify({operation: 'set_holdings', changes: [
      {name: '现金', kind: 'cash', amount: '6', unit: '万'}, {name: '基金A', kind: 'unresolved', amount: '2', unit: '万'},
      {name: '基金B', kind: 'unresolved', amount: '2', unit: '万'},
    ]}));
    const facts = JSON.parse(body.messages[1].content);
    assert.equal(facts.original_holdings.total_yuan, 100000);
    assert.deepEqual(facts.original_holdings.rows.map(row => row.weight_pct), [60, 20, 20]);
    assert.equal(facts.execution_allowed, false);
    return sse('按你提供的数据，总额10万元，现金占60%，基金A和基金B各占20%。这里只做分析，不会进行真实交易。');
  });
  const created = await visitor.call('/api/local/chats', {});
  assert.equal(created.status, 201);
  const chat = await created.json(), path = `/api/local/chats/${chat.id}`;
  const body = {request_id: crypto.randomUUID(), text: '这组为合成测试数据：我有现金6万、基金A 2万、基金B 2万，请分析。'};
  const started = await visitor.call(path + '/turns', body);
  assert.equal(started.status, 202, await started.clone().text());
  await f.settle();
  const result = await (await visitor.call(path)).json();
  assert.equal(result.turns[0].status, 'COMPLETE', JSON.stringify(result.turns[0].error));
  assert.equal(result.state.actual_tool.output.total_cents, 10000000);
  assert.deepEqual(result.state.actual_tool.output.rows.map(row => row.weight_pct), [60, 20, 20]);
  assert.equal(result.state.version, 1);
  assert.ok(riskCalls > 0);
  const duplicate = await visitor.call(path + '/turns', body);
  assert.equal(duplicate.status, 202);
  assert.equal((await duplicate.json()).id, (await started.json()).id);
  await f.settle();
  assert.equal(calls, 2);
  assert.equal((await (await visitor.call(path)).json()).state.version, 1);
  const status = await f.send('status');
  assert.equal(status.recent_receipts.length, 2);
  assert.ok(status.recent_receipts.every(receipt => receipt.provider === 'bailian'));
});
