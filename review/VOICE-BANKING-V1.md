# Voice Banking Assistant V1 开发候选（2026-10-29）

状态：浏览器 ASR/TTS 原型，可本地验收；不是 Staging 验收、生产就绪或团队正式交付。没有部署、没有合并 main、没有修改 team-staging。

GitHub 当前账号 lixjanus526-art 对目标仓库仅有 pull 权限（push=false）；采用个人分叉 lixjanus526-art/agent 的同名开发分支及指向目标 main 的 Draft PR 供审核。目标 main 由 Owner 审查后决定是否接收，不绕过保护。

## 审查结论

- 明确目标为 realchenchenluo/agent，基线 main `1d2052f4fe6dbd4ed7d2236ca5398242be2e5fa6`。独立目录 F:/voice-banking-source，分支 codex/voice-banking-v1；初始工作区干净。
- 原 F:/人工智能AI 比赛 属于 Fintechathon-agent/Fintechathon-agent，分支 codex/kosx-landing-glass，存在大量用户修改，完整保留，未向该仓库同步本轮文件。
- 根 README 只有项目名。读取 chenchen/README.md、contracts/README.md、docs/public-backend-deployment.md、server.js、deployment/worker.js、cloudflare/worker.js、wrangler 配置、integrations/model-review.js、bailian-provider.js、review-workflow.js 和现有前端。
- 实际默认页是 /investment，根 index.html 的旧聊天 getAgentReply 是固定回复，且 /index.html 被路由为投资页。没有把该历史聊天认定为真实 Agent，也没有建立另一套聊天页。
- 可用输入链路是 /risk-workbench 原有“你想做什么”文本框和“发起模型复核”按钮。本轮在这里接语音，复用 funding 确认、/api/review、Risk、任务及审计。此范围不是完整的统一工作台聊天产品；真正统一聊天 UI 与身份接入需产品/后端 Owner 确定。
- https://realchenchenluo.github.io/agent/risk-workbench/ 实测 HTTP 200。公开 Worker /health 返回 configured=true、cloudflare_workers_ai 和 durable_object。一次仅含虚构内容的 /api/review 实测 HTTP 200、source=model、call_succeeded=true，模型 @cf/meta/llama-3.3-70b-instruct-fp8-fast；不是百炼调用。
- 真实测试 task_id=review-task-00a6e09a-66fd-410c-8582-5063ca39c2f7，run_id=review-5bd37d45-0afe-4742-9778-1a6243f85eac；PENDING_RISK、execution.status=BLOCKED、execution_allowed=false、receipt=null。模型明确缺少账户信息。没有调用审批、模拟或执行端点。
- 本机 Node fetch 直连 Worker 失败，curl 可访问。该网络证据不能推断所有大陆网络可达。
- Worker 主入口为 chenchen/deployment/worker.js；根 cloudflare/worker.js 是旧配置。百炼现有适配器限制 qwen3.7-flash、北京专用 workspace 与显式付费预算；不适合直接借作 ASR，也未修改。
- 当前服务是演示身份边界，未证明正式 RBAC/最终用户身份。账单模型复核、投资样例计算、任务/审计接口存在；真实账单、真实账户分析、任意账户风险查询、统一任务导航均不承诺已接通。语音仅改变输入方式。

## 功能与文件

- versions/voice-banking.mjs：可注入 BrowserAsrAdapter、BrowserTtsAdapter，输入校验与 UI 状态；请求授权/录音/识别/成功/失败/取消；中文和英语；不自动发送；保留原草稿，识别期间编辑会取消晚到结果。
- versions/voice-banking.css：沿用现有按钮与颜色，44px 触控目标、换行布局、键盘焦点。
- versions/risk-workbench.html/js：在现有输入旁挂载语音；发送仍需原确认流程；校验文本；60 秒请求超时；不把规则降级标成真实模型。朗读仅读取当前可见模型解释，自动朗读固定关闭。
- server.js 只增加两项静态资源白名单，没有更改 /api、风控、审批、公共 Schema 或后端业务逻辑。
- tests/voice-banking.test.mjs 和 scripts/voice-banking-browser-check.cjs：适配器和真实页面交互检查。

ASR 明确点击并勾选本次音频处理同意后才启动。授权启动 15 秒、录音最长 60 秒、等待识别 10 秒；开始间隔 1.5 秒且同一实例单会话。该节流只是浏览器体验保护，不是安全限流。云端身份限流在 Contract 确认后由后端实现。失败/取消/切后台/离开页面清理 recognition 和定时器；结果更新停止朗读。不创建 MediaRecorder、音频文件或音频上传接口；浏览器服务商可能远程处理音频，其保存政策不由本应用控制。不得承诺端侧或离线识别。

## 本地复现

启动现有服务（不需要新依赖或语音密钥）：

```powershell
Set-Location F:\voice-banking-source\chenchen
$env:PORT = '4198'
node server.js
```

打开 http://127.0.0.1:4198/risk-workbench ：

