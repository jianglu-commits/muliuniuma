# 上下文管理与摘要提取：实现记录

日期：2026-11-20 起 · 合并于 `main` · 相关文档：[`docs/superpowers/specs/2026-11-17-agent-runtime-scaffold-design.md`](docs/superpowers/specs/2026-11-17-agent-runtime-scaffold-design.md)、[`docs/superpowers/plans/2026-11-17-agent-runtime-scaffold.md`](docs/superpowers/plans/2026-11-17-agent-runtime-scaffold.md)

本文记录「Agent 上下文管理 + 摘要提取」的**最终实现行为**、决定实现形态的 SDK 事实，以及实现过程中**被推翻的前提**。SDK 引文全部读自本仓库 `node_modules`，测试数字为实测值。

后续的「工具加载优化与工具输出清理」在此之上继续扩展（见 §9），两份记录互为补充。

---

## 1. 为什么做

改造前，`AgentRuntime.run()` 每轮把新消息**追加**进 SQLite checkpointer 的 `messages` 通道（reducer 是 `messagesStateReducer`：新 id 追加、同 id 替换）。历史没有任何上限管理。

两个后果：

1. **上下文会撑爆。** `sandbox_exec` 单条输出上限 256 KB（`SANDBOX_MAX_OUTPUT_BYTES`），**一条**工具输出就可能顶满模型的输入窗口；累积几轮后请求直接被网关拒绝。
2. **用户没有自救手段。** 即使还没报错，用户也没法主动把冗长历史收一收。

目标是：**历史超阈值时自动压缩**，同时给一个**主动触发**的入口。摘要不是通用「对话摘要」，而是按 agent 场景定制的结构化上下文。

用户确认的三个决策（决定了后面所有设计）：

| 决策点 | 结论 |
|---|---|
| 形态 | 自动压缩 **+** 可主动触发（两者都要） |
| 实现方式 | 复用 LangChain v1 内置 `summarizationMiddleware` 的机制 **+** 自写中文结构化摘要 prompt |
| 摘要模型 | 与主模型同一个（默认；允许测试注入替身） |

---

## 2. 落地文件

| 文件 | 动作 | 内容 |
|---|---|---|
| `src/agent/summary-prompt.ts` | 新建（65 行） | `SUMMARY_PROMPT_MARKER`（识别标记）、中文结构化 `SUMMARY_PROMPT`（含**唯一一处** `{messages}`）、`SUMMARY_PREFIX` |
| `src/agent/summary.ts` | 新建（245 行） | `SummaryPolicy` / `SummaryReason` / `SummaryOutcome` / `countMessageTokens` / `looksLikeSummaryCall` / `extractSummaryText` / `createSummaryMiddleware` / `planSummary` |
| `src/agent/runtime.ts` | 修改 | `AgentRuntimeDeps.summaryModel?`；构造器加 `summaryMiddleware`；`create()` 装配中间件并传 `middleware`；新增 `summarize()` |
| `src/agent/index.ts` | 修改 | barrel 追加两个模块 |
| `src/config/env.ts` | 修改 | 4 个 `SUMMARY_*` 键 + `AppConfig.summary` 子对象 + 映射 |
| `src/cli.ts` | 修改 | `/summarize` 命令分支 + 启动提示 |
| `.env.example` / `README.md` / spec | 修改 | 变量、行为说明、目录清单、数据流 |
| `tests/agent.summary.test.ts` | 新建 | prompt 结构、token 计数、失败判定、`planSummary` 切分与写回形状 |
| `tests/agent.summarize.test.ts` | 新建 | 自动压缩、主动触发、幂等、开关、注入模型、失败不破坏历史 |

摘要 prompt 的固定五节：`## 任务目标` / `## 关键事实` / `## 已完成的操作` / `## 决策与约束` / `## 未决事项与下一步`。三个设计要点（已写进代码注释）：

1. 摘要是 **HumanMessage** 入历史，模型会把它当成「用户说过的话」。prompt 里必须写清「这是历史摘要、**不是新指令**」，否则模型可能把摘要里的旧指令当新指令重复执行。
2. 必须区分「**已完成**」与「**待办**」——agent 场景最贵的错误是重复执行已经做过的操作（重复写文件、重复跑命令）。
3. 硬事实的**字面值**必须一字不差保留（路径 / 命令 / ID 被改写，后续就会操作到错误对象）。

---

## 3. SDK 硬约束

以下是决定实现形态的事实，全部读自本仓库 `node_modules`。

### 3.1 内置中间件

