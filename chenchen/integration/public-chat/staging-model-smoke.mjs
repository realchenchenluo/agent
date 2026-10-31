// One synthetic chat turn on the isolated staging Worker. This performs real
// Workers AI inference under the staging cost gate; never target production.
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';

const origin = 'https://personal-ai-fund-chat-staging.ai-banking-agent.workers.dev';
const sessionResponse = await fetch(origin + '/api/session');
assert.equal(sessionResponse.status, 200);
const cookie = sessionResponse.headers.get('set-cookie')?.split(';')[0];
const {csrf} = await sessionResponse.json();
assert.ok(cookie && csrf);
const headers = {Cookie: cookie, Origin: origin, 'X-CSRF-Token': csrf, 'Content-Type': 'application/json'};
const call = async (path, body) => {
  const response = await fetch(origin + path, {method: body === undefined ? 'GET' : 'POST', headers,
    ...(body === undefined ? {} : {body: JSON.stringify(body)})});
  return {status: response.status, body: await response.json()};
};
const created = await call('/api/local/chats', {});
assert.equal(created.status, 201);
const chatId = created.body.id;
const started = await call(`/api/local/chats/${chatId}/turns`, {
  request_id: randomUUID(),
  text: '这是合成测试：截至2026-10-24，股票A当前市值60000元、基金B当前市值20000元、现金20000元。请核对总额与占比；没有历史净值，请明确说不能计算过去一年的最大回撤。',
});
assert.equal(started.status, 202, JSON.stringify(started.body.error || {}));
const turnId = started.body.id;
const stream = await fetch(origin + `/api/local/chats/${chatId}/turns/${turnId}/events`,
  {headers, signal: AbortSignal.timeout(160_000)});
assert.equal(stream.status, 200);
assert.match(stream.headers.get('content-type') || '', /text\/event-stream/);
let buffer = '', events = 0, deltas = 0, terminal = null;
for await (const chunk of stream.body) {
  buffer += new TextDecoder().decode(chunk);
  let end;
  while ((end = buffer.indexOf('\n\n')) >= 0) {
    const frame = buffer.slice(0, end); buffer = buffer.slice(end + 2);
    const data = frame.split('\n').filter(line => line.startsWith('data:')).map(line => line.slice(5).trim()).join('\n');
    if (!data) continue;
    const event = JSON.parse(data); events++;
    if (event.type === 'delta') deltas++;
    if (event.type === 'turn' && event.turn.status !== 'RUNNING') terminal = event.turn;
  }
}
assert.ok(terminal, 'terminal SSE turn');
const reread = await call(`/api/local/chats/${chatId}`);
assert.equal(reread.status, 200);
const turn = reread.body.turns.at(-1);
assert.equal(turn.id, turnId);
const summary = {status: turn.status, error_code: turn.error?.code || null,
  sse_events: events, sse_deltas: deltas, receipts: turn.receipts?.map(receipt => ({
    phase: receipt.phase, provider: receipt.provider, model: receipt.model,
    usage: receipt.usage, completed: receipt.completed})) || [],
  total_yuan: turn.tool?.output?.total_cents == null ? null : turn.tool.output.total_cents / 100,
  risk: turn.risk?.result?.decision || null, answer_characters: turn.assistant?.length || 0,
  refreshed_status: reread.body.turns.at(-1).status};
console.log(JSON.stringify(summary));
assert.equal(turn.status, 'COMPLETE');
assert.equal(summary.total_yuan, 100_000);
assert.equal(summary.risk, 'REVIEW');
assert.equal(summary.receipts.length, 2);
assert.ok(deltas > 0);
