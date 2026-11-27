# 工具加载优化与工具输出清理设计

日期：2026-11-27
状态：设计已确认，待实现（分支 `feature/tool-loading-optimization`，基线 `838c2e4`，17 文件 / 283 测试全绿）

## 1. 目标

在已有的上下文压缩之上，补齐**工具侧**的 token 窗口优化，分两条轴：

- **加载轴**：按工具规模选择加载方式，避免把全部工具 schema 无差别塞进每一次模型调用。
- **输出轴**：把旧的工具输出从模型视图里换成占位符，削掉历史里最大的 token 源。

非目标（本次不做）：向量检索 / embedding、跨 thread 的工具使用统计与学习、工具 schema 自身的压缩改写、持久化删除工具输出。

## 2. 已确认决策

| 决策点 | 结论 |
|---|---|
| 加载分档 | 三档：`eager` 全量 / `catalog` 目录+按需激活 / `search` 检索+按需激活 |
| 升档判据 | 工具条数 **OR** schema 估算 token，任一超阈即升档 |
| 激活状态 | 中间件自定义 state 通道，随 checkpoint 持久化，thread 内累积 |
| 输出清理层次 | **视图层**（`wrapModelCall` + 浅拷贝），checkpoint 原文不动 |
| 额外 LLM 调用 | 零。不使用 `llmToolSelectorMiddleware`，不使用网关原生 tool search |
| 检索实现 | 自写词频重叠打分，不引新依赖 |

## 3. SDK 事实与硬约束

全部读自本地 `node_modules`，非推测。这些事实直接决定了实现形态。

### 3.1 被排除的两条 SDK 路径

| 路径 | 排除原因 | 证据 |
|---|---|---|
| `providerToolSearchMiddleware` | 要求 provider 具备服务端 tool search（gpt-5.4+ / Claude 4+）。本仓库默认 `openai-compatible` 网关，`getName()` 返回 `ChatOpenAI` 能通过它的 provider 门禁，但网关会拒掉注入的 `tool_search` 原生工具——**门禁放行不等于能力可用** | `providerToolSearch.js:79`、`:4-11`、`:116-125` |
| `llmToolSelectorMiddleware` | ① 每个模型回合多一次真实 LLM 调用；② 选择器 schema 只有 `z.literal(tool.name)`，**看不到 description**（其上方注释声称带 description，与代码不符），对带来源前缀的工具名选择质量差；③ 选到非法名直接抛错 | `llmToolSelector.js:18`、`:87-104`、`:191` |

### 3.2 决定实现形态的三条约束

1. **`wrapModelCall` 只能「减」工具，不能增、不能换。**
   新增名字（不在静态 `toolClasses` 里）会抛错，除非某个中间件提供 `wrapToolCall`；同名换实例**一律抛错**。
   → 全部工具必须在 `createAgent` 时静态注册齐全；「按需激活」只能是**过滤**这份静态表，且必须传**原实例**。仓库现有的 Proxy 改名（`src/shared/tool-rename.ts`）在装配期完成，正好满足。
   证据：`AgentNode.js:265`、`:267`。

2. **中间件数组第一个是 `wrapModelCall` 最外层。**
   证据：`AgentNode.js:197` 起的倒序折叠循环。

3. **`request.messages` 与 `state.messages` 是同一个数组引用。**
   SDK 的清理是原地替换数组槽位（`messages[idx] = new ToolMessage(...)`），有写脏 checkpoint 的风险。
   → 我们必须浅拷贝后再清，并显式替换 `request.messages`。槽位替换的是**新消息对象**、不改原消息对象，所以浅拷贝足够。
   证据：`AgentNode.js:359`、`contextEditing.js:158`、`:176`、`:220`、`:238`。

### 3.3 可复用与不可复用

- **中间件可以自带工具**，会被并入 `ToolNode`：`ReactAgent.js:71-72`。元工具因此不必在 `AgentRuntime` 里手工注册。
- **中间件可以自带持久化 state 通道**，支持 `StateSchema` + `ReducedValue`（带 reducer）：`middleware.d.ts:40-56`、`:68`。
- **`contextEditingMiddleware` 没有 `tokenCounter` 注入口**，只有 `tokenCountMethod: "approx" | "model"`；`approx` 是 chars/4，对中文低估 3–4 倍，`model` 路径要求模型实现 `getNumTokensFromMessages`。证据：`contextEditing.js:499`、`:508-516`，`contextEditing.d.ts:208`。
  → **复用 `ClearToolUsesEdit`（清理算法），自建 `createMiddleware`（外壳）**。`ContextEdit.apply` 收到的 `countTokens` 是参数，可以由我们传入 CJK 感知口径（`contextEditing.d.ts:44-72`）。外壳自建还顺带解决浅拷贝问题——比包装 SDK 外壳更简单。
