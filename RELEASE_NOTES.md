# Anything Analyzer v3.6.72

一次真实会话（12 个执行域 / 465 请求）的健康面板上，两处诊断在装糊涂：`cdp-instrumentation-unavailable` 那条写着「Reason: None reported」，排空超时丢掉的数据记成「Dropped events: Unknown」——而那条 realm 的 `Pending` 明明白白写着 1 events / 1896 bytes。**两样程序都知道，只是没说。**

## 修复

- **失败原因被丢掉，面板上只剩「None reported」** — realm router 把失败原因作为字符串交给 `onFailure`，控制器只 `console.warn` 一下就扔了（打包版的主进程日志一般也留不下来）。于是「CDP WebSocket 断了」「worker 入口脚本没改写」「realm 初始化失败」在界面上长得一模一样。

  **不能原样存**：原文里有 URL、targetId 和任意错误文本（例如 `Worker entry script was not rewritten for <targetId> (<url>)`），而诊断面板底下明确写着「不含 URL、正文、请求头、Cookie、hook 参数、交互值与自由文本」。改为分类成 17 个固定的码存进 `CaptureGap.detail`，面板显示码——回答了「到底是哪一类失败」，同时一个字节的内容都不落库。健康快照本来就是整段 JSON，不需要迁移。

- **排空超时把数得出来的丢失记成「未知」** — 会话停止时，realm 队列里压了几条是当场读得到的（`pendingEvents` / `pendingBytes`），却按 `unknown-coverage` 记、丢失条数留空。现在按 `known-loss` 记实际条数；只有「在途但数不出」（`processing` 为真而 `pendingEvents` 为 0）才仍是 `unknown-coverage`。上面那次会话会从「覆盖未知 / Dropped events: Unknown」变成「已知丢失 / Dropped events: 1」。

## 关于这次的改法

- **`cloak-realm-router.ts` 一行没动。** 更干净的做法是让 router 自己带上分类码（编译器保证不漏），但那是抓包路径，本项目的规矩是改它要配一批 12 轮真实 Cloak 验证跟基线对比。这次的需求在控制器这一层就能做完，所以就留在这一层。

- 代价是分类靠前缀匹配，router 的原文一改就会静默退化成 `other`。因此加了一条**读 router 源码的守护测试**：把每个 `reportFailure` 的模板骨架抽出来（插值换成占位符），逐条过分类器，要求都不是 `other`。它当场抓出 5 条漏掉的规则，其中 `Realm cleanup failed` 和 `Root CDP cleanup failed` 是人工通读时没发现的。目前 21 条全覆盖。

## 验证

- 全量测试：631 passed，23 skipped。其中 `tests/main/db/capture-reliability.test.ts` 的 18 项需要 Electron 的原生模块 ABI（本机 `postinstall` 按 Electron 构建，Node 侧加载不了），改用 `node scripts/run-electron-vitest.mjs` 与迁移测试一起运行，32 项通过；CI 里由 `rebuild:native:node` 处理。
- 新增 25 项测试（其中 21 项是守护测试逐条过 router 的失败原文）。三次摘除验证：排空超时退回 `unknown-coverage` 时 `expected 'unknown-coverage' to be 'known-loss'`；不传分类码时 `expected null to be 'worker-entry-script-rewrite-failed'`；分类器少一条规则时 `expected 'other' not to be 'other'`。
- 另有一条断言把带 URL 和 targetId 的原文喂进去，序列化后的缺口记录里搜不到那个域名，也搜不到那个 targetId。
- 类型检查（主进程 + 渲染进程）、`npm run build` 通过；内部包打包、产物校验、启动冒烟与 UI 冒烟通过。

## 已知问题

- **排空循环没有节流**：`stopOnce` 里 `do { await this.poll() } while (Date.now() < deadline)` 之间没有退避。生产环境下每轮走真实 CDP I/O，自然被拖慢，所以实际表现是「最多 5 秒内反复轮询」；但在假时钟下会活锁。属于抓包路径的既有行为，同样受 12 轮验证那条规矩管，本次未改。
- 3.6.71 的两条修复（输出上限截断的识别与提示）仍未在真实会话上验证过——触发它们需要再跑一次会撞上限的分析。
- 一轮分析里工具结果有**累计**总预算（实测：128k 窗口约 27k token ≈ 108KB，32k 窗口约 21KB），耗尽后工具结果整条替换为 `[tool result omitted: context budget exhausted; query a narrower range]`。
- AI 请求日志只保留原始 SSE 的**前** 100,000 字符，而 `finish_reason` 在流的末尾——长回复时日志里看不到它。靠 `completion_tokens` 是否正好等于配置的上限即可判断。
- 放宽相关性筛选后进入分析的请求会变多，索引条数的实际变化需要一次真实会话来量。
- 快速连续导航时，偶发（约 1/27）有文档执行域未能建立推送通道，被下一次导航销毁时带走尚未送出的数据。该情况会如实记为缺口，不会静默丢失。
- 混合压缩阶段若取消，摘要调用抛出的取消会被压缩层的 catch 吞掉，退回规则压缩；取消仍会在下一步生效，不会多花一次调用。

## 下载

| 平台 | 文件 |
|------|------|
| Windows | Anything-Analyzer-Setup-3.6.72.exe |
| macOS (Apple Silicon) | Anything-Analyzer-3.6.72-arm64.dmg |
| macOS (Intel) | Anything-Analyzer-3.6.72-x64.dmg |
| Linux | Anything-Analyzer-3.6.72.AppImage |
