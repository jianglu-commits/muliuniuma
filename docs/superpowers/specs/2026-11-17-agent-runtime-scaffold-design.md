# Agent Runtime 基础骨架设计

日期：2026-11-17
状态：已确认，待实现

## 1. 目标

从零建立一个**可运行、可扩展**的 TypeScript Agent 项目骨架，覆盖五个能力域：LLM 接入、MCP 工具接入、Skill 声明式加载、运行沙箱、A2A 互联。骨架必须首版即跑通端到端闭环，而非空目录占位。

非目标（首版不做）：多 Agent 编排图、Web UI、生产级鉴权、分布式部署。

## 2. 已确认决策

| 决策点 | 结论 |
|---|---|
| 项目形态 | 单包 + 模块化目录（`src/<module>/`），每模块一个 barrel 出口 |
| LLM | 多 Provider 抽象；首版只装 `@langchain/openai`，靠 `baseURL` 覆盖所有 OpenAI 兼容网关 |
| 沙箱 | `Sandbox` 接口 + `LocalProcessSandbox`（child_process）实现 |
| Skill | Markdown 声明式（`skills/<name>/SKILL.md` + frontmatter），可选同名 `tool.ts` |
| MCP | 用官方 `@langchain/mcp-adapters`，自身只保留配置加载 / 生命周期 / 工具命名空间 |
| 持久化 | SQLite checkpointer（`@langchain/langgraph-checkpoint-sqlite`） |
| A2A | 同时具备 server（被调用）与 client（主动调用远端 agent） |
| 测试 | 顶层 `tests/`，不混入 `src/` |
| 包管理 | pnpm |

## 3. 运行环境约束

- `engines.node = ">=22"`，`.nvmrc = 24`。
  依据：`@langchain/openai` 要求 ≥22，`vitest@5` 要求 `^22.12 || ^24`。
- 开发机 nvm 默认版本为 v18.17.0，**不满足要求**。`dev` / `serve` 脚本前置 Node 版本断言，版本不符直接报错退出，避免后续出现难以归因的语法/API 错误。

## 4. 依赖与版本（已核实 registry 真实最新版）

运行时：

| 包 | 版本 | Node |
|---|---|---|
| `langchain` | 1.6.6 | ≥20 |
| `@langchain/core` | 1.4.1 | ≥20 |
| `@langchain/langgraph` | 1.7.5 | ≥18 |
| `@langchain/langgraph-checkpoint-sqlite` | 1.1.1 | ≥18 |
| `@langchain/openai` | 1.8.4 | ≥22 |
| `@langchain/mcp-adapters` | 2.0.3 | ≥20.10 |
| `@a2a-js/sdk` | 1.3.0 | ≥20 |
| `zod` | 4.6.7 | — |
| `express` | 5.3.0 | ≥18 |

开发时：

| 包 | 版本 | 说明 |
|---|---|---|
| `typescript` | ~6.0.3 | registry latest 已是 7.0.2（Go 重写版），但 tsx / vitest / 编辑器插件对 7.x 的适配尚未验证，首版锁 6.x 求稳；升级 7.x 作为独立事项 |
| `tsx` | 4.23.15 | ≥18 |
| `vitest` | 5.1.0 | ≥22.12 |
| `@types/node` | ^24 | 对齐 `.nvmrc`；不用 26.x，避免引入本机不存在版本的 API 类型 |
| `@types/express` | 5.0.6 | 对齐 express 5 |

已确认的导入路径（非推测，均读自本地 `node_modules` 的 `.d.ts`）：
- `langchain` → `createAgent`、`tool`（实际使用）
- `@langchain/langgraph/prebuilt` → `createReactAgent`（已 `@deprecated`，不使用）
- `langchain/chat_models/universal` → `initChatModel`（备用，首版不采用）
- `@langchain/langgraph-checkpoint-sqlite` → `SqliteSaver`
- `@langchain/mcp-adapters` → `MCPAdapter`
- `@a2a-js/sdk`、`@a2a-js/sdk/server`、`@a2a-js/sdk/server/express`、`@a2a-js/sdk/client`

## 5. 目录结构

