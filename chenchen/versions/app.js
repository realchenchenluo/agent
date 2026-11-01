const $ = id => document.getElementById(id);
const esc = value => String(value ?? "").replace(/[&<>"']/g, char => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]);
const money = minor => minor == null ? "待核对" : `¥${(minor / 100).toLocaleString("zh-CN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const time = value => value ? new Date(value).toLocaleString("zh-CN", { hour12: false }) : "未知";
const names = { mot: "MOT · Treasury Agent", merchant: "店主财务助手", investment: "持仓分析", risk: "风险审核" };
const state = { agent: "mot", conversation: null, conversations: [], agents: [], mot: null, tab: "treasury", selectedTask: null, pendingKey: null, latestResult: null, merchantSummary: null, merchantDetail: null, merchantInsights: null, merchantDelay: 0 };

async function api(path, body) {
  const response = await fetch(path, { method: body === undefined ? "GET" : "POST", credentials: "same-origin",
    headers: body === undefined ? {} : { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body) });
  let data;
  try { data = await response.json(); } catch { throw new Error(`HTTP ${response.status}：后端未返回 JSON`); }
  if (!response.ok) throw new Error(data.error?.code || `HTTP ${response.status}`);
  return data;
}
function error(value) { $("global-error").textContent = value; $("global-error").hidden = !value; }
function url(agent = state.agent, conversation = state.conversation?.conversation_id) {
  const next = new URL("/app", location.origin);
  next.searchParams.set("agent", agent);
  if (conversation) next.searchParams.set("conversation", conversation);
  history.pushState({}, "", next);
}
function closeOverlays() { $("sidebar").classList.remove("open"); $("context-panel").classList.remove("open"); $("mobile-shade").classList.remove("show"); }
function renderNav() {
  $("agents").innerHTML = state.agents.map(agent => `<button type="button" class="${state.agent === agent.agent_id ? "active" : ""}" data-agent="${esc(agent.agent_id)}"><span class="agent-icon">${agent.agent_id === "mot" ? "◉" : "○"}</span><strong>${esc(agent.name)}</strong><small>${esc(agent.agent_id === "mot" ? `${agent.status} · ${agent.unresolved_count} 项待处理` : agent.status)}</small></button>`).join("");
  const term = $("history-search").value.trim().toLowerCase();
  $("history").innerHTML = state.conversations.filter(item => `${item.title} ${item.agent_id}`.toLowerCase().includes(term)).map(row => `<button type="button" data-conversation="${esc(row.conversation_id)}" class="${state.conversation?.conversation_id === row.conversation_id ? "active" : ""}">${esc(row.title)}</button>`).join("") || `<p class="muted" style="padding:0 12px">尚无对话</p>`;
  $("agent-title").textContent = names[state.agent] || "AI Banking";
  const mot = state.agents.find(item => item.agent_id === "mot");
  $("agent-subtitle").textContent = state.agent === "mot" ? `监测 ${mot?.status || "未知"} · 最近检查 ${time(mot?.last_check_at)}` : state.agent === "risk" ? "审批状态以服务端记录为准" : "所有数据来自现有后端工具";
  $("context-title").textContent = names[state.agent] || "Agent 详情";
  $("prompt").placeholder = `向${state.agent === "mot" ? " MOT" : " " + (names[state.agent] || "Agent")}提问或安排任务…`;
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
  if (kind === "risk") return `<div class="result-card"><div class="card-top">Core / Risk</div><span class="card-status">${esc(result.status)}</span><p class="danger-text">当前无法确认本人审批或模拟执行。</p></div>`;
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
  $("conversation").innerHTML = rows.length ? rows.map(row => row.message_type === "user" ? `<div class="message user"><div class="bubble">${esc(row.text)}</div></div>` : `<div class="message assistant"><div class="speaker"><span class="mini-icon">◎</span>${esc(names[row.agent_id] || "AI Banking")}</div><p>${esc(row.text)}</p>${(row.tool_results || []).map(card).join("")}${(row.actions || []).map(action => `<button type="button" class="action-link" data-open-context="${esc(action.target)}">${esc(action.label)}</button>`).join("")}<div class="meta">${esc(row.status)} · ${esc(row.source)} · ${time(row.as_of)}${row.audit_ref ? ` · 审计 ${esc(row.audit_ref)}` : ""}</div></div>`).join("") : `<div class="welcome"><span class="welcome-mark">◎</span><h1>${state.agent === "mot" ? "两家店的钱，随时可查。" : "今天想先看什么？"}</h1><p>在同一个聊天窗口查看资金、账单、持仓和任务。数字、状态与证据来自后端。</p><div><button type="button" class="secondary-action" data-suggestion="检查两家门店资金情况">检查门店资金</button><button type="button" class="secondary-action" data-suggestion="查看当前监测任务">查看监测任务</button></div></div>`;
  $("conversation-scroll").scrollTop = $("conversation-scroll").scrollHeight;
  renderContext();
}
function taskEvidence(task) {
  return `<div class="context-item"><strong>${esc(task.kind)} <span class="pill ${task.state === "BLOCKED" || task.state === "UNKNOWN" ? "blocked" : ""}">${esc(task.state)}</span></strong><small>任务 ${esc(task.task_id)} · 更新 ${time(task.updated_at)}</small><small>Core/Risk ${esc(task.review?.status || "UNAVAILABLE")} · 账本版本 ${esc(task.ledger_revision)}</small><details><summary>执行证据与审计</summary><pre>${esc(JSON.stringify({ evidence: task.evidence, approval: task.approval, review: task.review, simulation: task.simulation }, null, 2))}</pre></details>${task.state === "PENDING_APPROVAL" ? `<button type="button" class="secondary-action" data-decision="REJECT" data-task="${esc(task.task_id)}">拒绝提案</button>${task.approval?.decision !== "APPROVE" ? `<button type="button" class="secondary-action" data-decision="APPROVE" data-task="${esc(task.task_id)}">批准 PAPER 提案</button>` : `<button type="button" class="secondary-action" data-simulate="${esc(task.task_id)}">记录 PAPER 模拟</button>`}` : ""}${task.state === "BLOCKED" ? `<button type="button" class="secondary-action" data-decision="REJECT" data-task="${esc(task.task_id)}">关闭被阻断提案</button>` : ""}</div>`;
}
function renderContext() {
  const body = $("context-body");
  if (state.agent === "mot" || state.agent === "risk") {
    const ctx = state.mot;
    if (!ctx) { body.innerHTML = `<p class="muted">MOT 状态不可用。请重试读取后端。</p>`; return; }
    $("context-tabs").hidden = false;
    $("context-tabs").querySelectorAll("button").forEach(button => button.classList.toggle("active", button.dataset.tab === state.tab));
    if (state.tab === "treasury") body.innerHTML = `<section class="context-section"><h3>运行状态</h3><div class="context-item"><strong>${esc(ctx.status)} · ${ctx.unresolved_count} 项未解决</strong><small>上次检查 ${time(ctx.last_check_at)}${ctx.next_check_at ? ` · 下次计划 ${time(ctx.next_check_at)}` : ""}</small><small>Core/Risk ${esc(ctx.core_risk)} · 资金操作禁用</small></div></section><section class="context-section"><h3>账户与资金池</h3>${ctx.accounts.map(row => `<div class="context-item"><strong>${esc(row.name)} · ${money(row.balance_minor)}</strong><small>${esc(row.account_id)} · ${row.pool ? "资金池" : "非资金池"} · 快照 ${time(row.as_of)}</small></div>`).join("") || `<p class="muted">尚无已核对账户。</p>`}</section><section class="context-section"><h3>近期流水</h3>${ctx.transactions.slice(-12).reverse().map(row => `<div class="context-item"><strong>${esc(row.transaction_type)} · ${money(row.amount_minor)}</strong><small>${esc(row.source_system)}:${esc(row.external_transaction_id)} · ${esc(row.status)}</small><small>${esc(row.store_id || "—")} / ${esc(row.terminal_id || "—")} · ${time(row.occurred_at)}</small></div>`).join("") || `<p class="muted">暂无流水。</p>`}</section>`;
    else if (state.tab === "tasks") body.innerHTML = `<section class="context-section"><h3>Inbox · ${ctx.inbox.length} 条</h3>${ctx.inbox.slice(-10).reverse().map(row => `<div class="context-item"><strong>${esc(row.status)}</strong><small>任务 ${esc(row.task_id)} · ${time(row.updated_at)}</small></div>`).join("") || `<p class="muted">暂无提醒。</p>`}</section><section class="context-section"><h3>任务时间线</h3>${ctx.tasks.slice().reverse().map(taskEvidence).join("") || `<p class="muted">暂无任务。</p>`}</section>`;
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
    renderNav(); renderContext();
  } catch (cause) { error(`MOT 数据读取失败：${cause.message}`); }
}
async function bootstrap() {
  const data = await api("/api/app/bootstrap");
  state.mode = data.mode; state.agents = data.agents; state.conversations = data.conversations;
  const params = new URLSearchParams(location.search);
  const selected = params.get("agent");
  state.agent = names[selected] ? selected : "mot";
  const id = params.get("conversation");
  if (id) await openConversation(id, false); else { state.conversation = null; renderNav(); renderConversation(); }
  await refreshMot();
}
async function openConversation(id, changeUrl = true) {
  const row = await api(`/api/app/conversations/${encodeURIComponent(id)}`);
  state.conversation = row; state.agent = row.agent_id;
  if (changeUrl) url(row.agent_id, id);
  error(""); renderNav(); renderConversation(); closeOverlays();
}
async function selectAgent(agent) {
  if (!names[agent]) return;
  state.agent = agent; state.conversation = null; state.latestResult = null; state.tab = agent === "risk" ? "tasks" : "treasury";
  url(agent, null); renderNav(); renderConversation(); closeOverlays();
}
async function sendText(text) {
  if (!text.trim()) return;
  error(""); $("send").disabled = true;
  const key = state.pendingKey || crypto.randomUUID(); state.pendingKey = key;
  try {
    if (!state.conversation) {
      const created = await api("/api/app/conversations", { agent_id: state.agent, request_id: crypto.randomUUID() });
      state.conversation = created; url(state.agent, created.conversation_id);
    }
    await api(`/api/app/conversations/${encodeURIComponent(state.conversation.conversation_id)}/messages`, { text, request_id: key });
    state.pendingKey = null; $("prompt").value = "";
    const data = await api("/api/app/bootstrap"); state.conversations = data.conversations;
    await openConversation(state.conversation.conversation_id, false);
    await refreshMot();
  } catch (cause) { error(`消息结果未确认：${cause.message}。先刷新会话；若未记录，可用相同内容重试。`); }
  finally { $("send").disabled = false; $("prompt").focus(); }
}

$("composer").addEventListener("submit", event => { event.preventDefault(); sendText($("prompt").value); });
$("prompt").addEventListener("keydown", event => { if (event.key === "Enter" && !event.shiftKey && !event.isComposing) { event.preventDefault(); $("composer").requestSubmit(); } });
$("new-chat").onclick = () => selectAgent(state.agent);
$("history-search").oninput = renderNav;
$("agents").onclick = event => { const button = event.target.closest("[data-agent]"); if (button) selectAgent(button.dataset.agent); };
$("history").onclick = event => { const button = event.target.closest("[data-conversation]"); if (button) openConversation(button.dataset.conversation).catch(cause => error(cause.message)); };
$("conversation").onclick = event => {
  const suggestion = event.target.closest("[data-suggestion]"); if (suggestion) { $("prompt").value = suggestion.dataset.suggestion; $("prompt").focus(); }
  const action = event.target.closest("[data-open-context]"); if (action) { state.tab = action.dataset.openContext === "tasks" ? "tasks" : "treasury"; renderContext(); $("context-panel").classList.add("open"); $("mobile-shade").classList.add("show"); }
};
$("context-tabs").onclick = event => { const button = event.target.closest("[data-tab]"); if (button) { state.tab = button.dataset.tab; renderContext(); } };
$("context-body").onclick = async event => {
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
$("open-context").onclick = () => { $("context-panel").classList.add("open"); $("mobile-shade").classList.add("show"); };
$("close-context").onclick = closeOverlays;
$("mobile-shade").onclick = closeOverlays;
addEventListener("popstate", () => bootstrap().catch(cause => error(`页面恢复失败：${cause.message}`)));
bootstrap().catch(cause => error(`应用未能连接后端：${cause.message}`));
setInterval(refreshMot, 60_000);
