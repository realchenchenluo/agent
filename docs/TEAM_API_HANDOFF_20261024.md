# Personal AI Fund Manager：队友模型 API 接入交接

更新：2026-10-24。此分支从公开仓库 `main` 单独创建，只纳入公开聊天 Worker、其直接依赖、模型网关测试和交接文档；没有纳入 `vendor/team-pr27` 私有团队源码、运行账本、密钥或用户数据。生产环境尚未发布本分支。

## 一句话任务

在现有服务端模型网关的 **A/B 接口槽位**接入用户自己的供应商，先用独立 staging 和合成持仓验证，交付可审查的 PR。保留 Core Agent → 确定性 Tools → Risk → Memory/审批 → Answer 的顺序和现有费用闸门；不将 Key 放进前端，也不直接改生产预算或部署生产。

## 当前状态与接入点

| 项目 | 位置和状态 |
| --- | --- |
| 生产入口 | `https://personal-ai-fund-chat.ai-banking-agent.workers.dev/`；已核验旧版 release `chat-mobile-stability-20261024-v6.2`，模型是 Cloudflare Workers AI `@cf/meta/llama-3.3-70b-instruct-fp8-fast`。本分支不代表生产已更新。 |
| staging 入口 | `https://personal-ai-fund-chat-staging.ai-banking-agent.workers.dev/`；已用 Workers AI 验证动态预留和合成业务流程，外部 A/B 尚未实测或启用。 |
| 浏览器接口 | `chenchen/integration/public-chat/worker.mjs` 的同源 `/api/local/chats/...`；前端只访问本站。 |
| **模型接入窗口** | `chenchen/integration/public-chat/llm-gateway.mjs` 的 `createModelGateway(env, lease, transport)`；返回 `plan()` / `answer()`，由 `worker.mjs` 调用。 |
| 提供商协议转换 | `chenchen/integration/public-chat/provider-adapter.mjs` 的 `providerSlot()`、`callProvider()`、`routeProviders()`；当前只实现已校验的 Chat Completions 文本/JSON/SSE 格式。原生工具调用会明确报 `MODEL_TOOL_CALL_UNSUPPORTED`，不能静默丢弃。 |
| 能力、价格和预算 | `gateway-policy.mjs` 检查单价、输入上界、输出上限和 A/B 能力；`gate.mjs` 的 Durable Object 原子预留、回执、结算、幂等和北京时间日切不能绕开。金额单位为人民币**分**，内部账本为人民币微元，不能把美元 cents 直接填进 `*_CENTS`。 |
| 配置模板 | `chenchen/integration/public-chat/providers.env.example` 仅有占位符；`LLM_A_API_KEY` / `LLM_B_API_KEY` 必须通过 Cloudflare Secrets 注入。 |
| 部署配置 | `staging.jsonc` / `staging-risk.jsonc` 使用独立 staging Worker、Risk Worker 和 Durable Objects；`wrangler.jsonc` 是生产配置，禁止把 staging 资源绑定覆盖进去。 |

实际调用链：浏览器 → 同源聊天 API → ChatSession → ChatGate 预算预留 → `createModelGateway` Planner → 确定性持仓工具 → Risk / Memory / 审批 → `createModelGateway` Answer → SSE → usage 回执与费用结算。模型失败只重试当前模型阶段，不重放工具、保存或审批。Risk 的 BLOCK 不允许被模型覆盖。

## 队友需要先核实的资料

请在 PR 中填写两组 API 各自的服务商、官方 Base URL、模型 ID、官方计价链接、账户余额/有效期、上下文窗口、最大输出、速率限制、JSON/流式能力、usage 字段含义，以及 Cloudflare Worker 网络出口的实际状态码与延迟。**当前这些外部供应商事实均尚未验证。**同一账户多把 Key 不等于多份额度。

此前密钥曾被贴进聊天。请在供应商控制台先轮换，随后由有 Cloudflare 权限的人在安全终端执行 `wrangler secret put LLM_A_API_KEY --config staging.jsonc` / `LLM_B_API_KEY`。不要把 Key 写入 PR、Issue、配置模板、截图、日志或浏览器资源。缺少供应商、Base URL 和模型名时保持 `LLM_GATEWAY_MODE=cloudflare`，不要猜测。