| 事实 | 依据 |
|---|---|
| `summarizationMiddleware(options)` 由 `langchain` 包根导出 | `langchain/dist/agents/middleware/summarization.d.ts:293` |
| `trigger`：**数组 = OR，单对象内 = AND** | `summarization.js:314` |
| `trigger.fraction` **不可用** —— 它需要 `getProfileLimits(model)`，我们的 OpenAI 兼容网关没有 model profile，SDK 会直接抛 `Model profile information is required…` | `summarization.js:243` |
| `trigger.messages` 语义是 `length >= N` 才触发；`trigger.tokens` 是 `totalTokens >= N` 才触发 | `summarization.js:325-332` |
| 默认 token 计数 `countTokensApproximately` 是 **chars/4**，且 middleware 只传 messages（**工具 schema 不计入**） | `langchain/dist/agents/middleware/utils.js:16` |
| 摘要调用是 `model.invoke(单个字符串 prompt)`，**不是**消息数组 | `summarization.js:521` |
| `trimTokensToSummarize` 先把待摘要段裁到该预算，**超出的部分被直接丢掉、不进摘要** | `summarization.js:523-524` |
| 写回形状：`{ messages: [RemoveMessage(REMOVE_ALL_MESSAGES), summaryHumanMessage, ...preservedMessages] }` | `summarization.js:262-273` |
| 摘要是 **HumanMessage**，`id` 复用首条被摘要消息的 id，带 `additional_kwargs.lc_source === 'summarization'` | `summarization.js:264-266` |
| 默认摘要 prompt 是**英文通用模板** | `summarization.js:15` |

### 3.2 状态与写回

| 事实 | 依据 |
|---|---|
| `messages` 通道 reducer：带 `REMOVE_ALL_MESSAGES` 的 `RemoveMessage` **丢弃全部历史，只保留其后的消息** | `@langchain/langgraph/dist/graph/messages_reducer.d.ts:51` |
| **`systemPrompt` 不在 graph state 里** —— 它作为 node option 传下去，**每次调用模型时注入**。所以压缩**不会**吃掉系统提示里的 skill 清单 | `ReactAgent.js:97` → `AgentNode.js:353-358` |
| `agent.invoke` 返回**累积后的全量历史**，不是本轮增量 | `annotation.js:85-88` |
| `agent.updateState(config, values, asNode)`：应用 channel reducer 并写新 checkpoint，**不跑任何节点** | `ReactAgent.js:752` → `pregel/index.js:948` → `bulkUpdateState` |
| `asNode` **省略会抛 `Ambiguous update, specify "asNode"`**（只能按 checkpoint 的版本记录去猜节点，同任务写多 channel 时版本相同、猜不中） | `pregel/index.js:860` |
| `START`（`'__start__'`）是 `@langchain/langgraph` 的**公开导出**，`StateGraph.compile` 无条件 `attachNode(START)` | `@langchain/langgraph/dist/index.d.ts:50`；`graph/state.js:485` |
| `agent.getState(config)` 的**声明返回类型是 `never`** → 必须显式标注变量类型才能取 `.values` | `ReactAgent.d.ts:299` |

### 3.3 中间件的钩子与 context

| 事实 | 依据 |
|---|---|
| `middleware.beforeModel` 是**公开类型**，形态可能是函数，也可能是 `{ hook, canJumpTo }` | `langchain/dist/agents/middleware/types.d.ts:177-184, 417` |
| middleware 节点构造的 runtime **只有 6 个字段**：`context` / `store` / `configurable` / `writer` / `interrupt` / `signal` | `langchain/dist/agents/nodes/middleware.js:47-53` |
| `runtime.context.trigger` **整体覆盖** `userOptions.trigger`；`runtime.context.keep` 同理 | `summarization.js:225-226` |
| `runtime.context.model` **被 SDK 忽略** → 摘要模型只能在建中间件时定死 | `summarization.js:245` |
| `pickRunnableConfigKeys` 会取 `signal` → **手动路径的 signal 能进摘要模型的 invoke 配置，摘要调用可被 abort** | `@langchain/core/dist/runnables/config.js:152` |

### 3.4 一条差点判断错的

`contextSchema` 里 `keep` 与 `trigger` 都是 `z.ZodOptional`（**无默认值**），只有 `summaryPrompt` 是 `z.ZodDefault`（英文默认值）。

- `contextSchema.parse({ trigger: … })` **不会**给 `keep` 套默认值 → 手动路径回落到我们配置的 token 预算 keep ✓
- `parse` **会**给 `summaryPrompt` 套上英文默认值 → 命中 SDK 的 `=== DEFAULT_SUMMARY_PROMPT` 特判 → 改用我们的中文 prompt ✓