```
muliuniuma/
├─ package.json
├─ tsconfig.json              # 基础配置（含 paths）
├─ tsconfig.build.json        # 构建用，排除 tests
├─ vitest.config.ts
├─ .nvmrc                     # 24
├─ .env.example
├─ .gitignore
├─ README.md
├─ config/
│  ├─ mcp.servers.json        # MCP server 声明，空数组时静默跳过
│  └─ a2a.peers.json          # 可主动调用的远端 agent 列表
├─ skills/
│  └─ hello-world/
│     ├─ SKILL.md             # frontmatter: name / description / allowed-tools
│     └─ tool.ts              # 可选：skill 自带工具
├─ scripts/
│  └─ check-node.ts           # Node 版本断言，dev / serve 前置执行
├─ src/
│  ├─ config/
│  │  ├─ env.ts               # zod 校验 process.env → AppConfig
│  │  └─ index.ts
│  ├─ shared/
│  │  ├─ logger.ts
│  │  ├─ errors.ts            # AppError 层次
│  │  └─ index.ts
│  ├─ llm/
│  │  ├─ types.ts             # ModelSpec
│  │  ├─ factory.ts           # createChatModel：provider 注册表
│  │  └─ index.ts
│  ├─ sandbox/
│  │  ├─ types.ts             # Sandbox / ExecResult
│  │  ├─ local.ts             # LocalProcessSandbox
│  │  ├─ factory.ts           # createSandbox(config)
│  │  └─ index.ts
│  ├─ skills/
│  │  ├─ types.ts             # SkillManifest
│  │  ├─ loader.ts            # 扫描目录、解析 frontmatter、动态 import tool.ts
│  │  ├─ registry.ts          # SkillRegistry：提示注入 + 工具收集
│  │  └─ index.ts
│  ├─ mcp/
│  │  ├─ config.ts            # 读取 config/mcp.servers.json
│  │  ├─ hub.ts               # McpHub：MultiServerMCPClient 包装
│  │  └─ index.ts
│  ├─ a2a/
│  │  ├─ card.ts              # 构造本 agent 的 AgentCard
│  │  ├─ messages.ts          # 构造 A2A Message、提取文本（buildTextMessage / extractText）
│  │  ├─ executor.ts          # A2A 请求 → AgentRuntime
│  │  ├─ server.ts            # express server bootstrap
│  │  ├─ client.ts            # A2AClientHub：调用远端 agent
│  │  ├─ remote-tool.ts       # 把远端 agent 包装成本地可调用工具
│  │  └─ index.ts
│  ├─ tools/
│  │  ├─ sandbox-tool.ts      # sandbox_exec / sandbox_write_file
│  │  └─ index.ts
│  ├─ agent/
│  │  ├─ tools.ts             # 工具合并：按来源优先级去重改名
│  │  ├─ runtime.ts           # AgentRuntime：唯一装配点
│  │  └─ index.ts
│  ├─ cli.ts                   # 入口 1：本地 REPL
│  └─ serve.ts                 # 入口 2：A2A HTTP server
└─ tests/
   ├─ sandbox.local.test.ts
   ├─ skills.loader.test.ts
   └─ llm.factory.test.ts
```

边界规则：跨模块导入只允许走对方 `index.ts`。这是单包形态下保住模块边界的唯一手段，也让未来拆 monorepo 时可以按目录直接切分。

## 6. 核心接口

### 6.1 LLM

```ts
// src/llm/types.ts
export type ProviderId =
  | 'openai'               // 官方 OpenAI
  | 'openai-compatible'    // 任意 OpenAI 兼容网关（DashScope / DeepSeek / vLLM …）
  | 'anthropic' | 'google' | 'ollama'
  | (string & {});

export interface ModelSpec {
  provider: ProviderId;
  model: string;
  baseURL?: string;
  apiKey?: string;
  temperature?: number;
}

// src/llm/factory.ts
export type ChatModelFactory = (spec: ModelSpec) => Promise<BaseChatModel>;

export function registerProvider(id: ProviderId, f: ChatModelFactory): void;
export function createChatModel(spec: ModelSpec): Promise<BaseChatModel>;
```

首版注册表含 `openai` 与 `openai-compatible` 两个 id，二者共用同一个 `ChatOpenAI` 实现，差别仅在 `baseURL` 默认值（前者用官方地址，后者要求 `.env` 显式给出）。这样 `.env.example` 里的 `LLM_PROVIDER=openai-compatible` 与注册表严格对应。

未注册的 provider **不走** `initChatModel` 的隐式解析，而是直接抛 `ProviderNotRegisteredError`，错误信息里指明需要装哪个包、到哪里注册一行代码。这比隐式回退更可控：厂商差异（参数名、鉴权方式、模型名映射）在各家的 `@langchain/*` 包里已经解决，注册表只是把「用哪家」的选择权显式交给调用方。代价是 `LLM_PROVIDER` 写错时不会自动纠正，而是立刻报明确错误——这正是我们想要的反馈。

