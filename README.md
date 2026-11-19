# muliuniuma

可扩展的 TypeScript Agent 运行时骨架：LLM、MCP、Skill、沙箱、A2A。

## 环境要求

Node >= 22（推荐 24）。仓库带 `.nvmrc`，执行 `nvm use` 即可。`pnpm dev` / `pnpm serve`
会先跑 `scripts/check-node.ts` 断言版本，过低时直接报错退出。

## 快速开始

```bash
pnpm install
cp .env.example .env   # 填入 LLM_API_KEY（以及按需调整 LLM_BASE_URL / LLM_MODEL）
pnpm dev               # 本地 REPL
pnpm serve             # A2A HTTP server，默认 http://localhost:4124
```

所有环境变量经 zod schema 校验，缺失或非法时**在启动阶段就报明确错误**（指出变量名与期望
格式），不在运行中途炸。`LLM_API_KEY` 缺失时 `dev` 与 `serve` 都拒绝启动，并提示复制
`.env.example` 为 `.env` 填入。已存在的环境变量优先于 `.env` 文件内容。

REPL 中输入 `/exit` 或 `/quit` 退出；`Ctrl+C`（SIGINT）、`Ctrl+D`（EOF）也都会清理沙箱与
检查点数据库后干净退出。

## 目录结构

```
src/
├─ agent/      运行时装配（AgentRuntime）、工具合并
├─ a2a/        A2A 卡片、消息、executor、server、client、远程工具
├─ config/     环境变量校验（loadConfig / loadEnvFileIfPresent）
├─ llm/        provider 注册表（createChatModel / registerProvider）
├─ mcp/        MCP 配置读取与连接（McpHub）
├─ sandbox/    沙箱接口与本地实现（LocalProcessSandbox）
├─ skills/     Skill 加载器、注册表、load_skill 工具
├─ tools/      内置工具（sandbox_exec / sandbox_write_file）
├─ cli.ts      入口 1：本地 REPL
└─ serve.ts    入口 2：A2A HTTP server
skills/        用户 skill 目录（含 hello-world 示例）
config/        mcp.servers.json / a2a.peers.json
scripts/       check-node.ts（Node 版本断言）
tests/         vitest 用例
```

跨模块导入只走对方的 `index.ts`（barrel），以保住模块边界。

## Skill 与渐进式披露

在 `skills/<name>/` 放一个 `SKILL.md`（frontmatter 含 `name` / `description`，可选
`allowed-tools`），可选再放 `tool.ts`（命名导出数组 `tools`，元素是 LangChain `tool()` 的
结果）。新增 skill **无需改代码、无需重新构建**。

启动时只把每个 skill 的 **name 与 description** 注入系统提示（渐进式披露），**不注入正文**。
模型需要某个 skill 的具体用法时，再调用内置的 `load_skill` 工具按名称拉取完整正文。这样
系统提示保持精简，skill 细节按需加载。

`tool.ts` 里的工具会被注册表改名为 `<skill-name>_<原工具名>`。例如 `hello-world` 示例的
`echo` 工具，实际注册名是 **`hello-world_echo`**。`SKILL.md` 的正文与 `allowed-tools` 都应
引用这个真实名字（示例已如此）。注意：`allowed-tools` 目前是**声明性**字段，首版不强制执行
工具过滤。

## 配置

### MCP（`config/mcp.servers.json`）

规范形状是 SDK 的**对象形** `{"servers": {}}`，**不是数组**。空配置即「未声明任何 server」，
此时 MCP 静默跳过，其余功能照常工作：

```json
{ "servers": {} }
```

声明 server 时，`servers` 的每个键是 server 名、值是一个连接对象（stdio 示例）：

```json
{
  "servers": {
    "example": {
      "transport": "stdio",
      "command": "node",
      "args": ["./some-mcp-server.mjs"],
      "stderr": "ignore"
    }
  }
}
```

工具名会带上 server 名前缀。单个 server 连接失败会被跳过并告警，不会拖垮整个 agent。

### A2A peers（`config/a2a.peers.json`）

声明可主动调用的远端 agent，每个 peer 自动获得一个 `ask_<name>` 工具：

```json
{
  "peers": [
    { "name": "remote-agent", "url": "http://localhost:5000", "description": "远端协作 agent" }
  ]
}
```

空配置为 `{"peers": []}`。启动时不可达的 peer 会被跳过并告警；调用远端失败或超时会抛出
`A2APeerError` 并**呈现给模型/用户，不会被静默吞掉**。

### 环境变量

见 `.env.example`：`LLM_*`（provider/model/baseURL/apiKey/temperature）、`SANDBOX_*`
（root/timeoutMs/maxOutputBytes）、`CHECKPOINT_DB`、`SKILLS_DIR`、`MCP_CONFIG`、`A2A_PEERS`、
`A2A_*`（port/publicUrl/agentName/description）、`LOG_LEVEL`。

## 扩展方式

| 想做的事 | 改哪里 |
|---|---|
| 换 LLM 厂商 | 装 `@langchain/*` 包，在 `src/llm/factory.ts` 加一行 `registerProvider` |
| 换沙箱实现 | 实现 `Sandbox` 接口，在 `src/sandbox/factory.ts` 加 `registerSandbox` |
| 新增 Skill | 在 `skills/<name>/` 放 `SKILL.md`（可选 `tool.ts`），无需改代码 |
| 新增 MCP server | 编辑 `config/mcp.servers.json` |
| 对接远端 agent | 编辑 `config/a2a.peers.json`，自动获得 `ask_<name>` 工具 |

## 安全提示

`LocalProcessSandbox` 只是**本地进程隔离，不是安全边界**。它做了路径穿越校验、超时中断
（按进程组杀，避免孤儿孙进程）、环境变量白名单（不继承 `process.env`）和输出截断，但：

- **不解析符号链接**：`readFile` / `writeFile` 均跟随软链。沙箱内用 `ln -s /etc passwd` 建的
  软链，`readFile` 会读到工作目录之外的内容，`writeFile` 同样会跟随软链写到外部目标。
- 同机用户仍可通过其他途径影响进程。

因此它只用于约束误操作，**不能用来隔离不可信代码**。需要强隔离时，用 `registerSandbox`
换成容器或 VM 实现。

## 常用命令

```bash
pnpm typecheck   # tsc --noEmit
pnpm test        # vitest run
pnpm build       # tsc -p tsconfig.build.json
```
