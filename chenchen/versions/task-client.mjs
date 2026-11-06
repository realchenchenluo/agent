export const pendingKey = "ui-demo-p0-pending-v1";
function browserStorage() { try { return globalThis.localStorage; } catch { return null; } }
export class RequestError extends Error {
  constructor(code, message, payload = null, status = null) { super(message); Object.assign(this, { code, payload, status }); }
}
const statusCopy = { 401: "登录或服务身份未验证", 403: "权限不足或任务归属不符", 409: "任务、方案或数据版本冲突", 423: "任务已锁定", 503: "服务不可用" };
export async function requestJson(url, { body, signal, timeoutMs = 15000, fetcher = globalThis.fetch, expectedTaskId } = {}) {
  const controller = new AbortController();
  let timedOut = false;
  const abort = () => controller.abort();
  signal?.addEventListener("abort", abort, { once: true });
  if (signal?.aborted) controller.abort();
  const timer = setTimeout(() => { timedOut = true; controller.abort(); }, timeoutMs);
  try {
    const response = await fetcher(url, { method: body === undefined ? "GET" : "POST", signal: controller.signal, cache: "no-store",
      headers: { Accept: "application/json", ...(body === undefined ? {} : { "Content-Type": "application/json" }),
        ...(body?.idempotency_key ? { "Idempotency-Key": body.idempotency_key } : {}) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    let data;
    try { data = await response.json(); } catch (error) {
      if (controller.signal.aborted) throw error;
      if (!response.ok) throw new RequestError("HTTP_" + response.status, (statusCopy[response.status] || "请求失败") + "（HTTP " + response.status + "）；未返回有效错误信封。", null, response.status);
      throw new RequestError("INVALID_RESPONSE", "后端返回格式错误；结果未知，请查询原任务。");
    }
    if (!data || typeof data !== "object" || Array.isArray(data)) throw new RequestError("INVALID_RESPONSE", "后端未返回有效对象；结果未知。");
    if (!response.ok) throw new RequestError(data.error?.code || "HTTP_" + response.status,
      (statusCopy[response.status] || "请求失败") + "（HTTP " + response.status + "）。" + (data.error?.recovery || "请核对原任务，不会自动重试。"), data, response.status);
    const actualId = data.task_id || data.task_state?.task_id;
    if (expectedTaskId && actualId !== expectedTaskId) throw new RequestError("TASK_CONTEXT_MISMATCH", "返回了其他任务；已停止展示。");
    return data;
  } catch (error) {
    if (error instanceof RequestError) throw error;
    throw new RequestError(timedOut ? "TIMEOUT" : signal?.aborted ? "CANCELLED" : "NETWORK_ERROR",
      (timedOut ? "请求超时" : signal?.aborted ? "已停止本页等待" : "网络中断") + "；后端结果可能未知，不代表任务已取消。请查询原任务，勿重复提交。");
  } finally { clearTimeout(timer); signal?.removeEventListener("abort", abort); }
}
export function pendingRequest(storage = browserStorage()) {
  try { return JSON.parse(storage.getItem(pendingKey) || "null"); } catch { return { unreadable: true }; }
}
export class TaskClient {
  constructor({ storage = browserStorage(), locks = globalThis.navigator?.locks, fetcher = globalThis.fetch } = {}) {
    Object.assign(this, { storage, locks, fetcher, busy: false, controller: null });
  }
  cancel() { this.controller?.abort(); }
  async request(url, body) {
    const path = new URL(url, "http://localhost").pathname;
    if (body === undefined) return requestJson(url, { fetcher: this.fetcher,
      expectedTaskId: path.startsWith("/api/review/task/") ? decodeURIComponent(path.slice("/api/review/task/".length)) : undefined });
    if (!["/api/review", "/api/health-check/run", "/api/risk-workbench/handoff", "/api/funding-demo/plan", "/api/funding-demo/plan/revise"].includes(path)) {
      throw new RequestError("UI_ACTION_BLOCKED", "当前 UI 仅提供分析、查询和虚构计划输入；可信 Risk、审批与执行尚未验收。");
    }
    if (this.busy) throw new RequestError("REQUEST_IN_PROGRESS", "本页请求正在进行，请勿重复点击。");
    if (!this.storage?.setItem) throw new RequestError("PERSISTENCE_UNAVAILABLE", "浏览器不能保存结果未知的请求编号；已禁用提交，请检查浏览器存储设置。");
    if (!this.locks?.request) throw new RequestError("LOCK_UNAVAILABLE", "浏览器不支持跨标签页互斥；已禁用提交，请使用本机 Chrome 或 Edge 安全上下文。");
    this.busy = true;
    try {
      return await this.locks.request("ui-demo-p0-writes", { ifAvailable: true }, async lock => {
        if (!lock) throw new RequestError("OTHER_TAB_BUSY", "另一标签页正在请求；请返回原页面核对。");
        if (pendingRequest(this.storage)) throw new RequestError("UNRESOLVED_REQUEST", "存在结果未知的原请求；请先查询原任务或联系 Backend Owner，禁止自动重提。");
        const requestId = body.request_id || body.request?.request_id || null;
        this.storage.setItem(pendingKey, JSON.stringify({ path, request_id: requestId, started_at: new Date().toISOString() }));
        this.controller = new AbortController();
        try {
          const data = await requestJson(url, { body, signal: this.controller.signal, fetcher: this.fetcher });
          const receivedId = data.request_id || data.agent_response?.request_id;
          if (requestId && receivedId !== requestId) throw new RequestError("REQUEST_CONTEXT_MISMATCH", "响应请求编号不一致；结果未知，请查询原任务。");
          this.storage.removeItem(pendingKey);
          return data;
        } catch (error) {
          // Only explicit precondition failures are safe to clear. Never retry ambiguous writes.
          if ([400, 401, 403, 404, 413, 422, 423].includes(error.status)) this.storage.removeItem(pendingKey);
          throw error;
        } finally { this.controller = null; }
      });
    } finally { this.busy = false; }
  }
  reconcile(record) {
    const pending = pendingRequest(this.storage);
    const requestId = record.request_id || record.task_state?.request_id;
    if (pending?.request_id && pending.request_id === requestId && (record.task_id || record.task_state?.task_id)) this.storage.removeItem(pendingKey);
  }
}