新增厂商 = 装包 + 一行 `registerProvider`，不动任何调用方代码。

### 6.2 Sandbox

```ts
// src/sandbox/types.ts
export interface ExecResult { stdout: string; stderr: string; exitCode: number; timedOut: boolean; }

export interface Sandbox {
  readonly id: string;
  readonly workdir: string;
  exec(cmd: string, o?: { timeoutMs?: number; cwd?: string }): Promise<ExecResult>;
  writeFile(relativePath: string, data: string | Uint8Array): Promise<void>;
  readFile(relativePath: string): Promise<Uint8Array>;
  dispose(): Promise<void>;
}
```

`LocalProcessSandbox` 约束：
- 工作目录 `.sandbox/<sessionId>/`，启动时创建，`dispose()` 时删除。
- `exec` 用 `spawn` 且 `cwd` 锁定在工作目录内；`relativePath` 与 `cwd` 参数必须做路径穿越校验（解析后必须仍位于 workdir 下），否则抛 `SandboxEscapeError`。
- 默认 `timeoutMs`（配置项，默认 30000），超时 kill 进程树并置 `timedOut = true`。
- `env` 用白名单构造，**不继承 `process.env`**，避免 API key 泄漏进沙箱。
- 输出截断上限（默认 256KB），防止大输出打爆上下文。

这是本地进程隔离，**不是安全边界**。真正的强隔离（容器/VM）通过 `createSandbox` 换实现接入，接口不变。README 中明确写出这一限制。

### 6.3 Skill

```ts
// src/skills/types.ts
export interface SkillManifest {
  name: string;
  description: string;
  allowedTools?: string[];
  entry?: string;          // tool.ts 绝对路径
  body: string;            // Markdown 正文
  dir: string;
}
```

`SKILL.md` frontmatter 示例：

```markdown
---
name: hello-world
description: 演示 skill，回显输入并可读取沙箱文件
allowed-tools: [sandbox_exec, echo]
---
当用户要求演示时，调用 echo 工具……
```

加载策略：启动时扫描 `skills/*/SKILL.md`，只把 `name` + `description` 注入系统提示（渐进式披露）；模型决定使用某 skill 时，通过内置 `load_skill` 工具拉取完整 `body`。带 `tool.ts` 的 skill 在扫描阶段动态 import 并注册其工具，工具名加 `<skill>.` 前缀避免冲突。

### 6.4 MCP

```ts
// src/mcp/hub.ts —— 包装 @langchain/mcp-adapters 的 MCPAdapter
export class McpHub {
  static fromConfig(file: string): Promise<McpHub>;
  tools(): Promise<DynamicStructuredTool[]>;
  close(): Promise<void>;
}
```

已核实的 SDK 事实（读 `@langchain/mcp-adapters@2.0.3` 的 `dist/client.d.ts`、`dist/types.d.ts` 得到，非推测）：
- 类名是 `MCPAdapter`，`MultiServerMCPClient` 只是同义别名导出；统一用 `MCPAdapter`。
- 配置形状为 `{ servers: Record<string, Connection>, onConnectionError?: 'ignore' | 'throw' | handler }`；扁平的 `Record<string, Connection>` 形式已标记 `@deprecated`。
- `onConnectionError` 默认值是 `'throw'`，与「单个 server 失败不阻塞启动」的要求冲突，**必须显式传 `'ignore'`**。
- 取工具用 `await adapter.listTools()`；`getTools()` / `initializeConnections()` 均已废弃，不要用。
- stdio 型 Connection 必填 `transport: 'stdio'`、`command`、`args`。

配置文件为空对象或文件不存在时返回空工具集，不阻塞启动；单个 server 连接失败只记录告警并跳过该 server，不影响其余 server 与整体启动。

### 6.5 A2A

已核实的 SDK 事实（读 `@a2a-js/sdk@1.3.0` 的 `dist/server/index.d.ts`、`dist/server/express/index.d.ts`、`dist/client/index.d.ts`、`dist/index.d.ts` 得到）。1.x 与网上大量 0.x 教程差异很大，以下为准：

