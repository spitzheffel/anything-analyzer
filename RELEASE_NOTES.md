# Anything Analyzer v3.6.69

本版本集中修 AI 分析与报告这一块：一次系统评审找出的准确性问题、取消路径缺失，以及若干静默截断。

## 修复

### 分析准确性

- **内联预算削掉了工具、搜索和鉴权链能看到的正文** — `DataAssembler.assemble()` 无条件把最大的响应体就地截到 1/4（预算是整会话 30000 token = 12 万字符，50 条 20KB 响应就会触发）。但它的产物是所有人的数据源：`get_request_detail` 即使 `full=true` 也拿不回来（原文只在库里）；`search_requests` 在被丢掉的 3/4 里的命中直接搜不到，而它的职责正是定位 token 和加密参数；`extractAuthChain` 对响应体做 `JSON.parse`，截断过的 JSON 一定失败，被 `catch` 吞掉后整条鉴权链消失——而 `authChain` 同时喂给报告的鉴权链段、`SessionEnrichment` 和结构化抽取的提示词。实测 20 个登录响应只有 8 个进了鉴权链。

  而正文只有 `legacy_inline` 会内联进提示词，默认的索引优先模式明确不内联。也就是说这个预算在默认模式下没有任何收益，只在削证据。现在把它挪到真正内联的那一步：`assemble()` 返回全文，`budgetInlineBodies()` 给那一路返回削过的副本。工具那一路本来就有自己的两层预算（每字段 8k/40k 的 `clip`，以及按实时上下文预算收口的 `createToolResultLimiter`）。

- **结构化数据抽取失败，提示 `No output generated.`** — `completeStructured()` 用 `generateText` + `Output.object`，这个组合抛的是 `NoOutputGeneratedError`，而判别函数只认 `generateObject` 抛的 `NoObjectGeneratedError`。于是那条专为此准备的降级路径（普通回复 + 手动抠 JSON + schema 校验）从来走不到。

- **预过滤静默丢批次** — 回复解析只接受裸数组或纯围栏数组，`好的，相关请求如下：[1,3,5]` 和 `[1,3,5]\n这些是登录相关的请求。` 都解析为空，调用处用 `?.forEach` 直接丢掉，整批请求不参与筛选而进度条照常报数。现在按已有的 `extractJsonObjectText` 同样方式抠出数组，解析不了的批次会计数播报；过半批次失败时整个筛选结果不予采信，退回全量分析。

- **`search_requests` 静默截断** — 命中到上限就停，打印「命中 20 条（limit=20）」，既没有总数也没有 offset 参数，模型很容易当成全部。现在先数全再切片，报 `matched/returned/offset` 并打印续查调用，与 `list_requests` 一致。

- **工具侧态说明无上限、且会指向已删除的请求** — 「已拉取详情的请求」会把历史上拉过的每个序号都铺进**每一轮**追问的提示词（`recentRefs` 有 12 条上限，它没有）。另外 `hydrateToolSessionFromHistory` 会从历史标记重建侧态并写回，清空抓包数据后那些序号又回来了，指向已经不存在的请求。现在只列最后 60 条并标注总数，只保留工具当前还取得到的序号，`data:clear` 和 `session:delete` 都会清掉对应侧态。

- **抽取提示词的请求索引可能远超预留** — 取头部 120 条后再无上限地追加报告引用过的序号，1000 条请求引用 400 条时索引会涨到 460 行，而 `PROMPT_OVERHEAD_TOKENS` 是按"最多 120 行"预留的 12k。小窗口的抽取模型会直接超窗。现在硬上限 240 行、被引用的优先占位，预留按实测调到 16k（长 URL 索引行约 46 token，ProtocolSpec 的 schema 提示约 1.3k）。

### 交互

- **追问（AI 追问）无法取消** — `AiAnalyzer.chat` 不接受 AbortSignal，`ai:cancel` 只作用于分析；而追问期间输入框、模型选择和「重新分析」全部禁用，停止按钮只在分析态渲染。加上请求层的 10 分钟超时只管首包（有意为之），响应头到达后流卡住就只能重启应用。现在新增 `ai:cancelChat` 通道把 signal 传到底，追问态下有独立的停止按钮；取消会回滚那条尚未落库的用户消息，并且取消与「回复刚好写完」擦肩而过时不会把被回滚的消息写进库。

- **结束的 AI 调用会把接替它的那次注销掉** — 发起分析会打断上一次并装上自己的 controller，但上一次解绑时是按会话 id 删的，于是把新那次从表里抹掉了：停止按钮变成空操作，新的分析在「空闲」的界面背后继续烧 token。追问的报告保护（`activeChatReports`）是同一个形状，改成引用计数。

- **报告代码块被引用改写污染** — `[#12]` 的链接改写作用在整段 markdown 上，而围栏内 markdown 链接不解析，于是复现代码里会多出字面量 `(seq://12)`。现在跳过围栏和行内代码；反引号不配对或围栏没收尾时一律不改——少一个链接比改坏代码强。

## 验证

- 全量测试：570 passed，20 skipped。其中 `tests/main/db/capture-reliability.test.ts` 的 18 项需要 Electron 的原生模块 ABI（本机 `postinstall` 按 Electron 构建，Node 侧加载不了），改用 `node scripts/run-electron-vitest.mjs` 运行后全部通过；CI 里由 `rebuild:native:node` 处理。
- 新增 28 项回归测试。每一条都先把修复摘掉确认会挂，失败信息就是问题本身：20 个登录只有 8 个进鉴权链、尾部内容搜不到也取不到、`命中 5 条` 该是 30 条、停止按钮拿不到 controller、被取消的追问仍被落库、代码块里冒出 `seq://12`、索引 460 行该是 240 行、侧态列出 500 个序号、已删除的 `#77` 仍出现在提示词里。
- 类型检查（主进程 + 渲染进程）、打包与产物校验通过。

## 已知问题

- 快速连续导航时，偶发（约 1/27）有文档执行域未能建立推送通道，被下一次导航销毁时带走尚未送出的数据。该情况会如实记为缺口，不会静默丢失。
- 混合压缩阶段若取消，摘要调用抛出的取消会被压缩层的 catch 吞掉，退回规则压缩；取消仍会在下一步生效，不会多花一次调用。

## 下载

| 平台 | 文件 |
|------|------|
| Windows | Anything-Analyzer-Setup-3.6.69.exe |
| macOS (Apple Silicon) | Anything-Analyzer-3.6.69-arm64.dmg |
| macOS (Intel) | Anything-Analyzer-3.6.69-x64.dmg |
| Linux | Anything-Analyzer-3.6.69.AppImage |