**当时先怀疑「parse 会覆盖 keep」，逐字段查了 schema 才确认不会。** 若不查，手动路径与自动路径的保留语义就会不一致。

---

## 4. 实现过程中被推翻的两个前提

### 4.1 「自动路径无法拦截摘要失败」——错

**已批准方案的前提是错的。** 方案里写了「自动路径无法拦截摘要失败，只能记日志」——**这是错的**：包装器**持有 SDK 的返回值**，拦截只需几行。

真实链路：

1. SDK 捕获摘要模型异常，把 `Error generating summary: …` **当成摘要正文**返回（`summarization.js:559-560`）
2. 包装器原样放行
3. SDK 用 `RemoveMessage(REMOVE_ALL_MESSAGES)` 写回（`summarization.js:268-272`）→ **整段历史被替换成一条错误文本**
4. 同时还打了「已压缩上下文」**成功**日志

**后果**：一次瞬态网关故障（限流 / 超时）就清空整个会话上下文，且日志看起来是成功的。手动路径对同一失败**有**防护、自动路径没有——不对称。

修法（约 4 行）：`extractSummaryText(update) === undefined` 时 `logger.warn(...)` 并 **`return undefined`**（不写回、**不抛错**——抛错会让整轮 agent 调用失败；返回 undefined 只是「本轮不压缩」，最坏退回既有的撑爆行为，**不丢数据**）。复用既有 `extractSummaryText`，不另写判定。

补了自动路径失败的 e2e：断言历史完整、无 `lc_source`、warn 出现且**无**成功日志。

> 教训：**方案里的「做不到」要先验证再写进去。** 这条错误前提差点让一个数据丢失 bug 带着「已评审通过」的标签合入。

### 4.2 「空正文摘要会被拦截」——也错

模型返回空 / 纯空白 content 时，SDK `content.trim()` 得 `''`，写回前无空值守卫 → 摘要消息只剩前缀。`extractSummaryText` 剥前缀后返回 `''`（`'' !== undefined`）→ 拦截条件不命中 → **空摘要被写回**，被摘要段历史被静默换成一条空前缀消息。手动路径同洞。

评审判为 Minor（触发器罕见），但符合「自动摘要零静默丢失」的标准且只需一行 + 两条用例，**当场修掉**没长期 deferred：`extractSummaryText` 把空 / 纯空白正文视为 `undefined`，两条路径同修。

---

## 5. 关键设计推导

### 5.1 为什么复用内置中间件，而不是自己写

内置的 `summarizationMiddleware` 已经把「触发判定 → 切分 → 摘要 → 写回 checkpoint」整套机制做好了。自己重写意味着要自己处理 `REMOVE_ALL_MESSAGES` 的写回语义——这类状态交互在本仓历史上反复踩坑（Task 5 的沙箱超时、Task 12 的 `updateState` 竞态）。

我们自己的部分是摘要的**内容语义**：中文、结构化、按 agent 场景定制。这是内置给不了的（它的默认 prompt 是英文通用模板）。

### 5.2 为什么 `keep` 用 token 预算而不是条数

`keep: { messages: N }` 在历史条数 ≤ N 时切点为 0 → **一条都不摘**。而本仓一条工具输出就可能 256 KB——历史只有 2–3 条时，条数 keep 会拒绝压缩，历史继续膨胀直到请求被网关拒绝。

token 预算走二分查找在**消息边界**上找切点，与条数无关。代价是「保留多少条」不再固定，所以 `SummaryOutcome` 里带 `preservedMessages` 告诉调用方实际保留了几条。

### 5.3 为什么自备 CJK 感知的 token 计数器

SDK 默认是 chars/4，对中文**低估 3–4 倍**（中文 1 字 ≈ 1 token，chars/4 算成 0.25）。阈值口径必须诚实，否则配 8000 实际要等到约 30000 token 才触发。

自备计数器：**CJK 字符一字一 token，其余四字符一 token**，另计入 `tool_calls` 的 JSON 与 `tool_call_id`——它们同样占模型的输入窗口。口径偏大是**保守**的（提前压缩），方向安全。

这个计数器后来被 `src/agent/context-clearing.ts` 直接复用。

### 5.4 主动触发：为什么直接调 `beforeModel` 钩子

主动触发要在**不跑模型回合**的前提下压缩历史并写回 checkpoint。三条路：