- **`isClientTool` 不是公开导出**（langchain 内部 `utils.js:133`，实现是 `Runnable.isRunnable(tool)`）。我们用公开等价物 `Runnable.isRunnable`（`@langchain/core/runnables`）判别客户端工具与 provider dict。
- **`toJsonSchema`** 可用：`@langchain/core/utils/json_schema`。

### 3.4 一条被推翻的初始假设（记录以免重犯）

设计初期认为「把清理排在摘要中间件之前，就能推迟甚至避开摘要」。**这是错的**：

- 摘要中间件用 `beforeModel`，是**独立图节点**，跑在模型节点之前，写回 checkpoint。
- 清理用 `wrapModelCall`，在**模型节点内部**。
- `beforeModel` 恒早于 `wrapModelCall`，**与中间件数组顺序无关**。

所以清理**不能**减少摘要的触发。它省的是每一次模型调用的输入 token，包括那些尚未达到摘要阈值的回合。两条轴独立生效，不互相替代。

### 3.5 已实测验证的五条前提

用一次性探针（`createAgent` + `MemorySaver` + `FakeListChatModel` 替身）实跑确认，非推断：

1. **`StateSchema` + `ReducedValue` 配 zod v4 可用**，但 **`inputSchema` 必须自带 `.default()`**。
   `utils.js:57` 的必填检查取 `field.inputSchema || field.valueSchema`——只在 `valueSchema` 上放 `.default()` 会被绕过，启动直接抛
   `Middleware "…" has required state fields that must be initialized: activatedTools: Required`。
2. **`wrapModelCall` 里过滤静态工具表不会触发 SDK 的增/换校验**（传原实例、只减不增）。
3. **激活状态跨 `invoke` 持久**（同一 thread）。
4. **FIFO 淘汰按预期生效**：上限 3、依次激活 t1,t2 → t3,t4，结果恰为 `t2,t3,t4`。
5. **激活扛住 `REMOVE_ALL_MESSAGES`**：清空 `messages` 通道前后，`activatedTools` 均为 `["t2","t3","t4"]`。这是选自定义通道而非「从历史推导」的决定性依据。
6. **真实 `Command` 路径可写通道**：模型发 `activate_tools` 的 tool_call → ToolNode → `Command.update` → 通道值为 `["t1","t2"]`。

附带观察：绑定顺序是 `[...静态工具, ...中间件工具]`（`ReactAgent.js:72`），所以元工具出现在列表末尾。不影响语义。

## 4. 模块边界

`src/agent/` 下三个新文件：

| 文件 | 职责 | 依赖 |
|---|---|---|
| `tool-catalog.ts` | 纯函数：schema token 估算、选档、目录渲染、检索打分 | 类型 + `toJsonSchema` + 已有 CJK 计数口径 |
| `tool-loading.ts` | 中间件：state 通道、元工具、`wrapModelCall` 过滤 | `tool-catalog` |
| `context-clearing.ts` | 中间件：`ClearToolUsesEdit` + 浅拷贝 + CJK 计数 | SDK + `countMessageTokens` + `estimateToolTokens` |

`tool-catalog.ts` 不碰中间件机制，选档与检索的全部逻辑可用纯函数测，不需要起 agent。

`countTextTokens` 与 `isCjk` 目前是 `summary.ts` 内的私有函数。**从 `summary.ts` 导出这两个**，`tool-catalog.ts` 经同目录相对路径引用。不复制第二份实现，避免两套 CJK 口径漂移（检索切词同样需要 `isCjk`）。

## 5. 选档判据

判据只算**可延迟集合**（来源为 skill / mcp / a2a 的工具）。builtin 与元工具是常驻入口，不参与判据、永远绑定。

```ts
export type ToolTier = 'eager' | 'catalog' | 'search';

export function selectTier(count: number, tokens: number, p: ToolLoadingPolicy): ToolTier {
  if (count <= p.eagerMaxTools && tokens <= p.eagerMaxTokens) return 'eager';
  if (count <= p.catalogMaxTools && tokens <= p.catalogMaxTokens) return 'catalog';
  return 'search';
}
```

