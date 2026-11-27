# 工具加载优化与工具输出清理：实现记录

日期：2026-11-27 · 分支 `feature/tool-loading-optimization` · 设计 spec：[`docs/superpowers/specs/2026-11-27-tool-loading-optimization-design.md`](docs/superpowers/specs/2026-11-27-tool-loading-optimization-design.md)

本文记录最终实现行为、决定实现形态的 SDK 事实，以及实现过程中被推翻的两个前提。SDK 引文全部读自本仓库 `node_modules`，测试数字为实测值。

## 1. 为什么做

上下文窗口里有两类不同的 token 源：

- **工具 schema**：每个工具的 name / description / 参数 JSON Schema 随每次模型调用全量绑定。工具越多，这块固定开销越大，且与对话长短无关。
- **工具输出**：历史里的 ToolMessage。一轮沙箱输出就可能几百 KB，常常是历史里最大的单项。

已有的上下文压缩（摘要）只管**历史增长**：把旧消息压成一条摘要，但**管不到工具 schema**——哪怕历史压到零，几十个工具的 schema 仍每回合全量进模型。因此补上工具侧两条独立的轴：

- **加载轴**：按工具规模三档选择加载方式，避免把全部 schema 无差别塞进每一次模型调用；
- **输出轴**：把旧工具输出在**模型视图层**换成占位符，削掉历史里最大的 token 源，checkpoint 原文不动。

两条轴独立生效，不互相替代——清理为什么不能替代摘要，见 §4.1。

## 2. 三档判据表

判据只算**可延迟集合**：来源为 skill / mcp / a2a 的工具。builtin（`sandbox_exec`、`sandbox_write_file`、`load_skill`）与元工具是常驻入口，不参与判据、永远绑定。

升档判据是「**条数 OR token**」：`estimateToolTokens` = 对 `name + description + JSON.stringify(toJsonSchema(schema))` 做 CJK 感知估算，条数或 token 总和**任一**超过当前档上限即升档。

| 档 | 判据（可延迟集合，默认值） | 绑定给模型 | 追加进 systemMessage | 元工具 |
|---|---|---|---|---|
| `eager` | 条数 ≤ 12 **且** token ≤ 1500 | 全部工具（**不安装加载中间件**） | 无 | 无 |
| `catalog` | 条数 ≤ 40 **且** token ≤ 4000（eager 任一项已超） | 常驻 + 已激活 | 可延迟工具目录：每工具一行 `- 名字: 一句话描述` | `activate_tools` |
| `search` | 条数 > 40 **或** token > 4000 | 常驻 + 已激活 | 只说「有 N 个工具可用，用 `search_tools` 检索」，**不列目录** | `search_tools` + `activate_tools` |

细节：

- **选档在装配期算一次**（`src/agent/tool-catalog.ts` 的 `selectTier`）。工具表装配后不再变化，每回合重算是纯浪费；每回合变化的只有「绑定哪些」，那取决于激活状态。
- `TOOL_LOADING_ENABLED=false` 时同样全量绑定，但装配日志写「工具加载已关闭」，**不谎称档位 eager**——归因不同。无论哪种情况都有一条 info 日志记录档位与判据数值，便于归因。
- **目录描述必须截断**：取 `description` 首行、折叠连续空白、截断到 **80 个码点**（超出补 `…`）。截断用 `[...str]` 按码点迭代，而不是 `String.prototype.slice` 的 UTF-16 口径——`isCjk` 刻意覆盖扩展 B 区（U+20000..U+3FFFF），按 UTF-16 切会把 astral 平面汉字切成孤立代理对。该常量固定（`CATALOG_DESC_LIMIT = 80`），不做配置项。不截断的话，MCP 工具的多段长描述会让目录体积逼近完整 schema，token 收益归零。
- **检索打分**（`searchCatalog`）：query 切词去重后，命中 `name` 记 2 分、命中 `description` 记 1 分（**匹配用完整描述**，截断只用于展示，否则长描述里的关键词召回不到），按分降序、同分按名字排序保证稳定，取前 `searchTopK` 条，0 分不返回。`search_tools` **只返回候选、不自动激活**——激活是模型的显式决定，避免检索噪声直接占窗口。

## 3. 数据流

三个新模块，都在 `src/agent/` 下：

