const $ = id => document.getElementById(id);
const esc = value => String(value ?? "").replace(/[&<>"']/g, char => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]);
const money = minor => minor == null ? "待核对" : `¥${(minor / 100).toLocaleString("zh-CN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const time = value => value ? new Date(value).toLocaleString("zh-CN", { hour12: false }) : "未知";
const names = { mot: "MOT · 财务总助手", merchant: "店主财务专员", investment: "持仓分析专员", risk: "风险审核专员" };
const state = { agent: "mot", conversation: null, conversations: [], taskRuns: [], agents: [], mot: null, tab: "treasury", selectedTask: null, selectedTeam: null, pendingKey: null, pendingText: null, pendingController: null, sending: false, viewEpoch: 0, latestResult: null, merchantSummary: null, merchantDetail: null, merchantInsights: null, merchantDelay: 0 };

async function api(path, body, signal) {
  const response = await fetch(path, { method: body === undefined ? "GET" : "POST", credentials: "same-origin",
    headers: body === undefined ? {} : { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body), signal });
  let data;
  try { data = await response.json(); } catch { throw new Error(`HTTP ${response.status}：后端未返回 JSON`); }
  if (!response.ok) throw new Error(data.error?.code || `HTTP ${response.status}`);
  return data;
}
function error(value) { $("global-error").textContent = value; $("global-error").hidden = !value; }
function url(agent = state.agent, conversation = state.conversation?.conversation_id) {
  const next = new URL("/app", location.origin);
  if (conversation) next.searchParams.set("conversation", conversation);
  history.pushState({}, "", next);
}
function closeOverlays() { $("sidebar").classList.remove("open"); $("context-panel").classList.remove("open"); $("mobile-shade").classList.remove("show"); }
function renderNav() {
  $("agents").innerHTML = state.agents.filter(agent => agent.agent_id !== "mot").map(agent => `<button type="button" data-team="${esc(agent.agent_id)}"><span class="agent-icon">○</span><strong>${esc(names[agent.agent_id])}</strong><small>${esc(agent.connection_status)} · ${esc(agent.data_mode)}</small></button>`).join("");
  const term = $("history-search").value.trim().toLowerCase();
  $("history").innerHTML = state.conversations.filter(item => item.agent_id === "mot" && item.title.toLowerCase().includes(term)).map(row => `<button type="button" data-conversation="${esc(row.conversation_id)}" class="${state.conversation?.conversation_id === row.conversation_id ? "active" : ""}">${esc(row.title)}</button>`).join("") || `<p class="muted" style="padding:0 12px">尚无 MOT 对话</p>`;
  $("agent-title").textContent = names.mot;
  const mot = state.agents.find(item => item.agent_id === "mot");
  $("agent-subtitle").textContent = `监测 ${mot?.status || "未知"} · ${state.mode === "LOCAL_DEMO" ? "本机合成数据" : "受控 Staging 合成数据"} · 最近检查 ${time(mot?.last_check_at)}`;
  $("mot-nav-status").textContent = `${mot?.status || "未知"} · ${mot?.unresolved_count ?? "未知"} 项待处理`;
  $("context-title").textContent = state.selectedTeam ? names[state.selectedTeam] : "资金与任务";
  $("prompt").placeholder = "向 MOT 提问，或用 @持仓分析 指定协作方向…";
  $("identity").textContent = state.mode === "LOCAL_DEMO" ? "本机合成演示 · 同一身份" : "已授权会话";
}
function card(result) {
  const kind = result.kind;
  if (kind === "treasury") {
    const view = result.overview;
    return `<div class="result-card"><div class="card-top"><span>多门店资金 · ${esc(view.as_of || "未知时间")}</span><span class="card-status ${view.balance_fresh ? "ready" : ""}">${view.balance_fresh ? "已核对" : "待核对"}</span></div><div class="card-stats"><div><small>账户总额</small><strong>${money(view.total_verified_minor)}</strong></div><div><small>池内可用</small><strong>${money(view.available_minor)}</strong></div><div><small>待结算</small><strong>${money(view.pending_settlement_minor)}</strong></div></div><div class="card-list">${result.stores.map(row => `<div>${esc(row.name)} · ${esc(row.source_system)}</div>`).join("")}</div></div>`;
  }
  if (kind === "tasks") return `<div class="result-card"><div class="card-top">主动监测与待办</div><div class="card-list">${result.tasks.length ? result.tasks.slice().reverse().map(row => `<div><strong>${esc(row.kind)}</strong> · ${esc(row.state)} · ${esc(row.task_id)}</div>`).join("") : "<div>当前没有未解决任务</div>"}</div></div>`;
  if (kind === "merchant") { const item = result.summary; return `<div class="result-card"><div class="card-top">店主账单 · ${esc(item.ledger.as_of)}</div><div class="card-stats"><div><small>已核对余额</small><strong>${money(item.totals.balance_cents)}</strong></div><div><small>待到账</small><strong>${money(item.totals.receivable_cents)}</strong></div><div><small>待付款</small><strong>${money(item.totals.payable_cents)}</strong></div></div></div>`; }
  if (kind === "investment") { const item = result.snapshot; return `<div class="result-card"><div class="card-top">演示持仓 · ${esc(item.as_of)}</div><div class="card-stats"><div><small>组合市值</small><strong>${money(Math.round(item.total_value * 100))}</strong></div><div><small>现金</small><strong>${money(Math.round(item.cash * 100))}</strong></div><div><small>持仓数</small><strong>${item.positions.length}</strong></div></div></div>`; }
  if (kind === "reconciliation") return `<div class="result-card"><div class="card-top"><span>已载入流水对账</span><span class="card-status">${esc(result.completeness)}</span></div><div class="card-list">${result.pairs.map(row => `<div>${esc(row.source_id)} · 收款 ${money(row.expected_minor)} / 到账 ${row.settlement_ids.length ? money(row.settled_minor) : "未取得关联记录"} · ${esc(row.status)}${row.status === "MISMATCH" ? ` · 待核实差额 ${money(row.difference_minor)}` : ""}<div class="meta">到账关联 ${esc(row.settlement_ids.join(", ") || "未取得")} · ${time(row.as_of)}</div></div>`).join("")}${result.pending.map(row => `<div>${esc(row.source_id)} · 待结算 ${money(row.amount_minor)} · ${time(row.as_of)}</div>`).join("")}${result.internal_transfers.map(row => `<div>${esc(row.source_id)} · 内部转账 ${money(row.amount_minor)} · 不计营业收入</div>`).join("")}</div><div class="meta">范围 ${esc(result.scope)} · 完整性 ${esc(result.completeness)}；差异原因未经核实。</div></div>`;
  if (kind === "payment_decision") return `<div class="result-card"><div class="card-top"><span>房租付款核对</span><span class="card-status">${esc(result.status)}</span></div><div class="card-stats"><div><small>请求金额</small><strong>${money(result.amount_minor)}</strong></div><div><small>池内可用</small><strong>${money(result.pool_available_minor)}</strong></div><div><small>缺口</small><strong>${money(result.shortfall_minor)}</strong></div></div><div class="meta">账户 ${esc(result.account_id || "待确认")} · 单据 ${esc(result.bill_source_id || "待确认")} · 账本版本 ${esc(result.ledger_revision || "待取得")} · ${time(result.as_of)} · ${esc(result.data_mode || "待核对")}</div><p class="danger-text">未执行付款；资金足额仍须经过 Core/Risk 和本人审批。</p></div>`;
  if (kind === "risk") return `<div class="result-card"><div class="card-top">Core / Risk</div><span class="card-status">${esc(result.status)}</span><p class="danger-text">当前无法确认本人审批或模拟执行。</p></div>`;
  if (kind === "transfer_proposal") { const task = result.task; return `<div class="result-card"><div class="card-top"><span>资金调拨提案 · ${esc(task.task_id)}</span><span class="card-status">${esc(task.state)}</span></div><div class="card-stats"><div><small>金额</small><strong>${money(task.proposal.amount_minor)}</strong></div><div><small>来源</small><strong>${esc(task.proposal.from_account_id)}</strong></div><div><small>目标</small><strong>${esc(task.proposal.to_account_id)}</strong></div></div><p class="danger-text">Core/Risk 未接通；未执行转账或 PAPER 模拟。</p></div>`; }
  if (kind === "run") return `<div class="result-card"><div class="card-top"><span>MOT 协作任务 · ${esc(result.run.task_id)}</span><span class="card-status">${esc(result.run.status)}</span></div><ol class="run-steps">${result.run.steps.map(step => `<li><strong>${esc(names[step.agent_id] || step.agent_id)}</strong> · ${esc(step.status)}<small>${esc(step.source)} · ${time(step.as_of)} · ${esc(step.task_id)}</small></li>`).join("")}</ol><p class="danger-text">停止原因：${esc(result.run.stop_reason)}</p></div>`;
  if (kind === "monitor") return `<div class="result-card"><div class="card-top"><span>持续监测 · ${esc(result.monitor.monitor_id)}</span><span class="card-status ready">${esc(result.monitor.status)}</span></div><p>资金池可用低于 ${money(result.monitor.threshold_minor)} 时写入 Inbox。每 15 分钟由服务器检查。</p><div class="meta">下次计划 ${time(result.monitor.next_run_at)}</div></div>`;
  return "";
}
function renderMerchantContext(item) {
  const summary = state.merchantSummary || item.summary;
  const detail = state.merchantDetail;
  const insights = state.merchantInsights;
  return `<section class="context-section"><h3>账单状态</h3><div class="context-item"><strong>${esc(summary.ledger.shop)} · ${esc(summary.ledger.as_of)}</strong><small>${esc(summary.warnings.join(" "))}</small><small>已核对 ${money(summary.totals.balance_cents)} · 待到账 ${money(summary.totals.receivable_cents)} · 待付款 ${money(summary.totals.payable_cents)}</small><small>${summary.reviewed ? "账单已确认" : "提醒待人工核对"}</small></div><div class="context-item"><strong>到账假设</strong><select id="merchant-delay"><option value="0" ${state.merchantDelay === 0 ? "selected" : ""}>按预计日期</option><option value="3" ${state.merchantDelay === 3 ? "selected" : ""}>晚 3 天</option><option value="7" ${state.merchantDelay === 7 ? "selected" : ""}>晚 7 天</option></select><button type="button" class="secondary-action" data-merchant-action="scenario">重新测算</button><small>仅改变测算，不改原账单。</small><small>预计最早缺口：${esc(summary.forecast.first_gap?.date || "当前测算无缺口")}</small></div></section><section class="context-section"><h3>账单明细</h3>${summary.ledger.bills.slice(0,40).map(row => `<div class="context-item"><strong>${esc(row.category)} · ${money(row.amount_cents)}</strong><small>${esc(row.channel)}:${esc(row.id)} · ${esc(row.status)} · ${esc(row.kind)}</small><button type="button" class="secondary-action" data-merchant-bill="${esc(row.channel + ":" + row.id)}">查看来源</button></div>`).join("")}</section>${detail ? `<section class="context-section"><h3>已查看账单</h3><div class="context-item"><strong>${esc(detail.category)} · ${money(detail.net_cents)}</strong><small>${esc(detail.source)} · ${esc(detail.balance_effect)}</small><p>${esc(detail.description)}</p></div></section>` : ""}<section class="context-section"><h3>确认与提醒</h3><label class="muted"><input type="checkbox" id="merchant-confirm"> 我已查看账单来源并理解金额口径</label><button type="button" class="secondary-action" data-merchant-action="review">确认并生成提醒</button>${insights ? insights.notices.map(row => `<div class="context-item"><strong>${esc(row.title)}</strong><p>${esc(row.explanation)}</p><small>证据 ${esc(row.evidence.join(", "))}</small></div>`).join("") : `<p class="muted">提醒需先查看账单并明确确认。</p>`}</section><section class="context-section"><h3>数据文件</h3><a class="secondary-action" href="/api/merchant/export?type=ledger">导出账单</a><input type="file" id="merchant-import-file" accept=".json,application/json"><button type="button" class="secondary-action" data-merchant-action="import">校验并导入 JSON</button></section><section class="context-section"><h3>成本变化</h3>${summary.costs.map(row => `<div class="context-item"><strong>${esc(row.category)} · ${money(row.current_cents)}</strong><small>较上期 ${money(row.delta_cents)} · 证据 ${esc(row.evidence.join(", "))}</small></div>`).join("")}</section>`;
}
function renderConversation() {
  const rows = state.conversation?.messages || [];
  state.latestResult = [...rows].reverse().flatMap(row => row.tool_results || [])[0] || null;
  $("conversation").innerHTML = rows.length ? rows.map(row => row.message_type === "user" ? `<div class="message user"><div class="bubble">${esc(row.text)}</div></div>` : `<div class="message assistant"><div class="speaker"><span class="mini-icon">◎</span>${esc(names.mot)}</div><p>${esc(row.text)}</p>${(row.tool_results || []).map(card).join("")}${(row.actions || []).map(action => `<button type="button" class="action-link" data-open-context="${esc(action.target)}">${esc(action.label)}</button>`).join("")}<div class="meta">${esc(row.status)} · ${esc(row.source)} · ${time(row.as_of)}${row.audit_ref ? ` · 审计 ${esc(row.audit_ref)}` : ""}</div></div>`).join("") : state.mot?.tasks?.length || state.mot?.runs?.length ? `<div class="welcome recent"><span class="welcome-mark">◎</span><h1>MOT 正在看着这两家店</h1><p>最近检查 ${time(state.mot.last_check_at)} · ${state.mot.unresolved_count} 项待处理 · ${state.mot.monitors?.filter(row => row.status === "ACTIVE").length || 0} 条持续监测。</p><button type="button" class="secondary-action" data-open-context="tasks">查看任务和运行证据</button></div>` : `<div class="welcome"><span class="welcome-mark">◎</span><h1>把财务目标交给 MOT</h1><p>同一个对话里查看门店资金、持仓演示数据和监测任务。MOT 会标清专员来源与未接通的能力。</p><div><button type="button" class="secondary-action" data-suggestion="检查两家门店资金，并告诉我有没有需要关注的持仓风险">检查资金和持仓风险</button><button type="button" class="secondary-action" data-suggestion="查看当前监测任务">查看当前任务</button><button type="button" class="secondary-action" data-suggestion="监测资金池可用余额低于 3000 元，站内提醒我">设置持续监测</button></div></div>`;
  $("conversation-scroll").scrollTop = $("conversation-scroll").scrollHeight;
  renderContext();
}
function taskEvidence(task) {
  return `<div class="context-item"><strong>${esc(task.kind)} <span class="pill ${task.state === "BLOCKED" || task.state === "UNKNOWN" ? "blocked" : ""}">${esc(task.state)}</span></strong><small>任务 ${esc(task.task_id)} · 更新 ${time(task.updated_at)}</small><small>Core/Risk ${esc(task.review?.status || "UNAVAILABLE")} · 账本版本 ${esc(task.ledger_revision)}</small><details><summary>执行证据与审计</summary><pre>${esc(JSON.stringify({ proposal: task.proposal, evidence: task.evidence, approval: task.approval, review: task.review, simulation: task.simulation }, null, 2))}</pre></details>${task.state === "PENDING_APPROVAL" ? `<button type="button" class="secondary-action" data-decision="REJECT" data-task="${esc(task.task_id)}">拒绝提案</button>${task.approval?.decision !== "APPROVE" ? `<button type="button" class="secondary-action" data-decision="APPROVE" data-task="${esc(task.task_id)}">批准 PAPER 提案</button>` : `<button type="button" class="secondary-action" data-simulate="${esc(task.task_id)}">记录 PAPER 模拟</button>`}` : ""}${task.state === "BLOCKED" ? `<button type="button" class="secondary-action" data-decision="REJECT" data-task="${esc(task.task_id)}">关闭被阻断提案</button>` : ""}</div>`;
}
function renderContext() {
  const body = $("context-body");
  $("context-title").textContent = state.selectedTeam ? names[state.selectedTeam] : state.tab === "approvals" ? "待我确认" : "资金与任务";
  if (state.selectedTeam) {
    $("context-tabs").hidden = true;
    const agent = state.agents.find(row => row.agent_id === state.selectedTeam);
    body.innerHTML = `<section class="context-section"><h3>协作节点</h3><div class="context-item"><strong>${esc(names[state.selectedTeam])}</strong><small>连接：${esc(agent?.connection_status || "UNAVAILABLE")} · 数据：${esc(agent?.data_mode || "NONE")}</small><p>${state.selectedTeam === "investment" ? "仅使用固定演示持仓快照，不代表用户真实持仓，也不执行交易。" : state.selectedTeam === "merchant" ? "本机可读演示账本；云端商户账本未接通。" : "可信 Core / Risk 审批接口未接通；不能批准资金动作。"}</p><button type="button" class="secondary-action" data-mention="${esc(state.selectedTeam)}">在 MOT 对话中提及</button></div></section>`;
    return;
  }
  if (state.agent === "mot" || state.agent === "risk") {
    const ctx = state.mot;
    if (!ctx) { body.innerHTML = `<p class="muted">MOT 状态不可用。请重试读取后端。</p>`; return; }
    $("context-tabs").hidden = false;
    $("context-tabs").querySelectorAll("button").forEach(button => button.classList.toggle("active", button.dataset.tab === state.tab));
    if (state.tab === "approvals") {
      const pending = ctx.tasks.filter(task => task.state === "PENDING_APPROVAL");
      body.innerHTML = `<section class="context-section"><h3>待本人确认 · ${pending.length} 项</h3>${pending.map(taskEvidence).join("") || `<p class="muted">当前没有待本人确认的提案。被阻断的资金提案可在任务中心查看；Core/Risk 未接通时不能批准或执行。</p>`}</section>`;
      return;
    }
    if (state.tab === "treasury") body.innerHTML = `<section class="context-section"><h3>运行状态</h3><div class="context-item"><strong>${esc(ctx.status)} · ${ctx.unresolved_count} 项未解决</strong><small>上次检查 ${time(ctx.last_check_at)}${ctx.next_check_at ? ` · 下次计划 ${time(ctx.next_check_at)}` : ""}</small><small>Core/Risk ${esc(ctx.core_risk)} · 资金操作禁用</small></div></section><section class="context-section"><h3>账户与资金池</h3>${ctx.accounts.map(row => `<div class="context-item"><strong>${esc(row.name)} · ${money(row.balance_minor)}</strong><small>${esc(row.account_id)} · ${row.pool ? "资金池" : "非资金池"} · 快照 ${time(row.as_of)}</small></div>`).join("") || `<p class="muted">尚无已核对账户。</p>`}</section><section class="context-section"><h3>近期流水</h3>${ctx.transactions.slice(-12).reverse().map(row => `<div class="context-item"><strong>${esc(row.transaction_type)} · ${money(row.amount_minor)}</strong><small>${esc(row.source_system)}:${esc(row.external_transaction_id)} · ${esc(row.status)}</small><small>${esc(row.store_id || "—")} / ${esc(row.terminal_id || "—")} · ${time(row.occurred_at)}</small></div>`).join("") || `<p class="muted">暂无流水。</p>`}</section>`;
    else if (state.tab === "tasks") body.innerHTML = `<section class="context-section"><h3>MOT 协作任务</h3>${state.taskRuns.map(run => `<div class="context-item"><strong>${esc(run.status)} · ${esc(run.task_id)}</strong><small>会话 ${esc(run.conversation_id)} · ${time(run.updated_at)}</small>${run.steps.map(step => `<small>${esc(names[step.agent_id])} · ${esc(step.status)} · ${esc(step.source)}</small>`).join("")}<small>停止原因 ${esc(run.stop_reason || "无")}</small></div>`).join("") || `<p class="muted">尚无协作任务。</p>`}</section><section class="context-section"><h3>持续监测</h3>${ctx.monitors?.slice().reverse().map(row => `<div class="context-item"><strong>资金池低于 ${money(row.threshold_minor)} <span class="pill">${esc(row.status)}</span></strong><small>每 ${esc(row.frequency_minutes)} 分钟 · ${esc(row.channel)} · ${esc(row.timezone)}</small><small>最近 ${time(row.last_run_at)} · 下次 ${time(row.next_run_at)}</small>${row.status !== "CANCELLED" ? `<button type="button" class="secondary-action" data-monitor="${esc(row.monitor_id)}" data-monitor-action="${row.status === "ACTIVE" ? "PAUSE" : "RESUME"}">${row.status === "ACTIVE" ? "暂停" : "恢复"}</button><button type="button" class="secondary-action" data-monitor="${esc(row.monitor_id)}" data-monitor-action="CANCEL">取消</button><label class="muted">新阈值（元）<input type="number" min="0.01" step="0.01" id="threshold-${esc(row.monitor_id)}" value="${row.threshold_minor / 100}"></label><button type="button" class="secondary-action" data-monitor="${esc(row.monitor_id)}" data-monitor-action="UPDATE">修改阈值</button>` : ""}</div>`).join("") || `<p class="muted">尚无监测规则。在对话中说“监测资金池可用余额低于 3000 元”。</p>`}</section><section class="context-section"><h3>Inbox · ${ctx.inbox.length} 条</h3>${ctx.inbox.slice(-10).reverse().map(row => `<div class="context-item"><strong>${esc(row.status)}</strong><small>任务 ${esc(row.task_id)} · ${time(row.updated_at)}</small></div>`).join("") || `<p class="muted">暂无提醒。</p>`}</section><section class="context-section"><h3>任务时间线</h3>${ctx.tasks.slice().reverse().map(taskEvidence).join("") || `<p class="muted">暂无任务。</p>`}</section>`;
    else if (state.tab === "settings") body.innerHTML = `<section class="context-section"><h3>连接与权限</h3><div class="context-item"><strong>MOT · ${esc(ctx.status)}</strong><small>身份 ${esc(state.mode)} · 数据模式 ${state.mode === "LOCAL_DEMO" ? "本机合成" : "受控 Staging 合成"}</small><small>最近检查 ${time(ctx.last_check_at)} · Core/Risk ${esc(ctx.core_risk)}</small><small>实时语音通话：UNAVAILABLE · 电话外呼：DISABLED</small><p>语音听写依赖浏览器识别能力，转写结果只会填入输入框。当前没有授权的实时语音通话服务。</p></div></section>`;
    else body.innerHTML = `<section class="context-section"><h3>自动运行</h3>${ctx.runs.slice().reverse().map(row => `<div class="context-item"><strong>${esc(row.result.trigger)} · ${esc(row.result.findings)} 项发现</strong><small>${time(row.result.at)} · ${esc(row.result.check_id)}</small></div>`).join("") || `<p class="muted">尚无运行记录。</p>`}</section><section class="context-section"><h3>审计事件</h3>${ctx.audit.slice(-30).reverse().map(row => `<div class="context-item"><strong>${esc(row.event_type)}</strong><small>${time(row.at)} · ${esc(row.task_id || "全局")} · ${esc(row.audit_id)}</small></div>`).join("") || `<p class="muted">暂无审计事件。</p>`}</section>`;
    if (state.tab === "treasury") body.insertAdjacentHTML("afterbegin", `<button type="button" class="secondary-action" data-mot-check>手动检查</button>`);
  } else {
    $("context-tabs").hidden = true;
    const item = state.latestResult;
    if (state.agent === "merchant" && item?.kind === "merchant") body.innerHTML = renderMerchantContext(item);
    else if (state.agent === "investment" && item?.kind === "investment") body.innerHTML = `<section class="context-section"><h3>固定示例持仓</h3><div class="context-item"><strong>基准日 ${esc(item.snapshot.as_of)}</strong><small>行情不自动更新；没有交易指令。</small></div>${item.snapshot.positions.map(row => `<div class="context-item"><strong>${esc(row.name)} · ${money(Math.round(row.market_value * 100))}</strong><small>${esc(row.instrument_id)} · 权重 ${(row.weight * 100).toFixed(1)}%</small></div>`).join("")}</section>`;
    else body.innerHTML = `<p class="muted">向 Agent 提问后，这里会显示工具来源和详细结果。</p>`;
  }
}
async function refreshMot() {
  if (!state.agents.length) return;
  try {
    const ctx = await api("/api/app/context/mot"); state.mot = ctx;
    const agent = state.agents.find(item => item.agent_id === "mot");
    if (agent) Object.assign(agent, ...["status", "last_check_at", "next_check_at", "unresolved_count", "pending_approval_count", "last_result", "core_risk"].map(key => ({ [key]: ctx[key] })));
    renderNav(); if (!state.conversation?.messages?.length) renderConversation(); else renderContext();
  } catch (cause) { error(`MOT 数据读取失败：${cause.message}`); }
}
async function bootstrap() {
  const viewEpoch = state.viewEpoch;
  const data = await api("/api/app/bootstrap");
  if (viewEpoch !== state.viewEpoch) return;
  state.mode = data.mode; state.agents = data.agents; state.conversations = data.conversations; state.taskRuns = data.task_runs || [];
  const params = new URLSearchParams(location.search);
  state.agent = "mot";
  const id = params.get("conversation");
  if (id) await openConversation(id, false); else { state.conversation = null; renderNav(); renderConversation(); }
  if (viewEpoch !== state.viewEpoch) return;
  await refreshMot();
  if (!state.conversation) renderConversation();
}
async function openConversation(id, changeUrl = true) {
  const viewEpoch = state.viewEpoch;
  const row = await api(`/api/app/conversations/${encodeURIComponent(id)}`);
  if (viewEpoch !== state.viewEpoch) return;
  if (row.agent_id !== "mot") throw new Error("旧版专员对话请在原入口查看；新任务统一由 MOT 协调");
  state.conversation = row; state.agent = "mot";
  if (changeUrl) url("mot", id);
  error(""); renderNav(); renderConversation(); closeOverlays();
}
async function selectAgent(agent) {
  state.viewEpoch++; state.pendingKey = null; state.pendingText = null;
  state.agent = "mot"; state.conversation = null; state.latestResult = null; state.selectedTeam = null; state.tab = "treasury";
  url("mot", null); renderNav(); renderConversation(); closeOverlays();
}
async function sendText(text) {
  if (!text.trim() || state.sending) return;
  state.sending = true;
  const viewEpoch = state.viewEpoch;
  let conversationId = state.conversation?.conversation_id;
  error(""); $("send").disabled = true; $("stop-message").hidden = false;
  const key = state.pendingKey && state.pendingText === text ? state.pendingKey : crypto.randomUUID(); state.pendingKey = key; state.pendingText = text;
  try {
    if (!conversationId) {
      const created = await api("/api/app/conversations", { agent_id: "mot", request_id: crypto.randomUUID() });
      conversationId = created.conversation_id;
      if (viewEpoch === state.viewEpoch && !state.conversation) { state.conversation = created; url("mot", conversationId); }
    }
    state.pendingController = new AbortController();
    await api(`/api/app/conversations/${encodeURIComponent(conversationId)}/messages`, { text, request_id: key }, state.pendingController.signal);
    if (state.pendingKey === key) { state.pendingKey = null; state.pendingText = null; }
    if (viewEpoch === state.viewEpoch && state.conversation?.conversation_id === conversationId && $("prompt").value === text) $("prompt").value = "";
    const data = await api("/api/app/bootstrap"); state.conversations = data.conversations; state.taskRuns = data.task_runs || [];
    if (viewEpoch === state.viewEpoch && state.conversation?.conversation_id === conversationId) { await openConversation(conversationId, false); await refreshMot(); }
    else renderNav();
  } catch (cause) {
    if (viewEpoch === state.viewEpoch) error(cause.name === "AbortError" ? "已停止等待。服务端可能仍在处理；请刷新会话核对，勿另发相同资金请求。" : `消息结果未确认：${cause.message}。先刷新会话；若未记录，可用相同内容重试。`);
  }
  finally { state.pendingController = null; state.sending = false; $("stop-message").hidden = true; $("send").disabled = false; if (viewEpoch === state.viewEpoch) $("prompt").focus(); }
}

$("composer").addEventListener("submit", event => { event.preventDefault(); sendText($("prompt").value); });
$("prompt").addEventListener("keydown", event => { if (event.key === "Enter" && !event.shiftKey && !event.isComposing) { event.preventDefault(); $("composer").requestSubmit(); } });
$("new-chat").onclick = () => selectAgent("mot");
$("mot-home").onclick = () => selectAgent("mot");
$("task-center").onclick = () => { state.selectedTeam = null; state.tab = "tasks"; renderContext(); $("context-panel").classList.add("open"); closeSidebarOnly(); };
$("approval-center").onclick = () => { state.selectedTeam = null; state.tab = "approvals"; renderContext(); $("context-panel").classList.add("open"); closeSidebarOnly(); };
$("settings-open").onclick = () => { state.selectedTeam = null; state.tab = "settings"; renderContext(); $("context-panel").classList.add("open"); closeSidebarOnly(); };
function closeSidebarOnly() { $("sidebar").classList.remove("open"); $("mobile-shade").classList.add("show"); }
$("history-search").oninput = renderNav;
$("agents").onclick = event => { const button = event.target.closest("[data-team]"); if (button) { state.selectedTeam = button.dataset.team; renderNav(); renderContext(); $("context-panel").classList.add("open"); closeSidebarOnly(); } };
$("history").onclick = event => { const button = event.target.closest("[data-conversation]"); if (button) { state.viewEpoch++; state.pendingKey = null; state.pendingText = null; openConversation(button.dataset.conversation).catch(cause => error(cause.message)); } };
$("conversation").onclick = event => {
  const suggestion = event.target.closest("[data-suggestion]"); if (suggestion) { $("prompt").value = suggestion.dataset.suggestion; $("prompt").focus(); }
  const action = event.target.closest("[data-open-context]"); if (action) { state.selectedTeam = null; state.tab = action.dataset.openContext === "tasks" ? "tasks" : "treasury"; renderContext(); $("context-panel").classList.add("open"); $("mobile-shade").classList.add("show"); }
};
$("context-tabs").onclick = event => { const button = event.target.closest("[data-tab]"); if (button) { state.selectedTeam = null; state.tab = button.dataset.tab; renderContext(); } };
$("context-body").onclick = async event => {
  const mention = event.target.closest("[data-mention]");
  if (mention) { $("prompt").value = `@${names[mention.dataset.mention]} `; closeOverlays(); $("prompt").focus(); return; }
  const monitorAction = event.target.closest("[data-monitor-action]");
  if (monitorAction) {
    const threshold = Number($(`threshold-${monitorAction.dataset.monitor}`)?.value);
    const thresholdMinor = Math.round(threshold * 100);
    try { await api(`/api/mot/monitors/${encodeURIComponent(monitorAction.dataset.monitor)}`, {
      action: monitorAction.dataset.monitorAction, request_key: `app-${crypto.randomUUID()}`,
      ...(monitorAction.dataset.monitorAction === "UPDATE" ? { threshold_minor: thresholdMinor } : {}) }); await refreshMot(); }
    catch (cause) { error(`监测更新未确认：${cause.message}。请刷新后核对。`); }
    return;
  }
  const check = event.target.closest("[data-mot-check]");
  if (check) {
    check.disabled = true;
    try { await api("/api/mot/check", { idempotency_key: `app-manual-${crypto.randomUUID()}` }); await refreshMot(); }
    catch (cause) { error(`检查结果未确认：${cause.message}。请刷新状态核对。`); check.disabled = false; }
    return;
  }
  const simulate = event.target.closest("[data-simulate]");
  if (simulate) {
    if (!confirm("确认仅记录 PAPER 模拟？不会发生真实资金转账。")) return;
    simulate.disabled = true;
    try { await api(`/api/mot/tasks/${encodeURIComponent(simulate.dataset.simulate)}/simulate`, { idempotency_key: `app-paper-${crypto.randomUUID()}` }); await refreshMot(); }
    catch (cause) { error(`模拟结果未确认：${cause.message}。请刷新任务状态核对。`); simulate.disabled = false; }
    return;
  }
  const bill = event.target.closest("[data-merchant-bill]");
  if (bill) {
    try { state.merchantDetail = await api(`/api/merchant/bill?id=${encodeURIComponent(bill.dataset.merchantBill)}`); renderContext(); }
    catch (cause) { error(`账单读取失败：${cause.message}`); }
    return;
  }
  const merchantAction = event.target.closest("[data-merchant-action]");
  if (merchantAction) {
    try {
      if (merchantAction.dataset.merchantAction === "review") {
        const confirmed = $("merchant-confirm")?.checked === true;
        await api("/api/merchant/review", { revision: (state.merchantSummary || state.latestResult?.summary)?.revision, confirmed });
        state.merchantInsights = await api("/api/merchant/insights");
      } else if (merchantAction.dataset.merchantAction === "scenario") {
        state.merchantDelay = Number($("merchant-delay")?.value || 0);
      } else if (merchantAction.dataset.merchantAction === "import") {
        const file = $("merchant-import-file")?.files?.[0];
        if (!file || file.size > 950000) throw new Error("请选择小于 950KB 的 JSON 账单");
        await api("/api/merchant/import", JSON.parse(await file.text()));
        state.merchantDetail = null; state.merchantInsights = null;
      }
      state.merchantSummary = await api(`/api/merchant/ledger?delay=${state.merchantDelay}`); renderContext();
    } catch (cause) { error(`账单操作未完成：${cause.message}`); }
    return;
  }
  const button = event.target.closest("[data-decision][data-task]"); if (!button) return;
  if (!confirm(button.dataset.decision === "APPROVE" ? "确认批准这项 PAPER 模拟提案？这不会发生真实资金转账。" : "确认拒绝或关闭这项提案？")) return;
  button.disabled = true;
  try { await api(`/api/mot/tasks/${encodeURIComponent(button.dataset.task)}/approval`, { decision: button.dataset.decision }); await refreshMot(); }
  catch (cause) { error(`审批未确认：${cause.message}。请刷新任务状态核对。`); button.disabled = false; }
};
$("open-sidebar").onclick = () => { $("sidebar").classList.add("open"); $("mobile-shade").classList.add("show"); };
$("close-sidebar").onclick = closeOverlays;
$("open-context").onclick = () => { state.selectedTeam = null; state.tab = "tasks"; renderContext(); $("context-panel").classList.add("open"); $("mobile-shade").classList.add("show"); };
$("close-context").onclick = closeOverlays;
$("mobile-shade").onclick = closeOverlays;
let recognizer = null;
$("dictate").onclick = () => {
  const Recognition = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!Recognition) { $("voice-status").textContent = "此浏览器不支持语音听写，请直接输入文字。"; return; }
  try {
    recognizer = new Recognition(); recognizer.lang = "zh-CN"; recognizer.continuous = true; recognizer.interimResults = true;
    const original = $("prompt").value;
    recognizer.onresult = event => {
      let final = "", interim = "";
      for (let index = event.resultIndex; index < event.results.length; index++) {
        const text = event.results[index][0]?.transcript || "";
        if (event.results[index].isFinal) final += text; else interim += text;
      }
      if (final) { $("prompt").value = [$("prompt").value, final].filter(Boolean).join(" "); }
      $("voice-status").textContent = interim ? `识别中：${interim} · 完成后请核对再发送` : "转写已填入输入框，请修改和核对后再发送。";
    };
    recognizer.onerror = event => { $("voice-status").textContent = `听写未完成：${event.error}。可以直接输入文字。`; };
    recognizer.onend = () => { $("dictate").hidden = false; $("stop-dictate").hidden = true; recognizer = null; };
    recognizer.start(); $("dictate").hidden = true; $("stop-dictate").hidden = false;
    $("voice-status").textContent = "正在听写；结果只填入输入框，不会自动发送。";
  } catch { $("voice-status").textContent = "无法启动听写，请使用文字输入。"; }
};
$("stop-dictate").onclick = () => recognizer?.stop();
$("stop-message").onclick = () => state.pendingController?.abort();
$("attach").onclick = () => { $("voice-status").textContent = "通用附件分析服务未接通。当前可在文字中描述内容；请勿把附件当作已读取。"; };
$("call-mot").onclick = () => { state.selectedTeam = null; state.tab = "settings"; renderContext(); $("context-panel").classList.add("open"); $("mobile-shade").classList.add("show"); $("voice-status").textContent = "实时通话服务未接通。可使用语音听写，把转写核对后发给同一 MOT 对话。"; };
addEventListener("popstate", () => { state.viewEpoch++; state.pendingKey = null; state.pendingText = null; bootstrap().catch(cause => error(`页面恢复失败：${cause.message}`)); });
bootstrap().catch(cause => error(`应用未能连接后端：${cause.message}`));
setInterval(refreshMot, 60_000);
