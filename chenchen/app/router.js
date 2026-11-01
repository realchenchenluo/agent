"use strict";

const { randomUUID } = require("node:crypto");
const { overview } = require("../mot/engine");
const financial = require("../tools/financial-tools");

const fail = (code, statusCode = 400) => { throw Object.assign(new Error(code), { code, statusCode }); };
const minor = value => value == null ? "待核对" : `¥${(value / 100).toFixed(2)}`;
const amountInMinor = text => {
  const match = text.match(/((?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d{1,2})?)\s*元/);
  if (!match) return null;
  const value = Number(match[1].replace(/,/g, ""));
  const minorValue = Math.round(value * 100);
  return Number.isSafeInteger(minorValue) && minorValue > 0 ? minorValue : null;
};
function reconcile(transactions) {
  const settlements = new Map();
  for (const tx of transactions.filter(row => row.transaction_type === "SETTLEMENT" && row.related_transaction_id)) {
    const rows = settlements.get(tx.related_transaction_id) || [];
    rows.push(tx); settlements.set(tx.related_transaction_id, rows);
  }
  const pairs = transactions.filter(row => row.transaction_type === "RECEIPT" && row.status === "SETTLED").map(receipt => {
    const source_id = `${receipt.source_system}:${receipt.external_transaction_id}`;
    const linked = settlements.get(source_id) || [];
    const settled_minor = linked.reduce((sum, row) => sum + row.amount_minor, 0);
    return { source_id, source_system: receipt.source_system, expected_minor: receipt.amount_minor,
      settled_minor, difference_minor: receipt.amount_minor - settled_minor,
      settlement_ids: linked.map(row => `${row.source_system}:${row.external_transaction_id}`),
      status: linked.length ? (settled_minor === receipt.amount_minor ? "MATCHED" : "MISMATCH") : "UNVERIFIED",
      as_of: receipt.as_of };
  });
  const pending = transactions.filter(row => row.transaction_type === "RECEIPT" && row.status === "PENDING")
    .map(row => ({ source_id: `${row.source_system}:${row.external_transaction_id}`, amount_minor: row.amount_minor, as_of: row.as_of }));
  const internal = transactions.filter(row => row.transaction_type === "INTERNAL_TRANSFER")
    .map(row => ({ source_id: `${row.source_system}:${row.external_transaction_id}`, transfer_id: row.transfer_id,
      amount_minor: row.amount_minor, account_id: row.account_id, as_of: row.as_of }));
  return { kind: "reconciliation", pairs, pending, internal_transfers: internal,
    scope: "LOADED_SAMPLE_ONLY", completeness: "UNVERIFIED" };
}
const message = (conversationId, agentId, type, status, source, asOf, text, toolResults = [], actions = [], taskId = null, auditRef = null) => ({
  message_id: randomUUID(), conversation_id: conversationId, agent_id: agentId, task_id: taskId,
  message_type: type, status, source, as_of: asOf, text, tool_results: toolResults, actions, audit_ref: auditRef
});

async function motContext(runtime, owner) {
  if (!runtime) fail("MOT_UNAVAILABLE", 503);
  return runtime.read(owner, state => {
    const view = overview(state, runtime.now());
    const lastRun = state.checks.at(-1)?.result || null;
    const open = state.tasks.filter(task => !["RESOLVED", "CANCELLED"].includes(task.state));
    return { contract_version: "app.v1", agent_id: "mot", source: "MOT_LEDGER", as_of: view.as_of,
      status: state.stores.length ? "MONITORING" : "NO_DATA", last_check_at: lastRun?.at || null,
      next_check_at: runtime.scheduler?.timer ? runtime.scheduler.nextRunAt : null,
      unresolved_count: open.length, pending_approval_count: open.filter(task => task.state === "PENDING_APPROVAL").length,
      last_result: lastRun, overview: view, stores: state.stores, accounts: state.accounts,
      transactions: state.transactions.slice(-100), inbox: state.inbox.slice(-100), tasks: state.tasks.slice(-100),
      runs: state.checks.slice(-20), monitors: (state.monitors || []).slice(-100), audit: state.audit.slice(-100),
      core_risk: runtime.coreRisk ? "ADAPTER_CONFIGURED" : "UNAVAILABLE" };
  });
}

