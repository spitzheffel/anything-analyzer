# Anything Analyzer v3.6.70

接着 3.6.69 往下修同一块：模型能看到的证据，和报告说得出的依据。这批的共同点是**模型看到的 ≠ 实际抓到的，而且模型不知道差多少**。

## 新增

- **`get_request_detail` 支持正文分段续取** — 捕获层单条响应体最大 1MB，而 `full=true` 也只给前 40000 字符，截断标记不带任何续取手段，尾部永远够不着。现在标记里带区间、总长和续查调用：`...[响应体 40000-80000/213456 字符，续看：get_request_detail({seq: 12, full: true, offset: 80000})]`。`offset=0` 且一次取完时输出与改动前完全一致。

- **报告与 Spec 的「有据可查」机械校验** — 只做能机械判断的三件事，不做 LLM 二次校验（不可靠且贵）：报告正文引用了不存在的序号；Spec 条目一条证据序号都没有（`sanitizeSpecReferences` 会丢掉编造的序号但**保留条目本身**，所以「证据为空」正是「说不出依据」的状态，今天已经静默可达）；端点的 `urlTemplate` 匹配不上任何抓到的请求。结论随 Spec 一起落库（`analysis_reports` 新增可空列 `evidence_json`），报告面板上按「存疑」呈现——它是提示，不是判决。此前只有引用校验，而且只发一条瞬时进度事件，生成完就没了。

## 修复

- **请求索引在隐瞒它排除了什么** — 相关性筛选会把 content-type 不含 json / form-urlencoded / multipart、无请求体的 GET 整条丢掉：XML 接口、`text/plain` 的 token 接口、服务端没给 content-type 的 API 都会中招，不进索引，工具也取不到。而 legacy 分支的表头写着「包含被过滤的请求」「本次会话中所有 N 条请求」，N 是**过滤之后**的数。三处一起改：放宽规则（新增 xml / text-plain / protobuf / ndjson / csv，以及「没给 content-type 但确实抓到了正文」——那恰恰是 API 容易藏身的地方）；表头如实报「共 N 条；本次会话实际抓到 M 条，另 M−N 条为静态资源或无正文 GET，未纳入索引」；`get_request_detail` 能按序号回库取到索引外的请求并标注「未纳入分析索引」。静态资源仍不进索引——JS/CSS 正文单条可达 1MB，是字节的大头。

- **结构化抽取只看报告开头** — 截断只保留头部，长报告的尾部（复现代码、风险、未决问题）整段不参与 ProtocolSpec 抽取，而那些正是要抽的东西。改为头 70% / 尾 30%，中段标注省略。同时删掉 `PROMPT_OVERHEAD_TOKENS = 16000` 这个常量猜测：改为先把提示词建出来实测，再定报告预算；装不下先缩索引，还是装不下就抛一条可行动的错误（点名窗口大小、输出上限和设置里的 `lightweightModel`），而不是照样返回 3000 token 让服务端拒。抽取角色的输出上限也加了窗口约束——16k 窗口的模型不会再被要求 8192 输出占掉半个窗口。

- **结论核对拿「进了索引的」当全集** — 上一条让模型能按序号点取索引外的请求，索引表头也明写了这一点，但三处核对仍以索引为全集：净化 Spec 引用时，把指向索引外**真实**请求的 `exampleSeqs` / `evidenceSeqs` 当成编造的抹掉（落库的 Spec 真的丢了证据链接，界面上「跳到请求 #N」随之消失）；证据校验把这些序号记成「引用了不存在的请求」，只靠这类请求还原出来的端点同时被判「匹配不上抓到的请求」；生成过程里那条引用提示也跟着冤枉。于是模型越认真补取，越会被判定成在编。改为按会话真实抓到的序号核对，为此新增一条只取 `sequence / method / url` 的查询——核对序号不该把每条最大 1MB 的正文一起读出来。提示词里的索引仍是过滤后的那份，不变。

- **补取索引外请求时反复全表读 hook** — 每查一条请求就读一次 `js_hooks`，而那个查询没有 LIMIT；一次 `get_request_detail` 最多补 5 条、一轮分析最多 64 步工具。改为一轮分析 / 追问内缓存一次——工具看到的数据本来也该是同一个快照。

- **抽取步骤可能带走已经完成的分析** — 上面那次读库放在了 `try` 之外，而 `extractAndStoreSpec` 承诺「失败只记 `spec_error`，永不抛出」，且报告此时已经落库。改为读不到就退回旧口径：`capturedSeqs` 交回索引序号，证据校验直接不下结论——核对不了就别说话，总比把真实引用全判成编造的强。

## 验证

- 全量测试：599 passed，22 skipped。其中 `tests/main/db/capture-reliability.test.ts` 的 18 项需要 Electron 的原生模块 ABI（本机 `postinstall` 按 Electron 构建，Node 侧加载不了），改用 `node scripts/run-electron-vitest.mjs` 与迁移测试一起运行，31 项通过；CI 里由 `rebuild:native:node` 处理。
- 新增 31 项回归测试（本机跑通 29 项，另 2 项随迁移测试走 Electron）。每一条都先把修复摘掉确认会挂，失败信息就是问题本身：`expected [] to deeply equal [ 3 ]`（真实的证据序号被抹掉）、`expected [ 3, 404 ] to deeply equal [ 404 ]`（抓到的请求被判成不存在）、`expected 4 to be 1`（hook 表被重复读了 4 次）、`Error: database is locked`（读库失败带走整次分析）、索引表头不报排除数、长报告的尾部标记丢失、16k 窗口静默返回 3000 token。
- 另外用一个本地中转跑了三轮工具循环，逐个检查真实发出的请求体，确认工具结果的预算是**跨轮累计且持久**的：第一轮被截到 3600 字符后，在第 2/3/4 次请求里一直是 3600，后续轮次耗尽预算后整条替换为省略标记。分页续取不会让上下文无界增长。
- 类型检查（主进程 + 渲染进程）、`npm run build` 通过；内部包打包、产物校验（app.asar 19721 项）、启动冒烟与 UI 冒烟通过。

## 已知问题

- **本批改动尚未跑过真实端到端。** 现成的 `tests/manual/real-analysis.test.ts` 需要给定 `AA_TEST_BASE_URL` 与 `AA_TEST_API_KEY`。
- 一轮分析里工具结果有**累计**总预算（实测：128k 窗口约 27k token ≈ 108KB，32k 窗口约 21KB），耗尽后工具结果整条替换为 `[tool result omitted: context budget exhausted; query a narrower range]`。所以正文分页适合定位尾部，不适合通读大文件。
- 放宽相关性筛选后进入分析的请求会变多，索引条数的实际变化需要一次真实会话来量。
- 快速连续导航时，偶发（约 1/27）有文档执行域未能建立推送通道，被下一次导航销毁时带走尚未送出的数据。该情况会如实记为缺口，不会静默丢失。
- 混合压缩阶段若取消，摘要调用抛出的取消会被压缩层的 catch 吞掉，退回规则压缩；取消仍会在下一步生效，不会多花一次调用。

## 下载

| 平台 | 文件 |
|------|------|
| Windows | Anything-Analyzer-Setup-3.6.70.exe |
| macOS (Apple Silicon) | Anything-Analyzer-3.6.70-arm64.dmg |
| macOS (Intel) | Anything-Analyzer-3.6.70-x64.dmg |
| Linux | Anything-Analyzer-3.6.70.AppImage |