| 文件 | 职责 |
|---|---|
| `tool-catalog.ts` | 纯函数：token 估算、选档、目录渲染、检索打分、`isNamedTool` 守卫。不碰中间件机制，不起 agent 就能测 |
| `tool-loading.ts` | 加载中间件：`activatedTools` state 通道、`activate_tools` / `search_tools` 元工具、`wrapModelCall` 过滤 |
| `context-clearing.ts` | 清理中间件：复用 SDK `ClearToolUsesEdit` 算法 + 浅拷贝 + CJK 感知计数 |

`countTextTokens` / `isCjk` / `countMessageTokens` 从 `summary.ts` 导出、经同目录相对路径引用，不存在第二份 CJK 口径实现。

一次完整回合的数据流：

1. **装配期（一次）**：`mergeToolGroups` 之后取 builtin 名字为常驻名单，其余为可延迟集合 → 求 schema token 总和 → `selectTier` 选档 → `enabled && tier !== 'eager'` 时安装加载中间件；清理开关开启时安装清理中间件。中间件数组固定为 **`[toolLoading, clearing, summarization]`**。
2. **摘要先跑**：摘要用 `beforeModel`，是**独立图节点**，恒在模型节点之前运行并写回 checkpoint，与数组位置无关（见 §4.1）。
3. **加载中间件（最外层 `wrapModelCall`）**：按 `常驻 ∪ activatedTools` 过滤静态工具表，**传原实例**；systemMessage 追加目录 / 检索指引，以及**当前真实生效的激活清单**。
4. **清理中间件（内层 `wrapModelCall`）**：此时收到的 `request.tools` 已是**过滤后的真实绑定集**。浅拷贝 `request.messages`，以 `countMessageTokens(messages) + schemaTokens(过滤后的绑定集)` 为判据，让 `ClearToolUsesEdit` 在**副本上**把旧 ToolMessage 槽位替换成占位符新对象，再把副本显式交给 handler。checkpoint 原文一字不动。
5. **激活写回**：模型发 `activate_tools` 的 tool_call → ToolNode 执行元工具 → `Command.update` 写 `activatedTools` 通道（reducer：先把名字从旧位置移除再追加，重新激活即刷新新近度；合并后超上限从头部 FIFO 淘汰）→ 下一次模型调用看到新清单。**同一次调用内的重复名字先去重**，不会烧掉多个激活名额。

顺序 `[toolLoading, clearing, summarization]` 是 load-bearing 的：SDK 倒序折叠中间件（`AgentNode.js:199`），**数组第一个是最外层 `wrapModelCall`**。清理必须坐在加载内层，schema token 才只数过滤后的绑定集——那才是模型真实输入。

## 4. 实现过程中被推翻的两个前提

这两条是本文档的核心价值：都被实跑 / 读码推翻，记录以免重犯。

### 4.1 「清理排在摘要之前就能推迟摘要」——错

设计初期认为把清理中间件排在摘要中间件之前，就能先削 token、推迟甚至避开摘要。**这不成立**：

- 摘要用 `beforeModel`，是**独立图节点**，跑在模型节点之前，写回 checkpoint；
- 清理用 `wrapModelCall`，在**模型节点内部**；
- `beforeModel` 恒早于模型节点内部的 `wrapModelCall`，**与中间件数组顺序无关**。

所以清理**不能**减少摘要的触发。它省的是每一次模型调用的输入 token，包括那些尚未达到摘要阈值的回合。清理阈值 6000 刻意低于摘要阈值 8000：摘要躲不掉，但摘要发生前的那些回合能先省下来。

### 4.2 「`ReducedValue` 的 default 放 `valueSchema` 上就行」——错

SDK 的必填检查读的是 **`field.inputSchema || field.valueSchema`**（`langchain/dist/agents/nodes/utils.js:57`）。只在 `valueSchema` 上放 `.default()` 会被这个检查绕过，agent 启动直接抛：

```
Middleware "ToolLoading" has required state fields that must be initialized: activatedTools: Required
```

default 必须落在 **`inputSchema`** 上（实现里 valueSchema 与 inputSchema 都带 `.default(() => [])`）。这条用一次性探针（`createAgent` + `MemorySaver` + `FakeListChatModel` 替身）实跑确认，非推断。

## 5. SDK 硬约束

