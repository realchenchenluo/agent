"use strict";

const { randomUUID } = require("node:crypto");
const { overview } = require("../mot/engine");
const financial = require("../tools/financial-tools");

const fail = (code, statusCode = 400) => { throw Object.assign(new Error(code), { code, statusCode }); };
const minor = value => value == null ? "待核对" : `¥${(value / 100).toFixed(2)}`;
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
      runs: state.checks.slice(-20), audit: state.audit.slice(-100),
      core_risk: runtime.coreRisk ? "ADAPTER_CONFIGURED" : "UNAVAILABLE" };
  });
}

async function answer({ text, conversationId, agentId, owner, runtime, merchant, requestId }) {
  const now = new Date().toISOString();
  const query = text.trim();
  if (agentId === "mot" || /门店|收银|资金池|资金缺口|到账|调钱|划转|转账|转给|MOT/i.test(query)) {
    const ctx = await motContext(runtime, owner);
    if (/调钱|划转|转账|转给|转到|调给|付款|占用|调拨/.test(query) && /把|安排|执行|现在|帮我/.test(query)) {
      const matches = ctx.accounts.flatMap(account => [account.name, account.account_id].filter(Boolean)
        .flatMap(label => [...query.matchAll(new RegExp(label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "g"))]
          .map(hit => ({ account, at: hit.index })))).sort((a, b) => a.at - b.at);
      const selected = matches.filter((hit, index) => matches.findIndex(item => item.account.account_id === hit.account.account_id) === index);
      const amountText = query.match(/(\d+(?:\.\d{1,2})?)\s*元/);
      const amountMinor = amountText ? Math.round(Number(amountText[1]) * 100) : 0;
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
    return message(conversationId, "mot", "tool_result", ctx.overview.balance_fresh ? "READY" : "UNKNOWN", "MOT_LEDGER", ctx.as_of,
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
