# Anything Analyzer v3.6.65

本版本只有一处改动：修复 CloakBrowser 在免费计划下无法启动，并让浏览器版本按实际解析结果记录。

## 修复

- **CloakBrowser 免费计划下连接异常（`BACKEND_FAILURE: CloakBrowser binary status does not match the selected executable`）** — Strict 策略会向 CloakBrowser 请求固定内核版本，但官方 wrapper 对免费计划会主动丢弃版本固定（服务端对免费 key 强制下发最新内核）。应用此前在 `ensureBinary()` 之外，又用 CLI 诊断和 `binaryInfo()` 各解析一次并三方比对路径，而后两者只会照搬请求的版本号，于是同一个可执行文件得到两个答案，直接被判定为后端故障。现在以 `ensureBinary()` 返回的可执行文件为唯一事实，不再由应用去判断账号计划、版本固定是否被采纳、二进制 tier。
- **Session 记录的浏览器版本可能与实跑内核不符** — 该版本此前取自 CLI 诊断，而诊断只会回显请求的版本，因此免费计划下记录的一直是请求值而非实跑值。现在从实际解析到的可执行文件推导，包含 CloakBrowser 的构建后缀（`chrome --version` 只有四段，会丢掉该后缀）。

## 变更

- **Strict 策略语义明确为「请求」而非「保证」** — 免费计划仍会拿到最新内核，浏览器可正常使用，不再因此拦截启动。
- **版本漂移非阻断提示** — 当请求版本与实际解析版本不一致时，设置页 CloakBrowser 区块给出提示，说明版本固定仅对付费计划生效，并提醒内核变化后需重新执行浏览器契约测试。

## 验证

- 全量测试通过：435 passed，19 skipped。
- 真实 CloakBrowser 后端测试（`AA_REAL_CLOAK=1`）通过：Passive 抓包与 Deep 绑定跨导航保持正常。
- 内部包打包、产物校验、启动冒烟与 UI 冒烟通过。

## 下载

| 平台 | 文件 |
|------|------|
| Windows | Anything-Analyzer-Setup-3.6.65.exe |
| macOS (Apple Silicon) | Anything-Analyzer-3.6.65-arm64.dmg |
| macOS (Intel) | Anything-Analyzer-3.6.65-x64.dmg |
| Linux | Anything-Analyzer-3.6.65.AppImage |
