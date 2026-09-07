# Anything Analyzer v3.6.64

本版本包含 3.6.63 与 3.6.64 两轮改动（3.6.63 未单独发布说明）。

## 修复

- **CloakBrowser 里 Stripe 等嵌入式风控 / 支付挑战卡死** — Cloak 二进制默认阻止第三方 Cookie，跨站 iframe 里访问 `sessionStorage` / `localStorage` 会抛 `SecurityError: Access is denied for this document`，PerimeterX（HumanSecurity）、reCAPTCHA v3、SSO 这类嵌在 iframe 中的挑战加载后永远完不成。现在 Cloak 会话启动时带上官方开关 `--fingerprint-allow-3p-cookies`，与原版 Chrome 的默认行为一致。
- **分析输入漏掉 SSE / WebSocket 请求** — 无请求体、非 JSON 内容类型的 GET 订阅接口此前被相关性过滤丢弃，导致请求索引缺项、提示词中的"流式通信"一节始终为空。

## AI 分析

- **LLM 接入层改用 Vercel AI SDK** — OpenAI / Anthropic / OpenAI 兼容中转统一走一条代码路径；工具轮次也支持流式输出，报告不再在结束时一次性出现。
- **可配置的生成参数** — 思考级别（reasoning effort）、Anthropic fast mode 与 thinking budget、temperature，以及面向中转站的 `extraBody` 透传；未显式设置的参数不会发送。
- **推理过程独立展示** — 模型的 reasoning 以可折叠块显示在报告上方，进度事件改为带类型的 text / reasoning / status / reset。
- **LLM 设置页重构** — 按任务角色指定轻量模型、常见模型自动查表填充上下文窗口、压缩阈值等收进"高级"折叠区；预留输出 token 跟随输出上限。

## 结构化产物与外部 AI 消费

- **ProtocolSpec 自动抽取** — 每份报告完成后由轻量模型抽取端点、参数、鉴权链、流程、存储、加解密与复现代码，随报告落库；抽取失败记录为 `spec_error`，可在报告面板或 MCP 中重试，不阻断报告本身。
- **可点击引用** — 报告要求以 `[#12]` 引用请求序号，引用会与会话校验并可直接跳转到对应请求。
- **MCP 工具扩展** — 新增 `get_report`、`get_protocol_spec`、`get_openapi`、`get_session_enrichment`、`get_session_brief`、`get_request_by_seq`，以及 `report://`、`spec://` 资源；修复 `chat_followup` 取到最旧报告、历史只存内存、泄漏 `tool_state` 标记的问题；`run_analysis` 现在与界面一样遵循用户提示词模板。
- **导出** — 新增 HAR 1.2、ProtocolSpec JSON、OpenAPI 3.1 导出。

## 浏览器后端（内部版）

- **可选的 CloakBrowser 后端** — Electron 仍是默认后端；内部构建可选 Cloak 的 Passive / Deep 会话，浏览器配置与标签页持久化，CDP 访问由统一协调器代理。
- **Cloak Deep 模式可靠性** — SSE / multipart 响应体增量捕获；跨源 iframe 使用独立 CDP 会话挂接钩子与绑定；页面钩子以 Proxy 伪装保持 `toString` 原生；DOM 存储改走 CDP DOMStorage 域读取；交互回放优先使用 Cloak 的人性化输入。

## 验证

- 新增真实 Cloak 浏览器跨站 iframe 存储探测（`AA_REAL_CLOAK=1`），Passive / Deep / 复用已有 profile 三轮均可访问存储。
- 新增真实模型端点端到端分析测试（`AA_TEST_BASE_URL` / `AA_TEST_API_KEY`），校验引用、Spec 引用完整性、HAR / OpenAPI 导出。
- 全量测试通过：429 passed，19 skipped。
- Electron 迁移测试、生产构建、内部包打包与冒烟通过。

## 下载

| 平台 | 文件 |
|------|------|
| Windows | Anything-Analyzer-Setup-3.6.64.exe |
| macOS (Apple Silicon) | Anything-Analyzer-3.6.64-arm64.dmg |
| macOS (Intel) | Anything-Analyzer-3.6.64-x64.dmg |
| Linux | Anything-Analyzer-3.6.64.AppImage |
