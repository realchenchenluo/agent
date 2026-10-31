# 自有模型 API 接入：实施与验证记录

日期：2026-10-24。目标仓库：`realchenchenluo/agent`。

后续记录：[2026-10-25 千问候选接入与本地验证](../qwen-model-plan-20261025/README.md)。真实收费测试仍未开始，以下保留本日的交接与验证状态。

## 先看结论

本轮已经接收交接补丁，完成本地修复、测试和 Cloudflare 打包。**自有 API 还没有接通，修复也没有发布到线上 staging 或生产。**当前缺少服务商配置、余额/价格确认、付费测试授权，以及目标 Cloudflare 账户的部署权限。

本轮收费模型调用 **0 次**，未充值、未修改生产预算、未清空费用账本。现有网站继续运行。不要把下面的本地测试替身结果当作真实模型验收。

**用户后续决定：暂不进行收费测试，只完成本地验证。**下面的 ¥1/¥0.50 仅保留为此前建议，不是支出授权；真实 API 测试保持暂停。用户不知道供应商与计价信息，无需反复要求其填写专业配置表。

### 已代查的现有后端

用户提供的 `personal-ai-fund-manager-core-agent` 是 Worker 服务名称。2026-10-24 通过 Wrangler 只读查询部署和版本元数据，确认其100%流量版本为 `209a21a4-7245-4a96-bb3a-56a064e61d85`，服务端设置 `MODEL_PROVIDER=workers_ai`、`MODEL_NAME=@cf/meta/llama-3.3-70b-instruct-fp8-fast`，绑定名为 `AI`。该部署版本元数据未列出 `secret_text` 绑定，不存在已核实的外部模型 API Key 配置。没有读取或输出密钥值，没有调用模型。

通俗地说：这个旧 Core 后端使用 Cloudflare 提供的模型；它的服务名字并不是模型公司的名字，也不是密钥名称。该结果不证明用户拥有外部 API 余额，不能替代外部供应商信息。

它与交接包的 `personal-ai-fund-chat` / `personal-ai-fund-chat-staging` 是不同 Worker，且位于不同账户。本次没有把两套服务混接，没有修改它们的部署、身份、签名或预算。脱敏结果见 [配置检查记录](configuration-check.json)。

## 交接与版本保留

- 完整阅读 `README.txt`、`TEAM_API_HANDOFF_20261024.md`，检查本机目录与 Git 状态后实施。
- 基线：`2735ade933d123281dd583174697e0560a735afe`。独立分支：`codex/team-api-handoff-20261024`。
- 原始补丁 SHA-256：`564f1228d5db1f03fdc490b7ca7be4c584ab4a72f3701df4a697c754cc4ac1ec`。
- 补丁成功应用后的提交：`a798213624a9422b42df46dfe3d5933793fc6dab`。该 SHA 与交接人原提交不同，是从指定基线重新应用补丁的结果。
- 开始时远程不存在同名交接分支，本轮从本地包创建，未依赖一个不存在的 GitHub 分支。
- 原有个人开发目录内的未提交修改没有覆盖；本轮使用独立克隆目录。此前网络克隆失败，随后从已有本地 Git 对象完整克隆，再将 origin 指回目标 GitHub 仓库。没有创建公开 fork，也没有合并 main。

## 本轮修复了什么

