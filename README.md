# muliuniuma

可扩展的 TypeScript Agent 运行时骨架：**LLM 接入、MCP 工具、Skill 渐进式披露、本地执行沙箱、A2A 互联**，五块能力装在一个可运行的进程里。

它不是 demo 集合——每个模块都有明确的扩展点与真实测试；也不是框架——它刻意保持薄，让你能在任意一层替换实现而不动其它层。

## 特性

| 能力 | 说明 |
|---|---|
| **多 Provider LLM** | `registerProvider` 注册表，默认支持任意 OpenAI 兼容网关（DashScope / DeepSeek / vLLM …），换厂商只加一行 |
| **MCP 工具** | 读 `config/mcp.servers.json` 连接 MCP server，工具自动带 server 名前缀；单个 server 连不上只跳过它，不拖垮启动 |
| **Skill 渐进式披露** | 启动只把 skill 的 name/description 注入提示，模型按需用 `load_skill` 拉正文，提示词保持精简 |
| **本地沙箱** | `Sandbox` 接口 + 子进程实现：路径穿越校验、超时按进程组杀、env 白名单不继承 `process.env`、输出截断 |
| **A2A 互联** | 既能被别的 agent 调用（expose 卡片 + JSON-RPC），也能主动调远端 agent（自动获得 `ask_<name>` 工具） |
| **多轮会话** | SQLite checkpointer 持久化，CLI 会话 id 与 A2A contextId 都直接当 thread_id |
| **上下文压缩** | 历史超阈值时自动压成一条中文结构化摘要并保留最近原文，也可以随时输入 `/summarize` 手动收一收 |
| **可测试** | 276 个用例覆盖全部非模型路径；MCP / A2A 用真实子进程与真实 HTTP 夹具，不用 mock 冒充 |

## 环境要求

| 项 | 要求 |
|---|---|
| Node | **>= 22.12**（仓库带 `.nvmrc` 指向 24）。`pnpm dev` / `pnpm serve` 会先跑 `scripts/check-node.ts` 断言版本，过低直接报错退出 |
| 包管理器 | pnpm |
| 原生依赖 | `better-sqlite3`（SQLite checkpointer），需本机编译工具链 |

```bash
nvm use        # 读取仓库根目录的 .nvmrc
```

## 快速开始

```bash
pnpm install
cp .env.example .env      # 填入 LLM_API_KEY（以及按需改 LLM_BASE_URL / LLM_MODEL）
pnpm dev                  # 本地 REPL
```

`.env` 里的变量会在启动时被 zod 校验，**缺失或非法时在启动阶段就报错**并指出变量名与期望格式，不会在跑到一半时炸：

```
启动失败: 环境变量校验失败 → LLM_API_KEY: Too small: expected string to have >=1 characters
请复制 .env.example 为 .env 并填入 LLM_API_KEY 等必需变量。
```

（上面是 `.env` 已复制、只有 `LLM_API_KEY` 还空着时的输出。若 `.env` 整个缺失，会一次列出所有缺失变量。）

---

## 命令行使用（`pnpm dev`）

进入 REPL：

```
[info] cli: 会话已启动（thread=1f3c…），输入 /exit 退出。
> 帮我演示一下
模型回答…
```

| 操作 | 行为 |
|---|---|
| 直接输入 | 作为本轮提问交给模型，回车前不会发送 |
| `/summarize` | 立刻把当前会话的旧历史压成一条中文摘要，保留最近一段原文 |
| `/exit`、`/quit` | 退出并清理沙箱与检查点数据库 |
| `Ctrl+C`（SIGINT） | 同上，退出码 0 |
| `Ctrl+D`（EOF） | 同上 |

REPL 里的对话是**多轮**的：整个会话共用一个 thread id，模型能看到前面的上下文。

历史落在 `CHECKPOINT_DB` 指向的 SQLite 文件里。注意 CLI **每次启动会生成新的随机 thread id**，所以重启后不会自动接上上一次的对话——历史仍在库里，但当前 CLI 没有暴露「指定 thread id 续聊」的入口（A2A 侧则由客户端自带的 `contextId` 决定）。

