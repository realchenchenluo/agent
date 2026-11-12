// These are UI projections of existing contracts, never authorization decisions.
export function taskView(record, { expectedTaskId = null, source = "同源 Backend", stale = false } = {}) {
  if (!record || typeof record !== "object" || Array.isArray(record)) throw new Error("INVALID_TASK_RESPONSE");
  const health = Boolean(record.task_state);
  if (!health && record.workflow_version !== "review-workflow.v1") throw new Error("UNSUPPORTED_TASK_CONTRACT");
  const state = health ? record.task_state : record;
  const taskId = state.task_id;
  if (typeof taskId !== "string" || !taskId || (expectedTaskId && expectedTaskId !== taskId)) throw new Error("TASK_CONTEXT_MISMATCH");
  for (const part of [record.trace, record.audit_evidence, record.audit, record.approval, record.execution, record.risk_handoff]) {
    if (part?.task_id && part.task_id !== taskId) throw new Error("TASK_CONTEXT_MISMATCH");
    for (const key of ["request_id", "session_id"]) {
      if (state[key] && part?.[key] && part[key] !== state[key]) throw new Error("TASK_CONTEXT_MISMATCH");
    }
  }
  const audit = record.audit_evidence || record.audit;
  if (audit?.events?.some(event => event.task_id && event.task_id !== taskId)) throw new Error("TASK_AUDIT_MISMATCH");
  const tools = Object.values(record.tool_results || {});
  const model = record.model?.model_response;
  const receipt = record.execution?.receipt;
  const hash = record.proposed_action?.proposal_sha256;
  const receiptValid = !health && record.execution_mode === "PAPER" && record.capability === "SIMULATION_ONLY" && state.status === "SIMULATED" && record.execution?.status === "SIMULATED" &&
    receipt?.mode === "SIMULATED" && receipt.side_effects === false && receipt.task_id === taskId &&
    Boolean(receipt.execution_id) && receipt.execution_id === record.execution.execution_id &&
    record.execution.execution_allowed === false && Boolean(hash) && record.plan_hash === hash &&
    receipt.proposal_sha256 === hash && Number.isFinite(Date.parse(receipt.completed_at));
  const approvalExpired = Boolean(record.approval?.expires_at && Date.parse(record.approval.expires_at) <= Date.now() && !receiptValid);
  const rows = [
    ["用户输入", state.request_id || record.request_id ? "已关联请求" : "UNKNOWN", "请求关联由 Backend 返回", "核对本任务编号"],
    ["Backend", state.status || "UNKNOWN", source, "可查询原任务；不自动重提"],
    ["Tools / Quant", tools.length ? tools.map(tool => tool.tool_name + " @ " + tool.version).join("；") : "NOT_PROVIDED", tools.length ? "服务端真实代码计算；固定虚构数据" : "本 Contract 未提供 Tools 证据", "核对工具版本、输入指纹和数据日期"],
    ["Risk", health ? (state.status === "HANDOFF_REQUIRED" ? "HANDOFF_REQUIRED · 只读交接" : "NOT_PROVIDED") : record.risk_decision?.decision || record.risk_handoff?.status || "UNKNOWN", health ? "健康检查；不等价于模型链路 PENDING_RISK" : "服务端 Risk 记录；页面不代填决策", "等待独立 Risk 正式回写"],
    ["Approval", approvalExpired ? "EXPIRED" : record.approval?.status || "NOT_PROVIDED", "本人身份、完整方案确认协议未联合验收。服务端原因：" + (record.approval?.reason || "NOT_PROVIDED"), "NO-GO · 等待审批 Owner 证据"],
    ["SIMULATED Receipt", receiptValid ? "SIMULATED · 服务端回执" : "NOT_EXECUTED · 未取得有效回执", receiptValid ? "Backend receipt；虚构模拟，未操作真实资金" : "不从任务状态、余额或按钮推测成功", "当前 UI 不发起执行"],
    ["Audit", audit?.events?.length ? audit.events.length + " 条服务端事件" : "NOT_PROVIDED", audit?.audit_id || "无服务端审计编号", "只读核对原始记录"]
  ].map(([step, status, origin, next]) => ({ step, status, source: origin, next }));
  return {
    kind: health ? "health" : "review", taskId, status: state.status || "UNKNOWN", stale, receiptValid,
    contract: record.contract_version || record.schema_version || state.contract_version || record.workflow_version || "NOT_PROVIDED",
    identifiers: { request_id: state.request_id || record.request_id || null, task_id: taskId, session_id: state.session_id || record.session_id || null,
      run_id: record.run_id || null, audit_id: audit?.audit_id || null, handoff_id: record.risk_handoff?.handoff_id || null },
    model: health ? "NOT_CALLED · 此链路使用代码工具" : [model?.model || "NOT_PROVIDED", record.model?.source || "UNKNOWN",
      model?.call_succeeded === true ? "调用成功（服务端声明）" : model?.call_succeeded === false ? "调用失败" : "调用结果未明确声明", model?.provider_response_id || "无 provider_response_id"].join(" · "),
    versions: { data_mode: record.data_mode || (health ? "SYNTHETIC_REPLAY（健康检查演示）" : "NOT_PROVIDED"), portfolio_snapshot_id: record.portfolio_snapshot_id || record.artifacts?.portfolio_snapshot?.snapshot_id || null,
      data_as_of: record.artifacts?.portfolio_snapshot?.as_of || tools[0]?.data_as_of || null, plan_id: record.plan_id || null,
      plan_hash: record.plan_hash || hash || null, policy_version: record.policy_version || null,
      funding_revision: record.proposed_action?.funding?.revision ?? null, approval_expires_at: record.approval?.expires_at || null,
      last_server_event: audit?.events?.at(-1)?.timestamp || null, capability: record.capability || null,
      execution_allowed: record.execution?.execution_allowed ?? record.risk_handoff?.execution_allowed ?? null,
      simulation_allowed: record.execution?.simulation_allowed ?? null },
    reason: stale ? "输入或数据已变化；以下只保留历史证据，旧方案不得继续使用。" :
      record.error?.message || record.funding_check?.message || record.risk_decision?.reason || state.error_state?.message ||
      (receiptValid ? "SIMULATED 仅代表虚构模拟回执。" : "NO-GO · 正式 Risk、本人与任务绑定审批、共同 Staging 尚未联合验收。"),
    rows, tools, events: audit?.events || []
  };
}