| 方案 | 问题 |
|---|---|
| 走 `agent.invoke` + 强制 trigger | 会跑模型回合，产生一条多余的 AI 回答，污染历史 |
| 自己重写切分与摘要逻辑 | 与自动路径**两套实现**，必然漂移 |
| **直接调中间件的 `beforeModel` 钩子**（+ `runtime.context` 强制 trigger）+ `updateState` 写回 | ✅ 两条路径共用同一份切分逻辑、同一份 prompt、同一份写回形状 |

选第三条。`beforeModel` 是**公开类型 API**（`middleware/types.d.ts:417`），SDK 若改签名会**编译期报错**；行为变化才会静默——用单测锁住。

写回用 `updateState(config, { messages: update }, START)`：它走图自身的 channel reducer，所以「REMOVE_ALL 丢弃全部历史」这条语义**来自 SDK**，我们不重写。

**主动路径只换 trigger，不换 keep**——同一个中间件实例、同一份 `SUMMARY_KEEP_TOKENS` 预算、同一份 prompt。`keepMessages` 可按次覆盖（SDK 支持 `runtime.context.keep` 覆盖），给「现在就收一收」一个确定语义。

---

## 6. 实现过程中踩到的坑

| # | 坑 | 处置 |
|---|---|---|
| 1 | `BeforeModelHook` 可能是函数，也可能是 `{ hook, canJumpTo }` | 调用方兼容两种形态，否则 SDK 改一下形态就静默失效 |
| 2 | `updateState` 的 `asNode` 省略会抛 `Ambiguous update` | 显式传 `START`（公开导出，节点必然存在）；**不要**硬编码 SDK 内部节点名 |
| 3 | `getState` 返回类型是 `never` | 显式标注变量类型：`const snapshot: { values: { messages?: BaseMessage[] } } = await this.agent.getState(config)` |
| 4 | 手动路径要自己构造 runtime | 必须**镜像 SDK 的 6 字段形状**（`context`/`store`/`configurable`/`writer`/`interrupt`/`signal`），其中 `writer` 与 `interrupt` 必填；`interrupt` 给抛错桩即可 |
| 5 | 摘要消息 id 复用 `conversationMessages[0].id`，**连续两次压缩会复用同一 id** | 任何依赖 id 去重的逻辑都会失效——我们的日志用**条数**而不是 id |
| 6 | `RemoveMessage` 必须是写回数组的第一项（reducer 靠 `removeAllIdx` 切片） | 直接复用 SDK 拼好的数组，顺序天然正确 |

---

## 7. 配置表

| 变量 | 默认值 | 说明 |
|---|---|---|
| `SUMMARY_ENABLED` | `true` | 上下文压缩总开关；设为 `false` 时既不自动压缩，`/summarize` 也只提示已关闭 |
| `SUMMARY_TRIGGER_TOKENS` | `8000` | 历史 token 估算达到该值时自动压缩（口径见 §5.3） |
| `SUMMARY_KEEP_TOKENS` | `2000` | 压缩时保留的最近原文 token 预算 |
| `SUMMARY_TRIM_TOKENS` | `8000` | 单次送进摘要模型的 token 上限；**不得小于「触发阈值 − 保留预算」**，否则更早的历史既没保留也没进摘要 |

`SUMMARY_ENABLED` 用 `z.enum(['true','false'])` 而非 `z.coerce.boolean()`——后者会把字符串 `'false'` 变成 `true`（`Boolean('false') === true`）。

---

## 8. 语义与边界

- **压缩后历史里会多一条 HumanMessage 形态的摘要**。`extractFinalText` 只认 `AIMessage`，所以最终回答文本不受污染；但下游若假设 `messages[0]` 是用户输入会破。
- **摘要消耗主模型配额**：摘要是一次真实 LLM 调用。`SUMMARY_ENABLED=false` 可整体关闭。
- **`/summarize` 与提问并发**：两者都写 checkpoint，后写者可能覆盖前者。文档与代码注释均写明「不要并发」。
- **失败判定耦合 SDK 文案**：`Error generating summary:` / `Previous conversation was too long to summarize.` 两个英文标记，SDK 升级改文案就会失效。已加「与 SDK 版本文案耦合，升级需复核」注释；误判方向安全（宁可拒绝写回，不丢数据）。
- **单条超大消息压不掉**：历史只有一条时切点为 0，那条 256 KB 的输出仍会进模型。只能靠 `SANDBOX_MAX_OUTPUT_BYTES` 缓解，本功能不解决。
- **token 计数是近似值**：CJK 感知口径，跨 SDK 升级需复核。

---

## 9. 与后续工作的关系

`src/agent/context-clearing.ts`（工具输出清理）**直接复用**本功能的 `countMessageTokens`，把旧工具输出在**模型视图层**换成占位符、checkpoint 原文不动。两者的分工：