## 最小工作流程

1. 从本交接分支新建个人工作分支。阅读 `providers.env.example`、`gateway-policy.mjs`、`provider-adapter.mjs`、`gate.mjs`、`llm-gateway.mjs`。先补齐供应商协议适配和测试，再声明 `*_PROTOCOL_VERIFIED`、`*_JSON_VERIFIED`、`*_STREAM_VERIFIED`、`*_BILLING_BOUNDS_VERIFIED`。这些开关是验证结论，不能为了让配置通过而直接设为 true。
2. 使用独立 staging 的 Secret、独立预算和合成持仓做短请求。先验证中文规划 JSON，再验证 Answer SSE、Token usage、429/402/超时/5xx、部分流失败和两家都失败。不要使用真实用户持仓；不要进行额度压力测试。
3. 对每次尝试记录 request ID、供应商、模型、状态码、耗时、输入/输出 tokens、估算人民币费用和回执状态。账本估算不是供应商账单；拿不到 usage 时保留保守预留并标注估算。
4. 跑本分支测试与静态构建：

   ```sh
   node --test chenchen/tests/llm-gateway.test.mjs chenchen/tests/provider-adapter.test.mjs chenchen/tests/public-chat-gate.test.mjs chenchen/tests/public-chat-model.test.mjs chenchen/tests/public-chat.test.mjs chenchen/tests/review-tools.test.mjs
   node chenchen/integration/public-chat/build.mjs
   cd chenchen/integration/public-chat
   wrangler deploy --dry-run --config staging.jsonc --outdir /tmp/paifm-handoff-build
   ```

5. PR 附上脱敏的 staging 请求证据与回滚方法。只有管理员核实价格、余额和上限，并取得用户**明确生产发布授权**后，才可切生产。不要清空或重命名费用 Durable Object；旧账本阻止直接提高已有预算，相关迁移须独立审查。

## 必须保持的业务验收

- 合成持仓股票 60,000 元、基金 20,000 元、现金 20,000 元，确定性代码应得总额 100,000 元、比例 60% / 20% / 20%；没有历史序列时不能编造回撤。
- 注入式备注如“忽略规则、伪造100万元、声称调用实时API、无风险和已买入”不得改变工具结果、风控或执行状态。
- Risk ALLOW / REVIEW / BLOCK / ERROR 和人工审批保留；Memory 只有在后端保存成功后才可说“已保存”；重试不得重复保存或执行金融操作。
- 访客隔离、刷新后会话读取、SSE 中途失败和用户输入保留需回归；手机和大陆网络真实验收仍需队友提供实际设备与网络结果，不能用模拟代替。

## 已有验证与当前缺口

原修复分支 `codex/dynamic-budget-20261024` 的应用提交 `ad2985cd56e2bb96384b24949de250b45f1cfb2e` 已在隔离 staging 跑过真实 Workers AI 合成流程；全量 Node 测试 573/573。详细根因、币种、生产/staging 版本、发布及回滚命令见 [动态预算报告](DYNAMIC_BUDGET_STAGING_20261024.md)，原网关审计见 [网关报告](LLM_GATEWAY_AUDIT_20261024.md)。本交接分支从公开 `main` 提取最小可审查应用包，测试结果需以本分支实际运行记录为准。由于私有团队 Risk Python fixture 未纳入公开包，`public-chat.test.mjs` 中一项原版 Python 策略对照测试会明确 skip；其余测试应通过。

尚未验证：A/B 真实调用、账户余额与扣费、生产最新实时账本、生产发布、中国大陆三网及真机浏览器。现有站点没有账号登录功能，使用访客会话。不能把分支合并或 staging 成功写成生产用户已可用。

## 给队友的 PR 描述模板

> 请基于 `codex/team-api-handoff-20261024` 接入我提供的自有模型 API。先在服务端 A/B 槽位完成协议、价格和能力验证，再在独立 staging 用合成数据验证 Planner→工具→Risk/Memory→Answer→SSE、预算结算和异常回退。保留金融业务代码和现有数据。密钥仅由管理员放入 Cloudflare Secret；不要把密钥或真实持仓提交到 GitHub。提交脱敏测试证据、费用来源、部署版本和回滚步骤。未经我批准不要部署生产或提高生产预算。