全部读自本地 `node_modules`，非推测。这些事实直接决定了实现形态。

1. **`wrapModelCall` 只能「减」工具，不能增、不能换。** 新增名字（不在静态注册表里）会抛错，除非某个中间件提供 `wrapToolCall`（`AgentNode.js:265`）；同名换实例**一律抛错**（`:267`）。→ 全部工具必须在 `createAgent` 时静态注册齐全；「按需激活」只能是**过滤**这份静态表，且必须传**原实例**。仓库的 Proxy 改名（`src/shared/tool-rename.ts`）在装配期完成，正好满足。
2. **中间件数组第一个是 `wrapModelCall` 最外层**（`AgentNode.js:199` 起的倒序折叠循环）。顺序的实质作用见 §3。
3. **`request.messages` 与 `state.messages` 是同一个数组引用**（`AgentNode.js:359`）。SDK 的清理是原地替换数组槽位，有写脏 checkpoint 的风险。→ 必须浅拷贝后再清，并显式替换 `request.messages`；槽位替换的是**新消息对象**、不改原消息对象，所以浅拷贝足够。
4. **`contextEditingMiddleware` 没有 `tokenCounter` 注入口**，只有 `tokenCountMethod: "approx" | "model"`：`approx` 是 chars/4，对中文低估 3–4 倍；`model` 路径要求模型实现 `getNumTokensFromMessages`。→ **复用 `ClearToolUsesEdit`（清理算法），自建 `createMiddleware`（外壳）**，经 `ContextEdit.apply` 传入 CJK 感知的 `countTokens`。自建外壳顺带解决浅拷贝问题，比包装 SDK 外壳更简单。
   - **外壳省略了 SDK edit 的 `model` 参数**：`request.model` 的类型与 `BaseLanguageModel` 对不上，且 `model` 只在 `trigger.fraction` / `keep.fraction` 分支里被读取（`contextEditing.js:269-279`、`:317-324`）。本策略用 `{ tokens }` 触发、`{ messages }` 保留，不走 fraction，省略是安全的。**若日后改用 fraction 口径，这个省略会静默落回默认值**（触发条件被跳过、保留落回 `DEFAULT_KEEP`）——届时必须补传 `model`。
5. **`providerToolSearchMiddleware` 对 OpenAI 兼容网关不可用**：它要求 provider 具备服务端 tool search（gpt-5.4+ / Claude 4+）。本仓库默认 `openai-compatible` 网关的 `getName()` 返回 `ChatOpenAI`，能通过它的 provider 门禁，但网关会拒掉注入的 `tool_search` 原生工具——**门禁放行不等于能力可用**（`providerToolSearch.js:79`）。
6. **`llmToolSelectorMiddleware` 的选择器只看得到工具名**：选择 schema 只有 `z.literal(tool.name)`，**没有 description**（其上方注释声称带 description，与代码不符），对带来源前缀的工具名选择质量差；且每个模型回合多一次真实 LLM 调用，选到非法名直接抛错（`llmToolSelector.js:87-104`、`:191`）。不用。
7. **`Runnable.isRunnable` 的类型签名会撒谎**：声明为 `thing is Runnable`，实际返回 `thing.lc_runnable`（`@langchain/core/dist/runnables/utils.js:2-4`）——对带 `name` 的普通对象返回的是 `undefined`，不是 `false`。所以项目的 `isNamedTool` 守卫用 `Boolean(...)` 包一层，保证返回真正的布尔。该守卫区分客户端工具与 provider 原生工具 dict（后者没有 name/schema，不参与过滤与 token 估算）。
8. **中间件可以自带工具与持久化 state 通道**：工具会被并入 ToolNode（`ReactAgent.js:71-72`），元工具因此不必在 `AgentRuntime` 里手工注册；绑定顺序是 `[...静态工具, ...中间件工具]`，元工具出现在列表末尾，不影响语义。state 通道用 `StateSchema` + `ReducedValue`（带 reducer），随 checkpoint 持久化、thread 内累积。

### 已实测验证的前提

用一次性探针（`createAgent` + `MemorySaver` + `FakeListChatModel` 替身）实跑确认，非推断（spec §3.5）：

