# AI Banking Agent / Personal AI Fund Manager

受控的合成资金演示：在一个聊天入口查询门店资金、核对样本流水，并让 MOT 记录任务、监控和审计。金额由确定性账本代码计算；模型建议不授予付款权限。当前候选的公网正向付款仍被 Core/Risk 门禁阻断。

## 当前入口与职责

- 主入口：`/app`。本机由 `chenchen/server.js` 提供；受控演示站为 [MOT Staging `/app`](https://personal-ai-fund-manager-mot-staging.ai-banking-agent.workers.dev/app)，需要部署负责人提供访问口令。旧 `/mot`、`/merchant`、`/investment` 和 `/risk-workbench` 跳转到同一页面。
- `chenchen/app` 管理会话、确定性任务路由与带来源的答复；`chenchen/mot` 管理合成 Ledger、资金任务、阈值监控、Inbox 和审计。MOT 在同一会话内组织已有模块，当前没有通用 LLM 自主规划。
- `chenchen/merchant` 保留本机账单/现金测算；`chenchen/tools` 的投资工具使用固定演示快照。Core 的工作流和 Memory 在 `chenchen/core`、`chenchen/integrations`，但 Staging 的商户本人审批和 Core/Risk 正向付款尚未接通。`chenchen/versions/app.*` 是唯一主 UI；Worker 入口在 `chenchen/deployment`。
- 浏览器语音听写需要用户点击、转写可编辑且不会自动提交资金操作。浏览器朗读与真实电话、实时语音通话均未作为本候选交付。

## 安装、运行和验证

需要 Node.js 22 或更新版本。`chenchen/package.json` 没有第三方运行依赖或锁文件；使用仓库现有 npm 脚本，不需要安装额外包。

```powershell
cd chenchen
npm run build:app
npm run check
npm test
```

在**仅供本机访问**的终端启动一份新合成数据副本。路径可自行更改；不要复用真实账户数据。

```powershell
$env:MOT_LOCAL_DEMO = 'true'
$env:MOT_SCHEDULER_ENABLED = 'false'
$env:MOT_DATA_DIR = Join-Path $env:TEMP ('ai-banking-demo-' + [guid]::NewGuid())
$env:PORT = '4175'
npm start
```

在另一个终端初始化样本并检查服务；下面的 `127.0.0.1` **只用于本机复现，不是公网入口**。

```powershell
Invoke-RestMethod -Method Post -Uri 'http://127.0.0.1:4175/api/mot/demo/ingest' -ContentType 'application/json' -Body '{"idempotency_key":"demo-seed-1"}'
$env:PORT = '4175'
npm run smoke
```

打开本机 `/app`，在同一新会话依次输入：

1. `帮我看两家店现在有多少钱，资金池里有多少，还有多少没到账。` — 账户合计 15000 元、池内 8000 元、待结算 550 元。
2. `核对今天的收款和到账，哪几笔对不上？内部调拨不要算营业收入。` — 200/200 相符，300/290 差 10 元且原因待核实，550 元待结算；500 元内部划转不计收入。样本非全天完整数据，状态为 `PARTIAL`。
3. `帮我支付 13,500 元房租。` — 已登记付款账户的池内资金仅 8000 元，缺口 5500 元；状态 `BLOCKED`，不发生付款。

三步连续使用同一合成账本，查询与阻断均不改变余额。再次用新数据目录启动可以得到空白副本。精准断言在 `chenchen/tests/mot-coordinator.test.js`；公网隔离验收历史记录在 `chenchen/docs/qa-delivery-staging-20261101.json`。正向 1200 元 PAPER 付款仅在隔离测试中注入合成 Risk/审批适配器，公网服务不具备该正向链路。

## 配置、部署与限制

变量说明见 [`.env.example`](.env.example)。Node 不自动读取该文件；本机演示显式设置环境变量。Cloudflare Staging 使用 `wrangler.mot-staging.toml`，访问口令、会话签名、MOT token 和 Cron 密钥须作为 Worker Secrets 由有权限的部署者配置。`MOT_BUILD_SHA` 应绑定已测试的提交，并从已认证的 `/api/mot/health` 核验。推送分支本身不发布 Worker。

当前 Staging 口令映射共享合成 owner；真正的用户身份、Core/Risk 本人审批、正向公网模拟付款、官方三类完整核心场景、实时语音、移动真机及中国大陆无代理访问仍未通过验收。参见 [最终交接](chenchen/docs/FINAL_HANDOFF.md) 和 [既有验收矩阵](chenchen/docs/qa-delivery-matrix-20261101.md)。
