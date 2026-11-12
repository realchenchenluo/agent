# Account Hub v1：多场景、多平台、一个账户统一管理

日期：2026-10-28

## 已完成

这次把 GitHub 调研得到的几类能力适配进现有 Personal AI Fund Manager：

- 参考 MIT 项目的账户目录和只读优先设计，新增银行、基金/证券、支付钱包、信用卡、手工账本五类来源；
- 参考账单对账项目的统一明细结构，账户下可以保存持仓、现金、待付款、收入和支出；
- 每个来源保留平台、金额、可用金额、来源、数据日期、确认状态和权限边界；
- Core Agent 读取账户汇总和来源明细，用于理解跨场景问题；
- 账户变更带请求编号和幂等键，重复提交不会重复写入；
- 新增跨场景预检：投资与房租冲突、账单跟进、持仓安排、订阅检查和跨平台比价；
- 所有账户来源都固定为只读/模拟，`execution_allowed=false`，不连接真实银行，不接收密码、Token 或银行卡密钥；
- 原有持仓核对、Risk、Memory、人工审批、SSE 和模拟执行流程继续保留。

## 页面怎么使用

打开集成页后，页面顶部新增“统一账户中心”。

1. 点击“试用合成数据”，加载四个演示来源：银行、基金、支付钱包和信用卡；
2. 页面会显示资产总额、可用金额、待付款、净资产和最近到期日；
3. 点击某个来源，可以展开查看房租、学费或信用卡待还等明细；
4. 点击“手动添加一个资金来源”，可录入自己的合成数据或已经整理好的记录；
5. 在“想核对一件跨场景的事”中输入：

   `我想再投入8000元买基金，但下个月还要交房租，资金够不够？`

6. 点击“先看怎么处理”，系统先给出问题分类和需要补充的信息；
7. 点击“把这件事交给对话继续”，才会把问题送入现有 Core Agent 对话链路；
8. 任何需要资金动作的请求，仍必须经过 Risk 和人工审批，当前产品只允许模拟。

## API

这些接口都位于同一个浏览器访客会话下，并沿用现有 CSRF 和 Durable Object 隔离。

### 获取账户总览

```http
GET /api/local/accounts
```

返回 `accounts`、`summary` 和最近的账户审计记录。摘要包含：

- `total_assets_cents`：各来源账户金额合计；
- `available_cents`：用户填写的可用金额合计；
- `liabilities_cents`：信用卡等待还金额；
- `obligations_cents`：已录入的待付款明细；
- `upcoming_obligations`：按日期排列的待付款；
- `data_quality`：已确认和待确认来源数量。

### 加载合成数据

```http
POST /api/local/accounts/demo
Content-Type: application/json

{"idempotency_key":"account-hub-demo-v1"}
```

重复使用同一个 `idempotency_key` 会返回原结果，不会重复添加账户。

### 添加一个来源

```http
POST /api/local/accounts
Content-Type: application/json

{
  "request_id": "account-request-001",
  "idempotency_key": "account-write-001",
  "account": {
    "display_name": "我的银行卡",
    "platform": "bank",
    "account_type": "bank",
    "balance_cents": 5000000,
    "available_cents": 4200000,
    "source": {
      "channel": "USER_ENTERED",
      "label": "用户手工录入",
      "as_of": "2026-10-28",
      "confirmed": false
    },
    "entries": [
      {"label":"房租","kind":"obligation","amount_cents":800000,"due_on":"2026-11-01"}
    ]
  }
}
```

### 跨场景预检

```http
POST /api/local/accounts/plan
Content-Type: application/json

{"question":"我想买8000元基金，但下个月要交房租，资金够不够？"}
```

这个接口只返回 `scenario`、原因和需要补充的信息，不会调用资金工具，也不会修改账户或执行操作。

## 和现有 Core Agent 的关系

账户中心是数据归集和问题预检层。Core Agent 现在会读取账户汇总和来源明细，再结合现有持仓、Memory 和模型网关理解问题。金额计算继续由确定性工具完成，Risk 仍是资金动作的必经环节。

模型只能提出解释或建议，不能把账户中心里的记录改成“已付款”“已交易”或“已保存”。真实平台接入时，仍需为每个平台单独开发只读连接器，并通过来源、日期和确认状态验收。

## 本地验证

在 `chenchen` 目录执行：

```text
npm run check
npm test
npm run demo:account-hub
```

本次结果：

- `npm run check` 通过；
- 全量 Node 测试通过：403 项通过，1 项按既有条件跳过；
- 账户中心新增测试 5 项全部通过；
- 演示脚本验证 4 个合成来源、资产总额 ¥133,000、可用金额 ¥44,000、待付款 ¥25,000；
- 跨场景问题被识别为 `FUNDING_CONFLICT`；
- 所有结果的 `execution_allowed` 为 `false`。

## 部署说明

部署前先执行 `node integration/public-chat/build.mjs`，它会把 `app.html`、`review.js` 和 `review.css`生成到 `integration/public-chat/public/`，再由 Wrangler 发布。当前工作只完成代码和本地验证，没有直接替换线上生产版本，也没有接入真实银行或付费模型。
## 公网演示

当前独立演示地址：

https://personal-ai-fund-chat-account-hub-preview.realchenchenluo.workers.dev

这是独立的 preview Worker，不覆盖原有正式地址。页面里的账户、房租、学费、基金和信用卡数据均为合成数据，模型回答使用测试替身；不会连接真实银行、不会产生真实资金动作。打开后点击“试用合成数据”，再输入“我想再投入8000元买基金，但下个月还要交房租，会不会影响生活安排？”即可看到资金冲突检查。

