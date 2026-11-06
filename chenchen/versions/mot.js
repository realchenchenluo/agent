const $ = id => document.getElementById(id);
const escapeHtml = value => String(value ?? "").replace(/[&<>"']/g, char => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]);
const amount = minor => minor === null || minor === undefined ? "待核对" : `¥${(minor / 100).toLocaleString("zh-CN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const time = value => value ? new Date(value).toLocaleString("zh-CN", { hour12: false }) : "未知";
const empty = label => `<p class="mot-empty">${escapeHtml(label)}</p>`;
let current = null;
function findingText(task) {
  const finding = task.evidence?.find(row => row.finding)?.finding || {};
  if (task.kind === "FUNDING_SHORTFALL") return `已知七日付款 ${amount(finding.due_minor)}；池内可用 ${amount(finding.available_minor)}；缺口 ${amount(finding.shortfall_minor)}。`;
  if (task.kind === "SETTLEMENT_MISMATCH") return `收银记录 ${amount(finding.expected_minor)}，已结算 ${amount(finding.settled_minor)}；请核对 ${finding.source_transaction_id || "来源流水"}。`;
  if (task.kind === "SUSPECT_DUPLICATE") return `同分钟同金额收款：${finding.first || "?"} 与 ${finding.second || "?"}。`;
  if (task.kind === "BALANCE_UNKNOWN") return "资金池余额快照过期或缺失，请重新核对。";
  if (task.kind === "RESERVATION_PROPOSAL") return `拟议模拟占用 ${amount(task.proposal?.amount_minor)}；尚未得到可信 Core/Risk 与本人审批。`;
  return "需要核对任务证据。";
}

async function api(route, body) {
  const response = await fetch(`/api/mot/${route}`, { method: body === undefined ? "GET" : "POST",
    credentials: "same-origin", headers: body === undefined ? {} : { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body) });
  let data;
  try { data = await response.json(); } catch { throw new Error(`HTTP ${response.status}：后端未返回 JSON`); }
  if (!response.ok) throw new Error(`${data.error?.code || `HTTP ${response.status}`}`);
  return data;
}

function render(items) {
  const { overview, stores, accounts, transactions, alerts, tasks, runs, audit, health } = items;
  current = items;
  $("mot-check").disabled = false;
  $("mot-health").textContent = `MOT ${health.status} · ${health.persistence}`;
  $("mot-total").textContent = amount(overview.total_verified_minor);
  $("mot-available").textContent = amount(overview.available_minor);
  $("mot-asof").textContent = `余额快照：${overview.balance_fresh ? "新鲜" : "待核对"} · ${time(overview.as_of)}`;
  $("mot-scope").textContent = `资金池 ${overview.pool_account_ids.length} 个账户；已预留 ${amount(overview.reserved_minor)}。待结算收入未计入净可用额。`;
  $("mot-metrics").innerHTML = [["门店", overview.stores], ["收银机", overview.terminals], ["账户", overview.accounts],
    ["待结算", amount(overview.pending_settlement_minor)]].map(([label, value]) =>
    `<div class="mot-metric"><strong>${escapeHtml(value)}</strong><span>${escapeHtml(label)}</span></div>`).join("");
  $("mot-stores").innerHTML = stores.length ? stores.map(row => `<div class="mot-item"><strong>${escapeHtml(row.name)}</strong><small>${escapeHtml(row.store_id)} · ${escapeHtml(row.source_system)}</small></div>`).join("") : empty("尚无门店。请在本机加载合成样本。");
  $("mot-accounts").innerHTML = accounts.length ? accounts.map(row => `<div class="mot-item"><strong>${escapeHtml(row.name)} · ${amount(row.balance_minor)}</strong><small>${escapeHtml(row.account_id)} · ${row.pool ? "资金池账户" : "非资金池账户"} · 快照 ${time(row.as_of)}</small></div>`).join("") : empty("尚无已核对账户快照。");
  $("mot-alerts").innerHTML = alerts.length ? alerts.slice().reverse().map(row => { const task = tasks.find(item => item.task_id === row.task_id); return `<div class="mot-item"><strong>${escapeHtml(task?.kind || "任务提醒")} · ${escapeHtml(row.status)}</strong><small>${escapeHtml(task ? findingText(task) : "任务详情待读取")}</small><small>任务 ${escapeHtml(row.task_id)} · ${time(row.updated_at)}</small></div>`; }).join("") : empty("当前没有站内提醒。");
  $("mot-tasks").innerHTML = tasks.length ? tasks.slice().reverse().map(row => `<div class="mot-item"><strong>${escapeHtml(row.kind)}</strong><span class="mot-state ${row.state === "BLOCKED" ? "blocked" : row.state === "UNKNOWN" ? "unknown" : ""}">${escapeHtml(row.state)}</span><small>${escapeHtml(findingText(row))}</small><small class="mot-proof">${escapeHtml(row.task_id)} · 更新 ${time(row.updated_at)} · Core/Risk ${escapeHtml(row.review?.status || "UNAVAILABLE")}</small>${row.state === "PENDING_APPROVAL" ? `<button type="button" data-reject="${escapeHtml(row.task_id)}" class="secondary">拒绝模拟安排</button><button type="button" data-approve="${escapeHtml(row.task_id)}">批准模拟安排</button>` : ""}${row.state === "BLOCKED" || row.state === "UNKNOWN" ? `<button type="button" data-reject="${escapeHtml(row.task_id)}" class="secondary">关闭这项提议</button>` : ""}${row.approval?.decision === "APPROVE" && row.state === "PENDING_APPROVAL" ? `<button type="button" data-simulate="${escapeHtml(row.task_id)}">记录 PAPER 模拟</button>` : ""}${row.simulation ? `<small>模拟回执 ${escapeHtml(row.simulation.receipt_id)} · 无真实资金变动</small>` : ""}</div>`).join("") : empty("尚无任务。定时检查或手动检查会生成异常任务。");
  $("mot-runs").innerHTML = runs.length ? runs.slice(-5).reverse().map(row => `<div class="mot-item"><strong>${escapeHtml(row.result.trigger)} · ${row.result.findings} 项发现</strong><small>${time(row.result.at)} · 新收款 ${row.result.new_receipts} · 新付款 ${row.result.new_payments} · ${escapeHtml(row.result.check_id)}</small></div>`).join("") : empty("尚无自动或手动检查记录。");
  $("mot-last-run").textContent = runs.length ? `最近检查：${time(runs.at(-1).result.at)}` : "尚无检查记录";
  $("mot-audit").innerHTML = audit.length ? audit.slice(-20).reverse().map(row => `<div class="mot-item"><strong>${escapeHtml(row.event_type)}</strong><small>${time(row.at)} · ${escapeHtml(row.task_id || "全局")} · ${escapeHtml(row.audit_id)}</small></div>`).join("") : empty("尚无审计事件。");
  $("mot-transactions").innerHTML = transactions.length ? `<table class="mot-table"><thead><tr><th>时间</th><th>门店／收银机</th><th>来源流水</th><th>类型</th><th>金额</th><th>状态</th><th>账户</th></tr></thead><tbody>${transactions.slice().reverse().map(row => `<tr><td>${time(row.occurred_at)}</td><td>${escapeHtml(row.store_id || "—")} / ${escapeHtml(row.terminal_id || "—")}</td><td>${escapeHtml(row.source_system)}:${escapeHtml(row.external_transaction_id)}</td><td>${escapeHtml(row.transaction_type)}</td><td>${amount(row.amount_minor)}</td><td>${escapeHtml(row.status)}</td><td>${escapeHtml(row.account_id)}</td></tr>`).join("")}</tbody></table>` : empty("尚无业务流水。待结算流水不会自动计入可用余额。");
  $("mot-seed").hidden = health.mode !== "LOCAL_DEMO" || overview.stores > 0;
}

async function load() {
  $("mot-error").hidden = true;
  try {
    const [health, overview, stores, accounts, transactions, alerts, tasks, runs, audit] = await Promise.all([
      api("health"), api("overview"), api("stores"), api("accounts"), api("transactions"),
      api("alerts"), api("tasks"), api("runs"), api("audit")]);
    render({ health, overview, stores: stores.items, accounts: accounts.items,
      transactions: transactions.items, alerts: alerts.items, tasks: tasks.items,
      runs: runs.items, audit: audit.items });
  } catch (error) { current = null; $("mot-seed").hidden = true; $("mot-check").disabled = true;
    $("mot-error").textContent = `MOT 数据不可用：${error.message}`; $("mot-error").hidden = false; }
}

async function action(run) {
  $("mot-error").hidden = true;
  try { await run(); await load(); }
  catch (error) { $("mot-error").textContent = `操作未完成：${error.message}。请刷新任务状态后核对。`; $("mot-error").hidden = false; }
}

$("mot-seed").onclick = () => action(async () => { await api("demo/ingest", { idempotency_key: "mot-demo-v1" }); await api("check", { idempotency_key: `demo-first-${crypto.randomUUID()}` }); });
$("mot-check").onclick = () => action(() => api("check", { idempotency_key: `manual-${crypto.randomUUID()}` }));
$("mot-refresh").onclick = load;
$("mot-tasks").onclick = event => {
  const button = event.target.closest("button[data-reject],button[data-approve],button[data-simulate]");
  if (!button) return;
  const taskId = button.dataset.reject || button.dataset.approve || button.dataset.simulate;
  if (!current?.tasks.some(row => row.task_id === taskId)) return;
  if (button.dataset.reject) action(() => api(`tasks/${encodeURIComponent(taskId)}/approval`, { decision: "REJECT" }));
  if (button.dataset.approve) action(() => api(`tasks/${encodeURIComponent(taskId)}/approval`, { decision: "APPROVE" }));
  if (button.dataset.simulate) action(() => api(`tasks/${encodeURIComponent(taskId)}/simulate`, { idempotency_key: `paper-${crypto.randomUUID()}` }));
};
load();
setInterval(load, 60_000);
