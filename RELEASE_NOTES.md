# Anything Analyzer v3.6.66

本版本以 Deep 抓取的可靠性为主：worker 从第一条语句起就被覆盖，realm 的生死判断不再被重复会话误导；另外修正一处交互行为——选中 Cloak 会话不再自动弹出浏览器窗口。

## 修复

- **选中 Cloak 会话会直接弹出浏览器窗口** — 在列表里点一个会话，走的是 `enableStealth`，它会激活会话并打开浏览器上下文。对内置 Electron 后端这一步是无感的（切换分区、套用指纹），但对 Cloak 就是凭空多出一个外部浏览器窗口，而这一下点击只是想「看看这个会话」。会话面板本来就有「打开浏览器」按钮，窗口却在按钮被点之前就出现了。现在选中只会接管**已经打开**的 Cloak 上下文，绝不新开；打开与聚焦仍由按钮显式触发，Electron 路径不变。
- **已在运行的 Service Worker 被误判为已销毁，此后抓到的数据全部被丢弃** — Chromium 会为每个开启了 auto-attach 的父级各附加一次 service worker，同一个 worker 因此对应多个 CDP 会话，但它们指向同一个执行上下文、同一个 realm。此前任何一个会话断开都被当作 realm 销毁，于是关掉一个**无关页面**就会「封死」一个仍在运行的 service worker：宿主忽略它之后的全部上报，还给它记了一条 `realm-destroyed-unverified-tail`。现在只有在没有任何存活会话还能看到该 realm 时才判定其结束。
- **module worker 被误报为缺少首语句覆盖** — ES 模块会先完成模块图实例化再执行顶层代码，因此执行上下文存在一段时间之后，被改写进入口脚本的首条语句才真正运行。此前只在上下文创建时读取一次覆盖标记，落在这个窗口里就会给一个**确已被改写**的 worker 记上缺口。现在先装钩子、再有界重读标记（50ms 内），只有结论等待，期间没有代码裸跑；超出窗口仍按「未覆盖」如实上报，不会反过来声称覆盖。

## 新增

- **Deep 抓取的持久化投递与 worker 首语句覆盖** — 抓取数据改为带确认的持久化投递（提交后才确认、推送与轮询去重、按运行轮次隔离），worker 的入口脚本在响应阶段被改写，使插桩成为脚本的第一条语句，覆盖范围涵盖专用 / 共享 / Service Worker 与 classic / module，`blob:`、`data:` 由文档侧构造函数代理兜底。无法覆盖的情况不会被粉饰，而是如实记为缺口。
- **realm 失去推送通道时记录原因** — 注册推送绑定失败会让 realm 退化为轮询，而轮询周期是 750ms，快速导航下一个文档只存活约 300ms，这类 realm 可能带着尚未送出的数据被销毁。健康记录此前只显示 `poll` 而不给原因，现在补上 `push-binding-unavailable`，区分「慢」与「永远送不出去」。

## 验证

- 全量测试：536 passed，20 skipped。其中 `tests/main/db/capture-reliability.test.ts` 的 18 项需要 Electron 的原生模块 ABI，改用 `node scripts/run-electron-vitest.mjs` 运行后通过（抓取相关 5 个套件共 98 项全过）。
- 真实 CloakBrowser 验证（`AA_REAL_CLOAK=1`）9 个场景全部通过，含此前从未跑到的 `stop-and-cross-run-isolation`、`warm-existing-service-worker`、`sqlite-reopen-durability`；连续 26 轮零失败（此前同等批次为 3/12 失败）。
- 持久化一致性：245 条 hook / 303 条回执，重复生产序号 0，无回执的 hook 行 0。
- 内部包打包、产物校验、启动冒烟与 UI 冒烟通过。

## 已知问题

- 快速连续导航时，偶发（约 1/27）有文档 realm 未能建立推送通道，被下一次导航销毁时带走尚未送出的数据。该情况会如实记为缺口，不会静默丢失；本版本已加入原因字段以便定位。

## 下载

| 平台 | 文件 |
|------|------|
| Windows | Anything-Analyzer-Setup-3.6.66.exe |
| macOS (Apple Silicon) | Anything-Analyzer-3.6.66-arm64.dmg |
| macOS (Intel) | Anything-Analyzer-3.6.66-x64.dmg |
| Linux | Anything-Analyzer-3.6.66.AppImage |
