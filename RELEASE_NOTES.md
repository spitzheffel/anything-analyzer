# Anything Analyzer v3.6.71

3.6.70 之后跑了一次真实会话（465 请求 / 527 hooks），当场暴露两个问题：报告写到一半停了，结构化抽取报「JSON 语法错误」。两个都是同一个根因——**模型撞上输出上限停手，而应用根本不看它为什么停**。

## 修复

- **模型在输出上限处停手时，半截正文被当成写完的报告** — 落库、渲染、喂给抽取器，全程没有任何提示。全仓搜 `finishReason` 零命中：AI SDK 在 `finish-step` 分片上给了这个字段，就在我们已经在读的 `usage` 旁边，从来没人碰过。于是「正常写完」「撞上限」「上游流提前断开」三种情况在应用眼里完全一样。

  实测那次运行的日志：`analyze` 的 `completion_tokens` 正好 4096（= 配置的 `maxTokens`），报告停在 `| POST | ` 之后的反引号处——表格单元格中间，反引号都没闭合。

  现在 `LLMResponse` 带上 `finishReason`（多步时取最后一步的，中间几步都是 `tool-calls`）。报告被截断时：记进 `analysis_reports.output_truncated` 新列，报告面板上单独一块「报告不完整」警告排在最前，生成过程里也发一条说明该去改哪个设置；同时**跳过自动抽取**——残报告抽出来的 Spec 一定也是残的，原因写进 `spec_error`，用户仍可手动点「重新抽取」。

- **结构化抽取被截断时只说「JSON 语法错误」** — 一句对用户毫无可操作性的话。同一次运行里 `extract` 的 `completion_tokens` 正好 8192，JSON 断在半截。现在直接说「结构化输出在 N tokens 的输出上限处被截断」，并且**不再走降级路径**：降级受同一个上限约束，再试一次只是把钱烧两遍。

- **抽取的输出上限是写死的 8192** — 代码注释自己就写着「被截断的 JSON 等于全失败」，而 8192 装不下几百条请求的 Spec。但也不能改成「模型能吐多少就要多少」：`spec-extractor` 的报告预算是 `窗口 − 输出上限 − 提示词实测 − 余量`，多报的每个 token 都从喂进去的报告里扣——真按 gpt-5 声明的 128k 报，400k 窗口里报告就少了 12.8 万 token 的位置。

  改成三条约束取最小：模型自己声明的上限、一份 Spec 顶天需要的 65536、窗口能匀出的 25% 份额。表里查不到的模型（多是中转的自定义模型名）保守按 32768 算——已知的 44 条规则里有 32 条上限不到 64k，对不认识的模型报高了会被服务端 400，那会变成每次抽取都硬失败。用户自己把「最大输出 tokens」调得更高时以用户的为准。

  实际落点：

  | 模型 | 窗口 | 抽取上限 | 模型声明 |
  |---|---|---|---|
  | gpt-5 | 400k | 65,536 | 128,000 |
  | claude-sonnet-4.5 | 200k | 50,000（份额压的） | 64,000 |
  | gemini-2.5-pro | 1M | 65,536 | 65,536 |
  | deepseek-r1 | 131k | 32,768 | 65,536 |
  | gpt-4o | 128k | 16,384 | 16,384 |
  | 表里没有的模型 | 1M | 32,768 | — |

## 说明：两个设置项容易混

- **最大输出 tokens**（`maxTokens`）→ 真的发给 API，管**一次回复最多吐多少**。默认 4096。
- **最大上下文 (tokens)**（`maxContextTokens`）→ 从不发给 API，只在本地做预算，管**提示词塞到多大该压缩**。

把上下文开到 1M，只是让送进去的东西可以很多；吐出来的另有一道闸。开了思考（`reasoningEffort`）时，思考 token 与正文**共用**输出上限。报告写不完整时，先看的应该是前者。

## 验证

- 全量测试：606 passed，23 skipped。其中 `tests/main/db/capture-reliability.test.ts` 的 18 项需要 Electron 的原生模块 ABI（本机 `postinstall` 按 Electron 构建，Node 侧加载不了），改用 `node scripts/run-electron-vitest.mjs` 与迁移测试一起运行，32 项通过；CI 里由 `rebuild:native:node` 处理。
- 新增 8 项回归测试，每条都先把修复摘掉确认会挂：`expected undefined to be 'length'`、`expected [Function] to throw error matching /输出上限/ but got '结构化输出解析失败: 回复中没有 JSON 对象'`、`expected +0 to be 1`、迁移不注册时挂 2 项。
- `finishReason` 那条走真实 HTTP：本地中转按 `finish_reason: "length"` 回一段半截正文，断言收到的正文就是那半截——和真实会话里那份报告同一个形状。
- 类型检查（主进程 + 渲染进程）、`npm run build` 通过；内部包打包、产物校验、启动冒烟与 UI 冒烟通过。

## 已知问题

- **这两条修复本身还没在真实会话上验证过。** 触发它们需要再跑一次会撞上限的分析。
- 一轮分析里工具结果有**累计**总预算（实测：128k 窗口约 27k token ≈ 108KB，32k 窗口约 21KB），耗尽后工具结果整条替换为 `[tool result omitted: context budget exhausted; query a narrower range]`。所以正文分页适合定位尾部，不适合通读大文件。
- AI 请求日志只保留原始 SSE 的**前** 100,000 字符，而 `finish_reason` 在流的末尾——长回复时日志里看不到它。现在靠 `completion_tokens` 是否正好等于配置的上限即可判断，但日志本身仍是只留头部。
- 放宽相关性筛选后进入分析的请求会变多，索引条数的实际变化需要一次真实会话来量。
- 快速连续导航时，偶发（约 1/27）有文档执行域未能建立推送通道，被下一次导航销毁时带走尚未送出的数据。该情况会如实记为缺口，不会静默丢失。
- 混合压缩阶段若取消，摘要调用抛出的取消会被压缩层的 catch 吞掉，退回规则压缩；取消仍会在下一步生效，不会多花一次调用。

## 下载

| 平台 | 文件 |
|------|------|
| Windows | Anything-Analyzer-Setup-3.6.71.exe |
| macOS (Apple Silicon) | Anything-Analyzer-3.6.71-arm64.dmg |
| macOS (Intel) | Anything-Analyzer-3.6.71-x64.dmg |
| Linux | Anything-Analyzer-3.6.71.AppImage |
