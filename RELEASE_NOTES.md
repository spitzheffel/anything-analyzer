# Anything Analyzer v3.6.73

3.6.72 的健康面板在一次真实会话上给出「已确认丢失 34 条 / 已知丢失事件 434」。数是对的——问题在于它数出来的东西：**434 里有 426 是页面里的 bridge 自己扔掉的加密操作记录**，而且这条路一直存在，只是以前没被标出来。

## 修复

- **`crypto.subtle` 在 ≥16 KB 数据上的操作两条记录全丢** — 30 条 `producer-queue-loss` 里 26 条是 OpenPGP worker，几乎每条正好 16 个事件，全部在同一秒（邮箱加载、worker 池拉起），而这些 realm 的队列是空的。不是队列满（上限 4096 条 / 2 MB），不是背压（要全局压到 32 MB），是**单个事件超过 bridge 64 KB 的上限被静默丢掉**：`crypto.subtle.sign/digest/encrypt/decrypt` 的钩子把 buffer 整个转 hex 且没有上限，B 字节 → 2B 字符，进 `enqueue` 一量超过 64 KB 就 `droppedEvents += 1`。每次调用发两个事件（调用 + `.result`，后者还带着同一份参数），所以一次操作丢两条；16 条 = 8 次大 buffer 操作，一个固定的初始化序列。用真实 bootstrap 实测阈值：

  ```
  buffer=  8192 bytes  → dropped 0 of 2
  buffer= 16000 bytes  → dropped 1 of 2
  buffer= 16384 bytes  → dropped 2 of 2
  ```

  对「详解加密/签名流程」这个用途，这是正中要害的盲区：大 buffer 上的加密操作恰恰是最该看到的，而它们一条都不在库里。同一份文件里第三方库钩子走 `truncateArg`（500 字符），原生 `crypto.subtle` 却没截——两条路不一致。

  **改法：整条保存到 1 MB，超过留头尾。** 边界和网络正文的 `MAX_BODY_SIZE = 1 MB` 对齐，不发明新数；超过 1 MB 的留头尾各 32 KB + `...[truncated: N bytes total, first and last 32768 shown]...`——头部有算法特征和魔数，尾部有 MAC / padding，长度本身也是线索。一个事件要过四道限制，只删第一道会在第二道死，所以一起开：

  | 位置 | 之前 | 现在 |
  |---|---|---|
  | 单事件 | 64 KB | 9 MB（1 MB 的 decrypt 连结果约 8.4 MB） |
  | 单批次 | 128 KB | 9 MB；且队头那条无论多大都进批次（批次循环从 0 起算，比批次还大的事件会永远卡在队头堵住后面所有事件） |
  | 推送接收 | 512 K 字符 | 5 M 字符 |
  | 队列总量 | 2 MB | 32 MB |

  代价：每个 realm 页内最多多占 32 MB，内存换完整性。推送是即时的，队列通常瞬间清空，实际远达不到上限。

- **bridge 的丢弃只有一个总数** — 「太大」「队列满」「背压」「序列化抛错」四种情况合在一个 `droppedEvents` 里，健康面板上根本分不出来，上面那 426 条只能靠反推。现在按原因拆成四个计数器随 status 上报，controller 按原因各出一条 `producer-queue-loss` 缺口并带 `detail`，面板的 realm 行显示 `Dropped: 16 (event-oversize: 16)`。旧版 bootstrap 不上报时退回原来的单条缺口。

## 验证

- 全量测试：638 passed，23 skipped。其中 `tests/main/db/capture-reliability.test.ts` 的 18 项需要 Electron 的原生模块 ABI（本机 `postinstall` 按 Electron 构建，Node 侧加载不了），改用 `node scripts/run-electron-vitest.mjs` 与迁移测试一起运行，32 项通过；CI 里由 `rebuild:native:node` 处理。
- 新增 7 项回归测试，五次摘除验证（每次先断言锚点唯一命中）：单事件上限退回 64 KB 时 `expected 1 to be +0`；不按原因计数时 `expected { 'event-oversize': +0 } to match { 'event-oversize': 1 }`；controller 不分原因时 `expected [ [ null, 2 ] ] to deeply equal [ [ 'event-oversize', 1 ], … ]`；推送接收退回 512 K 时 `expected "spy" to be called 1 times, but got 0 times`；hook-script 不截时 `expected 'aa1111…' to contain '...[truncated: 1572864 bytes total…'`。
- hook-script 的两条测试用真实编译出的注入脚本在 vm 里跑：200 KB 的 buffer 拿到 409,600 字符的完整 hex；1.5 MB 的拿到 `aa11…` 开头、`…11ff` 结尾、中间带标记。
- 类型检查（主进程 + 渲染进程）、`npm run build` 通过；内部包打包、产物校验、启动冒烟与 UI 冒烟通过。

## 已知问题

- **决定性的验证只能在真实页面上做**：在同一个站再抓一次，看 `producer-queue-loss` 是否归零。单测证明的是链路上四道闸都过得去，不是真实页面上不再丢。这是抓包路径的行为变化，装上后请跑一次看健康面板。
- `.result` 事件仍把参数再带一遍（所以一次 1 MB 操作是 8.4 MB 而不是 4.2）。去掉会让 `.result` 行的 `args=` 变空，影响分析提示词的格式，本次未改。
- `data:hooks` 仍把整个会话的 hook 全部发给渲染进程；1 MB 的参数会让这一步变重。列表的 tooltip 截到 2000 字符，传输没截——「整条保存」意味着界面要拿得到整条。
- 批次里「队头必进」的守卫没有独立测试：它只在批次上限小于单事件上限时才起作用，两个常量现在相等，构造不出那个场景。它是防御性的。
- 排空循环没有节流（`stopOnce` 里 `do { await this.poll() } while (Date.now() < deadline)`），生产环境靠真实 CDP I/O 拖慢，假时钟下会活锁。抓包路径既有行为，未改。
- 3.6.71 的两条修复（输出上限截断的识别与提示）仍未在真实会话上验证过。
- 一轮分析里工具结果有**累计**总预算（128k 窗口约 27k token ≈ 108KB），耗尽后整条替换为省略标记。
- AI 请求日志只保留原始 SSE 的**前** 100,000 字符，`finish_reason` 在末尾看不到；靠 `completion_tokens` 是否正好等于配置上限判断。
- 快速连续导航时，偶发（约 1/27）有文档执行域未能建立推送通道，被下一次导航销毁时带走尚未送出的数据。该情况会如实记为缺口，不会静默丢失。
- 混合压缩阶段若取消，摘要调用抛出的取消会被压缩层的 catch 吞掉，退回规则压缩；取消仍会在下一步生效。

## 下载

| 平台 | 文件 |
|------|------|
| Windows | Anything-Analyzer-Setup-3.6.73.exe |
| macOS (Apple Silicon) | Anything-Analyzer-3.6.73-arm64.dmg |
| macOS (Intel) | Anything-Analyzer-3.6.73-x64.dmg |
| Linux | Anything-Analyzer-3.6.73.AppImage |