| 机制 | 管什么 | 动 checkpoint 吗 |
|---|---|---|
| 摘要（本功能） | **历史增长**：把旧消息压成一条摘要 | 是（写回 checkpoint） |
| 工具输出清理 | **工具输出占历史最大单项** | 否（模型视图层替换） |

清理**不能替代**摘要、摘要也替代不了清理——两者的取舍与数据流见 [`readme-context-tool.md`](readme-context-tool.md)。

---

## 10. 测试证据

全量实测：**20 个测试文件 / 370 个用例 PASS**，`pnpm typecheck` 与 `pnpm build` 均 exit 0。

**不依赖真实 key 也能验证的**（本仓的既有做法）：单元测试覆盖 prompt 结构与 token 计数；端到端用 `ScriptedChatModel` 断言压缩前后的消息形状与摘要内容；`/summarize` 冒烟在历史为空时不触发任何模型调用。

**测试要解决的冲突**：SDK 的摘要调用是 `model.invoke(单个字符串 prompt)`，落到模型层就是「**只有一条 human 消息**、内容是整段摘要 prompt」；主模型回合是「system + human(+ tool) 数组」。`FakeListChatModel` 只有一个 `responses` 队列按序消费，两种调用会**抢位置**。

解法：写 `ScriptedChatModel extends FakeListChatModel`，按**消息形状 + prompt 标记**分流，两条响应序列各自独立。判定函数 `looksLikeSummaryCall` 放在**生产代码**里，测试与生产共用同一份判定。另外必须覆写 `bindTools` 返回 `this.withConfig({})`——`FakeListChatModel.bindTools` 会新建普通实例绕开子类的 `_generate`。

**mutation 自检记录**（每次只破坏一处，跑聚焦用例，确认恰好对应的那一个失败，再立即还原）：

| # | 破坏 | 失败用例 |
|---|---|---|
| M1 | `updateState` 去掉 `asNode = START` | `写回 checkpoint 时显式指定 asNode = START` |
| M2 | `trigger` 改成 `{messages: 100000}` | `历史超阈值时自动压缩成一条摘要` |
| M3 | `plan()` 去掉 `keepMessages` 覆盖 | `keepMessages 按条数覆盖保留预算` |
| M4 | `SUMMARY_ENABLED` 解析恒为 true | `总开关关闭时不装中间件且主动触发返回 disabled` |
| M5 | `extractSummaryText` 去掉失败标记检查 | `摘要失败时不写回、历史保持原样` |
| M6 | 去掉自动路径的失败拦截 | `自动压缩时摘要失败则放弃本轮压缩，历史完整保留` |
| M7 | 去掉第二个失败标记 | `SDK 的「历史太长无法摘要」标记视为失败` |
| M8 | 去掉空正文守卫 | `空正文视为失败…` + `纯空白正文视为失败` |

---

## 11. 需要真实 key 的手动冒烟

1. `cp .env.example .env` 填入 key → `pnpm dev` → 连续对话十余轮，观察日志出现「已压缩上下文：N 条历史 → M 条」，且模型在压缩后仍能接着上文做对事。
2. 同会话输入 `/summarize` → 观察压缩提示；再输入一次 → 应提示「当前历史无需压缩」（幂等）。
3. `pnpm serve` → `curl -s http://localhost:4124/.well-known/agent-card.json | head -20` → 卡片正常。

---

## 附：流程降级（披露）

实现过程有两次**由控制器代做**，如实记录：

1. **实现阶段**：子 agent 完成全部代码与提交后，在「为报告复现红阶段」时触达 150 轮上限被终止，**且当时正处于一次未还原的 mutation 中间态**——它把整个功能回退以复现红。控制器核实那些未提交改动**恰为提交的逆向**（逐行比对），不是真实改进；直接 `git restore` 被权限分类器拦下（判定为不可逆销毁），改用 `git stash push -u -m "task15-abandoned-mutation-redphase" -- <六个路径>` **可逆地**存进 `stash@{0}`，工作树随即回到提交状态。随后补做验证、8 处 mutation 自检、代写报告。**独立评审席位未跳过。**
2. **修复阶段**：派出的修复子 agent 在写任何代码之前被 `terminated`。修复规格已精确成文，改动小且边界清晰，按本仓已有先例（Task 5 / Task 10）**由控制器直接实现**并披露。**独立范围化复审席位同样未跳过。**

`stash@{0}` 经逐行比对确认**不含任何该功能提交之外的内容**（它是「删实现、留测试与文档」的回退），可安全丢弃。
