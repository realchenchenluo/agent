# AI Banking MOT 独立验收矩阵（2026-11-01）

范围：本机隔离测试与代码复核。执行命令：`node --test tests/mot-engine.test.js tests/mot-coordinator.test.js tests/app-http.test.js tests/mot-worker.test.mjs tests/mot-payment-http.test.js`，结果 30 passed / 0 failed；原始输出见 [qa-delivery-targeted-20261101.tap](./qa-delivery-targeted-20261101.tap)。其中 Worker 测试使用模拟运行时，不等于公网 Staging 验收。下表中的故事子断言与同一测试共享一次运行，不应再相加为独立测试次数。所有测试使用合成数据，没有真实资金操作。

状态：`PASS_LOCAL` 为本轮本机测试通过；`BLOCKED` 为缺少接口或权威材料；`NOT_TESTED` 为本轮未执行。`账本变化` 指测试是否有意改变隔离账本；`无` 包括只读请求和被阻断的操作。

| case_id | 前置数据 | 操作 | 预期结果 | 本轮实际结果 | 账本变化 | 证据 | 状态 |
|---|---|---|---|---|---|---|---|
| APP-01 | 隔离 HTTP 服务 | 打开 `/app` 和旧入口 | 同一应用外壳，旧路由重定向 | 四个旧路由重定向，`/app` 为 200 | 无 | TAP: `one app entry redirects legacy product routes` | PASS_LOCAL |
| APP-03 | 两个隔离 owner | 建会话并用同一请求键重放 | 只建一条会话 | 返回相同 conversation_id | 会话存储 | TAP: `server owned conversations...` | PASS_LOCAL |
| APP-04 | 已建会话 | 同键不同文本发消息 | 拒绝参数冲突 | 返回 409 | 无 | TAP: `server owned conversations...` | PASS_LOCAL |
| APP-08 | Core/Risk 未接通 | 请求转账 | 提案阻断且无转账 | `BLOCKED`，有 task_id | 仅任务/审计 | TAP: `merchant and investment adapters...` | PASS_LOCAL |
| APP-09 | 两店资金与固定持仓 | 复合询问资金及持仓风险 | 同会话子任务，Risk 不可用可见 | `PARTIAL`，MOT/Investment/Risk 三步骤 | 无 | TAP: `one MOT conversation returns sourced substeps...` | PASS_LOCAL |
| APP-10 | owner A、B | 创建监控并让 B 控制 | 持久化且跨 owner 禁止 | ACTIVE；B 控制返回 404 | 监控状态 | TAP: `MOT coordinator keeps one conversation...` | PASS_LOCAL |
| MON-01 | 阈值 9000、池内 8000 | 调度检查两次 | 同一问题一条 Inbox | 一条告警，重跑未新增 | 任务/Inbox | TAP: `persistent threshold monitor...` | PASS_LOCAL |
| MON-03 | 已存监控 | 暂停、恢复、改阈值 | 状态可控，问题解除 | PAUSED/ACTIVE/RESOLVED | 监控/任务 | TAP: `persistent threshold monitor...` | PASS_LOCAL |
| LED-01 | 固定三账户 | 汇总唯一账户 | 15000 元；池内 8000 元 | 精确分值 1500000/800000 | 无 | TAP: `synthetic import...`；本轮直接计算 | PASS_LOCAL |
| LED-11 | 两家店引用同一账户 ID | 跨店汇总余额 | 同一账户只计一次 | 当前合成模型未记录门店到账户的引用关系，无法构造该关联验收 | 无 | `mot/engine.js` 的 stores/accounts fixture | BLOCKED |
| LED-02 | 固定 POS 待结算 | 资金总览 | 550 元待结算不计可用 | pending=55000 分，available=800000 分 | 无 | TAP: `synthetic import...`；本轮直接计算 | PASS_LOCAL |
| LED-03 | 同一导入键 | 重复导入 | 不重复写流水 | replayed 且未新增 | 无 | TAP: `synthetic import...` | PASS_LOCAL |
| LED-04 | 同一外部交易 ID、不同内容；零/负/缺金额 | 导入冲突与非法金额 | Fail-Closed | 拒绝交易冲突及三种非法金额，账本未写入 | 无 | TAP: `conflicting external transaction...`、`zero, negative and missing...` | PASS_LOCAL |
| LED-05 | 过期或未来余额快照；非池内账户过期 | 查询/提议 | 可用资金未知并阻断；总额不引用过期非池内余额 | 池内过期拒绝；少量时钟偏差容忍；非池内过期使总额为未知但新鲜池内余额仍可读 | 无 | TAP: `small source clock skew...`、`stale non-pool account...`、`treasury chat marks...` | PASS_LOCAL |
| LED-06 | POS 300、银行结算 290 | 运行对账规则 | 差额 10 元，原因未知 | `SETTLEMENT_MISMATCH`，1000 分 | 任务/Inbox | TAP: `checks detect settlement mismatch...`；本轮直接计算 | PASS_LOCAL |
| LED-07 | 房租待付 13500、池内 8000 | 缺口检测 | 缺口 5500 元 | `FUNDING_SHORTFALL`，550000 分 | 任务/Inbox | TAP: `checks detect settlement mismatch...`；本轮直接计算 | PASS_LOCAL |
| LED-08 | 一或三账户池配置 | 配置后检查 | 只按池内账户计算 | 配置后短缺状态更新 | 配置/任务 | TAP: `pool configuration supports one or three...` | PASS_LOCAL |
| LED-09 | 同分钟同门店同金额两笔 POS | 检查可疑重复 | 提醒但不自行删账 | `SUSPECT_DUPLICATE` | 任务/Inbox | TAP: `distinct POS identifiers...` | PASS_LOCAL |
| LED-10 | 一组内部划转 500 出/入 | 汇总资产和营业收款 | 净资产不增加，非营业收入 | 账户快照独立汇总，双边各 500 | 无 | 固定 fixture + `synthetic import...`；本轮直接计算 | PASS_LOCAL |
| RISK-01 | 余额 10000、房租预留 4000 | 再安排 8000 | 可用仅 6000，拒绝 | `FUNDING_UNAVAILABLE` | 无 | TAP: `ten-thousand cash...` | PASS_LOCAL |
| RISK-02 | 上述余额与预留 | 安排 3000 | 资金够仍须 Risk/审批 | 提案 `BLOCKED`，模拟拒绝 | 仅任务/审计 | TAP: `ten-thousand cash...` | PASS_LOCAL |
| RISK-04 | Risk 调用结果不明 | 重复提案 | UNKNOWN，不盲目重发 | UNKNOWN，未二次派发 | 任务/审计 | TAP: `lost Core/Risk acknowledgement...` | PASS_LOCAL |
| RISK-05 | 隔离的测试专用验证适配器 | 审批后并发模拟预留 | 仅一份预留回执 | 一份 PAPER 预留 | 预留/审计 | TAP: `test-only verified adapter...` | PASS_LOCAL |
| RISK-06 | 已审批任务、账本版本变化 | 执行旧批准 | 旧审批失效 | `STALE_TASK` 或阻断 | 无 | TAP: `changed ledger invalidates...` | PASS_LOCAL |
| RISK-07 | 持久化失败 | 创建或执行任务 | 不返回虚假成功 | 返回 unavailable | 无 | TAP: `changed ledger...`、`Worker storage failure...` | PASS_LOCAL |
| SEC-01 | owner A、B 的 DO 存储 | 跨 owner 访问并重启 | 隔离且恢复 | 测试通过 | 各自隔离 | TAP: `Worker uses existing ReviewService...` | PASS_LOCAL |
| SEC-02 | 调度秘钥 | 未授权触发 tick | 拒绝；有秘钥时幂等 | 测试通过 | 授权时运行记录 | TAP: `Worker scheduled trigger...` | PASS_LOCAL |
| SEC-03 | 受控 Staging 入口模拟 | 登录、会话恢复、无关路由 | 签名会话、无关路由拒绝 | 测试通过 | 会话存储 | TAP: `Staging app uses signed session...`、`Staging entry rejects...` | PASS_LOCAL |
| STORY-1 | 固定三账户、两店 | “帮我看两家店现在有多少钱，资金池里有多少，还有多少没到账。” | 15000 / 8000 / 550 元 | 三金额正确，未动账 | 无 | TAP: `three demo prompts share one verified sample...` | PASS_LOCAL |
| STORY-2 | 固定 POS/银行关联 | “核对今天的收款和到账，哪几笔对不上？内部调拨不要算营业收入。” | 200/200、300/290、550 待结算、内部双边 | 返回 `PARTIAL`、配对证据、差额原因待核实 | 无 | TAP: 同上；2026-11-01 首轮曾只回通用余额，已由主线修复 | PASS_LOCAL |
| STORY-3 | 固定房租待付 13500 | “帮我支付 13,500 元房租。” | 池内仅 8000，缺 5500，禁止执行 | `BLOCKED`、shortfall=550000 分 | 无 | TAP: 同上；2026-11-01 首轮曾只回通用余额，已由主线修复 | PASS_LOCAL |
| STORY-4 | 上述有限流水 | “今天赚了多少钱？” | 不把余额/收款当利润 | `UNKNOWN`，说明缺完整收入、成本、费用、退款 | 无 | TAP: 同上 | PASS_LOCAL |
| EXEC-01 | 隔离副本，合成收款人及测试专用验证适配器 | 提议、Risk、本人批准、模拟支付 1200 并重放 | 池内 6800、总额 13800、待结算 550；只扣一次 | Node HTTP 真路由返回一张回执、一笔 PAPER 流水、一条审计；重复请求不再扣 | 隔离账本 -120000 分 | TAP: `isolated synthetic approval completes one paper payment...`、`isolated HTTP payment uses real MOT routes...` | PASS_LOCAL |
| EXT-01 | 公网 Staging；独立 token owner B | 重放三个故事与正向付款 | 同版本、可复现且互不污染的响应 | 主线完成 16 次 HTTP 请求，三个故事返回 READY/PARTIAL/BLOCKED；正向付款因 Core/Risk 不可用返回 409；未认证 401、跨 owner 404、Cookie 跨源写入 403。浏览器口令仍固定到 owner A，多位评委共享其演示账本 | B 仅新增任务/会话，无扣账 | [qa-delivery-staging-20261101.json](./qa-delivery-staging-20261101.json)；`deployment/mot-staging-entry.js` | BLOCKED |
| EXT-02 | 公网 Staging | 真正 Core/Risk 审批及正向 1200 元模拟支付 | 可验证审批、回执与扣账 | Worker 构造 MotEngine 时没有 `coreRisk`；health 明示 UNAVAILABLE，正向公网链路不可演示 | 无 | `deployment/mot-worker.js` | BLOCKED |
| EXT-03 | 官方赛题说明 | 将三个门店故事映射到至少三个官方核心场景 | 每个场景有独立端到端证据 | 官网列出 01 智能转账、02 账单分析、03 理财操作、04 卡片管理、05 订阅/代扣、06 跨场景联动，要求至少三个。门店余额、对账、被阻断房租付款不是三个不同官方场景；现有固定持仓和受阻转账也未形成 01/03 完整闭环 | 无 | [赛事官网](https://fintechathon.g-ican.com/) 公开赛题说明（搜索索引全文，官网 SPA 直开需 JS）；内部 PRD 只作团队基线 | BLOCKED |
| EXT-04 | MOT Staging 当前路由 | 真实模型解释调用与费用 | 记录次数、费用、预算 | 本轮 MOT 调用为确定性路由，真实模型调用 0；账户级已用费用和剩余额度未取得 | 无 | `app/router.js`；Staging entry 仅放行 app/mot API | BLOCKED |
| UI-01 | 桌面/手机浏览器 | 360/390/768/1440、抽屉与软键盘 | 无遮挡、可点击 | 主线在 Staging 浏览器四个模拟视口验证无水平溢出、输入框及抽屉在可视区；软键盘和 Android/iOS 真机未测 | 无 | [桌面](./screenshots/staging-approval-desktop.png)、[手机聊天](./screenshots/staging-mobile-chat.png)、[手机抽屉](./screenshots/staging-mobile-drawer.png) | NOT_TESTED |
| UI-02 | 麦克风/实时通话服务 | 听写、权限拒绝、断线、返回文字 | 与 MOT 同上下文 | 本轮未启用麦克风；实时通话服务未接通 | 无 | `versions/app.js` 的 `call-mot` 仅显示不可用 | BLOCKED |
| NET-01 | 中国大陆真实网络 | 打开公网 Staging 并执行问答 | 实际可用 | 本轮无大陆网络实测 | 无 | 需大陆网络的请求/浏览器证据 | NOT_TESTED |

## 独立结论

本机 30 个目标测试全部通过；最终全量 `npm test` 为 324/324。矩阵 40 项中，32 项 PASS_LOCAL、6 项 BLOCKED、2 项 NOT_TESTED。三个门店故事在修复后可作为**合成数据只读/阻断演示**。正向 1200 元模拟付款已经通过隔离 Node HTTP 链路，但公网 Staging 的真实 Core/Risk 仍未接通，不能把这项本机通过当作公网通过。应用内实时语音和官方三场景覆盖也无端到端证据。此矩阵不将测试专用 Risk 适配器、固定持仓快照或 Worker 模拟运行时算作真实公网能力。