- **没有 `A2AExpressApp`**。express 层由 `@a2a-js/sdk/server/express` 的三个中间件工厂组成：`agentCardHandler({ agentCardProvider })` 发卡片、`jsonRpcHandler({ requestHandler, userBuilder })` 处理 JSON-RPC、`restHandler(...)` 处理 HTTP+JSON。
- `UserBuilder.noAuthentication` 是一个**函数**（`() => Promise<UnauthenticatedUser>`），作为 `userBuilder` 直接传入，不要调用它。
- `DefaultRequestHandler` 构造函数是**位置参数**：`new DefaultRequestHandler(agentCard, taskStore, agentExecutor, eventBusManager?, pushNotificationStore?, pushNotificationSender?, extendedAgentCardProvider?, signatureGenerator?, options?)`。不是 0.x 的对象字面量。
- `InMemoryTaskStore` 从 `@a2a-js/sdk/server` 导出。
- `AgentExecutor` 接口是 `{ execute(requestContext, eventBus), cancelTask(taskId, eventBus) }` —— 取消方法名是 `cancelTask`，不是 `cancel`。
- 事件通过 `eventBus.publish(AgentEvent.message(msg))` / `AgentEvent.task(task)` / `AgentEvent.statusUpdate(evt)` 发布；`AgentEvent` 是工厂对象。SDK 强制要求**首个事件必须是 `task` 或 `message`**，以 `statusUpdate` 开头会被拒绝。
- `RequestContext` 提供 `userMessage`、`taskId`、`contextId`。
- A2A 的类型是 protobuf 风格：`Message`、`AgentCard` 等接口里多数字段是必填（可选字段写成 `T | undefined`），根入口同时导出同名的 `MessageFns` 运行时常量，但它只有 `fromJSON` / `toJSON` 两个方法，**不是带默认值的 builder**。因此我们自己写 `buildTextMessage()` / `buildAgentCard()` 两个显式填全字段的辅助函数，靠类型检查保证不漏字段。
- `Role` 枚举值为 `ROLE_USER = 1` / `ROLE_AGENT = 2`；`TaskState` 为 `TASK_STATE_*` 前缀。
- 卡片路径常量 `AGENT_CARD_PATH` 从根入口导出，直接用它挂载，不要硬编码字符串。

Server 侧：`card.ts` 依配置构造完整 `AgentCard`（含 `supportedInterfaces`、`capabilities`、`securitySchemes`、`securityRequirements`、`defaultInputModes`、`defaultOutputModes`、`skills`），`executor.ts` 实现 `AgentExecutor` 并把请求转成 `AgentRuntime.run()`，`server.ts` 用 express 依次挂 `express.json()`、`agentCardHandler`、`jsonRpcHandler`。

Client 侧：`client.ts` 用 `new ClientFactory().createFromUrl(baseUrl)`（默认自动取 `/.well-known/agent-card.json`）拿到 `Client`，调用 `client.sendMessage({ tenant, message, configuration, metadata })`，返回 `SendMessageResult = Message | Task`；peers 列表来自 `config/a2a.peers.json`。`remote-tool.ts` 把每个远端 agent 包装成本地工具（`ask_<agentName>`），于是「调用别的 agent」对编排层而言就是普通工具调用，不需要单独的编排逻辑。

## 7. 数据流

```
cli.ts / serve.ts
      ↓
AgentRuntime.create(config)          ← 唯一装配点
      ├─ createChatModel(config.model)          → Promise<BaseChatModel>
      ├─ McpHub.tools()                        ┐
      ├─ SkillRegistry.tools() + load_skill    ├─→ 合并、按名去重 → tools[]
      ├─ sandboxTool(sandbox)                  │
      └─ A2AClientHub.remoteTools()            ┘
      ↓
createAgent({ model, tools, systemPrompt, checkpointer: SqliteSaver })
      ↓
model ⇄ tools 循环 → 最终 messages
```

编排用 `langchain` v1 的 `createAgent`，已核实参数名为 `{ model, tools?, systemPrompt?, stateSchema?, checkpointer?, responseFormat? }`。
不用 `@langchain/langgraph/prebuilt` 的 `createReactAgent`：它的 `CreateReactAgentParams` 在 1.x 里已标注 `@deprecated`，并明确要求迁到 `langchain` 包的 `CreateAgentParams`。新项目没有理由从废弃入口起步。

provider 工厂约定返回 `Promise<BaseChatModel>`，为将来需要异步初始化（拉取凭证、协商端点）的 provider 留出余地。这个异步性会传导到整个装配链，`AgentRuntime.create()` 全链路 await。

工具名冲突处理：优先级 builtin > skill > mcp > a2a，冲突时后者加数字后缀并记录告警。

持久化：SQLite 文件位于 `.data/checkpoints.sqlite`，`thread_id` = CLI 会话 id 或 A2A 的 contextId，使两条入口都天然支持多轮续聊。

## 8. 命令