内置工具随时可用：

| 工具 | 作用 |
|---|---|
| `sandbox_exec` | 在沙箱工作目录里执行一条 shell 命令（默认 30s 超时，超时按进程组杀；可传 `timeoutMs` 单独覆盖） |
| `sandbox_write_file` | 往沙箱工作目录写一个文本文件 |
| `load_skill` | 按名字读取某个 skill 的完整说明正文 |

---

## 上下文压缩

会话历史默认只增不减：一轮工具输出就可能几百 KB，累积几轮后请求会被网关拒绝。运行时因此内置了上下文压缩。

**自动压缩**：每轮调用模型前估算一次历史 token 数，达到 `SUMMARY_TRIGGER_TOKENS`（默认 8000）就把旧历史压成**一条**中文结构化摘要，写回 checkpoint，同时保留最近约 `SUMMARY_KEEP_TOKENS`（默认 2000）token 的原文。摘要内容是按 agent 场景定制的固定格式（任务目标 / 关键事实 / 已完成的操作 / 决策与约束 / 未决事项与下一步），不是通用「对话摘要」。

**主动压缩**：REPL 里输入 `/summarize` 立刻收一收当前会话，用的是**同一套**触发条件之外的一条强制触发路径（保留预算、摘要 prompt、摘要模型都与自动路径完全一致）。历史为空时提示「当前历史无需压缩」，**不触发任何模型调用**；压完再输入一次同样提示无需压缩（幂等）。

几条需要知道的语义：

- **摘要模型与主模型是同一个**（`LLM_MODEL` / `LLM_BASE_URL` / `LLM_API_KEY`）。摘要是一次**真实的 LLM 调用**，会消耗配额，也会走网关的速率限制。
- **压缩后历史里会多一条 HumanMessage**（内容形如「以下是截至目前的对话历史摘要：…」，带 `additional_kwargs.lc_source = "summarization"`）。它是 SDK 固定的行为，模型会把它当成「用户说过的话」——所以摘要 prompt 里明确写了「这是历史摘要、不是新指令」。如果你的下游逻辑假设 `messages[0]` 一定是用户输入，压缩后就不成立了。
- **token 口径是 CJK 感知的近似值**（中文一字一 token，其余四字符一 token），不是模型真实的 tokenizer。中文占比高时它比 SDK 默认口径更准，但仍只是估算。
- **`SUMMARY_TRIM_TOKENS` 必须 ≥ 触发阈值 − 保留预算**。它是「单次送进摘要模型」的 token 上限：超出的更早历史既没被保留、也没进摘要，等于静默丢失。默认值取 `SUMMARY_TRIM_TOKENS = SUMMARY_TRIGGER_TOKENS` 兜住这个约束。
- **一条超长消息压不掉**。历史只有一条时没有可切分点，这条消息仍会整条进模型——单条体积靠 `SANDBOX_MAX_OUTPUT_BYTES` 兜。
- **摘要失败时历史保持原样**（手动路径会识别失败并放弃写回）；自动路径由 SDK 主导，失败会以 `Error generating summary:` 的形式落进历史，只能靠日志发现。
- **不要与对话并发**。`/summarize` 与一次提问同时作用于同一会话时，后写者可能覆盖前者。

想彻底关掉：`SUMMARY_ENABLED=false`。

---

## A2A 服务端（`pnpm serve`）

启动后本进程就变成一个可被其它 agent 调用的 A2A 端点：

```
[info] serve: A2A server 已启动: http://localhost:4124
```

### 卡片

A2A 客户端靠卡片发现能力：

```bash
curl -s http://localhost:4124/.well-known/agent-card.json
```