1. `StateSchema` + `ReducedValue` 配 zod v4 可用，但 **`inputSchema` 必须自带 `.default()`**（见 §4.2）。
2. `wrapModelCall` 里过滤静态工具表不会触发 SDK 的增/换校验——前提是传原实例、只减不增。
3. 激活状态跨 `invoke` 持久（同一 thread）。
4. FIFO 淘汰按预期生效：上限 3、依次激活 t1,t2 → t3,t4，结果恰为 `t2,t3,t4`。
5. **激活扛住 `REMOVE_ALL_MESSAGES`**：清空 `messages` 通道前后 `activatedTools` 不变。这是选自定义通道而非「从历史推导」的决定性依据——摘要压缩清的正是 `messages` 通道，碰不到 `activatedTools`。
6. 真实 `Command` 路径可写通道：模型发 `activate_tools` 的 tool_call → ToolNode → `Command.update` → 通道更新。

## 6. 为什么不引入额外 LLM 调用

三档全部靠**本地判据与本地检索**：

- 选档是两次整数比较；
- 目录是字符串渲染；
- 检索是自写词频重叠打分（ASCII 按词切 + CJK 单字与相邻二字 bigram），不引新依赖、不做 embedding；
- 激活是模型在正常回合内的显式工具调用，不是额外调用。

零配额开销、零额外延迟。对照被排除的两条 SDK 路径：`llmToolSelectorMiddleware` 每回合多一次真实 LLM 调用且选择器看不到 description；网关原生 tool search 依赖 provider 能力，兼容网关没有。工具集规模下 IDF 收益低，也不做 BM25。摘要仍是运行时里唯一的额外 LLM 调用（既有功能，本特性不改动它）。

## 7. 配置表

10 个新变量，定义在 `src/config/env.ts`，启动期 zod 校验，缺失或非法立即报错：

| 变量 | 默认值 | 含义 |
|---|---|---|
| `TOOL_LOADING_ENABLED` | `true` | 加载分档总开关；`false` 时全量绑定 |
| `TOOL_LOADING_EAGER_MAX_TOOLS` | `12` | 可延迟工具条数 ≤ 该值才可能走 eager |
| `TOOL_LOADING_EAGER_MAX_TOKENS` | `1500` | 可延迟工具 schema token ≤ 该值才可能走 eager |
| `TOOL_LOADING_CATALOG_MAX_TOOLS` | `40` | 条数 ≤ 该值才可能走 catalog，否则 search |
| `TOOL_LOADING_CATALOG_MAX_TOKENS` | `4000` | schema token ≤ 该值才可能走 catalog |
| `TOOL_LOADING_SEARCH_TOP_K` | `8` | `search_tools` 返回候选上限 |
| `TOOL_LOADING_MAX_ACTIVE` | `24` | 同时激活上限，超出按 FIFO 淘汰 |
| `TOOL_CLEARING_ENABLED` | `true` | 工具输出清理开关 |
| `TOOL_CLEARING_TRIGGER_TOKENS` | `6000` | 视图 token 达到该值开始清理 |
| `TOOL_CLEARING_KEEP_MESSAGES` | `3` | 保留最近 N 条工具输出不清 |

约束与口径：

- **`EAGER_MAX_* ≤ CATALOG_MAX_*`**（两对各自成立）：eager 是 catalog 的子集，上限反了会让 catalog 档永远选不中，非法组合在启动期抛 `ConfigError`。
- 布尔用 `z.enum(['true','false'])`，**不用 `z.coerce.boolean()`**（`Boolean('false') === true`，仓库已有此教训）。
- 清理阈值 6000 刻意低于摘要阈值 8000，理由见 §4.1。
- 目录描述截断长度（80 码点）是固定常量，不是配置项。

## 8. 语义与边界