| 文件 | 修改及原因 |
| --- | --- |
| `chenchen/integration/public-chat/provider-adapter.mjs` | 流式回答已经输出后，超时必须保留“已输出部分内容”标记，禁止继续重试或拼接备用模型。取消连接不再等待上游无限确认。供应商 HTTP 跳转被明确拒绝，不把请求转往未确认地址。所有供应商都需明确完成协议验证。 |
| `chenchen/integration/public-chat/gateway-policy.mjs` | 修复 hybrid 模式总预估值出现 `NaN`、序列化后成为 `null` 的问题，报价包含 Workers AI 与备用路径。实际费用闸门仍按输入与获准路径预留。 |
| `chenchen/integration/public-chat/gate.mjs` | Token 总量或同义字段相互矛盾时，保持保守预留；只有一致、完整且在上界内的 usage 才能释放差额，重复回执不能再退款。 |
| `chenchen/tests/provider-adapter.test.mjs` | 增加已输出后超时、拒绝跳转、取消连接无响应的回归测试，补齐所有供应商协议检查。前两个新用例在修复前已实际失败。 |
| `chenchen/tests/llm-gateway.test.mjs`、`public-chat-gate.test.mjs` | 增加混合模式报价、Token 一致性、重复回执检查。保留原预算边界、并发、日切及失败回执测试。 |
| `chenchen/integration/public-chat/local-runtime-verify.mjs` | 新增仅在本机启动两个 Cloudflare Worker 的复现工具，使用随机临时测试凭据、独立本地账本、明确标注的模型替身；没有真实 AI 绑定，也不会部署。 |

聊天页面、Core 金融计算、Risk 规则、Memory 规则、审批接口、生产部署配置均未修改。服务商原生 `tool_calls` 仍明确拒绝；业务工具由既有 Core 流程调用。模型重试只重试该模型阶段，不能重新执行保存、审批或资金动作。现有公开聊天链路始终 `execution_allowed=false`。

## 当前配置和待确认资料

| 项目 | 本轮能确认的事实 | 尚需提供/核实 |
| --- | --- | --- |
| 现有模型 | 交接包及服务端配置使用 Cloudflare Workers AI，模型 `@cf/meta/llama-3.3-70b-instruct-fp8-fast` | 本轮没有调用该真实模型，也未读取供应商账单。 |
| 自有 API 服务商 | 未提供，不猜测 | 服务商名称，A 必填；如有备用 B 再提供 B。 |
| Base URL / 模型 | 未提供，不复用历史示例作为实际配置 | 官方 Base URL、精确模型 ID、官方协议及计价链接。 |
| Secret | 适配器读取服务端 `LLM_A_API_KEY` / `LLM_B_API_KEY`；模板只是占位符 | 实际已存放的 Cloudflare Secret 名称，以及此前暴露的 Key 是否已轮换。**不要在聊天、文档或 GitHub 发送 Key 值。**若现有名称不同，先确认服务端映射。 |
| 余额/有效期 | 未知 | 供应商后台显示的金额、币种、赠送/付费额度、到期时间；可只提供文字数额。 |
| 价格/计费边界 | 自有 API 未知 | 未缓存输入、输出、隐藏推理 Token、最低费用、税费/币种及峰值单价。未验证不得打开 `*_VERIFIED`。 |
| 真实兼容性 | 未验证 | 中文计划 JSON、SSE、usage、供应商响应 ID、网络延迟、429/402/超时及备用路径。 |