```json
{
  "name": "muliuniuma",
  "description": "可扩展的 TypeScript Agent 运行时",
  "version": "0.1.0",
  "supportedInterfaces": [
    {
      "url": "http://localhost:4124",
      "protocolBinding": "JSONRPC",
      "tenant": "",
      "protocolVersion": "1.0"
    }
  ],
  "capabilities": {
    "streaming": false,
    "pushNotifications": false,
    "extensions": [],
    "extendedAgentCard": false
  },
  "securitySchemes": {},
  "securityRequirements": [],
  "defaultInputModes": ["text/plain"],
  "defaultOutputModes": ["text/plain"],
  "skills": [
    {
      "id": "hello-world",
      "name": "hello-world",
      "description": "演示 skill：回显用户输入，并演示读取沙箱文件",
      "tags": [],
      "examples": [],
      "inputModes": ["text/plain"],
      "outputModes": ["text/plain"],
      "securityRequirements": []
    }
  ],
  "signatures": []
}
```

> `supportedInterfaces[0].url` 是**客户端实际建连的地址**，必须是对外可达的 URL。本地开发用 `A2A_PUBLIC_URL` 指向 `http://localhost:4124`；部署到别处时改成对外地址，否则客户端会连到错误的地址。
> `provider` 字段默认不出现（未配置）；要填就在 `buildAgentCard` 的 `provider` 选项里给。

### 手工发起一次问答

A2A v1.0 的 JSON-RPC 端点是 `POST /`，**必须带 `A2A-Version: 1.0` 头**——缺省会按 v0.3 处理并被拒：

```bash
curl -s http://localhost:4124/ \
  -H 'content-type: application/json' \
  -H 'A2A-Version: 1.0' \
  -d '{
    "jsonrpc": "2.0",
    "id": 1,
    "method": "SendMessage",
    "params": {
      "message": {
        "messageId": "manual-1",
        "role": "ROLE_USER",
        "parts": [{ "text": "你好", "mediaType": "text/plain" }]
      },
      "configuration": {}
    }
  }'
```

响应形状：

```json
{
  "jsonrpc": "2.0",
  "id": 1,
  "result": {
    "task": {
      "id": "0e24af1e-…",
      "contextId": "31ec1f63-…",
      "status": {
        "state": "TASK_STATE_COMPLETED",
        "message": {
          "role": "ROLE_AGENT",
          "parts": [{ "text": "你好：你好", "mediaType": "text/plain" }]
        },
        "timestamp": "2026-11-20T01:21:28.094Z"
      },
      "history": [ … ]
    }
  }
}
```

模型的回答在 `result.task.status.message.parts[0].text`。

### 多轮

客户端只要在后续请求里带**同一个 `contextId`**，本地 agent 就会沿用同一个 thread 继续上下文（`thread_id` = A2A 的 contextId）。

---

## 配置

### 环境变量（`.env`）

| 变量 | 默认值 | 说明 |
|---|---|---|
| `LLM_PROVIDER` | — | provider id。已注册：`openai`、`openai-compatible` |
| `LLM_MODEL` | — | 模型名，如 `gpt-4o-mini` |
| `LLM_BASE_URL` | — | API 基址，OpenAI 兼容网关填自己的（如 `https://dashscope.aliyuncs.com/compatible-mode/v1`） |
| `LLM_API_KEY` | — | API key，**必填** |
| `LLM_TEMPERATURE` | `0` | 采样温度 |
| `SANDBOX_ROOT` | `.sandbox` | 沙箱根目录 |
| `SANDBOX_TIMEOUT_MS` | `30000` | 单条命令超时 |
| `SANDBOX_MAX_OUTPUT_BYTES` | `262144` | 单流输出上限（stdout / stderr 各自封顶） |
| `CHECKPOINT_DB` | `.data/checkpoints.sqlite` | SQLite checkpointer 路径 |
| `SKILLS_DIR` | `skills` | skill 目录 |
| `MCP_CONFIG` | `config/mcp.servers.json` | MCP server 声明 |
| `A2A_PEERS` | `config/a2a.peers.json` | 可主动调用的远端 agent |
| `A2A_PORT` | `4124` | A2A 服务端口 |
| `A2A_PUBLIC_URL` | `http://localhost:4124` | 卡片里对外公布的地址 |
| `A2A_AGENT_NAME` | `muliuniuma` | 卡片上的 agent 名 |
| `A2A_DESCRIPTION` | `可扩展的 TypeScript Agent 运行时` | 卡片上的描述 |
| `SUMMARY_ENABLED` | `true` | 上下文压缩总开关；设为 `false` 时既不自动压缩，`/summarize` 也只提示已关闭 |
| `SUMMARY_TRIGGER_TOKENS` | `8000` | 历史 token 估算达到该值时自动压缩（口径见「上下文压缩」） |
| `SUMMARY_KEEP_TOKENS` | `2000` | 压缩时保留的最近原文 token 预算 |
| `SUMMARY_TRIM_TOKENS` | `8000` | 单次送进摘要模型的 token 上限；**不得小于「触发阈值 − 保留预算」**，否则更早的历史既没保留也没进摘要 |
| `LOG_LEVEL` | `info` | `debug` / `info` / `warn` / `error` / `silent` |

