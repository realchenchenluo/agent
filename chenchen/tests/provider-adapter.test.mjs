import test from 'node:test';
import assert from 'node:assert/strict';
import {callProvider, classifyProviderStatus, providerSlot, routeProviders} from '../integration/public-chat/provider-adapter.mjs';

const env = {
  LLM_PRIMARY: 'A',
  LLM_A_PROVIDER: 'xai', LLM_A_PROTOCOL: 'chat-completions',
  LLM_A_BASE_URL: 'https://api.x.ai/v1', LLM_A_MODEL: 'test-model-a', LLM_A_API_KEY: 'test-only',
  LLM_A_PROTOCOL_VERIFIED: 'true', LLM_A_JSON_VERIFIED: 'true', LLM_A_STREAM_VERIFIED: 'true',
  LLM_B_PROVIDER: 'synthetic', LLM_B_PROTOCOL: 'chat-completions',
  LLM_B_BASE_URL: 'https://model-b.example/v1', LLM_B_MODEL: 'test-model-b', LLM_B_API_KEY: 'test-only',
  LLM_B_PROTOCOL_VERIFIED: 'true', LLM_B_JSON_VERIFIED: 'true', LLM_B_STREAM_VERIFIED: 'true',
};
const messages = [{role: 'system', content: 'Reply in Chinese.'}, {role: 'user', content: '你好'}];
const json = (id, text) => Response.json({id, choices: [{message: {content: text}, finish_reason: 'stop'}], usage: {prompt_tokens: 10, completion_tokens: 5}});

test('provider config rejects absent verification and unsafe URLs', () => {
  assert.equal(providerSlot(env, 'A').url.href, 'https://api.x.ai/v1/chat/completions');
  assert.throws(() => providerSlot({...env, LLM_A_BASE_URL: 'http://127.0.0.1:3000/v1'}, 'A'), {code: 'MODEL_BASE_URL_INVALID'});
  assert.throws(() => providerSlot({...env, LLM_B_PROTOCOL_VERIFIED: 'false'}, 'B'), {code: 'MODEL_PROTOCOL_UNVERIFIED'});
  assert.throws(() => providerSlot({...env, LLM_A_PROTOCOL_VERIFIED: 'false'}, 'A'), {code: 'MODEL_PROTOCOL_UNVERIFIED'});
  assert.throws(() => providerSlot({...env, LLM_A_JSON_VERIFIED: 'false'}, 'A'), {code: 'MODEL_CAPABILITY_UNVERIFIED'});
});

test('status classes distinguish auth, quota, rate and upstream failures', () => {
  assert.equal(classifyProviderStatus(401), 'MODEL_AUTH_FAILED');
  assert.equal(classifyProviderStatus(402), 'MODEL_QUOTA_EXHAUSTED');
  assert.equal(classifyProviderStatus(429), 'MODEL_RATE_LIMITED');
  assert.equal(classifyProviderStatus(503), 'MODEL_UPSTREAM_FAILED');
});

test('a pre-output provider error falls back once without replaying agent work', async () => {
  const urls = [];
  const result = await routeProviders(env, messages, {requestId: 'stable-test-request', fetchImpl: async (url, request) => {
    urls.push(String(url));
    assert.equal(request.headers['X-Client-Request-Id'], 'stable-test-request');
    return urls.length === 1 ? new Response(null, {status: 429}) : json('response-b', '完成');
  }});
  assert.equal(result.slot, 'B');
  assert.equal(result.provider_response_id, 'response-b');
  assert.equal(result.usage.prompt_tokens, 10);
  assert.deepEqual(urls, ['https://api.x.ai/v1/chat/completions', 'https://model-b.example/v1/chat/completions']);
});

test('a partial stream never joins a second provider answer', async () => {
  const stream = new ReadableStream({start(controller) {
    controller.enqueue(new TextEncoder().encode('data: {"id":"response-a","choices":[{"delta":{"content":"部分"}}]}\n'));
    controller.close();
  }});
  let calls = 0;
  await assert.rejects(routeProviders({...env, LLM_PRIMARY: 'B'}, messages, {stream: true, fetchImpl: async () => {
    calls++;
    return new Response(stream, {status: 200});
  }}), {code: 'MODEL_PARTIAL_RESPONSE'});
  assert.equal(calls, 1);
});

test('an incomplete success payload and a timeout are errors, not model answers', async () => {
  await assert.rejects(callProvider(providerSlot(env, 'A'), messages, {fetchImpl: async () => Response.json({choices: []})}), {code: 'MODEL_EMPTY_RESPONSE'});
  await assert.rejects(callProvider(providerSlot(env, 'A'), messages, {fetchImpl: async () => { throw Error('offline'); }}), {code: 'MODEL_NETWORK_FAILED'});
  await assert.rejects(callProvider(providerSlot(env, 'A'), messages, {connectTimeoutMs: 20, fetchImpl: () => new Promise(() => {})}), {code: 'MODEL_TIMEOUT'});
});

test('a bounded same-provider retry consumes both attempts without replaying a second provider', async () => {
  const urls = [];
  const result = await routeProviders({...env, LLM_A_MODEL: 'retry-test-model', LLM_A_MAX_ATTEMPTS: '2'}, messages, {fetchImpl: async url => {
    urls.push(String(url));
    return urls.length === 1 ? new Response(null, {status: 503}) : json('retry-success', '你好');
  }});
  assert.equal(result.attempts, 2);
  assert.deepEqual(urls, ['https://api.x.ai/v1/chat/completions', 'https://api.x.ai/v1/chat/completions']);
});