```jsonc
{
  "type": "module",
  "engines": { "node": ">=22" },
  "scripts": {
    "dev":        "tsx scripts/check-node.ts && tsx src/cli.ts",
    "serve":      "tsx scripts/check-node.ts && tsx src/serve.ts",
    "build":      "tsc -p tsconfig.build.json",
    "typecheck":  "tsc --noEmit",
    "test":       "vitest run",
    "test:watch": "vitest"
  }
}
```

## 9. 配置与环境变量

`.env.example`：

```
LLM_PROVIDER=openai-compatible
LLM_MODEL=gpt-4o-mini
LLM_BASE_URL=https://api.openai.com/v1
LLM_API_KEY=
SANDBOX_TIMEOUT_MS=30000
SANDBOX_ROOT=.sandbox
CHECKPOINT_DB=.data/checkpoints.sqlite
A2A_PORT=4124
A2A_AGENT_NAME=muliuniuma
LOG_LEVEL=info
```

所有变量经 zod schema 校验，缺失或非法时在启动阶段就报明确错误（指出变量名与期望格式），不在运行中途炸。`LLM_API_KEY` 缺失时 CLI 拒绝启动并提示复制 `.env.example`；`serve` 同样拒绝，避免起一个必然失败的 server。

## 10. 首版验收标准

1. `pnpm install` 在 Node 24 下成功，含 `better-sqlite3` 原生依赖编译/预构建通过。
2. `pnpm typecheck` 与 `pnpm test` 全绿。
3. 配好 `.env` 后 `pnpm dev` 能进入 REPL，模型可调用 `echo`（来自 hello-world skill）与 `sandbox_exec`，沙箱内命令真实执行并回传输出。
4. 模型可通过 `load_skill` 拿到 skill 完整正文。
5. `pnpm serve` 启动后 `curl localhost:4124/.well-known/agent-card.json` 返回合法 AgentCard，A2A 消息端点能完成一次问答。
6. `config/mcp.servers.json` 为空数组时，上述 3–5 全部照常工作。
7. 同一 `thread_id` 二次提问时，模型能看到上一轮历史（验证 SQLite checkpointer 生效）。

## 11. 风险与应对

| 风险 | 应对 |
|---|---|
| ~~`better-sqlite3` 在 Node 24 下无法编译~~ | **已排除**：Node v24.19.0 下 `pnpm install` 已从源码编译成功（`gyp info ok`）。仍保留 `node:sqlite` 自实现 `BaseCheckpointSaver` 作为备选，但首版不需要 |
| ~~`@a2a-js/sdk` 1.x server 端类名不确定~~ | **已排除**：全部 API 已逐条从本地 `.d.ts` 核实并写入 §6.5。实现时以 §6.5 为准，禁止照搬网上 0.x 示例（`A2AExpressApp`、对象字面量构造 `DefaultRequestHandler`、`cancel()` 都是错的） |
| provider 工厂约定为异步 | `createChatModel` 返回 `Promise`，`AgentRuntime.create()` 全链路 async；测试里注意 await |
| `MCPAdapter` 默认 `onConnectionError: 'throw'` | 显式传 `'ignore'`，否则一个坏掉的 MCP server 会让整个 agent 起不来 |
| A2A protobuf 风格类型必填字段多 | 集中在 `buildTextMessage()` / `buildAgentCard()` 两个辅助函数里填全，靠 `tsc --noEmit` 兜底；不散落在各处构造 |
| `@langchain/mcp-adapters` 2.x 依赖 MCP SDK v2 模块化包 | 不直接依赖 `@modelcontextprotocol/sdk` v1，统一走 adapters，避免两代 SDK 混用 |
| 沙箱被误认为安全边界 | README 显著位置声明其非安全性；强隔离通过 `createSandbox` 换实现 |
| 未装 anthropic/google provider 但用户在 `.env` 里写了 | `createChatModel` 对未注册 provider 抛出明确错误，提示需要安装哪个包 |

## 12. 扩展指引（写进 README）

- 新增 LLM 厂商：装对应 `@langchain/*` 包 → `src/llm/factory.ts` 加一行 `registerProvider`。
- 新增强隔离沙箱：实现 `Sandbox` 接口 → `src/sandbox/factory.ts` 加分支。
- 新增 Skill：`skills/<name>/SKILL.md`，无需改代码、无需重新构建。
- 新增 MCP server：编辑 `config/mcp.servers.json`。
- 新增可协作的远端 agent：编辑 `config/a2a.peers.json`，自动获得 `ask_<name>` 工具。
