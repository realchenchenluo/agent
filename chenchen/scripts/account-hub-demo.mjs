import {ChatSession} from '../integration/public-chat/worker.mjs';

class Storage {
  constructor() { this.data = new Map(); }
  async get(key) { return structuredClone(this.data.get(key)); }
  async put(key, value) { if (typeof key === 'object') for (const [name, item] of Object.entries(key)) this.data.set(name, structuredClone(item)); else this.data.set(key, structuredClone(value)); }
}

const storage = new Storage();
const object = new ChatSession({storage, blockConcurrencyWhile: fn => fn(), waitUntil() {}}, {});
const owner = 'a'.repeat(64);
async function call(path, method = 'GET', body) {
  const response = await object.handle(new Request('https://demo.example' + path, {
    method,
    headers: {'X-Verified-Owner': owner, 'Content-Type': 'application/json'},
    ...(body === undefined ? {} : {body: JSON.stringify(body)}),
  }));
  return {status: response.status, body: await response.json()};
}

const seeded = await call('/api/local/accounts/demo', 'POST', {idempotency_key: 'account-hub-demo-v1'});
const overview = await call('/api/local/accounts');
const plan = await call('/api/local/accounts/plan', 'POST', {question: '我想再投入8000元买基金，但下个月还要交房租，资金够不够？'});
console.log(JSON.stringify({
  seed_status: seeded.status,
  account_count: overview.body.summary.data_quality.account_count,
  assets_yuan: overview.body.summary.total_assets_cents / 100,
  available_yuan: overview.body.summary.available_cents / 100,
  obligations_yuan: overview.body.summary.obligations_cents / 100,
  next_due: overview.body.summary.upcoming_obligations[0]?.due_on || null,
  platforms: overview.body.summary.by_platform,
  scenario: plan.body.plan.scenario,
  scenario_title: plan.body.plan.title,
  execution_allowed: overview.body.execution_allowed,
}, null, 2));
