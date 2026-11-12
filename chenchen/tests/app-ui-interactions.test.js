"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { randomUUID } = require("node:crypto");

const source = fs.readFileSync(path.join(__dirname, "../versions/app.js"), "utf8");
const response = data => ({ ok: true, status: 200, json: async () => data });
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const tick = () => new Promise(resolve => setImmediate(resolve));

async function harness({ pendingMessage, initialMessages = [] } = {}) {
  const elements = new Map();
  function element(id) {
    if (!elements.has(id)) elements.set(id, {
      id, value: "", innerHTML: "", textContent: "", hidden: false, disabled: false, scrollHeight: 0,
      classList: { add() {}, remove() {}, toggle() {} }, querySelectorAll: () => [],
      addEventListener(name, handler) { this[`on_${name}`] = handler; }, focus() {},
      insertAdjacentHTML(_where, html) { this.innerHTML = html + this.innerHTML; }
    });
    return elements.get(id);
  }
  const location = { origin: "http://127.0.0.1:4183", search: "?conversation=a" };
  const conversations = {
    a: { conversation_id: "a", agent_id: "mot", messages: initialMessages, title: "会话 A" },
    b: { conversation_id: "b", agent_id: "mot", messages: [], title: "会话 B" }
  };
  const mot = { status: "MONITORING", unresolved_count: 1, pending_approval_count: 1,
    last_check_at: "2026-11-01T12:30:00Z", overview: {}, stores: [], accounts: [], transactions: [],
    inbox: [], runs: [], monitors: [], audit: [], tasks: [
      { task_id: "pending-approval", kind: "TRANSFER_PROPOSAL", state: "PENDING_APPROVAL", updated_at: "2026-11-01T12:00:00Z", ledger_revision: 1 },
      { task_id: "blocked-proposal", kind: "TRANSFER_PROPOSAL", state: "BLOCKED", updated_at: "2026-11-01T12:00:00Z", ledger_revision: 1 }
    ] };
  const fetch = async (url, options = {}) => {
    if (url === "/api/app/bootstrap") return response({ mode: "LOCAL_DEMO", agents: [{ agent_id: "mot", status: "MONITORING" }],
      conversations: Object.values(conversations).map(({ conversation_id, agent_id, title }) => ({ conversation_id, agent_id, title })), task_runs: [] });
    if (url === "/api/app/context/mot") return response(mot);
    if (url === "/api/app/conversations/a") return response(conversations.a);
    if (url === "/api/app/conversations/b") return response(conversations.b);
    if (url === "/api/app/conversations/a/messages") {
      if (pendingMessage) await pendingMessage.promise;
      conversations.a.messages = [{ message_type: "user", text: JSON.parse(options.body).text }];
      return response(conversations.a);
    }
    throw new Error(`Unexpected API: ${url}`);
  };
  const context = vm.createContext({ document: { getElementById: element }, window: {}, location,
    history: { pushState(_state, _unused, next) { location.search = next.search; } },
    fetch, crypto: { randomUUID }, AbortController, URL, URLSearchParams, setInterval() {},
    addEventListener() {}, confirm() { return false; }, console });
  vm.runInContext(source, context, { filename: "app.js" });
  await tick(); await tick();
  return { elements, element, context, location };
}

test("待我确认只列待审批任务，任务中心保留完整时间线", async () => {
  const app = await harness();
  app.element("approval-center").onclick();
  assert.match(app.element("context-body").innerHTML, /pending-approval/);
  assert.doesNotMatch(app.element("context-body").innerHTML, /blocked-proposal/);
  app.element("task-center").onclick();
  assert.match(app.element("context-body").innerHTML, /blocked-proposal/);
});

test("任务与证据入口从协作专员详情回到任务时间线", async () => {
  const app = await harness();
  vm.runInContext('state.selectedTeam = "merchant"', app.context);
  app.element("open-context").onclick();
  assert.match(app.element("context-body").innerHTML, /任务时间线/);
  assert.doesNotMatch(app.element("context-body").innerHTML, /协作节点/);
});

test("旧消息迟到后不覆盖切换后的会话和新输入", async () => {
  const delayed = deferred();
  const app = await harness({ pendingMessage: delayed });
  app.element("prompt").value = "查询会话 A";
  app.element("composer").on_submit({ preventDefault() {} });
  await tick();
  app.element("history").onclick({ target: { closest: () => ({ dataset: { conversation: "b" } }) } });
  await tick();
  app.element("prompt").value = "会话 B 的新输入";
  delayed.resolve();
  await tick(); await tick(); await tick();
  const state = vm.runInContext("state", app.context);
  assert.equal(state.conversation.conversation_id, "b");
  assert.equal(app.location.search, "?conversation=b");
  assert.equal(app.element("prompt").value, "会话 B 的新输入");
  assert.equal(state.pendingKey, null);
});

test("对账和付款卡保留样本范围、关联凭证及资金阻断口径", async () => {
  const app = await harness({ initialMessages: [{ message_type: "assistant", text: "核对结果", status: "PARTIAL",
    source: "MOT_LEDGER", as_of: "2026-11-01T12:00:00Z", tool_results: [
      { kind: "reconciliation", completeness: "UNVERIFIED", scope: "LOADED_SAMPLE_ONLY", pairs: [
        { source_id: "POS_A:sale-101", expected_minor: 30000, settled_minor: 29000, difference_minor: 1000,
          status: "MISMATCH", settlement_ids: ["BANK_A:settle-101"], as_of: "2026-11-01T12:00:00Z" },
        { source_id: "POS_A:unlinked", expected_minor: 10000, settled_minor: 0, difference_minor: 10000,
          status: "UNVERIFIED", settlement_ids: [], as_of: "2026-11-01T12:00:00Z" }
      ], pending: [], internal_transfers: [] },
      { kind: "payment_decision", status: "BLOCKED", amount_minor: 1350000,
        account_id: "bank-main", pool_available_minor: 800000, shortfall_minor: 550000,
        bill_source_id: "ERP_A:rent-next", ledger_revision: 1, as_of: "2026-11-01T12:00:00Z", data_mode: "SYNTHETIC_ONLY" }
    ] }] });
  const html = app.element("conversation").innerHTML;
  assert.match(html, /待核实差额 ¥10\.00/);
  assert.match(html, /未取得关联记录/);
  assert.match(html, /LOADED_SAMPLE_ONLY/);
  assert.match(html, /BANK_A:settle-101/);
  assert.match(html, /缺口<\/small><strong>¥5,500\.00/);
  assert.match(html, /未执行付款/);
});
