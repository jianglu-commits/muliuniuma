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

已确认的导入路径（非推测）：
- `langchain/chat_models/universal` → `initChatModel`
- `@langchain/langgraph/prebuilt` → `createReactAgent`
- `@a2a-js/sdk/server`、`@a2a-js/sdk/server/express`、`@a2a-js/sdk/client`

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
│  │  ├─ factory.ts           # createChatModel：注册表 + initChatModel
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
│  │  ├─ executor.ts          # A2A 请求 → AgentRuntime
│  │  ├─ server.ts            # express server bootstrap
│  │  ├─ client.ts            # A2AClientHub：调用远端 agent
│  │  ├─ remote-tool.ts       # 把远端 agent 包装成本地可调用工具
│  │  └─ index.ts
│  ├─ tools/
│  │  ├─ sandbox-tool.ts      # sandbox_exec / sandbox_write_file
│  │  └─ index.ts
│  ├─ agent/
│  │  ├─ state.ts             # AgentState
│  │  ├─ graph.ts             # createReactAgent 装配
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
export function registerProvider(id: ProviderId, f: (spec: ModelSpec) => BaseChatModel): void;
export function createChatModel(spec: ModelSpec): BaseChatModel;
```

首版注册表含 `openai` 与 `openai-compatible` 两个 id，二者共用同一个 `ChatOpenAI` 实现，差别仅在 `baseURL` 默认值（前者用官方地址，后者要求 `.env` 显式给出）。这样 `.env.example` 里的 `LLM_PROVIDER=openai-compatible` 与注册表严格对应。`initChatModel` 作为回退路径，让未显式注册的 provider 也能通过 LangChain 官方解析链工作。新增厂商 = 装包 + 一行 `registerProvider`，不动调用方。

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
// src/mcp/hub.ts
export class McpHub {
  static fromConfig(file: string): Promise<McpHub>;
  tools(): Promise<StructuredTool[]>;   // 带 <server>__ 前缀
  close(): Promise<void>;
}
```

配置文件为空数组或不存在时返回空工具集，不阻塞启动；单个 server 连接失败只记录告警并跳过该 server，不影响其余 server 与整体启动。

### 6.5 A2A

Server 侧：`card.ts` 依配置生成 AgentCard（名称、描述、skills、capabilities），`executor.ts` 实现 SDK 的 executor 接口并把请求转成 `AgentRuntime.run()`，`server.ts` 用 express 挂载，暴露 `/.well-known/agent-card.json` 与消息端点。

Client 侧：`client.ts` 从 `config/a2a.peers.json` 读取远端 agent URL，拉取其 AgentCard 建立连接；`remote-tool.ts` 把每个远端 agent 包装成一个本地工具（`ask_<agentName>`），于是「调用别的 agent」对 LangGraph 而言就是普通工具调用，无需改编排逻辑。

## 7. 数据流

```
cli.ts / serve.ts
      ↓
AgentRuntime.create(config)          ← 唯一装配点
      ├─ createChatModel(config.model)
      ├─ McpHub.tools()                        ┐
      ├─ SkillRegistry.tools() + load_skill    ├─→ 合并、按名去重 → tools[]
      ├─ sandboxTool(sandbox)                  │
      └─ A2AClientHub.remoteTools()            ┘
      ↓
createReactAgent(model, tools, { checkpointSaver: SqliteSaver, state })
      ↓
model ⇄ tools 循环 → 最终 messages
```

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
| `better-sqlite3` 在 Node 24 下无预构建二进制、需本地编译 | 机器已装 Xcode CLT，可编译；若失败则退回 Node 22+ 内置 `node:sqlite` 自实现 `BaseCheckpointSaver`，`Sandbox` 式接口隔离保证上层无感 |
| `@a2a-js/sdk` 1.x server 端具体类名与 0.x 教程不一致 | 已确认 export 子路径（`/server`、`/server/express`、`/client`）；实现时以本地 `.d.ts` 为准，不照搬网上旧示例 |
| `@langchain/mcp-adapters` 2.x 依赖 MCP SDK v2 模块化包 | 不直接依赖 `@modelcontextprotocol/sdk` v1，统一走 adapters，避免两代 SDK 混用 |
| 沙箱被误认为安全边界 | README 显著位置声明其非安全性；强隔离通过 `createSandbox` 换实现 |
| 未装 anthropic/google provider 但用户在 `.env` 里写了 | `createChatModel` 对未注册 provider 抛出明确错误，提示需要安装哪个包 |

## 12. 扩展指引（写进 README）

- 新增 LLM 厂商：装对应 `@langchain/*` 包 → `src/llm/factory.ts` 加一行 `registerProvider`。
- 新增强隔离沙箱：实现 `Sandbox` 接口 → `src/sandbox/factory.ts` 加分支。
- 新增 Skill：`skills/<name>/SKILL.md`，无需改代码、无需重新构建。
- 新增 MCP server：编辑 `config/mcp.servers.json`。
- 新增可协作的远端 agent：编辑 `config/a2a.peers.json`，自动获得 `ask_<name>` 工具。