async function answer({ text, conversationId, agentId, owner, runtime, merchant, requestId }) {
  const now = new Date().toISOString();
  const query = text.trim();
  if (/今天|本日|昨日/.test(query) && /赚|利润|盈利|净利/.test(query)) {
    const ctx = await motContext(runtime, owner);
    return message(conversationId, "mot", "status", "UNKNOWN", "MOT_LEDGER", ctx.as_of,
      "当前只持有部分合成收款、结算及账户快照，缺少完整期间收入、成本、费用和退款，无法计算净利润。账户余额和收款不能当作利润。",
      [{ kind: "reconciliation", ...reconcile(ctx.transactions) }]);
  }
  const wantsTreasury = /门店|收银|资金池|资金缺口|到账|MOT|现金/.test(query);
  const wantsInvestment = /持仓|投资|组合|基金|股票|@持仓分析/.test(query);
  if (agentId === "mot" && wantsTreasury && wantsInvestment && !/调钱|划转|转账|付款/.test(query)) {
    const runId = randomUUID(), taskId = randomUUID();
    const steps = [];
    const step = (agent, status, source, asOf, evidence) => steps.push({ task_id: randomUUID(), parent_task_id: taskId,
      run_id: runId, agent_id: agent, status, source, as_of: asOf, evidence });
    const ctx = await motContext(runtime, owner);
    step("mot", ctx.overview.balance_fresh && ctx.overview.total_balance_fresh ? "READY" : "UNKNOWN", "MOT_LEDGER", ctx.as_of,
      { ledger_revision: ctx.overview.revision, account_ids: ctx.accounts.map(row => row.account_id) });
    const validation = financial.validatePortfolio(financial.getDemoPortfolio());
    const snapshot = validation.output.snapshot;
    const diagnosis = financial.diagnosePortfolio(snapshot);
    step("investment", "DEMO_DATA", "INVESTMENT_DEMO_SNAPSHOT", snapshot.as_of,
      { snapshot_id: snapshot.snapshot_id || null, position_count: snapshot.positions.length });
    step("risk", "UNAVAILABLE", "CORE_RISK_GATE", now, { core_risk: ctx.core_risk });
    const run = { run_id: runId, task_id: taskId, conversation_id: conversationId, status: "PARTIAL",
      created_at: now, updated_at: now, steps, stop_reason: "RISK_ADAPTER_UNAVAILABLE",
      ledger_revision: ctx.overview.revision };
    return message(conversationId, "mot", "task_result", "PARTIAL", "MOT_COORDINATOR", now,
      `两家门店的已核对账户总额 ${minor(ctx.overview.total_verified_minor)}，资金池可用 ${minor(ctx.overview.available_minor)}；${ctx.unresolved_count} 项未解决监测任务。持仓分析只能使用固定演示组合（基准日 ${snapshot.as_of}），不能代表你的真实持仓风险。Risk 服务 ${ctx.core_risk}，因此没有形成可信风险审批结论。`,
      [{ kind: "run", run }, { kind: "treasury", overview: ctx.overview, stores: ctx.stores, accounts: ctx.accounts, transactions: ctx.transactions.slice(-12) },
        { kind: "investment", snapshot, diagnosis: diagnosis.output }],
      [{ action: "open_context", label: "查看任务与证据", target: "tasks" }], taskId);
  }
  if ((agentId === "mot" && !wantsInvestment && !/账单|采购|经营|成本|商户|店主|@风险审核/.test(query)) ||
      /门店|收银|资金池|资金缺口|到账|调钱|划转|转账|转给|MOT/i.test(query)) {
    const ctx = await motContext(runtime, owner);
    if (/核对|对账|对不上|差异/.test(query) && /收款|到账|结算/.test(query)) {
      const result = reconcile(ctx.transactions);
      const mismatch = result.pairs.filter(row => row.status === "MISMATCH");
      const matched = result.pairs.filter(row => row.status === "MATCHED");
      const pending = result.pending.reduce((sum, row) => sum + row.amount_minor, 0);
      return message(conversationId, "mot", "tool_result", "PARTIAL", "MOT_LEDGER", ctx.as_of,
        `已载入样本中，${matched.length} 组收款与到账相符；${mismatch.map(row => `${row.source_id} 差额 ${minor(row.difference_minor)}`).join("，") || "暂无已关联差异"}，原因待核实；另有 ${minor(pending)} 待结算。内部转账不计营业收入。当前流水样本未证明覆盖完整一天。`,
        [result], [{ action: "open_context", label: "查看流水证据", target: "treasury" }]);
    }
    if (/支付|付款|付房租/.test(query) && /帮我|安排|执行|现在/.test(query)) {
      const amount_minor = amountInMinor(query);
      const due = ctx.transactions.filter(row => row.transaction_type === "PAYMENT" && row.status === "PENDING" && /rent|房租/i.test(row.external_transaction_id));
      const bill = /房租/.test(query) && due.length === 1 && due[0].amount_minor === amount_minor ? due[0] : null;
      const account = bill ? ctx.accounts.find(row => row.account_id === bill.account_id) : null;
      if (!amount_minor || !account)
        return message(conversationId, "mot", "approval", "NEEDS_INPUT", "MOT_LEDGER", ctx.as_of,
          "请核对付款金额、已登记的收款事项和付款账户；不能根据账户总额或模糊的收款人自动付款。",
          [{ kind: "payment_decision", status: "NEEDS_INPUT", amount_minor, account_id: account?.account_id || null }]);
      const available_minor = account.pool && ctx.overview.balance_fresh ? ctx.overview.available_minor : null;
      const shortfall_minor = available_minor === null ? null : Math.max(0, amount_minor - available_minor);
      const decision = { kind: "payment_decision", status: shortfall_minor === null ? "UNKNOWN" : "BLOCKED",
        amount_minor, account_id: account.account_id, pool_available_minor: available_minor, shortfall_minor,
        bill_source_id: `${bill.source_system}:${bill.external_transaction_id}`, ledger_revision: ctx.overview.revision,
        as_of: ctx.as_of, data_mode: "SYNTHETIC_ONLY", execution_allowed: false };
      return message(conversationId, "mot", "approval", decision.status, "MOT_LEDGER", ctx.as_of,
        shortfall_minor === null ? "付款账户的池内可用资金未核实，不能安排付款。" :
          shortfall_minor > 0 ? `已登记房租 ${minor(amount_minor)}，付款账户 ${account.account_id} 的资金池当前可用 ${minor(available_minor)}，缺口 ${minor(shortfall_minor)}。未发起付款；非池内资金须另行授权调拨，冻结及预占还需核对。` :
          `已登记房租 ${minor(amount_minor)}，池内当前可用 ${minor(available_minor)}。仍须经过 Core/Risk 和本人审批；当前未执行付款。`,
        [decision], [{ action: "open_context", label: "查看资金依据", target: "treasury" }]);
    }
    if (/监测|监控|提醒/.test(query) && /低于|小于|少于/.test(query)) {
      const threshold = amountInMinor(query) || 0;
      if (!/资金池/.test(query) || !Number.isSafeInteger(threshold) || threshold <= 0 || !requestId)
        return message(conversationId, "mot", "status", "NEEDS_INPUT", "MOT_MONITOR", ctx.as_of,
          "请明确资金池可用余额的阈值（元）。门店现金和银行账户不能自动对应；目前可持续监测的是已核对资金池。提醒仅写入站内 Inbox。",
          [{ kind: "risk", status: "NEEDS_INPUT", execution_allowed: false }]);
      const monitor = await runtime.createMonitor(owner, { scope: "POOL", threshold_minor: threshold,
        frequency_minutes: 15, channel: "INBOX_ONLY", timezone: "Asia/Shanghai", request_key: `app-monitor-${requestId}` });
      return message(conversationId, "mot", "task_result", "ACTIVE", "MOT_SCHEDULER", ctx.as_of,
        `已保存资金池可用余额低于 ${minor(threshold)} 的监测规则。服务器每 15 分钟检查，异常写入站内 Inbox；下次计划 ${monitor.next_run_at}。`,
        [{ kind: "monitor", monitor }], [{ action: "open_context", label: "管理监测", target: "tasks" }]);
    }
    if (/调钱|划转|转账|转给|转到|调给|付款|占用|调拨/.test(query) && /把|安排|执行|现在|帮我/.test(query)) {
      const matches = ctx.accounts.flatMap(account => [account.name, account.account_id].filter(Boolean)
        .flatMap(label => [...query.matchAll(new RegExp(label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "g"))]
          .map(hit => ({ account, at: hit.index })))).sort((a, b) => a.at - b.at);
      const selected = matches.filter((hit, index) => matches.findIndex(item => item.account.account_id === hit.account.account_id) === index);
      const amountMinor = amountInMinor(query) || 0;
      if (!/转账|转给|转到|划转|调拨|调钱|调给/.test(query) || selected.length !== 2 || !Number.isSafeInteger(amountMinor) || amountMinor <= 0 || !requestId)
        return message(conversationId, "mot", "approval", "NEEDS_INPUT", "MOT_CORE_RISK", ctx.as_of,
          "请明确金额（元）、来源账户和目标账户。只识别已核对账户的名称或 ID，不会根据门店名猜测账户。",
          [{ kind: "risk", status: ctx.core_risk, execution_allowed: false }]);
      try {
        const task = await runtime.proposeTransfer(owner, { amount_minor: amountMinor,
          from_account_id: selected[0].account.account_id, to_account_id: selected[1].account.account_id,
          request_key: `app-transfer-${requestId}` });
        return message(conversationId, "mot", "approval", task.state, "MOT_CORE_RISK", ctx.as_of,
          `已记录 ${minor(amountMinor)} 的调拨提案：${selected[0].account.name} → ${selected[1].account.name}。当前 Core/Risk 转账审批协议未接通，提案处于 ${task.state}，没有转账或模拟执行。`,
          [{ kind: "transfer_proposal", task, execution_allowed: false }],
          [{ action: "open_context", label: "查看提案与审计", target: "tasks" }], task.task_id);
      } catch (cause) {
        return message(conversationId, "mot", "approval", "BLOCKED", "MOT_CORE_RISK", ctx.as_of,
          `未创建调拨提案：${cause.code || "FUNDING_UNAVAILABLE"}。请核对账户快照和可用资金。`,
          [{ kind: "risk", status: cause.code || "UNAVAILABLE", execution_allowed: false }]);
      }
    }
    if (/任务|提醒|异常|监测|风险|缺口/.test(query)) {
      const active = ctx.tasks.filter(task => !["RESOLVED", "CANCELLED"].includes(task.state));
      const latest = active.at(-1);
      const auditRef = ctx.audit.filter(entry => entry.task_id === latest?.task_id).at(-1)?.audit_id || null;
      return message(conversationId, "mot", "tool_result", "READY", "MOT_INBOX", ctx.as_of,
        `当前有 ${active.length} 项未解决任务，${ctx.pending_approval_count} 项待审批；最近检查：${ctx.last_check_at || "尚无"}。`,
        [{ kind: "tasks", tasks: active.slice(-10), inbox: ctx.inbox.slice(-10), runs: ctx.runs.slice(-5) }],
        [{ action: "open_context", label: "查看任务与证据", target: "tasks" }], latest?.task_id || null, auditRef);
    }
    return message(conversationId, "mot", "tool_result", ctx.overview.balance_fresh && ctx.overview.total_balance_fresh ? "READY" : "UNKNOWN", "MOT_LEDGER", ctx.as_of,
      ctx.overview.stores ? `已核对账户总额 ${minor(ctx.overview.total_verified_minor)}，资金池可用 ${minor(ctx.overview.available_minor)}，待结算 ${minor(ctx.overview.pending_settlement_minor)}。待结算不计入可用资金。` : "尚无门店资金数据。",
      [{ kind: "treasury", overview: ctx.overview, stores: ctx.stores, accounts: ctx.accounts, transactions: ctx.transactions.slice(-12) }],
      [{ action: "open_context", label: "查看流水证据", target: "treasury" }]);
  }
  if (/账单|采购|经营|成本|商户|店主/.test(query) || agentId === "merchant") {
    if (!merchant) return message(conversationId, "merchant", "status", "UNAVAILABLE", "MERCHANT_ADAPTER", now,
      "当前云端尚未接入商户账本与会话存储；本机 Merchant 适配可用。未读取或编造云端账单金额。",
      [{ kind: "merchant_status", status: "UNAVAILABLE" }]);
    const result = merchant.summary();
    return message(conversationId, "merchant", "tool_result", "READY", "MERCHANT_LEDGER_LOCAL_SESSION", result.ledger.as_of,
      `已核对余额 ${minor(result.totals.balance_cents)}；待到账 ${minor(result.totals.receivable_cents)}，待付款 ${minor(result.totals.payable_cents)}。账单基准日为 ${result.ledger.as_of}，数据来自演示账本。`,
      [{ kind: "merchant", summary: result }], [{ action: "open_context", label: "查看账单与成本", target: "merchant" }]);
  }
  if (/持仓|投资|组合|基金|股票/.test(query) || agentId === "investment") {
    const validated = financial.validatePortfolio(financial.getDemoPortfolio());
    const snapshot = validated.output.snapshot;
    const diagnosis = financial.diagnosePortfolio(snapshot);
    return message(conversationId, "investment", "tool_result", "READY", "INVESTMENT_DEMO_SNAPSHOT", snapshot.as_of,
      `演示组合市值 ${minor(Math.round(snapshot.total_value * 100))}，现金占比 ${(snapshot.cash_weight * 100).toFixed(1)}%。行情是固定示例，未执行交易。`,
      [{ kind: "investment", snapshot, diagnosis: diagnosis.output }], [{ action: "open_context", label: "查看持仓与依据", target: "investment" }]);
  }
  if (/审批|风控|Risk|Core/i.test(query) || agentId === "risk") {
    const ctx = await motContext(runtime, owner);
    return message(conversationId, "risk", "status", "UNAVAILABLE", "CORE_RISK_GATE", ctx.as_of,
      `MOT 的 Core/Risk 商户审批适配状态为 ${ctx.core_risk}。可以查看已记录任务，但不能在这里生成可信本人审批或模拟执行成功。`,
      [{ kind: "risk", status: ctx.core_risk, tasks: ctx.tasks.filter(task => task.review).slice(-10) }],
      [{ action: "open_context", label: "查看阻断证据", target: "tasks" }]);
  }
  return message(conversationId, agentId, "status", "NEEDS_INPUT", "APP_TOOL_ROUTER", now,
    "可以询问门店资金、账单、持仓或监测任务。当前聊天使用确定性工具路由；未接入通用模型时，不会编造金融数据或操作结果。");
}

module.exports = { answer, motContext, message, fail };