test('authentication failure is reported without trying another paid model', async () => {
  let calls = 0;
  await assert.rejects(routeProviders({...env, LLM_A_MODEL: 'auth-test-model'}, messages, {fetchImpl: async () => {calls++;return new Response(null, {status: 401});}}), {code: 'MODEL_AUTH_FAILED'});
  assert.equal(calls, 1);
});

test('quota exhaustion stays explicit when no backup is configured', async () => {
  let calls = 0;
  await assert.rejects(routeProviders({...env, LLM_A_MODEL: 'quota-only-model', LLM_B_PROVIDER: undefined}, messages, {fetchImpl: async () => {
    calls++;
    return Response.json({error: {code: 'insufficient_quota'}}, {status: 429});
  }}), {code: 'MODEL_QUOTA_EXHAUSTED'});
  assert.equal(calls, 1);
});

test('two failed providers stop after two attempts and return a real error', async () => {
  let calls = 0;
  await assert.rejects(routeProviders({...env, LLM_A_MODEL: 'both-fail-a', LLM_B_MODEL: 'both-fail-b'}, messages, {fetchImpl: async () => {
    calls++;
    return new Response(null, {status: calls === 1 ? 503 : 429});
  }}), {code: 'MODEL_PROVIDERS_UNAVAILABLE'});
  assert.equal(calls, 2);
});

test('unverified native tool calls are rejected instead of silently discarded', async () => {
  const payload = {id: 'tool-response', choices: [{message: {content: null, tool_calls: [{id: 'call-1'}]}, finish_reason: 'tool_calls'}]};
  await assert.rejects(callProvider(providerSlot(env, 'A'), messages, {fetchImpl: async () => Response.json(payload)}), {code: 'MODEL_TOOL_CALL_UNSUPPORTED'});
  const body = new ReadableStream({start(c) {c.enqueue(new TextEncoder().encode('data: {"choices":[{"delta":{"tool_calls":[{"index":0}]}}]}\n\ndata: [DONE]\n\n'));c.close();}});
  await assert.rejects(callProvider(providerSlot(env, 'A'), messages, {stream: true, fetchImpl: async () => new Response(body)}), {code: 'MODEL_TOOL_CALL_UNSUPPORTED'});
});

test('verified per-model JSON mode and temperature settings shape only the server request', async () => {
  const config = providerSlot({...env, LLM_A_JSON_MODE: 'json_object', LLM_A_TEMPERATURE: 'omit', LLM_A_MAX_OUTPUT_TOKENS: '512'}, 'A');
  await callProvider(config, messages, {phase: 'plan', fetchImpl: async (_url, request) => {
    const body = JSON.parse(request.body);
    assert.deepEqual(body.response_format, {type: 'json_object'});
    assert.equal(body.max_tokens, 512);
    assert.equal('temperature' in body, false);
    return json('configured-response', '{"operation":"explain"}');
  }});
});

test('a timeout after the first stream delta stops without a retry or fallback', async () => {
  let calls = 0;
  const deltas = [];
  const attempts = [];
  await assert.rejects(routeProviders({...env, LLM_A_MODEL: 'partial-timeout-a', LLM_B_MODEL: 'partial-timeout-b'}, messages, {
    stream: true, responseTimeoutMs: 20, onDelta: delta => deltas.push(delta), onAttempt: item => attempts.push(item),
    fetchImpl: async () => {
      calls++;
      return new Response(new ReadableStream({start(controller) {
        controller.enqueue(new TextEncoder().encode('data: {"id":"partial-timeout","choices":[{"delta":{"content":"正在核对"}}]}\n\n'));
        if (calls > 1) {
          controller.enqueue(new TextEncoder().encode('data: [DONE]\n\n'));
          controller.close();
        }
      }}));
    },
  }), {code: 'MODEL_PARTIAL_RESPONSE', partial: true});
  assert.equal(calls, 1);
  assert.deepEqual(deltas, ['正在核对']);
  assert.equal(attempts.length, 1);
  assert.equal(attempts[0].error_code, 'MODEL_TIMEOUT');
});

test('provider redirects are rejected without contacting a backup', async () => {
  let calls = 0;
  await assert.rejects(routeProviders({...env, LLM_A_MODEL: 'redirect-rejected-a'}, messages, {fetchImpl: async (_url, request) => {
    calls++;
    assert.equal(request.redirect, 'manual', 'credentials and financial context must stay at the configured URL');
    return new Response(null, {status: 307, headers: {Location: 'https://unapproved.example/v1/chat/completions'}});
  }}), {code: 'MODEL_REDIRECT_REJECTED', status: 307});
  assert.equal(calls, 1);
});

test('an upstream that never acknowledges stream cancellation cannot hold the timeout open', async () => {
  let cancelled = false;
  let deadline;
  const stuck = new ReadableStream({
    start(controller) { controller.enqueue(new TextEncoder().encode('data: {"choices":[{"delta":{"content":"部分"}}]}\n\n')); },
    cancel() { cancelled = true; return new Promise(() => {}); },
  });
  try {
    await assert.rejects(Promise.race([
      callProvider(providerSlot({...env, LLM_A_MODEL: 'cancel-deadline-a'}, 'A'), messages, {
        stream: true, responseTimeoutMs: 20, fetchImpl: async () => new Response(stuck),
      }),
      new Promise((_, reject) => { deadline = setTimeout(() => reject(Error('cleanup exceeded deadline')), 500); }),
    ]), {code: 'MODEL_TIMEOUT', partial: true});
    assert.equal(cancelled, true);
  } finally { clearTimeout(deadline); }
});