- **被隐藏 / 被淘汰的工具仍可执行**。ToolNode 吃的是全量静态表，`wrapModelCall` 只改模型视图；历史里的工具调用不会失效。
- **清理可逆**。checkpoint 里工具输出原文一字不动，只有模型视图被削。占位符文案是 `[已清理的工具输出]`；`ClearToolUsesEdit` 自带 `response_metadata.context_editing.cleared` 幂等标记，重复清理不会叠加。
- **清理不能推迟摘要**（§4.1）。
- **token 口径是 CJK 感知近似值**（中文一字一 token，其余四字符一 token），不是模型真实 tokenizer。schema token 计入清理判据：工具绑定得多时清理更早触发——这是正确的，窗口确实被 schema 占了。
- **检索切词只覆盖 ASCII 与 CJK**。分词器只保留 `[a-z0-9]`（转小写）与 `isCjk` 命中的码点，带重音拉丁字母（é、ü…）、西里尔字母等会被当作分隔符**丢弃**。含这类字符的工具名**检索召回不到**——这是真实限制；模型需要用 `activate_tools` 直接点名（激活按名字精确匹配，不受切词影响）。
- **单条超大工具输出**：只要不在最近 `keepMessages` 条里，清理把整条换成占位符，体积立刻归零；若就在保留窗口内则原样进模型，此时仍靠 `SANDBOX_MAX_OUTPUT_BYTES` 兜——与摘要「单条消息压不掉」是同一个边界。
- **同一次 `activate_tools` 调用内的重复名字会去重**，只占一个激活名额；重复激活已激活的名字会刷新新近度（FIFO 位置移到末尾）；传入已常驻的名字视为 no-op，回执「已常驻，无需激活」；未知名字在回执里逐个点名。
- **淘汰对模型可见，不静默**：每次模型调用的 systemMessage 都列出当前真实生效的激活清单，FIFO 淘汰后模型在下一次模型调用（同一次 run 内即生效）看到的就是淘汰后的清单。
- **`load_skill` 与 `activate_tools` 并存**：前者读 skill 说明书正文，后者绑工具 schema，语义不同，都保留。
- **不要与对话并发**：激活状态与摘要写回一样，后写者可能覆盖前者。

## 9. 测试证据

真实数字（Node v24.19.0，`pnpm vitest run`）：

```
 Test Files  20 passed (20)
      Tests  368 passed (368)
```

`pnpm typecheck` 与 `pnpm build` 均退出码 0。

三个新测试文件各自覆盖：

| 文件 | 覆盖 |
|---|---|
| `tests/agent.tool-catalog.test.ts` | token 估算（中文一字一 token，名字 / 描述 / schema 都计入）；选档边界（条数命中 / token 命中 / 双命中 / 都不命中 / 零工具）；`isNamedTool`（真实工具 / provider dict / 带 name 的普通对象）；描述截断（首行、空白折叠、80 上限、恰好等于上限不加省略号、**扩展区汉字按码点截断、不留孤立代理**）；目录渲染；切词（ASCII 按词、CJK 单字 + bigram、中英混合）；检索打分（中文召回、名字权重高于描述、**靠完整描述召回**、topK 留最高分、同分稳定排序、无匹配 / 空 query） |
| `tests/agent.tool-loading.test.ts` | catalog 档只绑常驻 + `activate_tools`；目录进系统提示；激活后完整 schema 被绑定（**过滤传原实例、不触发 SDK 增/换校验**）；激活跨 invoke 持久；**摘要式 `REMOVE_ALL_MESSAGES` 后激活不丢**；FIFO 淘汰且清单对模型可见；重复激活刷新新近度；**同一请求内重复名字只占一个名额**；未知名字点名；常驻名字 no-op；元工具自身名字也算常驻；search 档绑双元工具、不列目录、检索不自动激活、无匹配给可执行下一步、检索后再激活即可绑定 |
| `tests/agent.tool-clearing.test.ts` | 超阈值旧 ToolMessage 换占位符；未达阈值不清理；**checkpoint 原文一字未改**；CJK 口径比 chars/4 更早触发；保留窗口内不清；重复调用幂等；**schema token 计入判据**（消息本身不超阈也会清理） |

两个既有文件同步扩展：`tests/config.env.test.ts`（10 个新变量的默认值与非法值报错，含 `EAGER > CATALOG` 非法组合）、`tests/agent.runtime.test.ts`（装配：档位日志、eager 不安装中间件、开关关闭时日志不谎称 eager、清理默认安装 / 关闭不安装、**清理在加载内层只数过滤后的绑定集**）。

模型替身沿用既有模式：加载测试用 `FakeListChatModel` 子类记录每次真实绑定的工具名与系统提示，装配与摘要测试用 `ScriptedChatModel` / `RecordingChatModel`。工具加载不引入额外 LLM 调用，因此不需要新的替身分流逻辑。
