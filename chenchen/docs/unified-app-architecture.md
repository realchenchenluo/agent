# AI Banking 单入口候选

基线 `origin/main` 为 `ced1ccad50319ba69385d7cbbe9c12114c840062`；本分支建立在 MOT Draft PR #8 之上。UI PR #7 仍未合并，本分支不覆盖其资产。线上 `personal-ai-fund-chat`、Node `chenchen/server.js` 和 MOT Staging Worker 是不同服务；正式聊天域名不随本分支自动更新。

```mermaid
flowchart LR
  B[单入口 /app 聊天与侧栏] --> A[/api/app 会话与工具路由 app.v1]
  A --> M[MOT Ledger + Scheduler + Inbox + Audit]
  A --> C[MerchantSession 账单与现金测算]
  A --> I[Investment financial-tools 固定样本]
  A --> R[Core/Risk 状态门禁]
  B --> D[同页详情面板]
  M --> D
```

## 审计与职责

| 旧页面 | 原 API / 状态 | 统一入口现状 |
|---|---|---|
| `/mot` | `/api/mot/*`；服务端按 owner 持久化任务、Inbox、账本、审计 | 重定向 `/app?agent=mot`；聊天卡片及详情面板读同一 MOT 后端，手动检查和审批仍调用原 API |
| `/merchant` | `/api/merchant/*`；进程内 `merchant_session` Cookie | 重定向 `/app?agent=merchant`；本机查询、账单来源、人工确认提醒、到账测算、导入导出在同页；会话账本仍是旧模块的进程内状态 |
| `/investment` | `/api/demo/portfolio`、`/api/health-check/run`、`/api/audit/*`；固定样本 | 重定向 `/app?agent=investment`；现接入持仓快照与确定性诊断摘要；完整旧报告、偏好输入与模拟对比尚未迁入聊天卡片 |
| `/risk-workbench` | `/api/review/*`、`/api/risk-workbench/handoff`；部分浏览器演示身份 | 重定向 `/app?agent=risk`；只展示 MOT 审批门禁与证据，未接通可信本人审批时返回 `UNAVAILABLE`，不沿用旧页的模拟 reviewer 身份 |
| 公网主聊天 | 独立 Worker，SoT main 未含其现行页面源码 | 需要单独接入同一部署链；此候选只在 Node 本地与隔离 MOT Staging Worker 运行 |

## 契约、身份与恢复

- `GET /api/app/bootstrap`：Agent 节点状态与 owner 归属的会话目录。
- `GET /api/app/context/mot`：实时 MOT 状态、资金、任务、Inbox、审计；下一次检查只在本机调度器存在时显示。
- `POST /api/app/conversations`、`GET /api/app/conversations/:id`、`POST /api/app/conversations/:id/messages`：`app.v1`，`request_id` 幂等。消息格式见 `contracts/app-message.v1.schema.json`。
- Node 本机以 MOT 的 `LOCAL_DEMO` owner 保护 `/api/app/*`，对话写入独立 owner 文件，原子替换且有进程内单写队列；MOT 账本保留原仓库，互不充当权威来源。
- Staging 复用 MOT 的 token 身份和同一个 `ReviewService` Durable Object；前端只用 HttpOnly、Secure、SameSite Cookie。Worker 验证 Cookie 后在服务端注入 MOT token，浏览器 JS 不接收 API token。Staging 口令只保护合成演示 owner，不能当作生产本人身份体系。
- 服务端发送结构化消息，包含 `conversation_id`、`agent_id`、`task_id`、`message_type`、`status`、`source`、`as_of`、`tool_results`、`actions`、`audit_ref`。确定性工具路由不冒充通用 LLM。
- 流水、余额、待结算、审计来自 MOT Ledger；Merchant 数据来自原账本；Investment 使用固定样本。Core/Risk 缺少可信商户接线时，转账请求明确 `BLOCKED`，不创建执行成功回执。

## 部署和回退

Staging 配置仅更新 `personal-ai-fund-manager-mot-staging`。新口令与 Cookie 签名密钥以 Worker Secret 保存；不修改正式域名、正式 Worker 或生产 Secrets。回退到此前 Worker 版本即可恢复旧 Staging API 入口；MOT 与 app 会话存在同一个 Durable Object 内的不同 key 前缀，回退不删除数据。Node 回退只需切换 Git 分支，`/app` 会话文件不会改变 MOT Ledger。

## 未完成的生产接线

公网主聊天的源码/部署版本与本候选尚未统一。云端 Merchant 账本仍 `UNAVAILABLE`；Investment 云端为固定演示样本；Core/Risk 的商户本人审批仍 `UNAVAILABLE`。Staging 演示口令映射到一个合成 owner，尚无面向真实用户的登录、角色和跨服务身份联邦。旧 UI PR #7 的任务视图与本分支应逐项合并测试，不能自动覆盖。
