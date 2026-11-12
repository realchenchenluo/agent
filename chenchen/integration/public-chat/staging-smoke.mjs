// Uses two fresh staging-only visitor cookies and synthetic holdings. Never
// points at production or sends credentials and never invokes a model.
import assert from 'node:assert/strict';

const origin = 'https://personal-ai-fund-chat-staging.ai-banking-agent.workers.dev';

async function visitor() {
  const response = await fetch(origin + '/api/session');
  assert.equal(response.status, 200, 'staging visitor session');
  const cookie = response.headers.get('set-cookie')?.split(';')[0];
  const {csrf} = await response.json();
  assert.ok(cookie && csrf, 'staging cookie and CSRF');
  return async (path, body) => {
    const response = await fetch(origin + path, {
      method: body === undefined ? 'GET' : 'POST',
      headers: {Cookie: cookie, Origin: origin, 'X-CSRF-Token': csrf, 'Content-Type': 'application/json'},
      ...(body === undefined ? {} : {body: JSON.stringify(body)}),
    });
    return {status: response.status, body: await response.json()};
  };
}

const home = await fetch(origin);
assert.equal(home.status, 200, 'staging homepage');
const release = home.headers.get('x-app-release');
assert.match(release || '', /^staging-dynamic-budget-/);
const health = await fetch(origin + '/health');
assert.deepEqual((await health.json()).status, 'ok');
const first = await visitor();
const second = await visitor();
const created = await first('/api/local/chats', {});
assert.equal(created.status, 201, 'create isolated chat');
const id = created.body.id;
const reviewed = await first(`/api/local/chats/${id}/review`, {
  base_version: 0,
  rows: [
    {name: '合成股票 A', kind: 'unresolved', amount: '60000'},
    {name: '合成基金 B', kind: 'unresolved', amount: '20000'},
    {name: '合成现金', kind: 'cash', amount: '20000'},
  ],
  metadata: {as_of: '2026-10-24', currency: 'CNY', basis: 'current_value', source: 'USER_TABLE', demo: true},
  mode: 'new',
});
assert.equal(reviewed.status, 200, 'deterministic review and signed Risk');
const review = reviewed.body.conversation.state.review;
assert.equal(review.tool.output.total_cents, 10_000_000);
assert.deepEqual(review.chart.map(row => row.weight_pct), [60, 20, 20]);
const risk = reviewed.body.conversation.turns.at(-1).risk.result.decision;
assert.equal(risk, 'REVIEW', '60% single holding requires Risk review');
const reread = await first(`/api/local/chats/${id}`);
assert.equal(reread.status, 200, 'persisted first visitor chat');
assert.equal(reread.body.state.review.tool.output.total_cents, 10_000_000);
const isolated = await second(`/api/local/chats/${id}`);
assert.equal(isolated.status, 404, 'second visitor isolation');
const admin = await fetch(origin + '/api/admin/status');
assert.equal(admin.status, 403, 'admin status requires token');
console.log(JSON.stringify({release, health: 'ok', create: created.status, review: reviewed.status,
  total_yuan: review.tool.output.total_cents / 100, weights: review.chart.map(row => row.weight_pct),
  risk, reread: reread.status, other_visitor: isolated.status, admin_without_token: admin.status,
  model_invoked: false}));