**选档在装配期算一次**——工具表装配后不再变化，每回合重算是纯浪费。每回合变化的只有「绑定哪些」，那取决于激活状态。

`estimateToolTokens(tool)` = `countTextTokens(name + description + JSON.stringify(toJsonSchema(tool.schema)))`。

常驻名单由 `AgentRuntime` 传入（builtin 工具名）。builtin 在 `mergeToolGroups` 里优先级最高、不会被冲突改名，名字稳定。

## 6. 三档暴露矩阵

| 档 | 绑定给模型 | 追加进 systemMessage | 元工具 |
|---|---|---|---|
| `eager` | 全部 | 无 | 无 |
| `catalog` | 常驻 + 已激活 | 可延迟工具的「名字 + 一句话描述」目录 | `activate_tools` |
| `search` | 常驻 + 已激活 | 只说「有 N 个工具可用，用 `search_tools` 检索」，**不列目录** | `search_tools` + `activate_tools` |

`eager` 档或总开关关闭时**不安装该中间件**（静态工具表本身就是全量绑定）。无论哪档，装配期都记一条 info 日志说明选中档位与判据数值，便于归因。

**目录里的描述必须截断**：MCP 工具的 `description` 常见多段长文，原样列目录会让目录体积逼近完整 schema，token 收益归零。目录每行取 `description` 首行并截断到 **80 个字符**（超出补 `…`），换行折叠为空格。该常量固定，不做配置项。

`search_tools` 只返回候选（名字 + 截断后的描述），**不自动激活**——激活是模型的显式决定，避免检索噪声直接占窗口。

## 7. 激活状态与元工具

```ts
new StateSchema({
  activatedTools: new ReducedValue(z.array(z.string()).default(() => []), {
    inputSchema: z.array(z.string()).default(() => []),   // default 必须在 inputSchema 上，见 §3.5
    reducer: (current, next) => {
      // next 中的名字先从 current 移除旧位置再追加：重新激活即刷新新近度
      // 合并后超过 maxActiveTools 时从头部丢弃（FIFO）
    },
  }),
})
```

元工具照 `todoListMiddleware` 的规范写法返回 `Command`（`todoListMiddleware.js:144-156`）：

```ts
tool(({ names }, config) => new Command({
  update: {
    activatedTools: names,
    messages: [new ToolMessage({
      content: /* 已知名字 / 未知名字 / 上限提示 */,
      tool_call_id: config.toolCall?.id,
      name: 'activate_tools',
    })],
  },
}), { name: 'activate_tools', schema: z.object({ names: z.array(z.string()).min(1) }) })
```

**淘汰对模型可见，不静默**：每次模型调用的 systemMessage 都列出**当前真实生效**的激活清单。reducer 做 FIFO 淘汰后，模型在下一次模型调用（同一次 `run` 内即生效）看到的就是淘汰后的清单。未知名字在 ToolMessage 里逐个点名；传入已常驻的名字视为 no-op 并回一句「已常驻，无需激活」。

摘要压缩用 `REMOVE_ALL_MESSAGES` 清的是 `messages` 通道，**碰不到 `activatedTools`**——这是选自定义通道而非「从历史推导」的唯一理由，会有专门测试钉住。

## 8. 检索打分

不引新依赖。

- **切词**：ASCII 按非字母数字切、转小写；CJK 取**单字 + 相邻二字 bigram**（中文无空格，纯单字召回噪声大）。
- **打分**：query 词命中 `name` 权重 ×2，命中 `description` 权重 ×1，求和。**匹配用完整 `description`**（截断只用于展示，否则长描述里的关键词召回不到）。
- **返回**：按分降序取 `searchTopK`，0 分不返回。全 0 时返回「无匹配，请换个说法或用 `activate_tools` 直接指定名字」。

工具集规模下 IDF 收益低，不做 BM25。

## 9. 清理中间件与中间件顺序

```ts
middleware: [toolLoading, clearing, summarization]
```

顺序有实质作用：**clearing 在内层，收到的 `request.tools` 已经是 toolLoading 过滤后的真实绑定集**，于是能把 schema token 一并计入窗口——这才是模型真实输入。