1. 初次进入不应弹麦克风授权；不勾同意点击录音不应调用识别。
2. 同意后开始录音，说一段虚构需求；停止后文本进入原输入框。编辑它，确认不会自动发送。
3. 取消、重新录音、拒绝授权、拔掉麦克风、断网、切换页面分别检查；文字输入始终可用。
4. 手动确认虚构资金安排，再手动发起复核。本地无模型 Secret 时应显示 503 失败；不要把它当作模型成功。
5. 后端 Owner 配置现有模型服务后，检查真实返回的 source/model 标记、task/run/audit、PENDING_RISK 与 execution_allowed=false。转账/买卖语音只能作为待复核文本，不得直接调用审批和执行。
6. 展开已有模型解释再点朗读、停止；没有可见回复时不能读隐藏记录；自动朗读关闭。

运行现有语法检查和测试（等同 package.json 的 check/test）：

```powershell
node scripts/check.js
node --test
```

浏览器检查需外部安装 Playwright，不增加产品运行依赖；使用已安装 Chrome/Edge：

```powershell
$env:VOICE_BROWSER_CHANNEL = 'chrome' # Change to msedge for Edge
node scripts/voice-banking-browser-check.cjs
```

可设置 VOICE_TEST_URL 改验收地址。检查脚本预期目标为未配置模型的本地服务，ASR/TTS 使用明确的测试替身；不是声学识别验收。当前环境通过 NODE_PATH 指向应用自带 Playwright。

## 环境变量（仅名称，无密钥）

本轮浏览器 ASR/TTS 不新增服务端变量。现有本地模型配置可涉及 MODEL_PROVIDER、MODEL_API_KEY、MODEL_API_URL、MODEL_API_STYLE、MODEL_NAME；百炼现有适配器涉及 DASHSCOPE_API_KEY、BAILIAN_WORKSPACE_ID、BAILIAN_REGION、BAILIAN_ALLOW_PAID_CALLS、BAILIAN_TEST_BUDGET_CNY、BAILIAN_MAX_OUTPUT_TOKENS。CORE_AGENT_API_KEY 若开启必须由受信任后端转发，不能加到网页。Cloudflare Workers AI 使用 AI/REVIEW_SERVICE 绑定；本轮未读取或改动任何 Secret。

## 测试边界

- 通过：14 项新增语音适配器测试；完整 node --test 共 298 项、0 失败；现有 JavaScript 语法检查。
- 浏览器：Chrome 156.0.8078.49、Edge 156.0.4314.50，375/768/1440 宽度；同意门槛、停止/取消、拒绝授权事件、可编辑转写、不自动发送、无资金确认阻断、pagehide 清理、可见内容朗读、真实本地 API 503 和原文本传递、无横向溢出、无页面异常。ASR/TTS 为替身，浏览器进程和页面为真实。
- 公网：上述一次真实模型复核通过；无账户信息、敏感资金需求仍在 Risk 等待且禁止执行。
- 未测试：真人麦克风与操作系统授权弹窗、识别准确率、真实声卡缺失、真实音频网络故障、扬声器输出、Android/iOS 真机、正式用户无权限/跨账户请求、百炼 ASR、Staging 和生产。
- npm 命令不在当前 PATH，执行了 package.json 中对应 Node 命令；仓库没有独立 lint/build 脚本。默认 Playwright 下载浏览器缺失，改用现有 Chrome/Edge 完成检查，不是测试豁免。

## 阻塞与负责人

1. 后端/身份 Owner：正式身份、RBAC、会话撤销与账户级审计；现有演示身份不能作为生产认证。
2. 后端/云平台 Owner：确认 docs/contract-proposals/2026-10-29-voice-asr.md，准备地域、预算、Secret 和云端 ASR。
3. 产品/UI Owner：确认统一聊天入口及可调用能力清单；当前最小闭环仅在已有真实复核输入区。
4. QA/用户：Chrome、Edge 真人麦克风和 Android/iOS 真机语音、读音与隐私验收。
5. 发布 Owner：现有 Pages 构建只复制固定文件，尚不会打包新 voice 资源；批准 Staging 时必须补打包并验证路径。当前分支没有触发部署，没有修改正式发布目录。

## 官方依据（2026-10-29 查询）

- [百炼短音频接口](https://help.aliyun.com/zh/model-studio/recording-file-recognition-qwen)：qwen3-asr-flash 可用同步短音频方案，支持 URL/Base64；北京和新加坡分别使用匹配地域 Key。
- [音频规格](https://help.aliyun.com/zh/model-studio/asr-model)：qwen3-asr-flash 支持 wav/mp3/webm/opus 等，最长 5 分钟、10 MB，pcm 16 kHz。新版概述还列出 qwen-audio-3.1-asr-flash；Owner 应按获准地域和模型广场确认可用版本。
- [配额](https://help.aliyun.com/en/model-studio/rate-limit)：qwen3-asr-flash 文档列北京/新加坡 100 RPM，按主账号聚合；不是本项目已获配额或免费额度证明。
- [MDN 浏览器处理位置](https://developer.mozilla.org/en-US/docs/Web/API/SpeechRecognition/processLocally)：默认可能远程识别；本地识别属性仍具实验性。