当前模型价格的官方参考为每百万输入 $0.293、输出 $2.253，24,000 tokens 上下文：[Cloudflare 模型说明](https://developers.cloudflare.com/workers-ai/models/llama-3.3-70b-instruct-fp8-fast/)。这不是自有 API 的报价。免费 Neurons 和应用人民币预算是两套限制：[平台计费](https://developers.cloudflare.com/workers-ai/platform/pricing/)、[错误码](https://developers.cloudflare.com/workers-ai/platform/errors/)。

## 需要充值或批准多少钱

| 事项 | 金额 | 状态 |
| --- | --- | --- |
| 本轮本地测试和非模型冒烟 | 收费模型调用 0 次 | 已完成，未发起充值。不能据此推断 Cloudflare 账户总账单为零。 |
| 自有 API 最小 staging 测试 | 此前建议总上限 **¥1**，每日上限 **¥0.50**，主备和重试合计计算 | **用户已决定暂不进行收费测试，本轮只做本地验证。**这些金额不是支出授权，也不代表要提高预算。 |
| 供应商充值 | **待余额与单价核实，现阶段无法报准确金额** | 若余额足够不需充值；否则先列出平台最低充值额，再由用户批准。 |
| 生产发布/生产预算提高 | 本轮不申请、不实施 | 后续单独审批；现有上限与账本保持原状。 |

这里 `*_CENTS` 指人民币分：50=¥0.50，100=¥1；内部 1 元=1,000,000 微元，1 分=10,000 微元。若供应商用人民币报价，必须先按统一计价口径转换，不可将人民币单价直接塞进美元字段。

成本估算（非供应商账单）：`ceil((输入tokens × 每百万输入美元价 + 输出tokens × 每百万输出美元价) × 保守人民币/美元汇率)` 微元人民币。

以现有 Cloudflare 价和代码保守汇率 10 为例：输入上界 2,000、最大输出 1,024 时，每阶段预留 28,931 微元=**¥0.028931**；实际完整 usage 1,000/100 时结算 5,183 微元=**¥0.005183**。汇率 10 是配置保护值，不是实时汇率。计划与回答分别预留，失败、缺少用量、多次尝试、用量超界或矛盾时保留完整动态预留。

旧问题是当天已记 40.0203 分，再固定预留 10 分会超过 50 分。现有动态预留在同一旧账本基础上完成，回归测试仍保留全部历史。`DAILY_BUDGET_EXHAUSTED` 仅代表本站人民币日预算拦截，不能据此认定 Cloudflare 账户余额或免费 Neurons 耗尽。

## 已验证到哪一步

| 验证范围 | 本轮结果 | 证据与边界 |
| --- | --- | --- |
| 修改前交接指定 6 组测试 | 90 项：89 通过、1 跳过、0 失败 | 在修改前执行；跳过的是公开包未包含的私有 Python Risk 对照 fixture。 |
| 修改后指定 6 组 | **95 项：94 通过、1 跳过、0 失败** | `handoff-tests.txt`。模型和 HTTP 上游为测试替身，包含402/429/超时、主备切换、部分流失败等。 |
| 本次公开代码包全部 chenchen Node 测试 | **379 项：378 通过、1 跳过、0 失败** | `full-node-tests.txt`。使用本机已有只读 Ajv 依赖目录；不是交接文档历史私有工作区的573项。 |
| 页面构建及 staging 打包 | 通过 | `build-manifest.json`、`staging-dry-run.txt`。dry-run 没有部署。 |
| 本机 workerd / 两个 Worker | 通过 | `local-runtime.json`：中文输入→测试计划→确定性工具→HMAC Risk→提交→回答；重复请求同一任务；仅提交一次；SSE；跨访客404；异常终止；8份回执；最终无活动租约。**没有真实模型或生产身份验收。** |
| 现有公网 staging 非模型业务 | 通过 | `staging-no-model.json`：合成 60,000/20,000/20,000 元=100,000 元，60/20/20%，Risk REVIEW；刷新200；异访客404；无管理员令牌403。没有调用模型，没有部署本轮代码。 |
| 自有 API 真实 staging 调用及账单 | **未验证** | 等待配置、轮换状态、价格/余额、支出批准和部署权限。 |
| 手机真机/大陆三网 | **未验证** | 本地 workerd 及电脑 HTTPS 测试不能代替这项验收。 |

本地运行工具开发时，第一次测试输入在现金金额后附了另一段含数字的控制标签，被现有金额溯源逻辑正确转为追问，未产生持仓写入。已修正测试输入为唯一明确金额；没有为了测试通过放宽金融校验。

## staging 版本和权限缺口

- 既有 staging：[打开](https://personal-ai-fund-chat-staging.ai-banking-agent.workers.dev/)。本轮 HTTP 实查 release：`staging-dynamic-budget-20261024-llm-v1`。
- 既有生产：[打开](https://personal-ai-fund-chat.ai-banking-agent.workers.dev/)。本轮首页 release：`chat-mobile-stability-20261024-v6.2`；`/health` 返回正常、禁止执行。
- release 响应头不等于完整 Cloudflare deployment version。本轮没有目标账户权限，未独立核实交接文档里的部署 UUID，因此不把历史 UUID 写成本轮已发布版本。
- 包内 staging 配置指向账户 `9b41127a11a47c2538db70e5ddafd7f6`；当前 Wrangler 登录只可见账户 `ac6544ae4b883727097fd868d2a5a13d`。需要账户管理员授予目标 staging Worker 的部署和 Secrets 管理权限，或由该账户的部署负责人执行经审查版本。不是缺少 GitHub 写权限。
- 不为绕过权限而在另一账户创建一个看似相同的 staging；不借用生产 Secrets、不轮换现有 ADMIN_TOKEN、不删除/重命名 DO 费用账本。

## 接通真实 API 后的最小验收

1. 核实 A（及可选 B）的官方地址、模型、余额、价格、计费字段与 Secret 名称；已暴露 Key 先轮换。只允许服务端使用 Key。
2. 在有权管理的独立 staging 保存部署前版本、只读预算快照和配置摘要；只向管理员受保护位置输出，不提交真实账本或令牌。保持现有 Session、HMAC Risk 和数据隔离。
3. 经用户批准小额费用后验证极短中文 JSON 计划和 SSE。确认费用估算覆盖实际 usage，再将相应 `*_VERIFIED` 作为验证结论设置；不可跳过校验来“演示成功”。
4. 执行合成 60/20/20 持仓、金额更正、Risk REVIEW/BLOCK、确认保存、重复请求与答案重试。拒绝或异常时不得继续执行，不声明实时账户或成交结果。
5. 每次上游尝试记录关联的 request/trace/turn ID、供应商、模型、响应ID、状态、耗时、输入/输出 Token、费用估算及回执状态。无 usage 保留预留；异常注入使用替身，不为制造402/429而消耗真实额度。
6. 由有权限的管理员只读核对 `/api/admin/status`，把部署版本、回执、供应商账单/用量相互对照；对外日志不得含 prompt、真实持仓、Key、Cookie、Authorization 或原始 IP。未通过则不宣称接通。

## 复现与回滚

在仓库根目录（Node 22+，已安装 Wrangler）：

```sh
node --test chenchen/tests/llm-gateway.test.mjs chenchen/tests/provider-adapter.test.mjs chenchen/tests/public-chat-gate.test.mjs chenchen/tests/public-chat-model.test.mjs chenchen/tests/public-chat.test.mjs chenchen/tests/review-tools.test.mjs
node chenchen/integration/public-chat/build.mjs
wrangler deploy --dry-run --config chenchen/integration/public-chat/staging.jsonc --outdir /path/to/local-build
node chenchen/integration/public-chat/local-runtime-verify.mjs --wrangler=/absolute/path/to/wrangler.js --output=/path/to/local-report.json
node chenchen/integration/public-chat/staging-smoke.mjs
```

最后一项只测试既有公网 staging 的合成非模型业务；不要把它误认为本轮新版本的真实模型验收。`staging-model-smoke.mjs` 会调用真实模型，未获预算批准前不要运行。

代码在独立分支，原 main 和旧提交保留。要回退本轮修复，可在审查分支对修复提交执行 `git revert <修复提交>`，不使用覆盖未提交工作的命令。生产未变更，本轮无需线上回滚。后续 staging 部署前先记录实际 version；出现问题回滚到该记录版本，**Worker 回滚不等于 DO 数据/费用回滚**，不得清空账本。参考 [Cloudflare 回滚说明](https://developers.cloudflare.com/workers/versions-and-deployments/rollbacks/)。

本轮证据不含私有团队目录、群聊、真实用户账户资料、密钥或供应商账单。日志中的本机工作区路径替换为 `<WORKSPACE>`，打包表格末尾空白已整理。用户可审查本分支后，再决定下一步配置与付费授权。