已存在的环境变量优先于 `.env` 文件内容——CI 里注入的 key 不会被 `.env` 覆盖。

### MCP server（`config/mcp.servers.json`）

规范形状是 SDK 的**对象形**，**不是数组**：

```json
{
  "servers": {
    "filesystem": {
      "transport": "stdio",
      "command": "node",
      "args": ["./some-mcp-server.mjs"],
      "stderr": "ignore"
    }
  }
}
```

- 空配置 `{"servers": {}}` 即「未声明任何 server」，MCP 静默跳过，其余功能照常工作。
- 工具名会自动带 server 名前缀：`filesystem` 的 `read_file` → `filesystem_read_file`。
- 单个 server 连接失败会被**跳过并告警**（stderr 上是一条 `warn` 级日志，含 server 名与错误详情），不影响其余 server，也不阻塞启动。

### A2A peer（`config/a2a.peers.json`）

```json
{
  "peers": [
    {
      "name": "remote-agent",
      "url": "http://localhost:5000",
      "description": "远端协作 agent"
    }
  ]
}
```

每个 peer 自动给模型带来一个 `ask_remote-agent` 工具，参数 `{ "message": "…" }`，返回远端的文本回答。

- 空配置 `{"peers": []}` 即「没有远端 agent」。
- 启动时不可达的 peer 会被跳过并告警；调用远端失败或超时（默认 120s）会抛出并**呈现给模型/用户，不会被静默吞掉**。
- 下载 peer 的 agent card 有 10s 超时，一个指向黑洞地址的 peer 不会把启动拖住。

---

## 编写 Skill

### 目录结构

```
skills/
└─ hello-world/
   ├─ SKILL.md      # 必填：声明 + 正文
   └─ tool.ts       # 可选：自带工具
```

放在 `skills/` 下的每个子目录都会被扫描，**新增 skill 不需要改代码、不需要重新构建**。

### `SKILL.md`

```markdown
---
name: hello-world
description: 演示 skill：回显用户输入，并演示读取沙箱文件
allowed-tools: [hello-world_echo, sandbox_exec, sandbox_write_file]
---

当用户要求「演示」「打招呼」「回显」时，调用 hello-world_echo 工具回显其输入。

若用户想验证沙箱能力，先用 sandbox_write_file 写入一个文件，
再用 sandbox_exec 执行 `cat` 读取它，把结果如实转述给用户。
```

frontmatter 字段：

| 字段 | 必填 | 说明 |
|---|---|---|
| `name` | 是 | skill 名，也是工具名前缀的来源 |
| `description` | 是 | 一句话说明，**会被注入系统提示**，写清「什么时候该用」 |
| `allowed-tools` | 否 | 声明性字段，**首版不强制执行**，但应写对真实工具名 |

