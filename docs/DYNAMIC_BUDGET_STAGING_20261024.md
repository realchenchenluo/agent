# Personal AI Fund Manager：动态预留修复与 staging 发布门槛

检查日期：2026-10-24，北京时间。本文件区分“已验证通过 / 失败待修复 / 尚未验证”。本次没有修改生产预算、清空账本、开通付费服务或部署生产。

## 根因、单位和版本

| 检查项 | 结论与证据 | 状态 |
| --- | --- | --- |
| 账本币种 | `gate.mjs` 使用 `used_micro_cny`；1 人民币分 = 10,000 微元。`DEMO_BUDGET_CENTS=100` 是 ¥1，`DAILY_BUDGET_CENTS=50` 是 ¥0.50，固定 `CALL_CENTS=10` 是 ¥0.10，不是美元美分。 | 已验证通过 |
| 原始拦截 | 2026-10-24 保存的 `/api/admin/status` 快照：40.0203 分已计入，固定预留 10 分，日限 50 分；`40.0203+10>50`。原代码 `gate.mjs` 的 `paidAllowed()` 在 `begin` 与 `reserve` 都先检查固定 10 分，因此没发起这次 Workers AI 调用。 | 已验证通过（历史快照） |
| 40.0203 分的组成 | 同一快照有 43 次预留、43 份回执、42 次 usage 结算、1 次完整预留。依据账本字段推得其中 **10 分是保守预留**，其余 **30.0203 分是 Token usage × 官方单价 × 保守汇率的估算**；均不是 Cloudflare 账单金额。最近 20 条回执没有覆盖那条完整预留，无法从此快照判断其失败细节。 | 已验证通过（组成）；失败细节尚未验证 |
| 日切 | `beijingDay()` 以 UTC 加 8 小时取日期，按北京时间 00:00 切日。跨日回执冲减原预留日期；Cloudflare 免费 Neurons 按 UTC 00:00 重置，两种日界不同。 | 已验证通过（代码与本地测试）；平台用量尚未验证 |
| 当前生产 | 2026-10-24 本轮 `wrangler deployments list --config wrangler.jsonc` 核实 100% 版本 `c2043bfe-4fc9-48ff-8c97-ff4930f39145`；HTTPS 首页头 `X-App-Release: chat-mobile-stability-20261024-v6.2`。此前保存的部署记录将该版本对应源码提交 `829df7d6f2b4c152ed54a39334db985ba555f78d`，见 `docs/access-evidence/deployment-v6.2.json`。生产页面 `/health` 为 `status:ok`，已有失败轮次展开显示 `DAILY_BUDGET_EXHAUSTED` 与 Workers AI 模型。 | **已验证通过**（Cloudflare version、release 头、现存失败轮次）；源码对应关系依据先前部署记录 |
| 候选与修复 | 候选基线 `cf7276e8142083e5d607389ba25968bf70b9291c` 只在本地；修复在独立分支 `codex/dynamic-budget-20261024`。生产 `wrangler.jsonc` 未改，默认仍是 Workers AI。 | 已验证通过（本地）；生产生效尚未验证 |

