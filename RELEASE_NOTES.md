# Anything Analyzer v3.6.68

本版本只有一处改动：修复部分第三方 OpenAI 兼容服务无法使用 AI 分析。

## 修复

- **配置第三方 OpenAI 兼容端点后，AI 分析直接失败（`Type validation failed ... expected "function"`）** — 按 OpenAI 规范，工具调用的 `id`、`type`、`function.name` 只出现在第一个增量分片中，后续分片应当省略；部分兼容服务改为发送空字符串。`@ai-sdk/openai` 的流式 schema 声明 `type: z.literal('function').nullish()`，缺省合法而空串非法，因此一个续传分片就会让整次请求失败。

  只有严格路径受影响：`@ai-sdk/openai-compatible` 的 schema 中没有 `type` 字段，Zod 会直接丢弃，所以选择 Custom 提供商不受影响；而把第三方端点配置在 OpenAI 提供商下是合理用法，不应因此中断。

  现在在所有 provider HTTP 共用的请求层统一规整流式响应，仅删除这几个为空的判别字段，使分片读起来与省略一致。其余内容逐字节透传：`function.arguments` 承载正文，空字符串在该处有意义；无法解析为分片的行不做改动；请求日志仍记录服务端实际发送的字节。

## 验证

- 全量测试：542 passed，20 skipped。其中 `tests/main/db/capture-reliability.test.ts` 的 18 项需要 Electron 的原生模块 ABI，改用 `node scripts/run-electron-vitest.mjs` 运行后全部通过。
- 新增 4 项回归测试，覆盖：真实失败分片的修复、合规分片与非分片行的原样透传、空 `arguments` 不被误删，以及跨网络边界切分（在 JSON 中间切开，按行重写会损坏报文）。接线本身也在覆盖内——移除规整步骤会导致该测试失败。
- 真实 CloakBrowser 验证（`AA_REAL_CLOAK=1`）9 个场景全部通过。
- 内部包打包、产物校验、启动冒烟与 UI 冒烟通过。

## 已知问题

- 快速连续导航时，偶发（约 1/27）有文档执行域未能建立推送通道，被下一次导航销毁时带走尚未送出的数据。该情况会如实记为缺口，不会静默丢失。

## 下载

| 平台 | 文件 |
|------|------|
| Windows | Anything-Analyzer-Setup-3.6.68.exe |
| macOS (Apple Silicon) | Anything-Analyzer-3.6.68-arm64.dmg |
| macOS (Intel) | Anything-Analyzer-3.6.68-x64.dmg |
| Linux | Anything-Analyzer-3.6.68.AppImage |
