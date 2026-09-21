# Anything Analyzer v3.6.74

3.6.73 装上后在同一个站再抓了一次。好消息：`producer-queue-loss` 归零，2,120 条 crypto 记录里 166 条是以前必丢的 >16 KB buffer，最大 91 KB 整条落库。坏消息：健康面板上多了 2 条「传送延迟 / `ingestion-invalid` / Dropped: 0」——那是 3.6.73 自己引入的回归，而且比原来的问题更糟：它连丢失都不算。

## 修复

- **第五道尺寸限制** — 3.6.73 的说明写了"一个事件要过四道限制"，是错的，有五道：仓储的 `validateBatch` 还按 256 KB / 2 MB 校验。bridge 放过的批次到仓储被整批判 `invalid`，没有回执，producer 原样重发、永远进不了库，还拖着同批的所有其它事件一起。receipts 表只记提交，所以那两批到底多少条已经无从知道。

  现在五道限制**只在 `capture-protocol.ts` 定义一次**：bootstrap 由构建时注入，controller 和仓储直接引用，不可能再各开各的。bootstrap 按 UTF-16 记（`chars*2+128`），utf8 字节数在任何文本上都不超过它，所以仓储按同一个数校验一定放得过 bridge 放过的东西。加了一条跨层测试：用真实 bootstrap 生成的批次直接过 `validateBatch`。

- **被仓储拒掉的批次记成「传送延迟」** — `invalid` 不是延迟：同一批内容会被原样重发、永远不会被接受。现在按**已知丢失**记数据事件的条数，realm 的 `pending` 如实显示卡住的队列（以前停在上次成功后的 0）。只数 hook / interaction，不数 control：realm 5 秒没确认时 controller 每次轮询会再入一条 `health-probe`，批次一直被拒它们就一直堆，按它们计数会让"丢失"每 750 ms 涨一条。同一批内容每次轮询都会再来，按序号只计一次。

- **会话中途销毁的 realm 在停止时被记成 `drain-timeout`** — 3.6.72 引入的标签错误。上次会话的 5 条 `drain-timeout` 全部对应停止前一到两分钟就销毁的 realm——它们没有超时，是早就没了。现在 `closeRealm` 当场按 `realm-destroyed-with-pending` 记已知丢失，排空只看还活着的 realm。

## 关于「不会丢东西了吧」

不能这么说，这套抓包从设计上做不到那个承诺。这几天做的是**让每一条丢失被看见、贴对标签、能数就数出来**。上次会话的水位：35 个执行域、2,120 条加密记录，已知丢失 9 条（5 个随导航销毁的 realm 队列里的最后几条——那个 1/27 的固有竞争），覆盖未知 28 条。该警惕的是两种情况：某类丢失数量大（像 426 那次），或某条缺口说不出原因。

## 验证

- 全量测试：641 passed，23 skipped。其中 `tests/main/db/capture-reliability.test.ts` 的 18 项需要 Electron 的原生模块 ABI，改用 `node scripts/run-electron-vitest.mjs` 与迁移测试一起运行，32 项通过；CI 里由 `rebuild:native:node` 处理。该文件里两条钉着旧上限（256 KB 载荷、12×200 KB 批次）的 fixture 改为引用共享常量。
- 新增 3 项测试，五次摘除验证（每次先断言锚点唯一命中）：仓储限制退回 256 KB / 2 MB 时 `'Error: Invalid capture batch' was thrown`；被拒批次不记丢失时 `expected 'delivery-delay' to be 'known-loss'`；把 control 事件也算上时 `expected 5 to be 2`；销毁时不记 pending 时 1 failed；排空仍看已销毁 realm 时 `expected true to be false`。
- 类型检查（主进程 + 渲染进程）、`npm run build` 通过；内部包打包、产物校验、启动冒烟与 UI 冒烟通过。

## 已知问题

- **`ingestion-invalid` 的修复还没在真实页面上验证过。** 装上后在同一个站再抓一次，那两条应该消失。
- 跨层测试里 vm 沙箱的活对象直接过 `validateBatch` 会被拒（realm 相关的检查），生产路径总是经过 JSON 字符串，测试按生产路径做了 round-trip；具体是哪一处检查对 realm 敏感没有追到底。
- `realm-destroyed-with-pending`（随导航销毁的 realm 队列里的最后几条）是抓包层与浏览器的固有竞争，约 1/27，此前专门查过、没能消掉。它还会发生，现在如实计数。
- `.result` 事件仍把参数再带一遍；`data:hooks` 仍把整个会话的 hook 全部发给渲染进程。
- 排空循环没有节流；批次「队头必进」的守卫没有独立测试。均为抓包路径既有行为。
- 3.6.71 的两条修复（输出上限截断的识别与提示）仍未在真实会话上验证过。
- 一轮分析里工具结果有累计总预算（128k 窗口约 27k token ≈ 108KB）；AI 请求日志只保留原始 SSE 的前 100,000 字符。
- 快速连续导航时，偶发有文档执行域未能建立推送通道，被下一次导航销毁时带走尚未送出的数据。该情况会如实记为缺口。
- 混合压缩阶段若取消，摘要调用抛出的取消会被压缩层的 catch 吞掉，退回规则压缩；取消仍会在下一步生效。

## 下载

| 平台 | 文件 |
|------|------|
| Windows | Anything-Analyzer-Setup-3.6.74.exe |
| macOS (Apple Silicon) | Anything-Analyzer-3.6.74-arm64.dmg |
| macOS (Intel) | Anything-Analyzer-3.6.74-x64.dmg |
| Linux | Anything-Analyzer-3.6.74.AppImage |