> frontmatter 只支持 `key: value` 与行内数组 `[a, b]` 这两种写法（手写 YAML 子集，没有引入 YAML 解析库）。多行列表、嵌套映射都不支持。值里的成对引号会被剥掉。

正文就是给模型看的详细用法说明。

### `tool.ts`（可选）

```ts
import { tool } from 'langchain';
import { z } from 'zod';

export const tools = [
  tool(async ({ value }) => `你好，${value}！`, {
    name: 'echo',
    description: '回显传入的字符串并加前缀问候。',
    schema: z.object({ value: z.string().min(1) }),
  }),
];
```

契约：`export const tools = [...]`，每个元素是 LangChain `tool()` 的结果。

> `tool.ts` 会在启动时被**动态 import 并执行**。把 skill 目录当作可信输入——它等价于允许在 agent 进程里跑代码。

### 工具命名与冲突

工具名按来源加前缀，避免不同来源的同名工具互相覆盖：

| 来源 | 命名 | 例 |
|---|---|---|
| 内置 | 原名 | `sandbox_exec`、`load_skill` |
| Skill | `<skill 名>_<工具名>` | `hello-world_echo` |
| MCP | `<server 名>_<工具名>` | `filesystem_read_file` |
| A2A peer | `ask_<peer 名>` | `ask_remote-agent` |

不同来源撞名时按 **builtin > skill > mcp > a2a** 保留优先级高的，后者加数字后缀（`dup`、`dup_1`）并在日志里告警。

### 渐进式披露

启动时**只**把每个 skill 的 `name` 与 `description` 注入系统提示，正文不进提示词。模型判断某个 skill 相关时，再调用内置的 `load_skill` 按名字拉完整正文。

这样提示词只随 skill 数量线性增长一点点，而不是被所有正文撑大。

---

## 扩展方式

| 想做的事 | 改哪里 |
|---|---|
| 换 LLM 厂商 | 装 `@langchain/*` 包，在 `src/llm/factory.ts` 加一行 `registerProvider('xxx', …)` |
| 换沙箱实现 | 实现 `Sandbox` 接口，在 `src/sandbox/factory.ts` 加 `registerSandbox('docker', …)` |
| 新增 Skill | 在 `skills/<name>/` 放 `SKILL.md`（可选 `tool.ts`），无需改代码 |
| 新增 MCP server | 编辑 `config/mcp.servers.json` |
| 对接远端 agent | 编辑 `config/a2a.peers.json`，自动获得 `ask_<name>` 工具 |
| 加新错误类型 | 在 `src/shared/errors.ts` 加一个 `AppError` 子类与对应 `ErrorCode` |

跨模块导入只走对方的 `index.ts`（barrel），以保住模块边界——将来拆 monorepo 时可以按目录直接切。

---

## 目录结构

```
src/
├─ agent/      运行时装配（AgentRuntime）、工具合并、上下文压缩（summary / summary-prompt）
├─ a2a/        A2A 卡片 / 消息 / executor / server / client / 远程工具
├─ config/     环境变量校验（loadConfig / loadEnvFileIfPresent）
├─ llm/        provider 注册表（createChatModel / registerProvider）
├─ mcp/        MCP 配置读取与连接（McpHub）
├─ sandbox/    沙箱接口与本地实现（LocalProcessSandbox）
├─ shared/     错误类型层次、日志、工具改名代理
├─ skills/     Skill 加载器、注册表、load_skill 工具
├─ tools/      内置工具（sandbox_exec / sandbox_write_file）
├─ cli.ts      入口 1：本地 REPL
└─ serve.ts    入口 2：A2A HTTP server
skills/        用户 skill 目录（含 hello-world 示例）
config/        mcp.servers.json / a2a.peers.json
scripts/       check-node.ts（Node 版本断言）
tests/         vitest 用例
docs/          设计 spec 与实现计划
```

---

## 安全提示

**这个骨架默认是「本机开发工具」，不是多租户服务。上生产前请逐条读完这一节。**

