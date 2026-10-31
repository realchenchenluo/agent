// PROTECTED TEST SERVICE ONLY. No Workers AI binding exists in canary.jsonc.
// Imports production HTTP/session/budget code; only the provider is a test double.
import production, {ChatSession as ProductionSession} from './worker.mjs';
import {ChatGate as ProductionGate} from './gate.mjs';
import {equal} from './risk.mjs';
import {randomUUID} from 'node:crypto';

const MARKER = 'TEST_DOUBLE_NOT_LIVE';
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
class TestAI {
  async run(_model, input) {
    this.lastRequestId = MARKER + '-' + randomUUID();
    const context = JSON.parse(input.messages.at(-1).content);
    const question = context.message || context.question || '';
    if (!input.stream) {
      const amount = /TEST_DOUBLE_SET_(\d+)/.exec(question)?.[1] || '10000';
      return {response: JSON.stringify({operation: 'set_holdings', changes: [{name: '现金', kind: 'cash', amount, unit: '元'}], transfer: null, question: ''}), usage: {prompt_tokens: 1000, completion_tokens: 100}};
    }
    if (question.includes('TEST_DOUBLE_RATE_LIMIT')) throw Object.assign(new Error('TEST_DOUBLE_RATE_LIMIT'), {code: 'MODEL_PROVIDER_FAILURE', status: 429});
    if (question.includes('TEST_DOUBLE_TIMEOUT')) return new Promise(() => {}); // Production 70s timer must stop it.
    let cancelled = false;
    const encoder = new TextEncoder();
    return new ReadableStream({
      async start(controller) {
        const send = value => {if (!cancelled) controller.enqueue(encoder.encode('data: ' + value + '\n\n'));};
        try {
          send(JSON.stringify({response: MARKER + '：'}));
          await delay(question.includes('TEST_DOUBLE_HOLD') ? 20_000 : 300);
          if (cancelled) return;
          if (question.includes('TEST_DOUBLE_INTERRUPTED')) {controller.error(new Error('TEST_DOUBLE_TRANSPORT_INTERRUPTED')); return;}
          send(JSON.stringify({response: '测试持仓已记录。', usage: {prompt_tokens: 1000, completion_tokens: 100}}));
          if (!question.includes('TEST_DOUBLE_TRUNCATED')) send('[DONE]');
          controller.close();
        } catch { if (!cancelled) {try {controller.close();} catch {}} }
      },
      cancel() {cancelled = true;},
    });
  }
}

export class CanarySession extends ProductionSession {
  constructor(ctx, env) {
    if (env.AI) throw new Error('CANARY_MUST_NOT_HAVE_AI_BINDING');
    super(ctx, {...env, AI: new TestAI()});
  }
}
export class CanaryGate extends ProductionGate {}
export class CanaryQuotaGate extends ProductionGate {
  constructor(ctx, env) {super(ctx, {...env, DEMO_BUDGET_CENTS: '20', DAILY_BUDGET_CENTS: '20'});}
}

export default {
  async fetch(request, env) {
    if (!env.CANARY_TOKEN || env.CANARY_TOKEN.length < 32 || !equal(request.headers.get('Authorization'), 'Bearer ' + env.CANARY_TOKEN)) return new Response('Protected test service', {status: 403});
    if (env.AI) return new Response('CANARY_MUST_NOT_HAVE_AI_BINDING', {status: 503});
    const url = new URL(request.url);
    if (url.origin !== env.PUBLIC_ORIGIN) return new Response('WRONG_HOST', {status: 421});
    const quota = /^\/canary\/quota\/(begin|reserve|receipt|release|status)$/.exec(url.pathname);
    if (quota) {
      const run = request.headers.get('X-Canary-Run');
      if (!/^[A-Za-z0-9_-]{8,80}$/.test(run || '') || request.method !== 'POST') return new Response(null, {status: 400});
      const body = await request.text();
      if (body.length > 8192) return new Response(null, {status: 413});
      const stub = env.CANARY_QUOTA.get(env.CANARY_QUOTA.idFromName(run));
      const response = await stub.fetch(new Request('https://gate/' + quota[1], {method: 'POST', body}));
      const result = new Response(response.body, response); result.headers.set('X-Canary-Mode', MARKER); return result;
    }
    const ip = request.headers.get('X-Canary-IP');
    if (ip && !/^198\.18\.\d{1,3}\.\d{1,3}$/.test(ip)) return new Response('INVALID_TEST_IP', {status: 400});
    const headers = new Headers(request.headers);
    if (ip) headers.set('CF-Connecting-IP', ip);
    const copied = new Request(request, {headers});
    const response = await production.fetch(copied, {...env, ADMIN_TOKEN: env.CANARY_TOKEN});
    const result = new Response(response.body, response); result.headers.set('X-Canary-Mode', MARKER); return result;
  },
};
