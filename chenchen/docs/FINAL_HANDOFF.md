# AI Banking Agent 收尾交接（2026-11-01，北京时间）

## 版本与范围

目标仓库是 `realchenchenluo/agent`；本轮从 `origin/main` 的 `ced1ccad50319ba69385d7cbbe9c12114c840062` 核查，统一聊天/MOT 候选原始 HEAD 为 `980c2d7437fb0d02da4bab56142b7616a8c56881`。收尾分支为 `codex/final-closeout-20261101`，最终提交请以该分支的远端 SHA 为准。顶层资料工作区不是目标仓库。其他工作树的未提交 UI 改动已做本地可恢复备份，因来源较早、与统一入口的作用未逐项确认，本分支未覆盖或批量并入。

本轮修正 `npm run smoke` 对旧页面的失效预期，改为核验 `/app`、旧路由跳转及当前静态资源；补充根 README、环境变量示例、忽略规则及一次独立本机 HTTP 演示证据。现有金额、审批与执行规则没有改动。

## 真实调用路径与执行边界

`/app` → `/api/app` 的 owner 会话与 `app/router.js` 确定性任务识别 → MOT Ledger、Merchant 本机会话或固定 Investment 样本工具 → 带来源、时点和审计引用的答复。MOT Ledger 保存资金快照、任务、Inbox、监控与审计；Memory 和 Core 的旧工作流仍在仓库中，但云端 MOT Worker 未注入 Core/Risk 验证适配器。页面上显示 Risk 状态不代表一次远端 Risk 调用。当前 MOT 演示路径模型调用数为 0；没有通用模型规划执行。

明确账户、金额、收款方和幂等键的正向付款使用 `PAYMENT_PROPOSAL`；测试专用适配器校验提案指纹、账本版本和五分钟审批期限，模拟执行在同一持久化事务写 PAPER 流水、余额、回执与审计，同键重放只返回既有回执。公网 Core/Risk `UNAVAILABLE` 时拒绝批准和模拟，不能使用模型建议或页面按钮越过门禁。真实资金操作禁用。

## 三个连续故事及本轮结果

复现命令见仓库 [README](../../README.md)。在新的本机 `MOT_DATA_DIR` 以 `POST /api/mot/demo/ingest` 装入两店、三账户、样本流水及待付房租；三个输入在**同一会话、同一账本 revision 1** 顺序执行。独立 HTTP 记录为 [closeout-local-20261101.json](closeout-local-20261101.json)。

| 故事与输入 | 预期 | 本轮本机实际 | 账本变化 |
|---|---|---|---|
| A `帮我看两家店现在有多少钱，资金池里有多少，还有多少没到账。` | 15000 / 8000 / 550 元，来源可查 | `READY`、`MOT_LEDGER`，金额分别为 1500000 / 800000 / 55000 分 | 无 |
| B `核对今天的收款和到账，哪几笔对不上？内部调拨不要算营业收入。` | 200/200 相符；300/290 差 10；550 待结算；内部划转不计收入 | `PARTIAL`，两条配对分别 `MATCHED` 与 `MISMATCH`，内部双边 2 条，样本完整性未验证 | 无 |
| C `帮我支付 13,500 元房租。` | 池内 8000，缺 5500，阻断付款 | `BLOCKED`，`execution_allowed=false`，账本 revision 保持 1 | 无 |

同一套本机 HTTP 请求后的总额仍 1500000 分、池内 800000 分、待结算 55000 分。本轮另执行 `npm run build:app`、`npm run check`、`npm test`（**324/324 通过**）、运行中服务的 `npm run smoke`（通过）。环境：Windows PowerShell，Node v24.14.0、npm 11.9.0；测试数据全为合成。本机正向 1200 元 PAPER 支付由 `mot-coordinator.test.js` 和 `mot-payment-http.test.js` 的隔离测试适配器覆盖，批准后池内 6800、同键重放无二次扣减；这不是公网本人审批验收。

历史公网隔离 owner B 的 16 次 HTTP 请求、部署者当时记录的 SHA/Worker Version 和阻断结果见 [QA 报告](qa-delivery-report-20261101.md)及 [原始 JSON](qa-delivery-staging-20261101.json)。**本轮独立线上版本核对未完成**：未认证 `/api/mot/health` 返回 401，Cloudflare Worker 部署读取返回 403；`/app` 返回 200 仅证明入口可达。历史报告所列部署代码 `a26ded59fdf9c2f42954031a5f78f56261d08962` 不应当作本次已核实的线上 HEAD。

## 部署、CI、恢复

`wrangler.mot-staging.toml` 是受控 Staging 的显式部署配置。推送本分支不会自动发布 Worker。仓库可见的 GitHub Actions 工作流 `deploy-standalone-sites.yml` 只在 `main` 的指定独立页面路径变动时发布 GitHub Pages；它不是本 `/app` 的构建、测试或部署 CI。没有对应提交的 Actions 运行就不能报告 CI 通过。正式聊天 Worker/域名没有因本分支更新。

部署负责人应先记录当前 Worker Version、部署 ID 和已认证 health 的 `build_sha`，用本分支经过测试的提交构建并设置 `MOT_BUILD_SHA`，只更新受控 Staging，然后复查已认证 health、`/app`、同一 owner 的三故事及错误门禁。Secrets 名称见 [示例](../../.env.example)，值只在部署环境配置。历史报告中的旧 Worker Version `c4b14b9c-af18-46fc-bc69-71a696b8968d` 是历史回滚参考，使用前须重新核实实际上一稳定版本；Wrangler 版本回滚不会回滚 Durable Object 数据，先确认数据兼容。代码可回到已记录的上一 Git 提交并重新构建，不重写共享历史。

## 阻塞与未验证

1. **P0 Core/Risk 与本人审批**：公网 Worker 未注入可信适配器；需要服务契约、身份、签名和状态绑定的双方联验。正向公网 PAPER 付款保持阻断。
2. **P0 参赛三类核心场景**：三段门店故事是同一资金/账单流程，不等于三项官方核心能力。完整智能转账、理财等跨模块链路仍缺端到端证据，不能标记参赛验收通过。
3. Staging 口令映射共享合成 owner；评委隔离身份与账本初始化未完成。不同 owner 的本机/隔离 HTTP 测试不等于正式用户鉴权。
4. 本轮在本机 `/app` 检查了桌面视口和 Chrome 模拟的 390×844 移动视口：[桌面截图](screenshots/closeout-desktop-20261101.png)、[移动聊天截图](screenshots/closeout-mobile-390-20261101.png)、[移动审批中心截图](screenshots/closeout-mobile-approval-20261101.png)。移动视口下输入框与审批入口可见，侧栏和审批中心可打开，页面测得 `innerWidth=390`、`scrollWidth=390`，未见水平溢出；审批中心显示 0 项，并说明 Core/Risk 不可用。回复展示、滚动和错误提示仅在已有本机 HTTP 测试及静态浏览器检查范围内核验；软键盘、iOS/Android 真机、实际语音授权/拒绝或中国大陆无代理网络未验证。语音听写是浏览器能力，实时语音和电话未交付。
5. Worker 部署读权限与已认证 health 不可用时，线上构建/提交映射保持未知。模型预算余额也未取得；本轮 MOT 路由未调用付费模型。