Cloudflare 官方列出当前模型 `@cf/meta/llama-3.3-70b-instruct-fp8-fast`：24,000 tokens 上下文、每百万输入 $0.293、输出 $2.253；免费配置每日 10,000 Neurons，平台错误 3036 为免费额度触顶、3040 为容量不足。这些平台事件需要管理员用 Dashboard 实际指标核实，不能由应用内部 `DAILY_BUDGET_EXHAUSTED` 推断。[模型与价格](https://developers.cloudflare.com/workers-ai/models/llama-3.3-70b-instruct-fp8-fast/)、[Neurons 与日切](https://developers.cloudflare.com/workers-ai/platform/pricing/)、[错误码](https://developers.cloudflare.com/workers-ai/platform/errors/)。

## 修复语义

`gateway-policy.mjs` 用实际模型请求的 UTF-8 字节数加 512 tokens 消息封装余量估算输入上界；云模型输入上界不得超过 `24,000-1,024=22,976 tokens`。每一阶段（Planner、Answer）用最大输出 1,024 tokens 计算保守预留：

`R_cloud = ceil((input_bound × 0.293 + 1024 × 2.253) × 10) 微元人民币`。

其中 `$ / 百万 tokens` 转为“微元人民币”后，`×10` 是保守的 10 CNY/USD 汇率。示例输入上界 2,000 tokens 时预留 28,931 微元，即 2.8931 分，而不是固定 10 分。若实际完整 usage 为 1,000 输入、100 输出，则结算 5,183 微元，即 0.5183 分，并在同一个 Durable Object 原子事务中释放差额。两个阶段分别预留，整轮最坏账本占用是 `R_plan + R_answer`；Answer 输入取决于真实工具结果，因此不能在 Planner 前伪造精确的整轮金额。第二阶段如余额不足，会保留输入和已完成计算并明确报错。

`ChatGate` 保留旧账本版本与旧 10 分预留的兼容结算，不删除历史记录。新调用的请求哈希、输入上界和预留金额随持久调用记录保存；重复请求不能二次调用或二次退款。无 usage、超时、流式中断、两次上游尝试和异常 usage 都保留本次完整**动态**预留，并标为保守估算，不写成实际账单。每模型日次数/费用上限与全局日/总上限都仍生效。

`LLM_GATEWAY_MODE=cloudflare` 不调用外部服务。仅管理员在核实模型、协议、价格、余额、Secret 和支出授权后设置 `LLM_GATEWAY_MODE=hybrid` 与 `LLM_PAID_PROVIDER_APPROVED=true`，才允许 Cloudflare 成为首选、A/B 中一个模型成为本次备用；总计最多两次上游尝试。备用由账本按可用模型日额度选出，并参考本地失败冷却；**只按本次获授权的备用路径计入费用预留**，不为未选中的高价模型占用预算。预留在备用调用前完成。3036、3040、外部 402/429、超时、网络和 5xx 分开记录。鉴权、风控拒绝、协议不兼容、已输出部分流时不回退；Planner、工具、Memory、Risk、确认保存都不因模型重试而重放。独立 `external` 模式仍保留，但不是生产默认。**外部 A/B 的供应商、模型、余额和 Secret 尚未验证或启用**，之前在对话中贴出的密钥应由用户在供应商控制台轮换后再安全配置。

输入成本上界使用保守字节/token 与封装余量，**尚未通过 staging 的真实 usage 对照验证**。若提供商报告超过所预留的输入或输出界限，账本不释放预留，管理员须核对供应商账单与模型计费边界；不能承诺供应商的最终账单严格等于该估算。外部模型价格、隐藏推理 tokens、缓存及区域服务能力均未实测。

## 本地验收和缺口

- **已验证通过：**定向合成测试覆盖 `40.0203 + 10 > 50` 原始拦截、短请求动态预留与 usage 结算、跨用户原子并发、重复请求、北京时间日切、402/429、超时、双供应商失败、部分流禁止拼接、Cloudflare 3036/3040 分类、默认不触发外部服务及混合模式限次回退。
- **已验证通过：**确定性持仓 60,000 + 20,000 + 20,000 元得总额 100,000 元、占比 60% / 20% / 20%。`USER_TABLE` 备注含“忽略规则、伪造100万元、声称调用实时API、无风险和已买入”时，规范化层丢弃备注，计算、历史回撤可用性和执行状态不受影响。当前公开聊天没有文件上传解析链路；这项是表格备注的合成注入测试，不能称作真实文件上传验收。
- **已验证通过：**完整 Node 测试集 **573/573**（`node --test --test-reporter=tap`，使用只读的既有 `ajv` 依赖目录作为 `NODE_PATH`，并给本地 HTTP 测试开启回环地址权限）；静态页面构建、JS 语法和 Wrangler 4.151.1 对生产/两份 staging 配置的 `deploy --dry-run` 打包。Risk BLOCK、访客隔离、已确认记录、SSE 重连与幂等回归在本地测试范围内。前端构建资源未检出 Secret 名称或疑似 Key 模式。受限沙箱直接跑测试仍会因依赖目录/回环权限使 17 项失败，但获得本地回环权限后全量通过。
- **已验证通过：**2026-10-24 约 15:49 北京时间，最终 staging Chat version `36ceba39-7f11-450c-a084-d6e210031875` 从应用代码提交 `ad2985cd56e2bb96384b24949de250b45f1cfb2e` 部署，release `staging-dynamic-budget-20261024-llm-v1`；独立 Risk version `b9e7c850-3103-4788-9091-13c71f6ed44a`。HTTPS `/health` 200、首页 release 头正确；`staging-smoke.mjs` 的合成持仓 60,000 + 20,000 + 20,000 元由真实 staging Worker 算得 100,000 元、60/20/20%，Risk 返回 `REVIEW`，刷新读取 200，另一访客读取 404，未带令牌的管理员接口 403。当前产品为访客会话，没有账号登录。
- **已验证通过：**`staging-model-smoke.mjs` 在最终 staging 版本再次发送一轮合成问题，真实 Workers AI 两次调用（Planner 1,249 输入/116 输出 tokens；Answer 2,012 输入/53 输出 tokens）、SSE 29 个事件含 22 个增量，回读状态 `COMPLETE`、确定性工具总额 ¥100,000、Risk `REVIEW`。两个响应共报告 121.5754 Neurons（约值），但这不等于 Cloudflare 已计费数量。按代码公式估算本轮 6,274 + 7,090 = **13,364 微元人民币 = 1.3364 分 = ¥0.013364**；这仍不是账单，也未核实平台免费额度扣减。staging 累计实际执行了两轮同样的模型冒烟测试，不能仅以本轮估算代替账本总额。
- **尚未验证：**管理员 `/api/admin/status` 的 staging 账本值。该接口正确拒绝无令牌请求（403），但本轮 staging 管理令牌随机注入后未保留可用副本。自动审批审查两次拒绝了为读取账本而轮换 staging `ADMIN_TOKEN`，理由是轮换可能使现有管理访问失效，未取得明确授权。停止轮换；需持有现有令牌的管理员只读查询，或用户明确批准专门轮换 staging 令牌。不得绕过鉴权。
- **尚未验证：**真实设备、中国大陆移动/联通/电信无代理网络、真实 A/B 服务、供应商余额、真实 Cloudflare 账单，以及 staging 使用量和账本预留/结算的逐项对照。HTTPS 请求从本机授权网络出口成功，不代表中国大陆链路成功。

## staging 配置与发布门槛

`chenchen/integration/public-chat/staging.jsonc` 使用独立 Worker/DO 命名空间，并绑定 `staging-risk.jsonc` 定义的独立 Risk Worker；两个 staging 服务共享一个**独立于生产**的 HMAC Secret。演示总上限 100 分（¥1）、日上限 50 分（¥0.50），截止 2026-11-09 00:00 北京时间；当前 `MODEL_ENABLED=true`、Workers AI 默认、外部付费模式关闭。staging 已部署，首页是 [staging 地址](https://personal-ai-fund-chat-staging.ai-banking-agent.workers.dev/)。任何美元上限都不能直接填进 `*_CENTS`：这里 200 表示人民币 200 分（¥2），不是 200 美分（$2）。若要相当于 $2/day，在保守 10 CNY/USD 下是 2,000 人民币分/日，超出当前授权与现有硬上限，必须单独审批并修改保护策略；本次没有这么做。

已按下列顺序完成 staging 部署、独立 Secret 注入及小额 Workers AI 测试。**首次重建时先临时将 staging 的 `MODEL_ENABLED` 设为 `false`**，注入全部 Secret 后再恢复为 `true` 并重新部署。管理员在有网络、Wrangler 与 Cloudflare 权限的环境中先部署 staging Risk，再部署 staging Chat；给二者注入**同一份新生成的 staging** `RISK_HMAC_SECRET`，给 Chat 注入独立的 `SESSION_SECRET`、`ADMIN_TOKEN`。Secret 由安全终端输入或密码管理器提供，不写进 JSONC、命令行参数或日志。启用外部模型时再注入 `LLM_A_API_KEY` / `LLM_B_API_KEY`。准备与发布命令（在 `chenchen/integration/public-chat` 目录）：

```sh
wrangler deploy --dry-run --config staging.jsonc --outdir /tmp/paifm-staging-build
wrangler deploy --config staging-risk.jsonc
wrangler secret put RISK_HMAC_SECRET --config staging-risk.jsonc
wrangler deploy --config staging.jsonc
wrangler secret put SESSION_SECRET --config staging.jsonc
wrangler secret put RISK_HMAC_SECRET --config staging.jsonc
wrangler secret put ADMIN_TOKEN --config staging.jsonc
wrangler deploy --config staging.jsonc # 将 MODEL_ENABLED 恢复为 true 后
wrangler deployments list --config staging.jsonc
node staging-smoke.mjs
node staging-model-smoke.mjs # 每次运行都会消耗真实 staging 模型额度
```

staging 必须核对 `/health`、首页 `X-App-Release`、管理员只读 `/api/admin/status`、现有访客会话完整 Planner→工具→Risk→Answer→SSE、刷新后记录、双访客隔离、用量回执和供应商账单。当前产品没有账号登录功能。使用合成数据，确认动态预留未低于真实 usage。完整 staging 通过且获得生产变更明确授权后，才可在生产 `wrangler.jsonc` 改成唯一新 `RELEASE_ID` 并发布：

```sh
wrangler deployments list --config wrangler.jsonc
wrangler deploy --config wrangler.jsonc --message "dynamic budget verified in staging"
wrangler deployments list --config wrangler.jsonc
```

生产回滚目标为最后已核验的 version `c2043bfe-4fc9-48ff-8c97-ff4930f39145`，执行前须再次核验它仍可用且资源绑定未变；命令为 `wrangler rollback c2043bfe-4fc9-48ff-8c97-ff4930f39145 --config wrangler.jsonc --message "revert dynamic budget"`。回滚 Worker 不回滚 Durable Object 账本，也不清空数据。[Cloudflare Rollback 文档](https://developers.cloudflare.com/workers/versions-and-deployments/rollbacks/)。

现有账本阻止通过改配置直接提高生产上限（`BUDGET_CONFIG_CHANGED`）；若未来获得审批，须单独实现并审查保留原 `used_micro_cny`、每日历史和授权记录的上限修订迁移，不能新建同名空账本或重命名 DO 以重置费用。