```ts
const edit = new ClearToolUsesEdit({
  trigger: { tokens: p.triggerTokens },
  keep: { messages: p.keepMessages },
  placeholder: '[已清理的工具输出]',
});

createMiddleware({
  name: 'ToolOutputClearing',
  wrapModelCall: async (request, handler) => {
    const messages = [...request.messages];               // 浅拷贝，checkpoint 不受影响
    const schemaTokens = request.tools
      .filter((t) => Runnable.isRunnable(t))              // provider dict 没有 zod schema，跳过
      .reduce((sum, t) => sum + estimateToolTokens(t), 0);
    await edit.apply({
      messages,
      model: request.model,
      countTokens: async (msgs) => countMessageTokens(msgs) + schemaTokens,
    });
    return handler({ ...request, messages });
  },
});
```

`ClearToolUsesEdit` 自带 `response_metadata.context_editing.cleared` 幂等标记，重复清理不会叠加。

## 10. 配置面（10 个新变量）

| 变量 | 默认值 | 说明 |
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

约束：`EAGER_MAX_* ≤ CATALOG_MAX_*`（两对各自成立），非法组合在启动期报错。布尔用 `z.enum(['true','false'])`，**不用 `z.coerce.boolean()`**（`Boolean('false') === true`，仓库已有此教训）。

清理阈值 6000 刻意低于摘要阈值 8000：摘要躲不掉，但摘要发生前的那些回合能先省下来。

## 11. 语义与已知边界

- **被隐藏 / 被淘汰的工具仍可执行**。`ToolNode` 吃的是全量静态表，`wrapModelCall` 只改模型视图。历史里的工具调用不会失效。
- **清理可逆**。checkpoint 里工具输出原文一字不动，只有模型视图被削。
- **清理不能推迟摘要**（见 §3.4）。
- **token 口径是 CJK 感知近似值**，不是模型真实 tokenizer。
- **schema token 计入清理判据**，因此工具绑定得多时清理会更早触发——这是正确的，窗口确实被 schema 占了。
- **`load_skill` 与 `activate_tools` 并存**：前者读说明书正文，后者绑工具 schema，语义不同，都保留。
- **单条超大工具输出**：只要它不在最近 `keepMessages` 条里，清理会把整条换成占位符，体积立刻归零。若它就在保留窗口内则原样进模型，此时仍靠 `SANDBOX_MAX_OUTPUT_BYTES` 兜——这与摘要「单条消息压不掉」是同一个边界。
- **不要与对话并发**：激活状态与摘要写回一样，后写者可能覆盖前者。

## 12. 测试策略

| 文件 | 覆盖 |
|---|---|
| `tests/agent.tool-catalog.test.ts` | token 估算（CJK / ASCII / schema 计入）；选档四象限边界（条数命中 / token 命中 / 双命中 / 都不命中）；目录渲染与**长描述截断到 80 字符**；检索打分（中文名命中、bigram、name 权重高于 description、**截断后仍能靠完整描述召回**、无匹配） |
| `tests/agent.tool-loading.test.ts` | eager 不安装中间件；catalog 档只绑常驻+已激活；`activate_tools` 写 state；激活跨轮持久；**摘要压缩后激活不丢**；FIFO 淘汰且清单对模型可见；未知名字点名；search 档不列目录；`search_tools` 不自动激活；**过滤传原实例、不触发 SDK 的增/换校验抛错** |
| `tests/agent.tool-clearing.test.ts` | 旧 ToolMessage 换占位符；最近 N 条保留；**checkpoint 原文未被改写**；CJK 口径生效（同样中文字符数比 chars/4 更早触发）；schema token 计入；幂等 |
| `tests/config.env.test.ts` | 10 个新变量的默认值与非法值报错，含 `EAGER > CATALOG` 的非法组合 |
| `tests/agent.runtime.test.ts` | 装配：档位日志、中间件顺序、开关关闭时不安装 |

模型调用沿用现有 `ScriptedChatModel` 模式（`tests/agent.summarize.test.ts`），按消息形状分流摘要回合与主回合；工具加载不引入额外 LLM 调用，因此不需要新的替身分流逻辑。

## 13. 文档交付

- **`readme-context-tool.md`（仓库根目录）**：实现过程记录——动机、三档判据表、SDK 事实与硬约束（含 §3.4 那条被推翻的假设）、模块边界、数据流、配置表、语义边界、测试证据。
- `README.md`：特性表加一行、配置表补 10 个变量、上下文压缩小节指向新文档。
- `.env.example`：补 10 个变量。