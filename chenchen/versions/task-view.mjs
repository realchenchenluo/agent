import { taskView } from "./task-state.mjs";
import { requestJson, pendingRequest } from "./task-client.mjs";
const escape = value => String(value ?? "NOT_PROVIDED").replace(/[&<>"']/g, ch => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[ch]));
const referenceKey = "ui-demo-p0-task-reference-v1";
export function mountTaskView({ client, resolveUrl = path => path }) {
  const box = document.createElement("section");
  box.className = "panel task-observer";
  box.id = "task-observer";
  box.setAttribute("aria-labelledby", "task-observer-title");
  box.innerHTML = '<h2 id="task-observer-title">同一任务 · 状态与来源</h2><p>Demo 主入口：投资健康检查。当前身份未联合验收；Risk、本人审批与模拟执行入口关闭。</p>' +
    '<p id="task-pending" class="notice" role="status"></p><form id="task-lookup"><label>查询链路<select id="task-kind"><option value="health">健康检查</option><option value="review">模型复核</option></select></label><label>原 task_id<input id="task-lookup-id" maxlength="200" required autocomplete="off"></label><button type="submit">查询原任务</button></form>' +
    '<div class="notice-actions"><button id="task-refresh" type="button" class="secondary" disabled>刷新当前任务</button><button id="task-stop-waiting" type="button" class="secondary">停止本页等待</button></div>' +
    '<p id="task-observer-message" role="status" aria-live="polite">尚无任务。读取后端后展示，不以本机记录代替服务端状态。</p><div id="task-observer-content"></div>';
  const anchor = document.querySelector("#input-panel") || document.querySelector(".hero");
  if (anchor) anchor.after(box); else document.querySelector("main").prepend(box);
  const $ = selector => box.querySelector(selector);
  let current = null, view = null, sequence = 0, reader = null;
  function pending() {
    const item = pendingRequest();
    $("#task-pending").textContent = item ? "结果未知的原请求：" + (item.request_id || "未取得编号") + "。刷新不会重提；请查询原任务，无法定位时联系 Backend Owner。" : "不自动重试请求；本机只保存任务编号，不保存身份、金额或审批。";
  }
  function show(record, { stale = false, source = new URL(resolveUrl("/"), location.href).origin + " · Backend 响应", fromLookup = false } = {}) {
    if (!fromLookup) { ++sequence; reader?.abort(); }
    view = taskView(record, { source, stale });
    current = record;
    if (!stale) client.reconcile(record);
    try { sessionStorage.setItem(referenceKey, JSON.stringify({ kind: view.kind, task_id: view.taskId })); } catch { /* Reference persistence is optional. */ }
    $("#task-kind").value = view.kind;
    $("#task-lookup-id").value = view.taskId;
    $("#task-refresh").disabled = false;
    $("#task-observer-message").textContent = view.reason;
    $("#task-observer-content").innerHTML = '<p class="tag">' + escape(view.status) + (stale ? ' · HISTORICAL' : '') + '</p><p>Contract：' + escape(view.contract) + '</p><dl class="task-identifiers">' +
      Object.entries(view.identifiers).map(([key, value]) => '<div><dt>' + key + '</dt><dd>' + escape(value) + '</dd></div>').join('') + '</dl><p class="task-model">模型：' + escape(view.model) + '</p><ol class="task-chain">' +
      view.rows.map(row => '<li><h3>' + escape(row.step) + '</h3><strong>' + escape(row.status) + '</strong><p>来源：' + escape(row.source) + '</p><p>下一步：' + escape(row.next) + '</p></li>').join('') +
      '</ol><details><summary>版本、数据日期和服务端时间戳</summary><pre>' + escape(JSON.stringify(view.versions, null, 2)) + '</pre></details><details><summary>Tools 原始计算证据</summary><pre>' + escape(JSON.stringify(view.tools, null, 2)) + '</pre></details><details><summary>服务端审计事件（只读）</summary><pre>' + escape(JSON.stringify(view.events, null, 2)) + '</pre></details>';
    pending();
  }
  async function lookup(kind, taskId) {
    const version = ++sequence;
    reader?.abort(); reader = new AbortController();
    $("#task-observer-message").textContent = "正在查询；历史证据暂不代表当前状态。";
    if (current) show(current, { stale: true, fromLookup: true });
    const prefix = kind === "review" ? "/api/review/task/" : "/api/task/";
    try {
      const record = await requestJson(resolveUrl(prefix + encodeURIComponent(taskId)), { signal: reader.signal, expectedTaskId: taskId });
      const validated = taskView(record, { expectedTaskId: taskId });
      if (validated.kind !== kind) throw new Error("TASK_CONTRACT_MISMATCH");
      if (version === sequence) show(record, { fromLookup: true });
    } catch (error) { if (version === sequence) $("#task-observer-message").textContent = error.message + " 当前读取未成功；不授予任何操作权限。"; }
  }
  $("#task-lookup").onsubmit = event => { event.preventDefault(); void lookup($("#task-kind").value, $("#task-lookup-id").value.trim()); };
  $("#task-refresh").onclick = () => { if (view) void lookup(view.kind, view.taskId); };
  $("#task-stop-waiting").onclick = () => { ++sequence; reader?.abort(); client.cancel(); $("#task-observer-message").textContent = "已停止本页等待；不能证明后端已取消，未知结果请查询原任务。"; pending(); };
  addEventListener("storage", pending);
  addEventListener("pagehide", () => { ++sequence; reader?.abort(); client.cancel(); });
  pending();
  try { const saved = JSON.parse(sessionStorage.getItem(referenceKey) || "null"); if (saved?.task_id && ["health", "review"].includes(saved.kind)) void lookup(saved.kind, saved.task_id); } catch { /* No stored response is trusted. */ }
  return { show, invalidate() { if (current) show(current, { stale: true }); }, message(text) { $("#task-observer-message").textContent = text; pending(); } };
}
