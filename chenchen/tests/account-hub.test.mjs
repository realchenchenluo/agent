import assert from 'node:assert/strict';
import test from 'node:test';
import hub from '../integrations/account-hub.js';
import {ChatSession} from '../integration/public-chat/worker.mjs';

class Storage {
  constructor() { this.data = new Map(); }
  async get(key) { return structuredClone(this.data.get(key)); }
  async put(key, value) { if (typeof key === 'object') for (const [name, item] of Object.entries(key)) this.data.set(name, structuredClone(item)); else this.data.set(key, structuredClone(value)); }
}

function session() {
  const storage = new Storage();
  const context = {storage, blockConcurrencyWhile: fn => fn(), waitUntil() {}};
  return new ChatSession(context, {});
}

async function call(object, path, method = 'GET', body) {
  return object.handle(new Request('https://test.example' + path, {
    method,
    headers: {'X-Verified-Owner': 'a'.repeat(64), 'Content-Type': 'application/json'},
    ...(body === undefined ? {} : {body: JSON.stringify(body)}),
  }));
}

test('normalizes multiple platform sources and summarizes assets, available money, liabilities, and due bills', () => {
  const state = hub.emptyHub();
  const result = hub.upsert(state, {
    display_name: '我的银行', platform: 'bank', account_type: 'bank',
    balance_cents: 5000000, available_cents: 4200000,
    source: {channel: 'USER_ENTERED', label: '用户手工录入', as_of: '2026-10-28', confirmed: true},
    entries: [{label: '房租', kind: 'obligation', amount_cents: 800000, due_on: '2026-11-01', status: 'CONFIRMED'}],
  }, {requestId: 'request-1', idempotencyKey: 'account-test-1'});
  const next = hub.upsert(result.hub, {
    display_name: '我的信用卡', platform: 'credit_card', account_type: 'credit_card',
    balance_cents: 0, available_cents: 0, liability_cents: 300000,
    source: {channel: 'USER_ENTERED', label: '用户手工录入', as_of: '2026-10-28', confirmed: false},
    entries: [{label: '信用卡待还', kind: 'obligation', amount_cents: 300000, due_on: '2026-11-05'}],
  }, {requestId: 'request-2', idempotencyKey: 'account-test-2'});
  const publicState = hub.publicHub(next.hub);
  assert.equal(publicState.summary.total_assets_cents, 5000000);
  assert.equal(publicState.summary.available_cents, 4200000);
  assert.equal(publicState.summary.liabilities_cents, 300000);
  assert.equal(publicState.summary.net_worth_cents, 4700000);
  assert.equal(publicState.summary.obligations_cents, 1100000);
  assert.equal(publicState.summary.upcoming_obligations[0].due_on, '2026-11-01');
  assert.equal(publicState.summary.data_quality.pending_account_count, 1);
  assert.equal(publicState.execution_allowed, false);
});

test('demo seed is idempotent and is clearly marked as synthetic', () => {
  const first = hub.seedDemo(hub.emptyHub());
  const second = hub.seedDemo(first.hub);
  assert.equal(first.replayed, false);
  assert.equal(second.replayed, true);
  assert.equal(second.hub.accounts.length, 4);
  assert.ok(second.hub.accounts.every(account => account.source.data_status === 'DEMO'));
  assert.ok(second.hub.accounts.every(account => account.permissions.real_actions === false));
});

test('scenario router identifies funding conflicts without executing anything', () => {
  const state = hub.seedDemo(hub.emptyHub()).hub;
  const plan = hub.routeScenario('我想再投入8000元买基金，但下个月还要交房租，资金够不够？', state);
  assert.equal(plan.scenario, 'FUNDING_CONFLICT');
  assert.equal(plan.next_step, 'READ_ONLY_PREVIEW');
  assert.equal(plan.execution_allowed, false);
  assert.equal(plan.risk_required_for_actions, true);
});

test('credentials, non-CNY sources, and balance conflicts are rejected', () => {
  assert.throws(() => hub.normalizeAccount({display_name: 'x', platform: 'bank', balance_cents: 1, api_key: 'never'}), {code: 'ACCOUNT_CREDENTIALS_NOT_ALLOWED'});
  assert.throws(() => hub.normalizeAccount({display_name: 'x', platform: 'bank', balance_cents: 1, currency: 'USD'}), {code: 'ACCOUNT_CURRENCY_UNSUPPORTED'});
  assert.throws(() => hub.normalizeAccount({display_name: 'x', platform: 'bank', balance_cents: 1, available_cents: 2}), {code: 'ACCOUNT_BALANCE_CONFLICT'});
});

test('public chat worker exposes owner-isolated account hub, demo seed, and scenario preflight', async () => {
  const object = session();
  const empty = await call(object, '/api/local/accounts');
  assert.equal(empty.status, 200);
  assert.equal((await empty.json()).summary.data_quality.account_count, 0);
  const seeded = await call(object, '/api/local/accounts/demo', 'POST', {idempotency_key: 'worker-demo-1'});
  assert.equal(seeded.status, 201);
  assert.equal((await seeded.json()).hub.accounts.length, 4);
  const plan = await call(object, '/api/local/accounts/plan', 'POST', {question: '基金和房租会不会冲突？'});
  assert.equal(plan.status, 200);
  assert.equal((await plan.json()).plan.scenario, 'FUNDING_CONFLICT');
});
