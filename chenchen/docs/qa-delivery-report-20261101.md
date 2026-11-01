# AI Banking MOT 赛前交付验收（2026-11-01，北京时间）

## 版本、范围与结论

- 唯一候选入口：`https://personal-ai-fund-manager-mot-staging.ai-banking-agent.workers.dev/app`。仅受控 Staging，演示口令映射到共享的合成 owner A；独立 HTTP 验收使用 owner B。
- 源码：`codex/unified-chat-20261101`，部署代码提交 `a26ded59fdf9c2f42954031a5f78f56261d08962`；Staging Worker Version ID `86c42869-eeb9-4a50-9364-a201912f4329`，`/api/mot/health` 返回同一 `MOT_BUILD_SHA`。后续仅提交验收文档与截图，不改变部署代码；正式聊天 Worker 未更新。
- 结论：**有限制可演示**。三个门店故事可在同一 `/app` 以合成数据展示真实读数、对账证据及付款阻断；Core/Risk、本人的可信审批、正向公网模拟付款、实时语音及官方三场景覆盖尚未达到参赛完成标准。
- [赛事官网](https://fintechathon.g-ican.com/)要求国内 AI 赛道至少覆盖三个核心场景。门店余额、营业对账和被阻断房租付款是同一产品的三段故事，不能计作三个不同的官方场景。官网列出智能转账、账单分析、理财操作、卡片管理、订阅/代扣、跨场景联动；当前固定持仓快照和被阻断转账不足以证明理财或转账端到端完成。

## 可重复演示脚本与实际结果

每轮使用新会话；基线是三个唯一账户共 15000 元，其中池内 `bank-main` 8000 元，待结算 POS 收款 550 元。账户快照与样本流水分开计算，流水不再叠加到账户余额。Staging owner B 的原始请求与结果见 [公网验收 JSON](./qa-delivery-staging-20261101.json)。

| 故事 | 在 `/app` 输入 | 预期及本次 Staging 实际 | 结果 |
|---|---|---|---|
| 1 资金查询 | “帮我看两家店现在有多少钱，资金池里有多少，还有多少没到账。” | 账户 15000、池内 8000、待结算 550 元；`READY`，来源 `MOT_LEDGER`，带账本时点 | 通过，合成数据 |
| 2 营业对账 | “核对今天的收款和到账，哪几笔对不上？内部调拨不要算营业收入。” | 200/200 相符；300/290 差 10 元，原因待核实；550 元待结算；内部转账 500 出入均不计收入；`PARTIAL` 表示样本非全天完整数据 | 通过，样本范围 |
| 3 房租决策 | “帮我支付 13,500 元房租。” | 从已登记待付单据确定 `bank-main`，池内 8000 元，缺口 5500 元；`BLOCKED`、无付款 | 通过，阻断路径 |
| 正向隔离分支 | HTTP `POST /api/mot/payments/propose`：`bank-main` 向 `synthetic-landlord` 模拟支付 1200 元 | 本地测试专用验证适配器：审批前不扣账，批准后一次 PAPER 扣账，池内 6800、总额 13800、待结算 550 元；同键重放一张回执。公网 Staging：Risk `UNAVAILABLE`，审批与模拟均 409，余额保持 15000/8000/550 | 本地通过；公网受阻 |

公网复合问句“检查两家门店资金，并告诉我有没有需要关注的持仓风险”记录 `run_id`、父 `task_id` 和三个步骤：MOT `READY/MOT_LEDGER`，持仓确定性工具 `DEMO_DATA/INVESTMENT_DEMO_SNAPSHOT`，Risk `UNAVAILABLE/CORE_RISK_GATE`。本轮 run_id 见公网 JSON，任务能经 `GET /api/app/bootstrap` 恢复。这是本地工具编排及来源记录；**没有调用三个独立的远程 Agent 服务**，也没有通用模型自主规划。

## P0 / P1 修复与复验

| 级别 | 复现、根因 | 最小修复 | 复验 |
|---|---|---|---|
| P0 演示故事 | 旧版问对账只回余额；问“支付 13,500 元房租”也只回余额。`app/router.js` 通用资金分支先匹配，金额解析不支持千位逗号 | 显式对账关联与付款判断，金额解析支持千位格式；利润数据不足返回 `UNKNOWN` | `mot-coordinator.test.js` 精确原句；Staging owner B 三故事均按预期 |
| P0 正向模拟 | 原 MOT 仅支持资金预留，不能将“预留”冒充付款；无付款流水、扣账和回执 | 新增 `PAYMENT_PROPOSAL`/`/api/mot/payments/propose`，提案指纹、五分钟审批有效期、执行前资金重查、同事务 PAPER 流水/余额/回执/审计 | 隔离 Node HTTP 与引擎测试通过；公网因无可信 Risk 保持 409，未假装完成 |
| P0 资金事实 | 零金额流水可被接受；非池内账户快照过期时，“当前账户总额”仍显示旧数 | 拒绝零/负/缺金额；总额仅在所有账户快照新鲜时给出，池内余额单独保持可读 | 精确金额和过期非池内账户专项测试通过；全量回归通过 |
| P1 待确认 | 旧“待我确认”直接复用全量任务中心，含 BLOCKED/RESOLVED | 仅显示 `PENDING_APPROVAL`，空态解释阻断原因 | 本地 UI 回归及 Staging 浏览器显示 0 项 |
| P1 迟到响应 | 切换会话后旧请求可能读取当前可变会话 ID 并刷新错误视图 | 固定提交时会话 ID 与视图 epoch；相同文本才复用幂等键 | `app-ui-interactions.test.js` 4/4 |
| P1 详情入口 | 打开协作节点后顶部“任务与证据”沿用旧节点面板 | 顶部入口清除旧节点选择并显示任务 | 本地 UI 回归与 Staging 浏览器复验 |

此前观察到点开抽屉后短暂只见遮罩。浏览器读取到 `context-panel.open=true`，过渡结束后面板位于视口内；这是 CSS 200ms 动画中的截图，不是持续性错位。四个模拟视口的 `scrollWidth` 均等于视口宽度；软键盘和真机仍未验证。

## 测试与证据

- 本次实际执行：`npm run build:app`、`npm run check`、`npm test`。最终代码及额外并发回归的全量 [原始 TAP](./qa-delivery-full-20261101.tap) 为 **324 passed / 0 failed**；[检查日志](./qa-delivery-check-20261101.log)通过。Wrangler `--dry-run --keep-vars` 通过。两笔并行申请同一池内快照时，只有一笔能获得有效批准并模拟扣款。
- [40 项独立复核矩阵](./qa-delivery-matrix-20261101.md)：**32 PASS_LOCAL / 0 FAILED / 6 BLOCKED / 2 NOT_TESTED**。32 是案例断言数，不与 324 项测试相加。
- Staging 完成 **16 个 HTTP 请求**，其中隔离 owner B 验算同一 SHA、三故事、复合任务恢复、正向付款拒绝及余额不变；另验证未认证 401、跨 owner 404、Cookie 跨源写入 403。当前口令登录 owner A 共用演示账本，重复演示会累积任务；不可用其历史任务数作为空白基线。
- 同一部署 SHA 下关闭浏览器标签页后的 Cron 证据：[13:13 UTC 检查前](./qa-delivery-cron-before-20261101.json)为 `run_count=2`、上次调度 13:00:34；[13:16 UTC 检查后](./qa-delivery-cron-after-20261101.json)为 `run_count=3`、最新调度 13:15:35，证明页面关闭后 15 分钟触发仍写入持久化状态。这证明调度执行，未证明每一种异常通知的外部送达。
- 截图：[当前部署桌面主页](./screenshots/staging-desktop-current.png)、[当前部署手机主聊天](./screenshots/staging-mobile-chat.png)、[待确认面板](./screenshots/staging-approval-desktop.png)、[手机任务抽屉](./screenshots/staging-mobile-drawer.png)。后两张截图来自上一 Worker 版本，但前端资源与当前部署相同。Staging 浏览器模拟 360/390/768/1440px；Android/iOS 真机、软键盘、实际语音授权/拒绝与大陆网络均**未测试**。
- MOT 这次路径调用实际模型 **0 次**；Wrangler 有 AI binding，但确定性路由没有使用。模型费用因此未由这轮 MOT 测试新增；账户级已用费用和剩余额度未读取，不能声称预算充足。真实电话未接通，实时语音通话不可用；浏览器支持时的听写只填入可编辑输入框。

## 保留问题与所需条件

1. **Core/Risk 与本人审批**：需要 Owner 提供可信服务契约、鉴权、签名/回调及测试身份；只有通过后才能在公网验证正向 PAPER 付款。不得把本地测试适配器的成功算作生产审批。
2. **官方至少三场景**：需逐场景与官网要求对照并交付对应可操作链路。当前门店故事只能证明部分账单/资金能力，不足以覆盖三项。
3. **身份和隔离**：当前 Staging 口令统一映射 owner A；评委独立副本需要受控独立身份/账本初始化方案。现有 owner B token 仅用于隔离 HTTP 验收。
4. **语音与大陆网络**：实时语音需授权服务、短期凭据和同一 MOT 会话接线；大陆可用性须在大陆网络打开 `/app`、登录并运行三故事，记录 DNS、HTTPS、页面与 API 的实际结果。无该环境时保持未验证。

## 恢复与回滚

上一 Staging Worker 版本为 `c4b14b9c-af18-46fc-bc69-71a696b8968d`。如新候选出现阻断，可在仓库根目录运行 `npx wrangler rollback c4b14b9c-af18-46fc-bc69-71a696b8968d --config wrangler.mot-staging.toml`，然后重新检查 `/api/mot/health` 的 SHA 和 `/app`。Wrangler 回滚 Worker **不会回滚 Durable Object 数据**；新付款任务字段与旧数据并存，回滚前须评估数据兼容性。正式 Worker 和正式域名均未参与本轮部署。