- **沙箱不是安全边界。** `LocalProcessSandbox` 只是**本地进程隔离**：超时按进程组杀、环境变量白名单（不继承 `process.env`）、输出截断。但：
  - **路径穿越校验只作用于 `readFile` / `writeFile`** 这两个文件操作的相对路径参数。
  - **`sandbox_exec` 的命令本身没有任何文件系统约束**——它只是 `spawn('/bin/sh', ['-c', command], { cwd: 工作目录, env: 白名单 })`，命令可以读写**整台机器**的任意路径（`cat /etc/hosts`、`rm -rf ~` 都不受限）。只有可选的 `cwd` 参数会做穿越校验。**不要拿它跑不可信输入。**
- **沙箱不解析符号链接。** `readFile` / `writeFile` 都跟随软链——沙箱内 `ln -s /etc passwd` 建的软链，`readFile` 会读到工作目录之外的内容，`writeFile` 同样会跟随软链写到外部目标。
- **skill 的 `tool.ts` 会被执行。** 启动时动态 import，等价于允许在 agent 进程里跑任意代码。只加载可信来源的 skill。
- **MCP 与 A2A 都是无鉴权的。** `UserBuilder.noAuthentication` 意味着任何能访问端口的人都能调用你的 agent、也能让你的 agent 去连任意 MCP server。
- **A2A 默认监听所有网卡。** `pnpm serve` 只绑定 `A2A_PORT`、不带 host 参数，因此同网段可达者都能调用这个**无鉴权**端点。`A2A_PUBLIC_URL` 只决定卡片上公布的地址，**不限制监听范围**；当前也没有配置项能把服务收回到本机。要收口就自己加反向代理与鉴权，或改 `src/serve.ts` 显式绑定 `127.0.0.1`。

---

## 故障排查

| 现象 | 原因 | 处理 |
|---|---|---|
| `需要 Node >= 22.12，当前为 18.17.0` | Node 版本过低 | `nvm use`（读取仓库 `.nvmrc`） |
| `启动失败: 环境变量校验失败 → LLM_API_KEY: …` | `.env` 缺变量或格式不对 | `cp .env.example .env` 后按提示补齐 |
| `LLM_BASE_URL: Invalid URL` | 基址不是合法 URL | 填完整地址（含 `https://` 与 `/v1` 之类路径） |
| `未注册的 LLM provider: "xxx"` | `LLM_PROVIDER` 写了没注册的 id | 改成 `openai-compatible`，或在 `src/llm/factory.ts` 注册 |
| REPL 里模型说「没有可用工具」 | SKILL.md 正文里让模型调用的工具名写错 | 工具真名是 `<skill 名>_<工具名>`（`allowed-tools` 首版不参与判定，写错它不会让工具消失） |
| `A2A server 启动失败（端口 4124）: listen EADDRINUSE` | 端口被占 | 改 `A2A_PORT`，或停掉占用进程 |
| 手工 curl 报 `VERSION_NOT_SUPPORTED` | 没带 `A2A-Version: 1.0` 头 | 补上该请求头 |
| MCP server 连不上但 agent 仍能启动 | 单 server 失败被跳过 | 看 stderr 的 `[warn] app:mcp:` 行；该 server 的工具确实不会出现 |
| 沙箱里的命令超时被杀 | 超过 `SANDBOX_TIMEOUT_MS` | 调大该变量，或在 skill 正文里改用更短命令 |

---

## 开发命令

```bash
pnpm typecheck   # tsc --noEmit
pnpm test        # vitest run
pnpm build       # tsc -p tsconfig.build.json
pnpm dev         # 本地 REPL
pnpm serve       # A2A HTTP server
```

测试覆盖的是**真实行为**：MCP 用真实 stdio 子进程、A2A 用真实 HTTP server + 真实 SDK 客户端、checkpointer 用真实 SQLite 文件。模型调用是唯一的例外——那需要真实 API key。

当前验收状态见 `docs/superpowers/plans/2026-11-17-agent-runtime-scaffold.md` 附录 B。
