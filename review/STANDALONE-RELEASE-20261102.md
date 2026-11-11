# Standalone 发布资源修复交接

日期：2026-11-02。交给 Sean 审核；不代表授权合并或部署。

## 范围和最终候选

- 团队 main 基线 `25be827a2363a3274df94819eae1fa166e92883f`。
- [UI P0 PR #7](https://github.com/realchenchenluo/agent/pull/7) HEAD 保持 `54a91f72d37be77b70d4eada0ee838913f69de63`，没有丢失或覆盖。
- [语音 PR #1](https://github.com/realchenchenluo/agent/pull/1) HEAD `5ac8c12daa2b35b6567c48b35ce042b3314d54d2`，未合并。
- 同一完整验证候选 SHA：`a11817e37f75776f2650f3e07bfeca2bf997425f`，个人 Fork 分支 `codex/ui-release-stability-20261102`，包含原 #7 和与本 PR 相同的发布补丁。
- [完整 A-F 验收报告及真机步骤](https://github.com/lixjanus526-art/agent/blob/a11817e37f75776f2650f3e07bfeca2bf997425f/review/ui-release-20261102/ACCEPTANCE.md)。同目录含测试日志、API 证据、浏览器明细和六张发布产物截图。

## 修复和验证

本 PR 只有工作流、资源检查、构建回归脚本与本文档。修复四个 task 资源未复制、CSS 绝对路径错误、paths 触发遗漏，并增加上传前递归检查。兼容当前尚无 task 模块的 main；P0 页面存在时要求四件套全部存在。旧补丁 `review/ui-demo-p0-standalone-assets.patch` 已由本 PR 完整替代，不再重复应用。

完整候选：语法检查通过，323 项 Node 测试通过；既有 Chrome/Edge 42 项通过；新增两浏览器 × 三宽度（375/768/1440）六个场景通过，包括 `/agent/` 入口导航、模块加载、刷新和无横向溢出。旧工作流在 P0 源码上复现 `task-view.css` 越出项目路径，补丁通过；逐个移除四资源均被检查器拒绝。

最终 SHA 冻结后再次执行 323 项测试与42项浏览器回归通过。期间 F: 盘断开导致 standalone 截图写入中断；恢复后检查远程 SHA、恢复本轮生成文件并重新执行 standalone 六场景，全部通过，无脚本错误。中断未计为通过，代码未因故障修改。

环境严格区分：LOCAL REAL API 是本机 Node 服务加虚构数据、真实 Tools 和审计查询；MOCK 是异常、回执和静态产物的 API 503 替身；STAGING 未验证；PRODUCTION 仅只读探测现有 Pages 首页/Risk HTTP 200，仍加载旧脚本，不能证明 #7 上线。真机 iOS/Android、真人语音、大陆网络均 UNVERIFIED。#7 HEAD 的 GitHub Actions 查询为0，本机通过不等于 CI。

## 兼容和发布门禁

建议受控集成顺序：审核本发布补丁，再 #7，最后人工解决 #1。只读 merge-tree 确认语音存在 `risk-workbench.html`、`risk-workbench.js`、`server.js` 三处内容冲突。保留 P0 的 TaskClient/观察区/禁用与互斥，只移入可编辑且显式提交的语音输入；静态白名单交 Backend Owner 审核，禁止恢复旧浏览器审批、Risk 或执行。

Voice standalone 后续还需独立补齐两资源复制、CSS 路径与 paths；本补丁不扩大到语音集成，资源图检查会拒绝缺资源产物。未接入付费 ASR。

仍阻塞正式验收：Backend 的可信身份/任务归属/持久化/取消语义；Risk 正式回调；Finance 共享账本；Sean 的同 SHA Staging 与 CI/部署证据；UI 的真机与语音冲突解决后验收。现有身份不可信时执行保持关闭，没有伪造回执或前端批准。

## 可复现命令

以下从本 PR 根目录执行，用于本地组装与路径负例、语法检查，不会运行 Actions 或发布：

```powershell
node chenchen/scripts/standalone-release-test.cjs
node chenchen/scripts/check.js
git diff --check
```

Windows 构建需要 Git for Windows Bash，脚本默认本机安装位置；其他机器设置 BASH_EXE。完整 P0/浏览器回归须检出上述候选 SHA，按完整报告执行。真机必须使用 Sean 提供的同 SHA HTTPS Staging，逐项检查导航/刷新、软键盘、双标签页、断网恢复、未知结果、回执和禁用语义，并记录设备/系统/浏览器与部署 ID。

结论：可交 Sean 审核发布补丁；未经 Sean 审核与联合验收，不宣称正式发布或端到端验收完成。原工作区未改动，无 force push、main merge、权限/Secrets 变更或真实金融操作。
