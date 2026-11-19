# Agent Runtime Scaffold Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 交付一个可运行、可扩展的 TypeScript Agent 项目骨架，覆盖 LLM 多 provider 抽象、MCP 工具接入、Markdown Skill 加载、LocalProcessSandbox、A2A server + client、SQLite checkpointer，以及 CLI 与 HTTP 两个入口。

**Architecture:** 单包 + 模块化目录。每个能力域一个目录（`src/<module>/`），只通过各自的 `index.ts` barrel 对外暴露，内部接口即是扩展点。`AgentRuntime` 是唯一装配点，CLI 与 A2A server 共用它，因此两条入口行为完全一致。A2A 的远端 agent 被包装成本地工具，使「调用别的 agent」对编排层透明。

**Tech Stack:** TypeScript 6.0.3 (ESM / NodeNext)、Node ≥22、langchain 1.6.6、@langchain/langgraph 1.7.5、@langchain/openai 1.8.4、@langchain/mcp-adapters 2.0.3、@langchain/langgraph-checkpoint-sqlite 1.1.1、@a2a-js/sdk 1.3.0、express 5.3.0、zod 4.6.7、vitest 5.1.0、tsx 4.23.15。

**Spec:** `docs/superpowers/specs/2026-11-17-agent-runtime-scaffold-design.md`

---

## 0. 执行前必读

### 0.1 环境

本机 shell 默认 Node 是 v18.17.0，**不满足要求**（`@langchain/openai` 需 ≥22，`vitest@5` 需 ≥22.12）。本计划所有命令前必须加 PATH 前缀，因为每次 Bash 调用都是全新 shell，PATH 不持久：

```bash
export PATH="/Users/jianglu/.nvm/versions/node/v24.19.0/bin:$PATH"
```

已装依赖：`pnpm install` 已成功执行，`better-sqlite3@12` 已从源码编译通过。**不要重跑 install**，除非 package.json 变了。

### 0.2 硬性约定

1. **ESM + NodeNext**：所有相对导入必须带 `.js` 后缀，例如 `import { logger } from '../shared/index.js'`。漏了后缀 `tsc` 会报错，且 `tsx` 运行时会 404。
2. **禁止跳钩子**：`git commit` 不加 `--no-verify`，不加 `-c core.hooksPath`。
3. **测试先行**：Task 2–13 都是先写失败测试、确认失败、再写实现。
4. **每任务一提交**：commit message 用中文正文 + 英文 type 前缀，与仓库现有风格一致（见 `git log`：`docs: add agent runtime scaffold design spec`）。
5. **只通过 barrel 跨模块导入**：`src/<module>/<file>.ts` 内部可以用同目录相对导入；其他模块只能 `from '../<module>/index.js'`。

### 0.3 已核实的 SDK 事实（实现时以此为准，禁止照搬网上 0.x 教程）

| 事实 | 依据 |
|---|---|
| `createAgent({ model, tools?, systemPrompt?, stateSchema?, checkpointer?, responseFormat? })` from `langchain` | `langchain/dist/agents/types.d.ts:403` |
| `createReactAgent` 的 `CreateReactAgentParams` 已 `@deprecated` | `langchain/dist/agents/types.d.ts:57` |
| `initChatModel(model?, options?)` 是**异步**，返回 `Promise<ConfigurableModel>` | `langchain/dist/chat_models/universal.d.ts:241` |
| `MCPAdapter`（`MultiServerMCPClient` 是别名），配置 `{ servers, onConnectionError }`，`onConnectionError` 默认 `'throw'` | `@langchain/mcp-adapters/dist/client.d.ts:9,225`、`dist/types.d.ts:3290` |
| 取 MCP 工具用 `await adapter.listTools()`；`getTools()`/`initializeConnections()` 已废弃 | `@langchain/mcp-adapters/dist/client.d.ts:68` |
| `SqliteSaver.fromConnString(path)` 是**同步**静态方法 | `@langchain/langgraph-checkpoint-sqlite/dist/index.d.ts:21` |
| A2A 没有 `A2AExpressApp`；express 层是 `agentCardHandler` / `jsonRpcHandler` / `restHandler` | `@a2a-js/sdk/dist/server/express/index.d.ts:37,71,55` |
| `DefaultRequestHandler` 是**位置参数**构造 | `@a2a-js/sdk/dist/server/index.d.ts:312` |
| `AgentExecutor` = `{ execute(ctx, bus), cancelTask(taskId, bus) }` | `@a2a-js/sdk/dist/server/index.d.ts:139,144` |
| `AgentEvent.message/task/statusUpdate` 工厂；首个事件必须是 `task` 或 `message` | `@a2a-js/sdk/dist/server/index.d.ts:51`、`index.d.ts:133-135` |
| `UserBuilder.noAuthentication` 是函数，**直接传入不要调用** | `@a2a-js/sdk/dist/server/express/index.d.ts:7` |
| A2A 类型是 protobuf 风格，字段多为必填；`MessageFns` 只有 `fromJSON`/`toJSON`，不是 builder | `@a2a-js/sdk/dist/extensions-DglIgEjg.d.ts` |
| `Role.ROLE_USER=1` / `Role.ROLE_AGENT=2`；`TaskState.TASK_STATE_*` | `@a2a-js/sdk/dist/a2a-CJdXl9vi.d.ts:4,30` |
| `ClientFactory.createFromUrl(baseUrl)` → `Client`；`client.sendMessage(req)` → `Message \| Task` | `@a2a-js/sdk/dist/client/index.d.ts:192`、`dist/multitransport-client-Bq8elQ1W.d.ts:201` |
| `FakeListChatModel` 存在于 `@langchain/core/utils/testing` | `@langchain/core/dist/utils/testing/chat_models.d.ts:95` |

---

## Task 1: 工具链与仓库基建

**Files:**
- Create: `tsconfig.json`, `tsconfig.build.json`, `vitest.config.ts`, `.nvmrc`, `.gitignore`, `.env.example`
- Create: `config/mcp.servers.json`, `config/a2a.peers.json`
- Create: `scripts/check-node.ts`
- Verify (已存在，无需改动): `package.json`（scripts 与 engines 已按 §8 写好）、`pnpm-lock.yaml`（依赖已安装成功）

- [ ] **Step 1: 写 `tsconfig.json`**

```json
{
  "compilerOptions": {
    "target": "ES2023",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "lib": ["ES2023"],
    "types": ["node"],
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "noImplicitOverride": true,
    "verbatimModuleSyntax": true,
    "skipLibCheck": true,
    "esModuleInterop": true,
    "resolveJsonModule": true,
    "forceConsistentCasingInFileNames": true,
    "noEmit": true,
    "rootDir": "."
  },
  "include": ["src", "tests", "scripts", "skills"]
}
```

`verbatimModuleSyntax: true` 强制类型导入写成 `import type`，能提前暴露误用的运行时导入。

- [ ] **Step 2: 写 `tsconfig.build.json`**

```json
{
  "extends": "./tsconfig.json",
  "compilerOptions": {
    "noEmit": false,
    "outDir": "dist",
    "rootDir": "src",
    "declaration": true,
    "sourceMap": true
  },
  "include": ["src"]
}
```

- [ ] **Step 3: 写 `vitest.config.ts`**

```ts
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
```

- [ ] **Step 4: 写 `.nvmrc`、`.gitignore`、`.env.example`**

`.nvmrc`：

```
24
```

`.gitignore`：

```
node_modules/
dist/
.sandbox/
.data/
.env
*.log
.DS_Store
```

`.env.example`：

```
LLM_PROVIDER=openai-compatible
LLM_MODEL=gpt-4o-mini
LLM_BASE_URL=https://api.openai.com/v1
LLM_API_KEY=
LLM_TEMPERATURE=0

SANDBOX_ROOT=.sandbox
SANDBOX_TIMEOUT_MS=30000
SANDBOX_MAX_OUTPUT_BYTES=262144

CHECKPOINT_DB=.data/checkpoints.sqlite

SKILLS_DIR=skills
MCP_CONFIG=config/mcp.servers.json
A2A_PEERS=config/a2a.peers.json

A2A_PORT=4124
A2A_PUBLIC_URL=http://localhost:4124
A2A_AGENT_NAME=muliuniuma
A2A_DESCRIPTION=可扩展的 TypeScript Agent 运行时

LOG_LEVEL=info
```

- [ ] **Step 5: 写 `config/mcp.servers.json` 与 `config/a2a.peers.json`**

`config/mcp.servers.json`：

```json
{
  "servers": {}
}
```

`config/a2a.peers.json`：

```json
{
  "peers": []
}
```

- [ ] **Step 6: 写 `scripts/check-node.ts`**

```ts
const REQUIRED_MAJOR = 22;
const REQUIRED_MINOR = 12;

const [majorPart = '0', minorPart = '0'] = process.versions.node.split('.');

const major = Number.parseInt(majorPart, 10);
const minor = Number.parseInt(minorPart, 10);

const tooOld =
  major < REQUIRED_MAJOR ||
  (major === REQUIRED_MAJOR && minor < REQUIRED_MINOR);

if (tooOld) {
  console.error(
    `需要 Node >= ${REQUIRED_MAJOR}.${REQUIRED_MINOR}，当前为 ${process.versions.node}。\n` +
      `请执行：nvm use（不带参数，nvm 会读取仓库根目录的 .nvmrc，使用仓库指定的 Node 版本）`,
  );
  process.exit(1);
}
```

次版本下限 12 来自 `vitest@5.1.0` 的 engines（`^22.12.0 || ^24.0.0 || >=26.0.0`）——只比主版本会让 Node 22.0–22.11 通过守卫却死在 vitest 上。提示语用 `nvm use` 而非写死版本号，避免与仓库 `.nvmrc`（24）矛盾。

- [ ] **Step 7: 验证**

```bash
export PATH="/Users/jianglu/.nvm/versions/node/v24.19.0/bin:$PATH" && pnpm typecheck
```

预期：退出码 0，无输出（`src`/`tests` 目录尚不存在不报错，因为 `scripts` 命中了 include）。

再验证版本守卫真的会拦人：

```bash
export PATH="/Users/jianglu/.nvm/versions/node/v18.17.0/bin:$PATH" && node scripts/check-node.ts; echo "exit=$?"
```

预期：打印「需要 Node >= 22.12，当前为 18.17.0。」与「请执行：nvm use……」，`exit=1`。

**验证命令必须用 `pnpm tsx` 而不是裸 `node`**：Node 18 没有原生 TS 类型剥离能力，裸 `node scripts/check-node.ts` 会先报 `ERR_UNKNOWN_FILE_EXTENSION` 而走不到守卫逻辑。`package.json` 的 `dev`/`serve` 脚本走的就是 `tsx`。

- [ ] **Step 8: 提交**

```bash
git add tsconfig.json tsconfig.build.json vitest.config.ts .nvmrc .gitignore .env.example config scripts
git commit -m "chore: add toolchain config, gitignore and env template"
```

---

## Task 2: 错误类型与日志

**Files:**
- Create: `src/shared/errors.ts`, `src/shared/logger.ts`, `src/shared/index.ts`
- Test: `tests/shared.errors.test.ts`, `tests/shared.logger.test.ts`

- [ ] **Step 1: 写失败的测试 `tests/shared.errors.test.ts`**

```ts
import { describe, expect, it } from 'vitest';
import {
  AppError,
  ConfigError,
  ProviderNotRegisteredError,
  SandboxEscapeError,
  SkillNotFoundError,
} from '../src/shared/index.js';

describe('AppError', () => {
  it('保留错误码并保留 cause', () => {
    const cause = new Error('root');
    const err = new AppError('CONFIG_INVALID', 'boom', { cause });
    expect(err.code).toBe('CONFIG_INVALID');
    expect(err.cause).toBe(cause);
    expect(err).toBeInstanceOf(Error);
  });

  it('子类各自带固定 code', () => {
    expect(new ConfigError('x').code).toBe('CONFIG_INVALID');
    expect(new SandboxEscapeError('x').code).toBe('SANDBOX_ESCAPE');
    expect(new SkillNotFoundError('x').code).toBe('SKILL_NOT_FOUND');
    expect(new ProviderNotRegisteredError('x').code).toBe('PROVIDER_NOT_REGISTERED');
  });

  it('provider 未注册时提示要装哪个包', () => {
    const err = new ProviderNotRegisteredError('anthropic');
    expect(err.message).toContain('anthropic');
    expect(err.message).toContain('registerProvider');
  });
});
```

- [ ] **Step 2: 写失败的测试 `tests/shared/logger.test.ts`**

```ts
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createLogger } from '../src/shared/index.js';

afterEach(() => vi.restoreAllMocks());

describe('createLogger', () => {
  it('低于当前等级的日志不输出', () => {
    const spy = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    const log = createLogger('warn', 'test');
    log.debug('d');
    log.info('i');
    expect(spy).not.toHaveBeenCalled();
  });

  it('达到当前等级的日志输出到 stderr 并带 scope', () => {
    const spy = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    const log = createLogger('info', 'scope');
    log.info('hello');
    expect(spy).toHaveBeenCalledTimes(1);
    expect(String(spy.mock.calls[0]?.[0])).toContain('scope');
    expect(String(spy.mock.calls[0]?.[0])).toContain('hello');
  });

  it('child 追加 scope 前缀', () => {
    const spy = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    createLogger('info', 'a').child('b').info('m');
    expect(String(spy.mock.calls[0]?.[0])).toContain('a:b');
  });
});
```

- [ ] **Step 3: 运行测试确认失败**

```bash
export PATH="/Users/jianglu/.nvm/versions/node/v24.19.0/bin:$PATH" && pnpm vitest run tests/shared.errors.test.ts tests/shared/logger.test.ts
```

预期：FAIL，报 `Failed to resolve import "../src/shared/index.js"`。

- [ ] **Step 4: 实现 `src/shared/errors.ts`**

```ts
export type ErrorCode =
  | 'CONFIG_INVALID'
  | 'PROVIDER_NOT_REGISTERED'
  | 'SANDBOX_ESCAPE'
  | 'SANDBOX_EXEC_FAILED'
  | 'SKILL_NOT_FOUND'
  | 'SKILL_PARSE_FAILED'
  | 'A2A_PEER_UNREACHABLE';

export class AppError extends Error {
  constructor(
    readonly code: ErrorCode,
    message: string,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = new.target.name;
  }
}

export class ConfigError extends AppError {
  constructor(message: string, options?: { cause?: unknown }) {
    super('CONFIG_INVALID', message, options);
  }
}

export class ProviderNotRegisteredError extends AppError {
  constructor(provider: string) {
    super(
      'PROVIDER_NOT_REGISTERED',
      `未注册的 LLM provider: "${provider}"。请先安装对应的 @langchain/* 包，` +
        `然后在 src/llm/factory.ts 调用 registerProvider("${provider}", ...)。`,
    );
  }
}

export class SandboxEscapeError extends AppError {
  constructor(path: string) {
    super('SANDBOX_ESCAPE', `沙箱路径越界: ${path}`);
  }
}

export class SkillNotFoundError extends AppError {
  constructor(name: string) {
    super('SKILL_NOT_FOUND', `未找到 skill: ${name}`);
  }
}

export class SkillParseError extends AppError {
  constructor(message: string, options?: { cause?: unknown }) {
    super('SKILL_PARSE_FAILED', message, options);
  }
}
```

- [ ] **Step 5: 实现 `src/shared/logger.ts`**

```ts
import { inspect } from 'node:util';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error' | 'silent';

const LEVEL_ORDER: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
  silent: 100,
};

/**
 * 未识别的 level 必须 fail closed：回退到 info 阈值，
 * 避免未知配置把 debug（含 LLM 载荷）全量打进 stderr。
 * 查表只认自有属性，否则 'constructor'/'toString' 等 Object.prototype
 * 继承键会取到函数而非 undefined，导致阈值变 NaN 而重新 fail-open。
 */
const FALLBACK_LEVEL: LogLevel = 'info';

function resolveThreshold(level: string): number {
  if (Object.hasOwn(LEVEL_ORDER, level)) {
    return LEVEL_ORDER[level as LogLevel];
  }
  return LEVEL_ORDER[FALLBACK_LEVEL];
}

/**
 * 渲染 rest 参数：字符串原样输出，其余值用 node:util 的 inspect 保真格式化，
 * 保留对象结构与 Error 堆栈，避免 String(x) 退化成 "[object Object]"。
 */
function renderArg(value: unknown): string {
  if (typeof value === 'string') return value;
  return inspect(value, { depth: null, breakLength: Infinity, colors: false });
}

export interface Logger {
  debug(message: string, ...rest: unknown[]): void;
  info(message: string, ...rest: unknown[]): void;
  warn(message: string, ...rest: unknown[]): void;
  error(message: string, ...rest: unknown[]): void;
  child(scope: string): Logger;
}

export function createLogger(level: LogLevel, scope = 'app'): Logger {
  const threshold = resolveThreshold(level);

  const emit = (
    lvl: Exclude<LogLevel, 'silent'>,
    message: string,
    rest: unknown[],
  ): void => {
    if (LEVEL_ORDER[lvl] < threshold) return;
    const suffix = rest.length > 0 ? ` ${rest.map(renderArg).join(' ')}` : '';
    process.stderr.write(`[${lvl}] ${scope}: ${message}${suffix}\n`);
  };

  return {
    debug: (m, ...r) => emit('debug', m, r),
    info: (m, ...r) => emit('info', m, r),
    warn: (m, ...r) => emit('warn', m, r),
    error: (m, ...r) => emit('error', m, r),
    child: (childScope: string) => createLogger(level, `${scope}:${childScope}`),
  };
}
```

三处刻意的偏离（均为评审驱动）：`rest` 用 `inspect` 而非 `String` 保真渲染并与消息同行；未知 level fail closed 到 info 阈值；查表用 `Object.hasOwn` 排除 `Object.prototype` 继承键。

- [ ] **Step 6: 实现 `src/shared/index.ts`**

```ts
export * from './errors.js';
export * from './logger.js';
```

- [ ] **Step 7: 运行测试确认通过**

```bash
export PATH="/Users/jianglu/.nvm/versions/node/v24.19.0/bin:$PATH" && pnpm vitest run tests/shared.errors.test.ts tests/shared/logger.test.ts
```

预期：2 个文件全部 PASS。

- [ ] **Step 8: 提交**

```bash
git add src/shared tests/shared.errors.test.ts tests/shared/logger.test.ts
git commit -m "feat: add shared error types and leveled logger"
```

---

## Task 3: 配置加载

**Files:**
- Create: `src/config/env.ts`, `src/config/index.ts`
- Test: `tests/config.env.test.ts`

- [ ] **Step 1: 写失败的测试 `tests/config.env.test.ts`**

```ts
import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config/index.js';

const BASE = {
  LLM_PROVIDER: 'openai-compatible',
  LLM_MODEL: 'gpt-4o-mini',
  LLM_BASE_URL: 'https://example.com/v1',
  LLM_API_KEY: 'sk-test',
};

describe('loadConfig', () => {
  it('读取必填项并给出默认值', () => {
    const config = loadConfig({ ...BASE });
    expect(config.model.provider).toBe('openai-compatible');
    expect(config.model.model).toBe('gpt-4o-mini');
    expect(config.model.baseURL).toBe('https://example.com/v1');
    expect(config.sandbox.timeoutMs).toBe(30_000);
    expect(config.a2a.port).toBe(4124);
    expect(config.logLevel).toBe('info');
  });

  it('缺少 LLM_API_KEY 时抛出 ConfigError 并指出变量名', () => {
    expect(() => loadConfig({ ...BASE, LLM_API_KEY: undefined })).toThrowError(
      /LLM_API_KEY/,
    );
  });

  it('非法的 A2A_PORT 抛错并指出期望范围', () => {
    expect(() => loadConfig({ ...BASE, A2A_PORT: 'not-a-port' })).toThrowError(
      /A2A_PORT/,
    );
  });

  it('数值项非法时报出变量名', () => {
    expect(() => loadConfig({ ...BASE, SANDBOX_TIMEOUT_MS: '0' })).toThrowError(
      /SANDBOX_TIMEOUT_MS/,
    );
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

```bash
export PATH="/Users/jianglu/.nvm/versions/node/v24.19.0/bin:$PATH" && pnpm vitest run tests/config.env.test.ts
```

预期：FAIL，`Failed to resolve import "../src/config/index.js"`。

- [ ] **Step 3: 实现 `src/config/env.ts`**

```ts
import { z } from 'zod';
import { ConfigError } from '../shared/index.js';
import type { LogLevel } from '../shared/index.js';

const EnvSchema = z.object({
  LLM_PROVIDER: z.string().min(1),
  LLM_MODEL: z.string().min(1),
  LLM_BASE_URL: z.url(),
  LLM_API_KEY: z.string().min(1),
  LLM_TEMPERATURE: z.coerce.number().min(0).max(2).default(0),

  SANDBOX_ROOT: z.string().min(1).default('.sandbox'),
  SANDBOX_TIMEOUT_MS: z.coerce.number().int().positive().default(30_000),
  SANDBOX_MAX_OUTPUT_BYTES: z.coerce.number().int().positive().default(262_144),

  CHECKPOINT_DB: z.string().min(1).default('.data/checkpoints.sqlite'),

  SKILLS_DIR: z.string().min(1).default('skills'),
  MCP_CONFIG: z.string().min(1).default('config/mcp.servers.json'),
  A2A_PEERS: z.string().min(1).default('config/a2a.peers.json'),

  A2A_PORT: z.coerce.number().int().min(1).max(65_535).default(4124),
  A2A_PUBLIC_URL: z.url().default('http://localhost:4124'),
  A2A_AGENT_NAME: z.string().min(1).default('muliuniuma'),
  A2A_DESCRIPTION: z.string().min(1).default('可扩展的 TypeScript Agent 运行时'),

  LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error', 'silent']).default('info'),
});

export interface AppConfig {
  model: {
    provider: string;
    model: string;
    baseURL: string;
    apiKey: string;
    temperature: number;
  };
  sandbox: {
    root: string;
    timeoutMs: number;
    maxOutputBytes: number;
  };
  checkpointDb: string;
  skillsDir: string;
  mcpConfigPath: string;
  a2aPeersPath: string;
  a2a: {
    port: number;
    publicUrl: string;
    agentName: string;
    description: string;
  };
  logLevel: LogLevel;
}

export function loadEnvFileIfPresent(file = '.env'): void {
  try {
    process.loadEnvFile(file);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
}

export function loadConfig(env: Record<string, string | undefined> = process.env): AppConfig {
  const parsed = EnvSchema.safeParse(env);

  if (!parsed.success) {
    const detail = parsed.error.issues
      .map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`)
      .join('; ');
    throw new ConfigError(`环境变量校验失败 → ${detail}`, { cause: parsed.error });
  }

  const v = parsed.data;

  return {
    model: {
      provider: v.LLM_PROVIDER,
      model: v.LLM_MODEL,
      baseURL: v.LLM_BASE_URL,
      apiKey: v.LLM_API_KEY,
      temperature: v.LLM_TEMPERATURE,
    },
    sandbox: {
      root: v.SANDBOX_ROOT,
      timeoutMs: v.SANDBOX_TIMEOUT_MS,
      maxOutputBytes: v.SANDBOX_MAX_OUTPUT_BYTES,
    },
    checkpointDb: v.CHECKPOINT_DB,
    skillsDir: v.SKILLS_DIR,
    mcpConfigPath: v.MCP_CONFIG,
    a2aPeersPath: v.A2A_PEERS,
    a2a: {
      port: v.A2A_PORT,
      publicUrl: v.A2A_PUBLIC_URL,
      agentName: v.A2A_AGENT_NAME,
      description: v.A2A_DESCRIPTION,
    },
    logLevel: v.LOG_LEVEL,
  };
}
```

zod v4 的 `safeParse` 错误结构是 `error.issues`，每项有 `path` 与 `message`。

实现说明（Task 3 评审后的实际落地，与上方代码的差异）：

- `z.string().url()` 在 zod v4.6.7 已废弃，实际实现用等价的顶层 `z.url()`。
- `loadEnvFileIfPresent` 只吞 `ENOENT`（文件缺失），存在但读不了必须抛出，否则「配置缺失」会掩盖「权限不足」。
- `loadConfig` 保持纯函数（可注入 env、不读文件、不改 `process.env`）；`.env` 由入口在调用前显式加载。
- 测试除简报的 4 个用例外，还覆盖：错误类型与 `code` 断言、`loadConfig()` 默认参数路径（读真实 `process.env`，用保存-恢复模式清理）。

- [ ] **Step 4: 实现 `src/config/index.ts`**

```ts
export * from './env.js';
```

- [ ] **Step 5: 运行测试确认通过**

```bash
export PATH="/Users/jianglu/.nvm/versions/node/v24.19.0/bin:$PATH" && pnpm vitest run tests/config.env.test.ts
```

预期：PASS，4 个用例。

- [ ] **Step 6: 提交**

```bash
git add src/config tests/config.env.test.ts
git commit -m "feat: add zod-validated environment configuration"
```

---

## Task 4: LLM provider 抽象

**Files:**
- Create: `src/llm/types.ts`, `src/llm/factory.ts`, `src/llm/index.ts`
- Test: `tests/llm.factory.test.ts`

- [ ] **Step 1: 写失败的测试 `tests/llm.factory.test.ts`**

```ts
import { describe, expect, it } from 'vitest';
import { createChatModel, registerProvider } from '../src/llm/index.js';

describe('createChatModel', () => {
  it('openai-compatible 返回可用的 chat model', async () => {
    const model = await createChatModel({
      provider: 'openai-compatible',
      model: 'gpt-4o-mini',
      baseURL: 'https://example.com/v1',
      apiKey: 'sk-test',
      temperature: 0,
    });
    expect(model).toBeDefined();
    expect(typeof model.invoke).toBe('function');
  });

  it('openai provider 走同一个实现', async () => {
    const model = await createChatModel({
      provider: 'openai',
      model: 'gpt-4o-mini',
      apiKey: 'sk-test',
    });
    expect(model).toBeDefined();
  });

  it('自定义 provider 可通过注册表注入', async () => {
    registerProvider('fake-provider', async () => {
      return { invoke: async () => 'fake' } as never;
    });
    const model = await createChatModel({
      provider: 'fake-provider',
      model: 'x',
      apiKey: 'k',
    });
    expect(model).toBeDefined();
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

```bash
export PATH="/Users/jianglu/.nvm/versions/node/v24.19.0/bin:$PATH" && pnpm vitest run tests/llm.factory.test.ts
```

预期：FAIL，`Failed to resolve import "../src/llm/index.js"`。

- [ ] **Step 3: 实现 `src/llm/types.ts`**

```ts
export type ProviderId =
  | 'openai'
  | 'openai-compatible'
  | 'anthropic'
  | 'google'
  | 'ollama'
  | (string & {});

export interface ModelSpec {
  provider: ProviderId;
  model: string;
  baseURL?: string;
  apiKey?: string;
  temperature?: number;
}
```

- [ ] **Step 4: 实现 `src/llm/factory.ts`**

```ts
import { ChatOpenAI } from '@langchain/openai';
import type { BaseChatModel } from '@langchain/core/language_models/chat_models';
import { ProviderNotRegisteredError } from '../shared/index.js';
import type { ModelSpec, ProviderId } from './types.js';

export type ChatModelFactory = (spec: ModelSpec) => Promise<BaseChatModel>;

const registry = new Map<ProviderId, ChatModelFactory>();

function openAiFactory(spec: ModelSpec): Promise<BaseChatModel> {
  return Promise.resolve(
    new ChatOpenAI({
      model: spec.model,
      apiKey: spec.apiKey,
      temperature: spec.temperature ?? 0,
      ...(spec.baseURL ? { configuration: { baseURL: spec.baseURL } } : {}),
    }),
  );
}

export function registerProvider(id: ProviderId, factory: ChatModelFactory): void {
  registry.set(id, factory);
}

export async function createChatModel(spec: ModelSpec): Promise<BaseChatModel> {
  const factory = registry.get(spec.provider);
  if (!factory) {
    throw new ProviderNotRegisteredError(spec.provider);
  }
  return factory(spec);
}

registerProvider('openai', openAiFactory);
registerProvider('openai-compatible', openAiFactory);
```

`ChatOpenAI` 的 `configuration.baseURL` 是 @langchain/openai v1 里指定自定义端点的正规位置（v1 里顶层没有 `baseURL` 字段，放顶层会静默不生效）。

**实际落地不需要任何类型断言**：`@langchain/openai@1.8.4` 与顶层安装的是同一个物理 `@langchain/core@1.4.1` 实例，`BaseChatOpenAI extends BaseChatModel`，所以 `ChatOpenAI` 本身就是 `BaseChatModel` 的子类，直接向上转型即可。计划初稿里的 `as unknown as BaseChatModel` 会短路类型检查（万一将来两个包实例分裂，tsc 不会报错而问题推迟到运行时），已删除。

- [ ] **Step 5: 实现 `src/llm/index.ts`**

```ts
export * from './types.js';
export * from './factory.js';
```

- [ ] **Step 6: 运行测试确认通过**

```bash
export PATH="/Users/jianglu/.nvm/versions/node/v24.19.0/bin:$PATH" && pnpm vitest run tests/llm.factory.test.ts
```

预期：PASS，3 个用例。

- [ ] **Step 7: 类型检查**

```bash
export PATH="/Users/jianglu/.nvm/versions/node/v24.19.0/bin:$PATH" && pnpm typecheck
```

预期：退出码 0。若 ChatOpenAI 的断言报错，按 Step 4 的说明调整后重跑。

- [ ] **Step 8: 提交**

```bash
git add src/llm tests/llm.factory.test.ts
git commit -m "feat: add pluggable LLM provider registry"
```

---

## Task 5: 沙箱接口与本地子进程实现

**Files:**
- Create: `src/sandbox/types.ts`, `src/sandbox/local.ts`, `src/sandbox/index.ts`
- Test: `tests/sandbox.local.test.ts`

- [x] **Step 1: 写失败的测试 `tests/sandbox.local.test.ts`**

```ts
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { constants, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { LocalProcessSandbox } from '../src/sandbox/index.js';
import { SandboxEscapeError } from '../src/shared/index.js';

let root: string;
let sandbox: LocalProcessSandbox;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'sandbox-test-'));
  sandbox = await LocalProcessSandbox.create({
    id: 'test',
    root,
    timeoutMs: 5_000,
    maxOutputBytes: 1_024,
  });
});

afterEach(async () => {
  await sandbox?.dispose();
  await rm(root, { recursive: true, force: true });
});

describe('LocalProcessSandbox', () => {
  it('执行命令并返回 stdout', async () => {
    const result = await sandbox.exec('echo hello');
    expect(result.stdout.trim()).toBe('hello');
    expect(result.exitCode).toBe(0);
    expect(result.timedOut).toBe(false);
  });

  it('非零退出码被如实返回', async () => {
    const result = await sandbox.exec('exit 3');
    expect(result.exitCode).toBe(3);
  });

  it('超时后终止命令并标记 timedOut', async () => {
    const result = await sandbox.exec('sleep 5', { timeoutMs: 300 });
    expect(result.timedOut).toBe(true);
    expect(result.exitCode).toBe(124);
  });

  it('命令看不到宿主机的环境变量', async () => {
    process.env.SANDBOX_LEAK_TEST = 'leaked';
    try {
      const result = await sandbox.exec('echo "[$SANDBOX_LEAK_TEST]"');
      expect(result.stdout.trim()).toBe('[]');
    } finally {
      delete process.env.SANDBOX_LEAK_TEST;
    }
  });

  it('超长输出被截断', async () => {
    const result = await sandbox.exec('head -c 100000 /dev/zero | tr "\\0" "a"');
    expect(result.stdout.length).toBeGreaterThan(0);
    expect(result.stdout.length).toBeLessThanOrEqual(1_024);
    expect(Buffer.byteLength(result.stdout)).toBeLessThanOrEqual(1_024);
    expect(result.stdout).toContain('输出已截断');
  });

  it('多字节输出按字节截断而不是按字符截断', async () => {
    const result = await sandbox.exec(
      "i=0; while [ $i -lt 2000 ]; do printf '中'; i=$((i+1)); done",
    );
    expect(result.stdout.length).toBeGreaterThan(0);
    expect(Buffer.byteLength(result.stdout)).toBeLessThanOrEqual(1_024);
    expect(result.stdout).toContain('输出已截断');
    const chars = result.stdout.split('中').length - 1;
    expect(chars).toBeGreaterThan(0);
    // 中文每字 3 字节，1024 字节上限只装得下约 341 个字；
    // 若改成按字符截断，字符数会逼近字节上限（上面的 byteLength 断言也会同时失败）。
    expect(chars).toBeLessThan(500);
  });

  it('writeFile 与 readFile 在工作目录内往返', async () => {
    await sandbox.writeFile('a/b.txt', 'content');
    const data = await sandbox.readFile('a/b.txt');
    expect(new TextDecoder().decode(data)).toBe('content');
  });

  it('路径越界的 readFile 被拒绝', async () => {
    await expect(sandbox.readFile('../escape.txt')).rejects.toBeInstanceOf(
      SandboxEscapeError,
    );
  });

  it('路径越界的 writeFile 被拒绝', async () => {
    await expect(sandbox.writeFile('../../escape.txt', 'x')).rejects.toBeInstanceOf(
      SandboxEscapeError,
    );
  });

  it('绝对路径的读写被拒绝', async () => {
    await expect(sandbox.readFile('/etc/passwd')).rejects.toBeInstanceOf(
      SandboxEscapeError,
    );
    await expect(sandbox.writeFile('/tmp/escape.txt', 'x')).rejects.toBeInstanceOf(
      SandboxEscapeError,
    );
  });

  it('看似越界但仍留在目录内的路径被允许', async () => {
    await sandbox.writeFile('b.txt', 'inside');
    const data = await sandbox.readFile('a/../b.txt');
    expect(new TextDecoder().decode(data)).toBe('inside');
  });

  it('exec 的 cwd 越界被拒绝', async () => {
    await expect(sandbox.exec('pwd', { cwd: '../' })).rejects.toBeInstanceOf(
      SandboxEscapeError,
    );
    await expect(sandbox.exec('pwd', { cwd: '/etc' })).rejects.toBeInstanceOf(
      SandboxEscapeError,
    );
  });

  it('exec 可在工作目录的子目录中执行', async () => {
    await sandbox.writeFile('sub/file.txt', 'x');
    const result = await sandbox.exec('cat file.txt', { cwd: 'sub' });
    expect(result.stdout.trim()).toBe('x');
  });

  it('超时会连同子进程一起终止', async () => {
    const marker = join(sandbox.workdir, 'alive.txt');
    const result = await sandbox.exec(`(sleep 1; echo alive > "${marker}") & sleep 5`, {
      timeoutMs: 300,
    });
    expect(result.timedOut).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 1_500));
    expect(existsSync(marker)).toBe(false);
  });

  it('主 shell 先退出但后台后代持有管道时，exec 仍有界且后代被杀', async () => {
    // 主 shell 立即 exit 0，两个后台任务持有 stdout/stderr 管道。
    // 超时定时器必须仍然杀掉进程组（只是不标记超时），否则 close
    // 要等 sleep 5 自然结束，exec 会绕过超时无限期挂起。
    const marker = join(sandbox.workdir, 'descendant-alive.txt');
    const startedAt = Date.now();
    const result = await sandbox.exec(
      `(sleep 1; echo alive > "${marker}") & sleep 5 & exit 0`,
      { timeoutMs: 300 },
    );
    const elapsed = Date.now() - startedAt;
    // 有界性：必须远小于后台 sleep 5 的时长
    expect(elapsed).toBeLessThan(2_000);
    expect(result.exitCode).toBe(0);
    expect(result.timedOut).toBe(false);
    // 后代真的被杀：打算在 1s 后写文件的子进程没能写出 marker
    await new Promise((resolve) => setTimeout(resolve, 1_500));
    expect(existsSync(marker)).toBe(false);
  });

  it('dispose 删除工作目录', async () => {
    const workdir = sandbox.workdir;
    await sandbox.dispose();
    expect(existsSync(workdir)).toBe(false);
  });

  it('id 越界或退化时拒绝创建沙箱，且不创建/删除 root 之外的目录', async () => {
    const outside = join(dirname(root), 'sandbox-outside-probe');
    await mkdir(outside, { recursive: true });
    await writeFile(join(outside, 'keep.txt'), 'keep');
    const neverCreated = join(dirname(root), 'sandbox-never-created');
    try {
      for (const id of ['..', '../..', '', '.', 'a/..']) {
        const error = await LocalProcessSandbox.create({
          id,
          root,
          timeoutMs: 5_000,
          maxOutputBytes: 1_024,
        }).then(
          () => undefined,
          (e: unknown) => e,
        );
        expect(error).toBeInstanceOf(SandboxEscapeError);
        expect((error as Error).message).toContain(id);
      }
      // 越界目标不得被创建出来
      const probeError = await LocalProcessSandbox.create({
        id: '../sandbox-never-created',
        root,
        timeoutMs: 5_000,
        maxOutputBytes: 1_024,
      }).then(
        () => undefined,
        (e: unknown) => e,
      );
      expect(probeError).toBeInstanceOf(SandboxEscapeError);
      expect(existsSync(neverCreated)).toBe(false);
      // root 之外的目录不得被 dispose 之类的递归删除波及
      expect(existsSync(outside)).toBe(true);
      expect(existsSync(join(outside, 'keep.txt'))).toBe(true);
      // 退化 id（'' / '.' / 'a/..'）不得让 dispose 把 root 自身或同级沙箱删掉
      expect(existsSync(root)).toBe(true);
      expect(existsSync(join(root, 'test'))).toBe(true);
    } finally {
      await rm(outside, { recursive: true, force: true });
      await rm(neverCreated, { recursive: true, force: true });
    }
  });

  it('被信号杀死的命令不会被报成成功', async () => {
    const result = await sandbox.exec('kill -9 $$');
    expect(result.exitCode).not.toBe(0);
    expect(result.exitCode).not.toBe(124);
    expect(result.exitCode).toBe(128 + constants.signals.SIGKILL);
  });

  it('名为 ..foo 的目录不被误判为越界', async () => {
    await sandbox.writeFile('..foo/x.txt', 'dots');
    const data = await sandbox.readFile('..foo/x.txt');
    expect(new TextDecoder().decode(data)).toBe('dots');
  });

  it('命令已退出但 close 事件未送达时不会被误报为超时', async () => {
    // 后台 sleep 持有 stdout 管道，close 要等它结束才触发；
    // 主进程早已退出（exitCode 已有值），超时定时器不该再把它标成超时。
    const result = await sandbox.exec('sleep 1 & exit 0', { timeoutMs: 400 });
    expect(result.exitCode).toBe(0);
    expect(result.timedOut).toBe(false);
  });

  it('spawn 失败的原因始终可见（不受输出上限影响）', async () => {
    const tiny = await LocalProcessSandbox.create({
      id: 'tiny',
      root,
      timeoutMs: 5_000,
      maxOutputBytes: 16,
    });
    try {
      // cwd 不存在 → spawn 直接失败
      const result = await tiny.exec('echo hi', { cwd: 'no-such-dir' });
      expect(result.exitCode).toBe(127);
      expect(result.stderr).toContain('ENOENT');
    } finally {
      await tiny.dispose();
    }
  });
});
```

- [x] **Step 2: 运行测试确认失败**

```bash
export PATH="/Users/jianglu/.nvm/versions/node/v24.19.0/bin:$PATH" && pnpm vitest run tests/sandbox.local.test.ts
```

预期：FAIL，`Failed to resolve import "../src/sandbox/index.js"`。

- [x] **Step 3: 实现 `src/sandbox/types.ts`**

```ts
export interface ExecResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  timedOut: boolean;
}

export interface ExecOptions {
  timeoutMs?: number;
  cwd?: string;
}

export interface Sandbox {
  readonly id: string;
  readonly workdir: string;
  exec(command: string, options?: ExecOptions): Promise<ExecResult>;
  writeFile(relativePath: string, data: string | Uint8Array): Promise<void>;
  readFile(relativePath: string): Promise<Uint8Array>;
  dispose(): Promise<void>;
}

export interface SandboxOptions {
  id: string;
  root: string;
  timeoutMs: number;
  maxOutputBytes: number;
}
```

- [x] **Step 4: 实现 `src/sandbox/local.ts`**

```ts
import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { constants } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import { SandboxEscapeError } from '../shared/index.js';
import type { ExecOptions, ExecResult, Sandbox, SandboxOptions } from './types.js';

const BASE_ENV: Record<string, string> = {
  PATH: '/usr/local/bin:/usr/bin:/bin',
  LANG: 'C.UTF-8',
  TERM: 'dumb',
};

const TRUNCATION_NOTICE = '\n...[输出已截断]';

/**
 * 采集子进程输出，超过上限后不再累积，避免大输出撑爆宿主进程内存。
 */
class OutputBuffer {
  private readonly chunks: Buffer[] = [];
  private size = 0;
  private truncated = false;

  constructor(private readonly maxBytes: number) {}

  push(chunk: Buffer): void {
    if (this.truncated) return;
    const remaining = this.maxBytes - this.size;
    if (chunk.length <= remaining) {
      this.chunks.push(chunk);
      this.size += chunk.length;
      return;
    }
    if (remaining > 0) {
      this.chunks.push(chunk.subarray(0, remaining));
      this.size += remaining;
    }
    this.truncated = true;
  }

  toText(): string {
    const raw = Buffer.concat(this.chunks);
    if (!this.truncated) return raw.toString('utf8');
    const noticeBytes = Buffer.byteLength(TRUNCATION_NOTICE, 'utf8');
    if (noticeBytes >= this.maxBytes) return new StringDecoder('utf8').write(raw);
    const keep = this.maxBytes - noticeBytes;
    return `${new StringDecoder('utf8').write(raw.subarray(0, keep))}${TRUNCATION_NOTICE}`;
  }
}

/**
 * 进程被信号杀死时按 shell 惯例返回 128 + 信号编号（如 SIGKILL=9 → 137）。
 */
function signalExitCode(signal: NodeJS.Signals): number {
  const number: number | undefined = constants.signals[signal];
  return number === undefined ? 1 : 128 + number;
}

/**
 * detached: true 让子进程自成进程组，超时时必须按组杀掉，
 * 否则 sh -c "sleep 5" 派生的孙进程会变成孤儿继续运行。
 */
function killProcessGroup(child: ChildProcess): void {
  if (child.pid === undefined) {
    child.kill('SIGKILL');
    return;
  }
  try {
    process.kill(-child.pid, 'SIGKILL');
  } catch {
    child.kill('SIGKILL');
  }
}

export class LocalProcessSandbox implements Sandbox {
  readonly id: string;
  readonly workdir: string;

  private readonly timeoutMs: number;
  private readonly maxOutputBytes: number;
  private readonly running = new Set<ChildProcess>();

  private constructor(options: SandboxOptions) {
    const root = resolve(options.root);
    const workdir = resolve(join(root, options.id));
    // id 是公开字段，必须保证 workdir 是 root 的真子目录：
    // id='..' 会把工作目录指到 root 之外，dispose() 就会递归删除那个目录；
    // id='' / '.' 会让 workdir 等于 root 本身，dispose() 会连同级其他沙箱一起删掉。
    const rel = relative(root, workdir);
    if (rel === '' || rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
      throw new SandboxEscapeError(options.id);
    }
    this.id = options.id;
    this.workdir = workdir;
    this.timeoutMs = options.timeoutMs;
    this.maxOutputBytes = options.maxOutputBytes;
  }

  static async create(options: SandboxOptions): Promise<LocalProcessSandbox> {
    const sandbox = new LocalProcessSandbox(options);
    await mkdir(sandbox.workdir, { recursive: true });
    return sandbox;
  }

  /**
   * 把相对路径解析到 workdir 内部，越界即拒绝。
   *
   * 注意：这里刻意不解析符号链接。沙箱内用 `ln -s /etc passwd` 建的软链，
   * readFile 会读到 workdir 之外的内容，writeFile 同样会跟随软链写到外部目标。
   * 这是有意为之：本地进程隔离只用于约束误操作，不是安全边界。
   */
  private resolveInside(relativePath: string): string {
    if (isAbsolute(relativePath)) {
      throw new SandboxEscapeError(relativePath);
    }
    const target = resolve(this.workdir, relativePath);
    const rel = relative(this.workdir, target);
    if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
      throw new SandboxEscapeError(relativePath);
    }
    return target;
  }

  async exec(command: string, options: ExecOptions = {}): Promise<ExecResult> {
    const cwd = options.cwd ? this.resolveInside(options.cwd) : this.workdir;
    const timeoutMs = options.timeoutMs ?? this.timeoutMs;

    return new Promise<ExecResult>((resolvePromise) => {
      const child = spawn('/bin/sh', ['-c', command], {
        cwd,
        env: { ...BASE_ENV, HOME: this.workdir, PWD: this.workdir },
        detached: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      this.running.add(child);

      const stdout = new OutputBuffer(this.maxOutputBytes);
      const stderr = new OutputBuffer(this.maxOutputBytes);
      let timedOut = false;
      let settled = false;
      let spawnError: string | undefined;

      const timer = setTimeout(() => {
        // 主进程可能已经正常退出、只是 close 事件还没送达（exit 早于 close）：
        // 这时不能标记超时，否则成功的命令会被报成 exitCode 124。
        // 但杀组必须无条件执行：后台后代可能仍持有 stdout/stderr 管道，
        // 不杀掉它们 close 就要等后代自然结束，exec 会绕过超时无限期挂起。
        if (child.exitCode === null && child.signalCode === null) {
          timedOut = true;
        }
        killProcessGroup(child);
      }, timeoutMs);

      child.stdout?.on('data', (chunk: Buffer) => stdout.push(chunk));
      child.stderr?.on('data', (chunk: Buffer) => stderr.push(chunk));

      const settle = (exitCode: number): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this.running.delete(child);
        const stderrText = stderr.toText();
        resolvePromise({
          stdout: stdout.toText(),
          // spawn 失败的原因单独存放，不经过会被截断的输出缓冲，保证始终可见
          stderr: spawnError === undefined ? stderrText : `${stderrText}\n${spawnError}`,
          exitCode,
          timedOut,
        });
      };

      child.on('error', (error) => {
        spawnError = error.message;
        settle(127);
      });

      child.on('close', (code, signal) => {
        if (spawnError !== undefined) {
          settle(127);
          return;
        }
        if (timedOut) {
          settle(124);
          return;
        }
        if (code !== null) {
          settle(code);
          return;
        }
        if (signal !== null) {
          // 被信号杀死：返回 128 + 信号编号，不能回退到 0（那会把失败伪装成成功）
          settle(signalExitCode(signal));
          return;
        }
        // 既没有退出码也没有信号：进程没有正常结束，同样不能回退到 0
        settle(1);
      });
    });
  }

  async writeFile(relativePath: string, data: string | Uint8Array): Promise<void> {
    const target = this.resolveInside(relativePath);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, data);
  }

  async readFile(relativePath: string): Promise<Uint8Array> {
    const target = this.resolveInside(relativePath);
    return readFile(target);
  }

  async dispose(): Promise<void> {
    for (const child of this.running) {
      killProcessGroup(child);
    }
    this.running.clear();
    await rm(this.workdir, { recursive: true, force: true });
  }
}
```

- [x] **Step 5: 实现 `src/sandbox/index.ts`**

```ts
export * from './types.js';
export * from './local.js';
```

- [x] **Step 6: 运行测试确认通过**

```bash
export PATH="/Users/jianglu/.nvm/versions/node/v24.19.0/bin:$PATH" && pnpm vitest run tests/sandbox.local.test.ts
```

预期：PASS，21 个用例（简报 8 个 + 边界与修复轮新增 13 个）。输出截断按 UTF-8 字节封顶，且为截断提示预留字节，故 `Buffer.byteLength(stdout)` 与 `stdout.length` 均 ≤ 上限。

- [x] **Step 7: 提交**

```bash
git add src/sandbox tests/sandbox.local.test.ts
git commit -m "feat: add local process sandbox with path and env isolation"
```

---

## Task 6: 沙箱工厂与沙箱工具

**Files:**
- Create: `src/sandbox/factory.ts`, `src/tools/sandbox-tool.ts`, `src/tools/index.ts`
- Modify: `src/sandbox/index.ts`, `src/shared/errors.ts`
- Test: `tests/tools.sandbox-tool.test.ts`

- [x] **Step 1: 写失败的测试 `tests/tools.sandbox-tool.test.ts`**

```ts
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createSandbox, registerSandbox } from '../src/sandbox/index.js';
import type { Sandbox, SandboxOptions } from '../src/sandbox/index.js';
import { createSandboxTools } from '../src/tools/index.js';
import { SandboxEscapeError, SandboxNotRegisteredError } from '../src/shared/index.js';

let root: string;
let sandbox: Sandbox | undefined;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'sandbox-tool-'));
  sandbox = await createSandbox('local', {
    id: 'tool-test',
    root,
    timeoutMs: 5_000,
    maxOutputBytes: 4_096,
  });
});

afterEach(async () => {
  await sandbox?.dispose();
  sandbox = undefined;
  await rm(root, { recursive: true, force: true });
});

describe('createSandboxTools', () => {
  it('sandbox_exec 执行命令并回传 JSON', async () => {
    const tools = createSandboxTools(sandbox!);
    const execTool = tools.find((t) => t.name === 'sandbox_exec');
    expect(execTool).toBeDefined();

    const output = await execTool!.invoke({ command: 'echo hi' });
    const parsed = JSON.parse(String(output)) as { stdout: string; exitCode: number };
    expect(parsed.stdout.trim()).toBe('hi');
    expect(parsed.exitCode).toBe(0);
  });

  it('sandbox_write_file 写入后能读回', async () => {
    const tools = createSandboxTools(sandbox!);
    const writeTool = tools.find((t) => t.name === 'sandbox_write_file');
    expect(writeTool).toBeDefined();

    const output = await writeTool!.invoke({ path: 'note.txt', content: 'hello' });
    expect(output).toBe('已写入 note.txt');
    const read = await sandbox!.readFile('note.txt');
    expect(new TextDecoder().decode(read)).toBe('hello');
  });

  it('返回的工具恰好是 sandbox_exec 与 sandbox_write_file', () => {
    const tools = createSandboxTools(sandbox!);
    expect(tools.map((t) => t.name).sort()).toEqual(['sandbox_exec', 'sandbox_write_file']);
  });

  it('sandbox_exec 如实回传非零退出码', async () => {
    const tools = createSandboxTools(sandbox!);
    const execTool = tools.find((t) => t.name === 'sandbox_exec');

    const output = await execTool!.invoke({ command: 'exit 3' });
    const parsed = JSON.parse(String(output)) as { exitCode: number; timedOut: boolean };
    expect(parsed.exitCode).toBe(3);
    expect(parsed.timedOut).toBe(false);
  });

  it('sandbox_exec 透传 timeoutMs 并如实回传超时', async () => {
    const tools = createSandboxTools(sandbox!);
    const execTool = tools.find((t) => t.name === 'sandbox_exec');

    const output = await execTool!.invoke({ command: 'sleep 5', timeoutMs: 300 });
    const parsed = JSON.parse(String(output)) as { exitCode: number; timedOut: boolean };
    expect(parsed.timedOut).toBe(true);
    expect(parsed.exitCode).toBe(124);
  });

  it('sandbox_write_file 越界路径 reject SandboxEscapeError', async () => {
    const tools = createSandboxTools(sandbox!);
    const writeTool = tools.find((t) => t.name === 'sandbox_write_file');

    await expect(
      writeTool!.invoke({ path: '../escape.txt', content: 'x' }),
    ).rejects.toBeInstanceOf(SandboxEscapeError);
  });
});

describe('createSandbox 注册表', () => {
  it('registerSandbox 注入的自定义工厂可被 createSandbox 使用', async () => {
    const fake: Sandbox = {
      id: 'fake',
      workdir: root,
      exec: async () => ({ stdout: 'fake', stderr: '', exitCode: 0, timedOut: false }),
      writeFile: async () => {},
      readFile: async () => new Uint8Array(),
      dispose: async () => {},
    };
    let received: SandboxOptions | undefined;
    registerSandbox('fake', async (options) => {
      received = options;
      return fake;
    });

    const options: SandboxOptions = {
      id: 'fake-instance',
      root,
      timeoutMs: 1_000,
      maxOutputBytes: 1_024,
    };
    const created = await createSandbox('fake', options);
    expect(created).toBe(fake);
    expect(received).toBe(options);
  });

  it('未注册的 kind 抛 SandboxNotRegisteredError，信息含 kind 与可用列表', async () => {
    const error: unknown = await createSandbox('no-such-kind', {
      id: 'missing',
      root,
      timeoutMs: 1_000,
      maxOutputBytes: 1_024,
    }).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(SandboxNotRegisteredError);
    expect((error as SandboxNotRegisteredError).code).toBe('SANDBOX_NOT_REGISTERED');
    expect((error as SandboxNotRegisteredError).message).toContain('no-such-kind');
    expect((error as SandboxNotRegisteredError).message).toContain('local');
  });
});
```

- [x] **Step 2: 运行测试确认失败**

```bash
export PATH="/Users/jianglu/.nvm/versions/node/v24.19.0/bin:$PATH" && pnpm vitest run tests/tools.sandbox-tool.test.ts
```

预期：FAIL，`Failed to resolve import "../src/tools/index.js"`。

- [x] **Step 3: 新增 `SandboxNotRegisteredError` 并实现 `src/sandbox/factory.ts`**

先在 `src/shared/errors.ts` 的 `ErrorCode` 联合里加 `'SANDBOX_NOT_REGISTERED'`，并对照 `ProviderNotRegisteredError` 新增错误类（barrel `src/shared/index.ts` 是 `export *`，自动覆盖）：

```ts
export class SandboxNotRegisteredError extends AppError {
  constructor(kind: string, availableKinds: readonly string[]) {
    super(
      'SANDBOX_NOT_REGISTERED',
      `未注册的沙箱实现: "${kind}"。请调用 registerSandbox("${kind}", ...) 注册对应工厂。` +
        `当前可用: ${availableKinds.join(', ')}`,
    );
  }
}
```

提示措辞指向对外导出的 `registerSandbox(...)`，不要让用户去改源码。然后实现工厂：

```ts
import { SandboxNotRegisteredError } from '../shared/index.js';
import { LocalProcessSandbox } from './local.js';
import type { Sandbox, SandboxOptions } from './types.js';

export type SandboxFactory = (options: SandboxOptions) => Promise<Sandbox>;

const factories = new Map<string, SandboxFactory>([
  ['local', (options) => LocalProcessSandbox.create(options)],
]);

export function registerSandbox(kind: string, factory: SandboxFactory): void {
  factories.set(kind, factory);
}

export async function createSandbox(
  kind: string,
  options: SandboxOptions,
): Promise<Sandbox> {
  const factory = factories.get(kind);
  if (!factory) {
    throw new SandboxNotRegisteredError(kind, [...factories.keys()]);
  }
  return factory(options);
}
```

这是 spec §12 的扩展点：新增 Docker / E2B 实现只需 `registerSandbox('docker', ...)`，上层不感知。

- [x] **Step 4: 修改 `src/sandbox/index.ts`**

```ts
export * from './types.js';
export * from './local.js';
export * from './factory.js';
```

- [x] **Step 5: 实现 `src/tools/sandbox-tool.ts`**

```ts
import { tool } from 'langchain';
import { z } from 'zod';
import type { StructuredToolInterface } from '@langchain/core/tools';
import type { Sandbox } from '../sandbox/index.js';

export function createSandboxTools(sandbox: Sandbox): StructuredToolInterface[] {
  const execTool = tool(
    async ({ command, timeoutMs }) => {
      const result = await sandbox.exec(command, timeoutMs ? { timeoutMs } : {});
      return JSON.stringify(result);
    },
    {
      name: 'sandbox_exec',
      description:
        '在隔离沙箱中执行一条 shell 命令，返回 { stdout, stderr, exitCode, timedOut }。',
      schema: z.object({
        command: z.string().min(1),
        timeoutMs: z.number().int().positive().optional(),
      }),
    },
  );

  const writeTool = tool(
    async ({ path, content }) => {
      await sandbox.writeFile(path, content);
      return `已写入 ${path}`;
    },
    {
      name: 'sandbox_write_file',
      description: '在沙箱工作目录内写入一个文本文件。',
      schema: z.object({
        path: z.string().min(1),
        content: z.string(),
      }),
    },
  );

  return [execTool, writeTool];
}
```

- [x] **Step 6: 实现 `src/tools/index.ts`**

```ts
export * from './sandbox-tool.js';
```

- [x] **Step 7: 运行测试确认通过**

```bash
export PATH="/Users/jianglu/.nvm/versions/node/v24.19.0/bin:$PATH" && pnpm vitest run tests/tools.sandbox-tool.test.ts
```

预期：PASS，8 个用例（简报 2 个 + 注册表扩展点与工具关键路径 6 个）。

- [x] **Step 8: 提交**

```bash
git add src/sandbox src/tools src/shared/errors.ts tests/tools.sandbox-tool.test.ts
git commit -m "feat: add sandbox factory and sandbox tools"
```

---

## Task 7: Skill 加载器

**Files:**
- Create: `src/skills/types.ts`, `src/skills/loader.ts`, `src/skills/index.ts`
- Test: `tests/skills.loader.test.ts`

- [x] **Step 1: 写失败的测试 `tests/skills.loader.test.ts`**

```ts
import { chmod, mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { loadSkills, parseSkillFile } from '../src/skills/index.js';
import { SkillParseError } from '../src/shared/index.js';

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return { ...actual, readdir: vi.fn(actual.readdir) };
});

let dir: string | undefined;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'skills-'));
});

afterEach(async () => {
  if (dir !== undefined) {
    await rm(dir, { recursive: true, force: true });
  }
  dir = undefined;
});

async function writeSkill(name: string, lines: string[]): Promise<string> {
  const skillDir = join(dir!, name);
  await mkdir(skillDir, { recursive: true });
  await writeFile(join(skillDir, 'SKILL.md'), lines.join('\n'));
  return skillDir;
}

describe('parseSkillFile', () => {
  const valid = [
    '---',
    'name: hello-world',
    'description: 演示用的 skill',
    'allowed-tools: [echo, sandbox_exec]',
    '---',
    '',
    '正文第一段。',
  ].join('\n');

  it('解析 frontmatter 与正文', () => {
    const manifest = parseSkillFile(valid, '/tmp/hello-world');
    expect(manifest.name).toBe('hello-world');
    expect(manifest.description).toBe('演示用的 skill');
    expect(manifest.allowedTools).toEqual(['echo', 'sandbox_exec']);
    expect(manifest.body).toBe('正文第一段。');
    expect(manifest.dir).toBe('/tmp/hello-world');
  });

  it('缺少 frontmatter 抛 SkillParseError', () => {
    expect(() => parseSkillFile('没有 frontmatter', '/tmp/x')).toThrowError(
      SkillParseError,
    );
  });

  it('缺少 name 抛错', () => {
    const noName = ['---', 'description: x', '---', 'body'].join('\n');
    expect(() => parseSkillFile(noName, '/tmp/x')).toThrowError(/name/);
  });

  it('缺少 description 抛错', () => {
    const noDesc = ['---', 'name: x', '---', 'body'].join('\n');
    expect(() => parseSkillFile(noDesc, '/tmp/x')).toThrowError(/description/);
  });

  it('双引号包裹的标量剥掉引号', () => {
    const quoted = [
      '---',
      'name: "hello-world"',
      'description: "演示用的 skill"',
      '---',
      'body',
    ].join('\n');
    const manifest = parseSkillFile(quoted, '/tmp/x');
    expect(manifest.name).toBe('hello-world');
    expect(manifest.description).toBe('演示用的 skill');
  });

  it('单引号包裹的标量剥掉引号', () => {
    const quoted = [
      '---',
      "name: 'hello-world'",
      "description: '演示用的 skill'",
      '---',
      'body',
    ].join('\n');
    const manifest = parseSkillFile(quoted, '/tmp/x');
    expect(manifest.name).toBe('hello-world');
    expect(manifest.description).toBe('演示用的 skill');
  });

  it('值内部的引号不被破坏', () => {
    const inner = [
      '---',
      'name: x',
      'description: 带 "内嵌引号" 与 \'单引号\' 的值',
      '---',
      'body',
    ].join('\n');
    expect(parseSkillFile(inner, '/tmp/x').description).toBe(
      '带 "内嵌引号" 与 \'单引号\' 的值',
    );
  });

  it('首尾不匹配的引号不剥', () => {
    const mismatched = [
      '---',
      'name: "unclosed',
      'description: d',
      '---',
      'body',
    ].join('\n');
    expect(parseSkillFile(mismatched, '/tmp/x').name).toBe('"unclosed');
  });

  it('allowed-tools 缺省时为空数组', () => {
    const noTools = ['---', 'name: x', 'description: d', '---', 'body'].join('\n');
    expect(parseSkillFile(noTools, '/tmp/x').allowedTools).toEqual([]);
  });

  it('allowed-tools 为单个字符串时包装成数组', () => {
    const single = [
      '---',
      'name: x',
      'description: d',
      'allowed-tools: echo',
      '---',
      'body',
    ].join('\n');
    expect(parseSkillFile(single, '/tmp/x').allowedTools).toEqual(['echo']);
  });

  it('allowed-tools 为空数组时保持空数组', () => {
    const empty = [
      '---',
      'name: x',
      'description: d',
      'allowed-tools: []',
      '---',
      'body',
    ].join('\n');
    expect(parseSkillFile(empty, '/tmp/x').allowedTools).toEqual([]);
  });

  it('行内数组元素同样剥掉成对引号', () => {
    const quotedItems = [
      '---',
      'name: x',
      'description: d',
      'allowed-tools: ["echo", \'sandbox_exec\']',
      '---',
      'body',
    ].join('\n');
    expect(parseSkillFile(quotedItems, '/tmp/x').allowedTools).toEqual([
      'echo',
      'sandbox_exec',
    ]);
  });

  it('只有 frontmatter 没有正文时 body 为空串', () => {
    const noBody = ['---', 'name: x', 'description: d', '---'].join('\n');
    expect(parseSkillFile(noBody, '/tmp/x').body).toBe('');
  });

  it('CRLF 换行的 SKILL.md 正确解析', () => {
    const crlf = [
      '---',
      'name: x',
      'description: d',
      'allowed-tools: [echo]',
      '---',
      '',
      '正文。',
    ].join('\r\n');
    const manifest = parseSkillFile(crlf, '/tmp/x');
    expect(manifest.name).toBe('x');
    expect(manifest.description).toBe('d');
    expect(manifest.allowedTools).toEqual(['echo']);
    expect(manifest.body).toBe('正文。');
  });

  it('frontmatter 里的 # 注释行被忽略', () => {
    const commented = [
      '---',
      '# 这是注释',
      'name: x',
      '  # 缩进的注释',
      'description: d',
      '---',
      'body',
    ].join('\n');
    const manifest = parseSkillFile(commented, '/tmp/x');
    expect(manifest.name).toBe('x');
    expect(manifest.description).toBe('d');
  });

  it('剥掉开头的 UTF-8 BOM 后正常解析', () => {
    const manifest = parseSkillFile(`\uFEFF${valid}`, '/tmp/x');
    expect(manifest.name).toBe('hello-world');
    expect(manifest.body).toBe('正文第一段。');
  });
});

describe('loadSkills', () => {
  it('目录不存在时返回空数组', async () => {
    expect(await loadSkills(join(dir!, 'missing'))).toEqual([]);
  });

  it('扫描每个子目录下的 SKILL.md', async () => {
    const skillDir = join(dir!, 'demo');
    await mkdir(skillDir, { recursive: true });
    await writeFile(
      join(skillDir, 'SKILL.md'),
      ['---', 'name: demo', 'description: d', '---', 'body'].join('\n'),
    );

    const manifests = await loadSkills(dir!);
    expect(manifests).toHaveLength(1);
    expect(manifests[0]?.name).toBe('demo');
    expect(manifests[0]?.entry).toBeUndefined();
  });

  it('存在 tool.ts 时记录 entry 路径', async () => {
    const skillDir = join(dir!, 'demo');
    await mkdir(skillDir, { recursive: true });
    await writeFile(
      join(skillDir, 'SKILL.md'),
      ['---', 'name: demo', 'description: d', '---', 'body'].join('\n'),
    );
    await writeFile(join(skillDir, 'tool.ts'), 'export const tools = [];\n');

    const manifests = await loadSkills(dir!);
    expect(manifests[0]?.entry).toBe(join(skillDir, 'tool.ts'));
  });

  it('指向普通文件路径时抛出 ENOTDIR 而不是返回空数组', async () => {
    const filePath = join(dir!, 'not-a-dir');
    await writeFile(filePath, 'i am a file');
    await expect(loadSkills(filePath)).rejects.toMatchObject({ code: 'ENOTDIR' });
  });

  it('一个坏 skill 让整体 fail-fast，错误信息含坏 skill 目录', async () => {
    await writeSkill('aaa-good', ['---', 'name: good', 'description: d', '---', 'body']);
    const badDir = await writeSkill('zzz-bad', ['---', 'description: d', '---', 'body']);

    const error = await loadSkills(dir!).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(SkillParseError);
    expect((error as Error).message).toContain(badDir);
  });

  it('多个 skill 按目录名排序输出', async () => {
    await writeSkill('zeta', ['---', 'name: zeta', 'description: d', '---', 'body']);
    await writeSkill('alpha', ['---', 'name: alpha', 'description: d', '---', 'body']);
    await writeSkill('mid', ['---', 'name: mid', 'description: d', '---', 'body']);

    const manifests = await loadSkills(dir!);
    expect(manifests.map((m) => m.name)).toEqual(['alpha', 'mid', 'zeta']);
  });

  // 本机文件系统恰好按字母序返回条目，必须模拟乱序 readdir 才能检验排序契约。
  it('readdir 返回乱序时输出仍按目录名排序', async () => {
    await writeSkill('zeta', ['---', 'name: zeta', 'description: d', '---', 'body']);
    await writeSkill('alpha', ['---', 'name: alpha', 'description: d', '---', 'body']);
    await writeSkill('mid', ['---', 'name: mid', 'description: d', '---', 'body']);
    const entries = await readdir(dir!, { withFileTypes: true });
    const descending = entries.sort((a, b) => (a.name > b.name ? -1 : 1));
    vi.mocked(readdir).mockImplementationOnce(async () => descending as never);

    const manifests = await loadSkills(dir!);
    expect(manifests.map((m) => m.name)).toEqual(['alpha', 'mid', 'zeta']);
  });

  it('没有 SKILL.md 的子目录被跳过', async () => {
    await mkdir(join(dir!, 'empty-dir'), { recursive: true });
    await writeSkill('demo', ['---', 'name: demo', 'description: d', '---', 'body']);

    const manifests = await loadSkills(dir!);
    expect(manifests).toHaveLength(1);
    expect(manifests[0]?.name).toBe('demo');
  });

  it('目录里的普通文件条目被跳过', async () => {
    await writeFile(join(dir!, 'stray.txt'), 'not a skill');
    await writeSkill('demo', ['---', 'name: demo', 'description: d', '---', 'body']);

    const manifests = await loadSkills(dir!);
    expect(manifests).toHaveLength(1);
    expect(manifests[0]?.name).toBe('demo');
  });

  // root 用户可以读 mode 000 的文件，构造不出 EACCES，跳过该用例。
  it.skipIf(process.getuid?.() === 0)(
    'SKILL.md 存在但不可读时抛出而不是静默跳过',
    async () => {
      const skillDir = await writeSkill('demo', [
        '---',
        'name: demo',
        'description: d',
        '---',
        'body',
      ]);
      await chmod(join(skillDir, 'SKILL.md'), 0o000);

      await expect(loadSkills(dir!)).rejects.toMatchObject({ code: 'EACCES' });
    },
  );
});
```

- [x] **Step 2: 运行测试确认失败**

```bash
export PATH="/Users/jianglu/.nvm/versions/node/v24.19.0/bin:$PATH" && pnpm vitest run tests/skills.loader.test.ts
```

预期：FAIL，`Failed to resolve import "../src/skills/loader.js"`。

- [x] **Step 3: 实现 `src/skills/types.ts`**

```ts
export interface SkillManifest {
  name: string;
  description: string;
  allowedTools: string[];
  entry?: string;
  body: string;
  dir: string;
}
```

- [x] **Step 4: 实现 `src/skills/loader.ts` 与 barrel `src/skills/index.ts`**

```ts
import { constants } from 'node:fs';
import type { Dirent } from 'node:fs';
import { access, readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { SkillParseError } from '../shared/index.js';
import type { SkillManifest } from './types.js';

const FRONTMATTER_PATTERN = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/;

function stripQuotes(value: string): string {
  if (
    value.length >= 2 &&
    ((value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'")))
  ) {
    return value.slice(1, -1);
  }
  return value;
}

// 刻意的手写 YAML 子集：只支持 `key: value` 与行内 `[a, b]` 数组，不支持多行数组/嵌套映射。
function parseValue(raw: string): string | string[] {
  const trimmed = raw.trim();
  if (trimmed.startsWith('[') && trimmed.endsWith(']')) {
    return trimmed
      .slice(1, -1)
      .split(',')
      .map((item) => stripQuotes(item.trim()))
      .filter((item) => item.length > 0);
  }
  return stripQuotes(trimmed);
}

export function parseSkillFile(content: string, dir: string): SkillManifest {
  const text = content.startsWith('\uFEFF') ? content.slice(1) : content;
  const match = FRONTMATTER_PATTERN.exec(text);
  if (!match) {
    throw new SkillParseError(`SKILL.md 缺少 frontmatter: ${dir}`);
  }

  const fields = new Map<string, string | string[]>();
  for (const line of match[1]!.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed.length === 0 || trimmed.startsWith('#')) continue;
    const separator = trimmed.indexOf(':');
    if (separator === -1) continue;
    fields.set(trimmed.slice(0, separator).trim(), parseValue(trimmed.slice(separator + 1)));
  }

  const name = fields.get('name');
  const description = fields.get('description');

  if (typeof name !== 'string' || name.length === 0) {
    throw new SkillParseError(`SKILL.md frontmatter 缺少 name: ${dir}`);
  }
  if (typeof description !== 'string' || description.length === 0) {
    throw new SkillParseError(`SKILL.md frontmatter 缺少 description: ${dir}`);
  }

  const allowedRaw = fields.get('allowed-tools');
  const allowedTools = Array.isArray(allowedRaw)
    ? allowedRaw
    : typeof allowedRaw === 'string' && allowedRaw.length > 0
      ? [allowedRaw]
      : [];

  return {
    name,
    description,
    allowedTools,
    body: text.slice(match[0].length).trim(),
    dir,
  };
}

export async function loadSkills(dir: string): Promise<SkillManifest[]> {
  let entries: Dirent[];
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw error;
    }
    return [];
  }

  entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));

  const manifests: SkillManifest[] = [];

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;

    const skillDir = join(dir, entry.name);
    let content: string;
    try {
      content = await readFile(join(skillDir, 'SKILL.md'), 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw error;
      }
      continue;
    }

    const manifest = parseSkillFile(content, skillDir);

    const entryPath = join(skillDir, 'tool.ts');
    try {
      await access(entryPath, constants.F_OK);
      manifest.entry = entryPath;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw error;
      }
    }

    manifests.push(manifest);
  }

  return manifests;
}
```

barrel（跨模块与测试都只走它，不深链 loader.js）：

```ts
export * from './types.js';
export * from './loader.js';
```

- [x] **Step 5: 运行测试确认通过**

```bash
export PATH="/Users/jianglu/.nvm/versions/node/v24.19.0/bin:$PATH" && pnpm vitest run tests/skills.loader.test.ts
```

预期：PASS，26 个用例（简报 7 个 + 裁决 R1–R7 要求的 19 个）。

- [x] **Step 6: 提交**

```bash
git add src/skills tests/skills.loader.test.ts
git commit -m "feat: add markdown skill loader with frontmatter parsing"
```

---

## Task 8: Skill 注册表与 load_skill 工具

**Files:**
- Create: `src/skills/registry.ts`, `src/skills/load-tool.ts`, `src/skills/index.ts`
- Test: `tests/skills.registry.test.ts`

**状态：已完成**（commits `cc99aba..547644d`，审查 Approved + 1 修复轮后复审 Approved；基线 8 文件 / 105 测试，typecheck 与 build 均 exit 0）

> **实现偏离简报之处（控制器裁决 R1–R8，下方代码为最终落地版本）**
>
> - **R1**：简报的 `schema: original.schema as never` 与 `input as never` 放弃类型检查，与 Task 4 已定为 Important 的同类 → **禁止 `as never` / `as unknown as`**。最终实现零断言。
> - **R2**：简报用 `tool()` 重包装加前缀，会丢失 `StructuredTool` 的行为配置字段（`returnDirect` / `responseFormat` / `extras` / `verboseParsingErrors`）。**实测更严重**：重包装即使透传全部字段，在普通输入与 ToolCall 输入两种形态下都抛 `Tool response format is "content_and_artifact" but the output was not a two-tuple` → 改用 **Proxy 只拦 `name`**，零 mutate、行为全保留。
> - **R3**：简报构造器静默覆盖重名 skill，且 `list()` 读去重 Map 而 `promptSection()` 读原始数组（两份数据不一致）→ 重名 **fail-fast** 抛错（含名字与两个冲突目录）；不保留原始数组字段，`promptSection()` 直接复用 `list()`，从结构上消灭不一致。
> - **R4**：`tool.ts` 是用户代码 → 只认命名导出 `export const tools`（**去掉简报的 `default` 兜底**）、必须是数组、元素必须有可用 `name`/`description`/`invoke`/`schema`；不符抛含 skill 名、entry 路径与 `tools[index]` 下标的错误；动态 import 失败同样含名与路径并保留 `{ cause }`。
> - **R5**：承接 Task 7 路由（`access(F_OK)` 对名为 `tool.ts` 的**目录**也成功）→ import 前用 `stat` + `isFile()` 校验。
> - **R6**：返回类型用 `StructuredToolInterface`（`import type` 自 `@langchain/core/tools`，**该接口不由 `langchain` 顶层重导出**），与 Task 6 一致；简报的 `StructuredTool[]` 是具体类，比接口窄。
> - **R7**：`loadTools()` 必须**幂等**，不得 mutate ES 模块缓存原对象（否则第二次调用产出 `demo_demo_echo`）→ 有调用两次的测试。
> - **R8**：简报零覆盖前缀机制存在的唯一理由 → 补两个 skill 各有同名工具、空注册表 `promptSection() === ''`、不含 body、无 entry 跳过、`load_skill` 传未注册名抛 `SkillNotFoundError`、`list()` 多 skill、工具名恰为 `load_skill`。
> - **简报自相矛盾**：`promptSection()` 标题文案含「读取正文」，而简报自己的断言是 `not.toContain('正文')` → 改标题为「读取完整说明」，**断言不得删改**。
>
> **修复轮 1**（评审 3 条 Minor 中裁定打包修 2 条）：守卫补 `description` 字符串校验（不要求非空）；Proxy 补 `set` 陷阱（只拦 `name`，抛含「为什么」与「另包一层」指引的错误，其余 `Reflect.set` 透传）与 `getOwnPropertyDescriptor` 陷阱（`name` 返回前缀值）。
> 裁定理由：`proxy.name = 'x'` 实测会**写穿污染 ES 模块缓存原对象**，破坏 R7；而 spec §7 要求 Task 12 冲突时「加数字后缀」，若用 `.name =` 赋值实现就会静默腐蚀原工具——非假设性风险。
>
> **路由到 Task 12（本任务不做）**：
> - 工具级重名检测（同 skill 内同名工具、跨 skill 前缀拼接碰撞如 `a`+`b_echo` 与 `a_b`+`echo` 都成 `a_b_echo`）。spec §7 把冲突处理放在 Task 12 合并层并带优先级排序，在 registry 里重复检测属过早抽象。
> - **实现数字后缀时必须「另包一层」，不得对 skill 工具 proxy 做任何字段写入或 `Object.defineProperty`**：非 `name` 属性赋值经 `Reflect.set` 透传仍写穿原对象，且无 `defineProperty` 陷阱。
>
> **已实证的前提（供后续任务复用，勿再猜测）**：`name` 是 `{writable:true, enumerable:true, configurable:true}` 数据属性，故覆写描述符 value 不触发 Proxy 不变量违规；LangChain tools 模块 `#private` 字段计数为 **0**，经 Proxy 调方法安全；对象展开 `{...proxy}` 走 [[Get]] 拿到**前缀名**；`JSON.stringify` 原工具与 Proxy **完全相同**（`toJSON()` 返回 lc 序列化桩，本就不含 name），不是 Proxy 回归。

- [x] **Step 1: 写失败的测试 `tests/skills.registry.test.ts`**

下方为简报原始的 4 个用例（全部保留、断言未删改）。最终落地 **21 个用例** = 简报 4 + R1–R8 要求的 14 + 修复轮 3。

```ts
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SkillRegistry, createLoadSkillTool, loadSkills } from '../src/skills/index.js';
import { SkillNotFoundError } from '../src/shared/index.js';

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'skills-reg-'));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('SkillRegistry', () => {
  it('列出全部 skill 的 name 与 description', async () => {
    const skillDir = join(dir, 'demo');
    await mkdir(skillDir, { recursive: true });
    await writeFile(
      join(skillDir, 'SKILL.md'),
      ['---', 'name: demo', 'description: 演示', '---', '正文'].join('\n'),
    );

    const registry = new SkillRegistry(await loadSkills(dir));
    expect(registry.list().map((m) => m.name)).toEqual(['demo']);
    expect(registry.promptSection()).toContain('demo');
    expect(registry.promptSection()).toContain('演示');
    expect(registry.promptSection()).not.toContain('正文');
  });

  it('get 未注册的 skill 抛 SkillNotFoundError', () => {
    const registry = new SkillRegistry([]);
    expect(() => registry.get('nope')).toThrowError(SkillNotFoundError);
  });

  it('加载 tool.ts 时给工具加 skill 前缀', async () => {
    const skillDir = join(dir, 'demo');
    await mkdir(skillDir, { recursive: true });
    await writeFile(
      join(skillDir, 'SKILL.md'),
      ['---', 'name: demo', 'description: 演示', '---', '正文'].join('\n'),
    );
    await writeFile(
      join(skillDir, 'tool.ts'),
      [
        "import { tool } from 'langchain';",
        "import { z } from 'zod';",
        "export const tools = [",
        "  tool(async ({ value }) => value, {",
        "    name: 'echo',",
        "    description: '回显',",
        "    schema: z.object({ value: z.string() }),",
        '  }),',
        '];',
      ].join('\n'),
    );

    const registry = new SkillRegistry(await loadSkills(dir));
    const tools = await registry.loadTools();
    expect(tools).toHaveLength(1);
    expect(tools[0]?.name).toBe('demo_echo');
    const output = await tools[0]!.invoke({ value: 'hi' });
    expect(String(output)).toBe('hi');
  });
});

describe('createLoadSkillTool', () => {
  it('按名字返回 skill 正文', async () => {
    const skillDir = join(dir, 'demo');
    await mkdir(skillDir, { recursive: true });
    await writeFile(
      join(skillDir, 'SKILL.md'),
      ['---', 'name: demo', 'description: 演示', '---', '详细正文'].join('\n'),
    );

    const registry = new SkillRegistry(await loadSkills(dir));
    const loadTool = createLoadSkillTool(registry);
    const output = await loadTool.invoke({ name: 'demo' });
    expect(String(output)).toBe('详细正文');
  });
});
```

`tool.ts` 的契约：`export const tools = [...]`，每个元素是 LangChain 的 `tool()` 结果。注册表会给工具名加 `<skillName>_` 前缀，避免不同 skill 的同名工具互相覆盖。

- [x] **Step 2: 运行测试确认失败**

```bash
export PATH="/Users/jianglu/.nvm/versions/node/v24.19.0/bin:$PATH" && pnpm vitest run tests/skills.registry.test.ts
```

预期：FAIL，`Failed to resolve import "../src/skills/index.js"`。

- [x] **Step 3: 实现 `src/skills/registry.ts`**（最终落地版本，含修复轮 1）

```ts
import { stat } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import type { StructuredToolInterface } from '@langchain/core/tools';
import { SkillNotFoundError, SkillParseError } from '../shared/index.js';
import type { SkillManifest } from './types.js';

function isImportedSkillTool(value: unknown): value is StructuredToolInterface {
  return (
    typeof value === 'object' &&
    value !== null &&
    'name' in value &&
    typeof value.name === 'string' &&
    value.name.length > 0 &&
    'description' in value &&
    typeof value.description === 'string' &&
    'invoke' in value &&
    typeof value.invoke === 'function' &&
    'schema' in value &&
    value.schema !== null &&
    (typeof value.schema === 'object' || typeof value.schema === 'function')
  );
}

async function importSkillTools(
  manifest: SkillManifest,
  entry: string,
): Promise<StructuredToolInterface[]> {
  let module: unknown;
  try {
    const stats = await stat(entry);
    if (!stats.isFile()) {
      throw new SkillParseError(`skill "${manifest.name}" 的 entry 不是普通文件: ${entry}`);
    }
    module = await import(pathToFileURL(entry).href);
  } catch (error) {
    if (error instanceof SkillParseError) throw error;
    throw new SkillParseError(`skill "${manifest.name}" 的工具模块加载失败: ${entry}`, {
      cause: error,
    });
  }

  if (
    typeof module !== 'object' ||
    module === null ||
    !('tools' in module) ||
    !Array.isArray(module.tools)
  ) {
    throw new SkillParseError(
      `skill "${manifest.name}" 的 tool.ts 必须命名导出数组 tools: ${entry}`,
    );
  }

  const tools: StructuredToolInterface[] = [];
  for (const [index, item] of module.tools.entries()) {
    if (!isImportedSkillTool(item)) {
      throw new SkillParseError(
        `skill "${manifest.name}" 的 tools[${index}] 缺少可用的 name/description/invoke/schema: ${entry}`,
      );
    }
    tools.push(item);
  }
  return tools;
}

// 用 Proxy 改名而非 invoke 重包装：双层包装会把 content_and_artifact 的 tuple 拍平，行为失真。
function renameTool(original: StructuredToolInterface, name: string): StructuredToolInterface {
  return new Proxy(original, {
    get(target, property, receiver) {
      if (property === 'name') return name;
      return Reflect.get(target, property, receiver);
    },
    set(target, property, value, receiver) {
      if (property === 'name') {
        throw new Error(
          `禁止改写 skill 工具的 name（"${name}"）：会写穿并污染模块缓存中的原工具，如需改名请另包一层`,
        );
      }
      return Reflect.set(target, property, value, receiver);
    },
    getOwnPropertyDescriptor(target, property) {
      const descriptor = Reflect.getOwnPropertyDescriptor(target, property);
      if (property === 'name' && descriptor) return { ...descriptor, value: name };
      return descriptor;
    },
  });
}

export class SkillRegistry {
  private readonly byName = new Map<string, SkillManifest>();

  constructor(manifests: SkillManifest[]) {
    for (const manifest of manifests) {
      const existing = this.byName.get(manifest.name);
      if (existing) {
        throw new SkillParseError(
          `skill 重名: "${manifest.name}"，冲突目录: ${existing.dir} 与 ${manifest.dir}`,
        );
      }
      this.byName.set(manifest.name, manifest);
    }
  }

  list(): SkillManifest[] {
    return [...this.byName.values()];
  }

  get(name: string): SkillManifest {
    const manifest = this.byName.get(name);
    if (!manifest) throw new SkillNotFoundError(name);
    return manifest;
  }

  promptSection(): string {
    const manifests = this.list();
    if (manifests.length === 0) return '';
    const lines = manifests.map((manifest) => `- ${manifest.name}: ${manifest.description}`);
    return ['可用 skill（需要细节时用 load_skill 读取完整说明）:', ...lines].join('\n');
  }

  async loadTools(): Promise<StructuredToolInterface[]> {
    const loaded: StructuredToolInterface[] = [];

    for (const manifest of this.list()) {
      if (!manifest.entry) continue;

      const originals = await importSkillTools(manifest, manifest.entry);
      for (const original of originals) {
        loaded.push(renameTool(original, `${manifest.name}_${original.name}`));
      }
    }

    return loaded;
  }
}
```

- [x] **Step 4: 实现 `src/skills/load-tool.ts`**（最终落地版本）

```ts
import { tool } from 'langchain';
import { z } from 'zod';
import type { StructuredToolInterface } from '@langchain/core/tools';
import type { SkillRegistry } from './registry.js';

export function createLoadSkillTool(registry: SkillRegistry): StructuredToolInterface {
  return tool(async ({ name }) => registry.get(name).body, {
    name: 'load_skill',
    description: '按名称读取某个 skill 的完整说明正文。仅在需要该 skill 的具体用法时调用。',
    schema: z.object({ name: z.string().min(1) }),
  });
}
```

- [x] **Step 5: 实现 `src/skills/index.ts`**

```ts
export * from './types.js';
export * from './loader.js';
export * from './registry.js';
export * from './load-tool.js';
```

- [x] **Step 6: 运行测试确认通过**

```bash
export PATH="/Users/jianglu/.nvm/versions/node/v24.19.0/bin:$PATH" && pnpm vitest run tests/skills.registry.test.ts
```

预期：PASS，**21 个用例**（简报 4 + R1–R8 要求的 14 + 修复轮 3）。全量套件 **8 文件 / 105 测试**，`pnpm typecheck` 与 `pnpm build` 均 exit 0。

简报原有的「若 `original.schema as never` 引发行类型错误，改用 `DynamicStructuredTool` 包装」备注**已作废**：R1 禁止该类断言，且实测重包装（含 `DynamicStructuredTool`）会破坏 `content_and_artifact` 语义，最终走 Proxy 改名。

- [x] **Step 7: 提交**

```bash
git add src/skills tests/skills.registry.test.ts
git commit -m "feat: add skill registry with progressive disclosure and load_skill tool"
```

修复轮 1 另起一次提交（不 amend）：

```bash
git add src/skills/registry.ts tests/skills.registry.test.ts
git commit -m "fix: validate skill tool description and keep renamed tool proxy isolated"
```

---

## Task 9: MCP 接入

**Files:**
- Create: `src/mcp/config.ts`, `src/mcp/hub.ts`, `src/mcp/index.ts`
- Test: `tests/mcp.hub.test.ts`

- [ ] **Step 1: 写失败的测试 `tests/mcp.hub.test.ts`**

```ts
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { McpHub } from '../src/mcp/index.js';

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'mcp-'));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('McpHub', () => {
  it('配置文件不存在时返回空工具集', async () => {
    const hub = await McpHub.fromConfig(join(dir, 'missing.json'));
    expect(await hub.tools()).toEqual([]);
    await hub.close();
  });

  it('servers 为空时返回空工具集', async () => {
    const file = join(dir, 'mcp.json');
    await writeFile(file, JSON.stringify({ servers: {} }));
    const hub = await McpHub.fromConfig(file);
    expect(await hub.tools()).toEqual([]);
    await hub.close();
  });

  it('单个 server 连接失败不影响整体', async () => {
    const file = join(dir, 'mcp.json');
    await writeFile(
      file,
      JSON.stringify({
        servers: {
          broken: {
            transport: 'stdio',
            command: 'definitely-not-a-real-binary',
            args: [],
            stderr: 'ignore',
          },
        },
      }),
    );

    const hub = await McpHub.fromConfig(file);
    expect(await hub.tools()).toEqual([]);
    await hub.close();
  });
});
```

第三个用例验证 `onConnectionError: 'ignore'` 生效——否则这里会抛错。

- [ ] **Step 2: 运行测试确认失败**

```bash
export PATH="/Users/jianglu/.nvm/versions/node/v24.19.0/bin:$PATH" && pnpm vitest run tests/mcp.hub.test.ts
```

预期：FAIL，`Failed to resolve import "../src/mcp/index.js"`。

- [ ] **Step 3: 实现 `src/mcp/config.ts`**

```ts
import { readFile } from 'node:fs/promises';
import type { MCPAdapterConfig } from '@langchain/mcp-adapters';

export type McpServers = MCPAdapterConfig['servers'];

export async function loadMcpServers(file: string): Promise<McpServers> {
  let raw: string;
  try {
    raw = await readFile(file, 'utf8');
  } catch {
    return {};
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return {};
  }

  if (typeof parsed !== 'object' || parsed === null) return {};
  const servers = (parsed as { servers?: unknown }).servers;
  if (typeof servers !== 'object' || servers === null) return {};

  return servers as McpServers;
}
```

- [ ] **Step 4: 实现 `src/mcp/hub.ts`**

```ts
import { MCPAdapter } from '@langchain/mcp-adapters';
import type { DynamicStructuredTool } from '@langchain/core/tools';
import { loadMcpServers } from './config.js';

export class McpHub {
  private constructor(private readonly adapter: MCPAdapter | null) {}

  static async fromConfig(file: string): Promise<McpHub> {
    const servers = await loadMcpServers(file);

    if (Object.keys(servers).length === 0) {
      return new McpHub(null);
    }

    return new McpHub(
      new MCPAdapter({
        servers,
        onConnectionError: 'ignore',
      }),
    );
  }

  async tools(): Promise<DynamicStructuredTool[]> {
    if (!this.adapter) return [];
    try {
      return await this.adapter.listTools();
    } catch (error) {
      console.warn(`[mcp] 加载工具失败: ${(error as Error).message}`);
      return [];
    }
  }

  async close(): Promise<void> {
    await this.adapter?.close();
  }
}
```

- [ ] **Step 5: 实现 `src/mcp/index.ts`**

```ts
export * from './config.js';
export * from './hub.js';
```

- [ ] **Step 6: 运行测试确认通过**

```bash
export PATH="/Users/jianglu/.nvm/versions/node/v24.19.0/bin:$PATH" && pnpm vitest run tests/mcp.hub.test.ts
```

预期：PASS，3 个用例。第三个用例耗时较长（等连接失败），属正常。

- [ ] **Step 7: 提交**

```bash
git add src/mcp tests/mcp.hub.test.ts
git commit -m "feat: add MCP hub backed by official adapters"
```

---

## Task 10: A2A 消息与卡片构造

**Files:**
- Create: `src/a2a/messages.ts`, `src/a2a/card.ts`
- Test: `tests/a2a.messages.test.ts`

- [ ] **Step 1: 写失败的测试 `tests/a2a.messages.test.ts`**

```ts
import { Role } from '@a2a-js/sdk';
import { describe, expect, it } from 'vitest';
import {
  buildAgentCard,
  buildTextMessage,
  extractResultText,
  extractText,
} from '../src/a2a/index.js';

describe('buildTextMessage', () => {
  it('构造出可提取文本的 message', () => {
    const message = buildTextMessage({ text: '你好', contextId: 'c1', taskId: 't1' });
    expect(message.role).toBe(Role.ROLE_AGENT);
    expect(message.contextId).toBe('c1');
    expect(message.taskId).toBe('t1');
    expect(extractText(message)).toBe('你好');
  });
});

describe('extractText', () => {
  it('没有文本 part 时返回空串', () => {
    const message = buildTextMessage({ text: '' });
    expect(extractText(message)).toBe('');
  });
});

describe('extractResultText', () => {
  it('从 Message 结果取文本', () => {
    const message = buildTextMessage({ text: 'answer' });
    expect(extractResultText(message)).toBe('answer');
  });
});

describe('buildAgentCard', () => {
  it('产出包含全部必填字段的卡片', () => {
    const card = buildAgentCard({
      name: 'demo-agent',
      description: '描述',
      publicUrl: 'http://localhost:4124',
      skills: [{ id: 's1', name: '技能一', description: '技能一的描述' }],
    });

    expect(card.name).toBe('demo-agent');
    expect(card.description).toBe('描述');
    expect(card.supportedInterfaces[0]?.url).toBe('http://localhost:4124');
    expect(card.supportedInterfaces[0]?.protocolBinding).toBe('JSONRPC');
    expect(card.skills[0]?.id).toBe('s1');
    expect(card.defaultInputModes).toContain('text/plain');
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

```bash
export PATH="/Users/jianglu/.nvm/versions/node/v24.19.0/bin:$PATH" && pnpm vitest run tests/a2a.messages.test.ts
```

预期：FAIL，`Failed to resolve import "../src/a2a/index.js"`。

- [ ] **Step 3: 实现 `src/a2a/messages.ts`**

```ts
import { randomUUID } from 'node:crypto';
import { Role, type Message, type SendMessageResult, type Task } from '@a2a-js/sdk';

export function buildTextMessage(params: {
  text: string;
  contextId?: string;
  taskId?: string;
  role?: Role;
}): Message {
  return {
    messageId: randomUUID(),
    contextId: params.contextId ?? '',
    taskId: params.taskId ?? '',
    role: params.role ?? Role.ROLE_AGENT,
    parts: [{ content: { $case: 'text', value: params.text } }],
    metadata: undefined,
    extensions: [],
    referenceTaskIds: [],
  };
}

export function extractText(message: Message): string {
  return message.parts
    .map((part) => (part.content?.$case === 'text' ? part.content.value : ''))
    .join('');
}

function isMessage(result: SendMessageResult): result is Message {
  return 'messageId' in result;
}

export function extractResultText(result: SendMessageResult): string {
  if (isMessage(result)) return extractText(result);

  const task = result as Task;
  const statusText = task.status.message ? extractText(task.status.message) : '';
  if (statusText) return statusText;

  return task.artifacts
    .map((artifact) =>
      artifact.parts
        .map((part) => (part.content?.$case === 'text' ? part.content.value : ''))
        .join(''),
    )
    .join('\n')
    .trim();
}
```

- [ ] **Step 4: 实现 `src/a2a/card.ts`**

```ts
import type { AgentCard } from '@a2a-js/sdk';

export interface CardSkillInput {
  id: string;
  name: string;
  description: string;
}

export interface CardInput {
  name: string;
  description: string;
  publicUrl: string;
  skills: CardSkillInput[];
}

export function buildAgentCard(input: CardInput): AgentCard {
  return {
    name: input.name,
    description: input.description,
    version: '0.1.0',
    provider: {
      url: 'https://github.com/',
      organization: 'muliuniuma',
    },
    supportedInterfaces: [
      {
        url: input.publicUrl,
        protocolBinding: 'JSONRPC',
        tenant: '',
        protocolVersion: '1.0',
      },
    ],
    capabilities: {
      streaming: false,
      pushNotifications: false,
      extensions: [],
      extendedAgentCard: false,
    },
    securitySchemes: {},
    securityRequirements: [],
    defaultInputModes: ['text/plain'],
    defaultOutputModes: ['text/plain'],
    skills: input.skills.map((skill) => ({
      id: skill.id,
      name: skill.name,
      description: skill.description,
      tags: [],
      examples: [],
      inputModes: ['text/plain'],
      outputModes: ['text/plain'],
      securityRequirements: [],
    })),
  };
}
```

- [ ] **Step 5: 实现 `src/a2a/index.ts`（本任务先只导出这两个模块，Task 11 再补）**

```ts
export * from './messages.js';
export * from './card.js';
```

- [ ] **Step 6: 运行测试确认通过**

```bash
export PATH="/Users/jianglu/.nvm/versions/node/v24.19.0/bin:$PATH" && pnpm vitest run tests/a2a.messages.test.ts
```

预期：PASS，4 个用例。

- [ ] **Step 7: 提交**

```bash
git add src/a2a tests/a2a.messages.test.ts
git commit -m "feat: add A2A message and agent card builders"
```

---

## Task 11: A2A client 与远程 agent 工具

**Files:**
- Create: `src/a2a/client.ts`, `src/a2a/remote-tool.ts`
- Modify: `src/a2a/index.ts`
- Test: `tests/a2a.client.test.ts`

- [ ] **Step 1: 写失败的测试 `tests/a2a.client.test.ts`**

```ts
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { A2AClientHub, createRemoteAgentTools } from '../src/a2a/index.js';

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'a2a-peer-'));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('A2AClientHub', () => {
  it('peers 为空时没有远程工具', async () => {
    const file = join(dir, 'peers.json');
    await writeFile(file, JSON.stringify({ peers: [] }));
    const hub = await A2AClientHub.fromConfig(file);
    expect(hub.list()).toEqual([]);
    expect(createRemoteAgentTools(hub)).toEqual([]);
  });

  it('配置文件不存在时返回空 hub', async () => {
    const hub = await A2AClientHub.fromConfig(join(dir, 'missing.json'));
    expect(hub.list()).toEqual([]);
  });

  it('peer 不可达时被跳过而不是抛错', async () => {
    const file = join(dir, 'peers.json');
    await writeFile(
      file,
      JSON.stringify({
        peers: [{ name: 'ghost', url: 'http://127.0.0.1:1/' }],
      }),
    );
    const hub = await A2AClientHub.fromConfig(file);
    expect(hub.list()).toEqual([]);
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

```bash
export PATH="/Users/jianglu/.nvm/versions/node/v24.19.0/bin:$PATH" && pnpm vitest run tests/a2a.client.test.ts
```

预期：FAIL，`Failed to resolve import "../src/a2a/index.js"`。

- [ ] **Step 3: 实现 `src/a2a/client.ts`**

```ts
import { readFile } from 'node:fs/promises';
import { ClientFactory, type Client } from '@a2a-js/sdk/client';
import { Role } from '@a2a-js/sdk';
import { buildTextMessage, extractResultText } from './messages.js';

export interface PeerSpec {
  name: string;
  url: string;
  description?: string;
}

export interface Peer {
  spec: PeerSpec;
  client: Client;
  description: string;
}

export class A2AClientHub {
  private constructor(private readonly peers: Peer[]) {}

  static async fromConfig(file: string): Promise<A2AClientHub> {
    let specs: PeerSpec[] = [];

    try {
      const raw = await readFile(file, 'utf8');
      const parsed = JSON.parse(raw) as { peers?: PeerSpec[] };
      specs = Array.isArray(parsed.peers) ? parsed.peers : [];
    } catch {
      specs = [];
    }

    const factory = new ClientFactory();
    const peers: Peer[] = [];

    for (const spec of specs) {
      try {
        const client = await factory.createFromUrl(spec.url);
        peers.push({
          spec,
          client,
          description: spec.description ?? `调用远程 agent ${spec.name}`,
        });
      } catch (error) {
        console.warn(
          `[a2a] 跳过不可达的 peer "${spec.name}": ${(error as Error).message}`,
        );
      }
    }

    return new A2AClientHub(peers);
  }

  list(): Peer[] {
    return [...this.peers];
  }

  async ask(name: string, text: string): Promise<string> {
    const peer = this.peers.find((candidate) => candidate.spec.name === name);
    if (!peer) {
      throw new Error(`未知的 A2A peer: ${name}`);
    }

    const result = await peer.client.sendMessage({
      tenant: '',
      message: buildTextMessage({ text, role: Role.ROLE_USER }),
      configuration: undefined,
      metadata: undefined,
    });

    return extractResultText(result);
  }
}
```

- [ ] **Step 4: 实现 `src/a2a/remote-tool.ts`**

```ts
import { tool } from 'langchain';
import { z } from 'zod';
import type { A2AClientHub } from './client.js';

function sanitizeToolName(name: string): string {
  return name.replace(/[^a-zA-Z0-9_-]/g, '_');
}

export function createRemoteAgentTools(hub: A2AClientHub) {
  return hub.list().map((peer) =>
    tool(async ({ message }) => await hub.ask(peer.spec.name, message), {
      name: `ask_${sanitizeToolName(peer.spec.name)}`,
      description: peer.description,
      schema: z.object({ message: z.string().min(1) }),
    }),
  );
}
```

- [ ] **Step 5: 修改 `src/a2a/index.ts`**

```ts
export * from './messages.js';
export * from './card.js';
export * from './client.js';
export * from './remote-tool.js';
```

- [ ] **Step 6: 运行测试确认通过**

```bash
export PATH="/Users/jianglu/.nvm/versions/node/v24.19.0/bin:$PATH" && pnpm vitest run tests/a2a.client.test.ts
```

预期：PASS，3 个用例。第三个用例会等连接失败，耗时稍长。

- [ ] **Step 7: 提交**

```bash
git add src/a2a tests/a2a.client.test.ts
git commit -m "feat: add A2A client hub and remote agent tools"
```

---

## Task 12: 工具合并与 Agent 运行时

**Files:**
- Create: `src/agent/tools.ts`, `src/agent/runtime.ts`, `src/agent/index.ts`
- Test: `tests/agent.runtime.test.ts`

- [ ] **Step 1: 写失败的测试 `tests/agent.runtime.test.ts`**

```ts
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FakeListChatModel } from '@langchain/core/utils/testing';
import { tool } from 'langchain';
import { z } from 'zod';
import { loadConfig } from '../src/config/index.js';
import { AgentRuntime, mergeToolGroups } from '../src/agent/index.js';

function makeTool(name: string) {
  return tool(async () => name, {
    name,
    description: name,
    schema: z.object({}),
  });
}

describe('mergeToolGroups', () => {
  it('同名工具按来源优先级保留并给后者加后缀', () => {
    const merged = mergeToolGroups([
      { source: 'mcp', tools: [makeTool('dup')] },
      { source: 'builtin', tools: [makeTool('dup')] },
    ]);

    expect(merged).toHaveLength(2);
    expect(merged.map((t) => t.name)).toEqual(['dup', 'dup_1']);
  });

  it('不同名工具保持原样', () => {
    const merged = mergeToolGroups([
      { source: 'builtin', tools: [makeTool('a')] },
      { source: 'skill', tools: [makeTool('b')] },
    ]);
    expect(merged.map((t) => t.name)).toEqual(['a', 'b']);
  });
});

describe('AgentRuntime', () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'runtime-'));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('用注入的 fake model 跑通一轮并返回文本', async () => {
    const config = loadConfig({
      LLM_PROVIDER: 'openai-compatible',
      LLM_MODEL: 'gpt-4o-mini',
      LLM_BASE_URL: 'https://example.com/v1',
      LLM_API_KEY: 'sk-test',
      SKILLS_DIR: join(root, 'skills'),
      CHECKPOINT_DB: join(root, 'data', 'checkpoints.sqlite'),
      MCP_CONFIG: join(root, 'mcp.json'),
      A2A_PEERS: join(root, 'peers.json'),
      SANDBOX_ROOT: join(root, 'sandbox'),
    });

    const runtime = await AgentRuntime.create(config, {
      model: new FakeListChatModel({ responses: ['模型回答'] }),
    });

    const result = await runtime.run('你好', { threadId: 't1' });
    expect(result.text).toContain('模型回答');

    await runtime.dispose();
  });

  it('同一 threadId 的第二次调用能看到历史消息', async () => {
    const config = loadConfig({
      LLM_PROVIDER: 'openai-compatible',
      LLM_MODEL: 'gpt-4o-mini',
      LLM_BASE_URL: 'https://example.com/v1',
      LLM_API_KEY: 'sk-test',
      SKILLS_DIR: join(root, 'skills'),
      CHECKPOINT_DB: join(root, 'data', 'checkpoints.sqlite'),
      MCP_CONFIG: join(root, 'mcp.json'),
      A2A_PEERS: join(root, 'peers.json'),
      SANDBOX_ROOT: join(root, 'sandbox'),
    });

    const runtime = await AgentRuntime.create(config, {
      model: new FakeListChatModel({ responses: ['第一轮', '第二轮'] }),
    });

    await runtime.run('第一问', { threadId: 'same' });
    const second = await runtime.run('第二问', { threadId: 'same' });

    expect(second.messages.length).toBeGreaterThan(2);
    expect(second.text).toContain('第二轮');

    await runtime.dispose();
  });
});
```

第二个用例验证 SQLite checkpointer 真的生效：第二次调用返回的消息里应包含第一轮的历史。

- [ ] **Step 2: 运行测试确认失败**

```bash
export PATH="/Users/jianglu/.nvm/versions/node/v24.19.0/bin:$PATH" && pnpm vitest run tests/agent.runtime.test.ts
```

预期：FAIL，`Failed to resolve import "../src/agent/index.js"`。

- [ ] **Step 3: 实现 `src/agent/tools.ts`**

```ts
import { DynamicStructuredTool, type StructuredTool } from '@langchain/core/tools';

export type ToolSource = 'builtin' | 'skill' | 'mcp' | 'a2a';

export interface ToolGroup {
  source: ToolSource;
  tools: StructuredTool[];
}

const PRIORITY: Record<ToolSource, number> = {
  builtin: 0,
  skill: 1,
  mcp: 2,
  a2a: 3,
};

function renameTool(original: StructuredTool, name: string): StructuredTool {
  return new DynamicStructuredTool({
    name,
    description: original.description ?? name,
    schema: original.schema as never,
    func: async (input) => await original.invoke(input as never),
  });
}

export function mergeToolGroups(groups: ToolGroup[]): StructuredTool[] {
  const ordered = [...groups].sort(
    (a, b) => PRIORITY[a.source] - PRIORITY[b.source],
  );

  const used = new Set<string>();
  const merged: StructuredTool[] = [];

  for (const group of ordered) {
    for (const tool of group.tools) {
      if (!used.has(tool.name)) {
        used.add(tool.name);
        merged.push(tool);
        continue;
      }

      let suffix = 1;
      while (used.has(`${tool.name}_${suffix}`)) suffix += 1;
      const name = `${tool.name}_${suffix}`;
      used.add(name);
      console.warn(`[tools] 工具名冲突，已重命名为 ${name}`);
      merged.push(renameTool(tool, name));
    }
  }

  return merged;
}
```

- [ ] **Step 4: 实现 `src/agent/runtime.ts`**

```ts
import { mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import { createAgent } from 'langchain';
import type { BaseChatModel } from '@langchain/core/language_models/chat_models';
import { AIMessage, type BaseMessage } from '@langchain/core/messages';
import { SqliteSaver } from '@langchain/langgraph-checkpoint-sqlite';
import type { AppConfig } from '../config/index.js';
import { createChatModel } from '../llm/index.js';
import { createSandbox, type Sandbox } from '../sandbox/index.js';
import { createSandboxTools } from '../tools/index.js';
import {
  SkillRegistry,
  createLoadSkillTool,
  loadSkills,
} from '../skills/index.js';
import { McpHub } from '../mcp/index.js';
import { A2AClientHub, createRemoteAgentTools } from '../a2a/index.js';
import { mergeToolGroups } from './tools.js';

export interface AgentRuntimeDeps {
  model?: BaseChatModel;
}

export interface RunResult {
  text: string;
  messages: BaseMessage[];
}

export function extractFinalText(messages: BaseMessage[]): string {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message instanceof AIMessage) {
      const text = message.text;
      if (text) return text;
    }
  }
  return '';
}

export class AgentRuntime {
  private constructor(
    private readonly agent: ReturnType<typeof createAgent>,
    private readonly sandbox: Sandbox,
    private readonly skillRegistry: SkillRegistry,
    private readonly mcpHub: McpHub,
    private readonly a2aHub: A2AClientHub,
    private readonly checkpointer: SqliteSaver,
  ) {}

  static async create(
    config: AppConfig,
    deps: AgentRuntimeDeps = {},
  ): Promise<AgentRuntime> {
    const model = deps.model ?? (await createChatModel(config.model));

    const sandbox = await createSandbox('local', {
      id: 'default',
      root: config.sandbox.root,
      timeoutMs: config.sandbox.timeoutMs,
      maxOutputBytes: config.sandbox.maxOutputBytes,
    });

    const skillRegistry = new SkillRegistry(await loadSkills(config.skillsDir));
    const mcpHub = await McpHub.fromConfig(config.mcpConfigPath);
    const a2aHub = await A2AClientHub.fromConfig(config.a2aPeersPath);

    const tools = mergeToolGroups([
      {
        source: 'builtin',
        tools: [...createSandboxTools(sandbox), createLoadSkillTool(skillRegistry)],
      },
      { source: 'skill', tools: await skillRegistry.loadTools() },
      { source: 'mcp', tools: await mcpHub.tools() },
      { source: 'a2a', tools: createRemoteAgentTools(a2aHub) },
    ]);

    await mkdir(dirname(config.checkpointDb), { recursive: true });
    const checkpointer = SqliteSaver.fromConnString(config.checkpointDb);

    const systemPrompt = [
      '你是一个可扩展 Agent 运行时的执行体。',
      skillRegistry.promptSection(),
    ]
      .filter((section) => section.length > 0)
      .join('\n\n');

    const agent = createAgent({
      model,
      tools,
      systemPrompt,
      checkpointer,
    });

    return new AgentRuntime(
      agent,
      sandbox,
      skillRegistry,
      mcpHub,
      a2aHub,
      checkpointer,
    );
  }

  async run(input: string, options: { threadId: string }): Promise<RunResult> {
    const result = await this.agent.invoke(
      { messages: [{ role: 'human', content: input }] },
      { configurable: { thread_id: options.threadId } },
    );

    const messages = result.messages as BaseMessage[];
    return { text: extractFinalText(messages), messages };
  }

  listSkills() {
    return this.skillRegistry.list();
  }

  async dispose(): Promise<void> {
    await this.mcpHub.close();
    await this.sandbox.dispose();
    this.checkpointer.db.close();
  }
}
```

- [ ] **Step 5: 实现 `src/agent/index.ts`**

```ts
export * from './tools.js';
export * from './runtime.js';
```

- [ ] **Step 6: 运行测试确认通过**

```bash
export PATH="/Users/jianglu/.nvm/versions/node/v24.19.0/bin:$PATH" && pnpm vitest run tests/agent.runtime.test.ts
```

预期：PASS，4 个用例。

若 `createAgent` 不接受 `systemPrompt` 或 `checkpointer` 字段（类型报错），查 `langchain/dist/agents/types.d.ts:403` 的 `CreateAgentParams` 实际字段名后修正；`checkpointer` 字段已核实存在。

- [ ] **Step 7: 类型检查并提交**

```bash
export PATH="/Users/jianglu/.nvm/versions/node/v24.19.0/bin:$PATH" && pnpm typecheck && git add src/agent tests/agent.runtime.test.ts && git commit -m "feat: add agent runtime with sqlite checkpointing"
```

---

## Task 13: A2A executor 与 HTTP server

**Files:**
- Create: `src/a2a/executor.ts`, `src/a2a/server.ts`
- Modify: `src/a2a/index.ts`
- Test: `tests/a2a.server.test.ts`

- [ ] **Step 1: 写失败的测试 `tests/a2a.server.test.ts`**

```ts
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { describe, expect, it } from 'vitest';
import { ClientFactory } from '@a2a-js/sdk/client';
import { Role } from '@a2a-js/sdk';
import {
  buildAgentCard,
  buildTextMessage,
  createA2AServer,
  extractResultText,
} from '../src/a2a/index.js';

async function reservePort(): Promise<number> {
  const probe = createServer();
  await new Promise<void>((resolve) => probe.listen(0, '127.0.0.1', resolve));
  const port = (probe.address() as AddressInfo).port;
  await new Promise<void>((resolve) => probe.close(() => resolve()));
  return port;
}

describe('A2A HTTP server', () => {
  it('对外提供 agent card 并能处理 message/send', async () => {
    const port = await reservePort();
    const baseUrl = `http://127.0.0.1:${port}`;

    const app = createA2AServer({
      cardProvider: () =>
        buildAgentCard({
          name: 'test-agent',
          description: '测试用 agent',
          publicUrl: baseUrl,
          skills: [],
        }),
      runner: {
        run: async (input: string) => ({ text: `echo: ${input}` }),
      },
    });

    const server = await new Promise<Server>((resolve) => {
      const listening = app.listen(port, '127.0.0.1', () => resolve(listening));
    });

    const cardResponse = await fetch(`${baseUrl}/.well-known/agent-card.json`);
    expect(cardResponse.status).toBe(200);
    const card = (await cardResponse.json()) as { name: string };
    expect(card.name).toBe('test-agent');

    const client = await new ClientFactory().createFromUrl(baseUrl);
    const result = await client.sendMessage({
      tenant: '',
      message: buildTextMessage({ text: '你好', role: Role.ROLE_USER }),
      configuration: undefined,
      metadata: undefined,
    });

    expect(extractResultText(result)).toContain('echo: 你好');

    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
});
```

这个用例用 SDK 自己的 `Client` 打自己的 server，真实覆盖「卡片可达 + JSON-RPC 往返 + executor 被调用」三件事，且不用手写 JSON-RPC 报文格式。

端口必须先于卡片确定：`ClientFactory` 会按卡片里 `supportedInterfaces[0].url` 建连，若卡片写的是 `:0` 或别的端口就会连错地方。因此测试先 `reservePort()` 拿一个空闲端口，再用它构造卡片。

- [ ] **Step 2: 运行测试确认失败**

```bash
export PATH="/Users/jianglu/.nvm/versions/node/v24.19.0/bin:$PATH" && pnpm vitest run tests/a2a.server.test.ts
```

预期：FAIL，`createA2AServer` 未导出。

- [ ] **Step 3: 实现 `src/a2a/executor.ts`**

```ts
import {
  AgentEvent,
  type AgentExecutor,
  type ExecutionEventBus,
  type RequestContext,
} from '@a2a-js/sdk/server';
import { buildTextMessage, extractText } from './messages.js';

export interface AgentRunner {
  run(input: string, options: { threadId: string }): Promise<{ text: string }>;
}

export class LangGraphAgentExecutor implements AgentExecutor {
  constructor(private readonly runner: AgentRunner) {}

  async execute(
    requestContext: RequestContext,
    eventBus: ExecutionEventBus,
  ): Promise<void> {
    const input = extractText(requestContext.userMessage);
    const result = await this.runner.run(input, {
      threadId: requestContext.contextId,
    });

    eventBus.publish(
      AgentEvent.message(
        buildTextMessage({
          text: result.text,
          contextId: requestContext.contextId,
          taskId: requestContext.taskId,
        }),
      ),
    );
  }

  async cancelTask(taskId: string, eventBus: ExecutionEventBus): Promise<void> {
    eventBus.publish(
      AgentEvent.message(
        buildTextMessage({ text: `任务 ${taskId} 已取消`, taskId }),
      ),
    );
  }
}
```

- [ ] **Step 4: 实现 `src/a2a/server.ts`**

```ts
import express, { type Express } from 'express';
import { AGENT_CARD_PATH, type AgentCard } from '@a2a-js/sdk';
import { DefaultRequestHandler, InMemoryTaskStore } from '@a2a-js/sdk/server';
import {
  agentCardHandler,
  jsonRpcHandler,
  UserBuilder,
} from '@a2a-js/sdk/server/express';
import { LangGraphAgentExecutor, type AgentRunner } from './executor.js';

export interface A2AServerOptions {
  cardProvider: () => AgentCard;
  runner: AgentRunner;
}

export function createA2AServer(options: A2AServerOptions): Express {
  const app = express();
  app.use(express.json());

  const card = options.cardProvider();

  const requestHandler = new DefaultRequestHandler(
    card,
    new InMemoryTaskStore(),
    new LangGraphAgentExecutor(options.runner),
  );

  app.use(
    `/${AGENT_CARD_PATH}`,
    agentCardHandler({
      agentCardProvider: { getAgentCard: async () => card },
    }),
  );

  app.use(
    jsonRpcHandler({
      requestHandler,
      userBuilder: UserBuilder.noAuthentication,
    }),
  );

  return app;
}
```

两点约束决定了上面的签名：

- `AGENT_CARD_PATH` 的值是 `.well-known/agent-card.json`，**没有前导斜杠**，所以 express 挂载路径要写成 `/${AGENT_CARD_PATH}`。
- `DefaultRequestHandler` 的构造期需要一张同步的 `AgentCard`，所以 `cardProvider` 是同步函数、构造时调用一次。调用方必须在调用 `createA2AServer` **之前**就知道对外端口（`serve.ts` 用配置里的 `A2A_PORT`，测试用 `reservePort()`），否则客户端会按卡片里的错误地址建连。

- [ ] **Step 5: 修改 `src/a2a/index.ts`**

```ts
export * from './messages.js';
export * from './card.js';
export * from './client.js';
export * from './remote-tool.js';
export * from './executor.js';
export * from './server.js';
```

- [ ] **Step 6: 运行测试确认通过**

```bash
export PATH="/Users/jianglu/.nvm/versions/node/v24.19.0/bin:$PATH" && pnpm vitest run tests/a2a.server.test.ts
```

预期：PASS，1 个用例。

- [ ] **Step 7: 提交**

```bash
git add src/a2a tests/a2a.server.test.ts
git commit -m "feat: add A2A executor and express server"
```

---

## Task 14: 入口、示例 skill、README 与最终验收

**Files:**
- Create: `src/cli.ts`, `src/serve.ts`
- Create: `skills/hello-world/SKILL.md`, `skills/hello-world/tool.ts`
- Create: `README.md`
- Test: `tests/cli.test.ts`（冒烟）

- [ ] **Step 1: 写示例 skill `skills/hello-world/SKILL.md`**

```markdown
---
name: hello-world
description: 演示 skill：回显用户输入，并演示读取沙箱文件
allowed-tools: [hello_echo, sandbox_exec, sandbox_write_file]
---

当用户要求「演示」「打招呼」「回显」时，调用 hello_echo 工具回显其输入。

若用户想验证沙箱能力，先用 sandbox_write_file 写入一个文件，
再用 sandbox_exec 执行 `cat` 读取它，把结果如实转述给用户。
```

- [ ] **Step 2: 写示例 skill `skills/hello-world/tool.ts`**

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

注册表会给它改名成 `hello-world_echo`。

- [ ] **Step 3: 写 `src/cli.ts`**

```ts
import { createInterface } from 'node:readline/promises';
import { randomUUID } from 'node:crypto';
import { loadConfig, loadEnvFileIfPresent } from './config/index.js';
import { AgentRuntime } from './agent/index.js';
import { createLogger } from './shared/index.js';

async function main(): Promise<void> {
  loadEnvFileIfPresent();
  const config = loadConfig();
  const logger = createLogger(config.logLevel, 'cli');

  const runtime = await AgentRuntime.create(config);
  const threadId = randomUUID();
  logger.info(`会话已启动（thread=${threadId}），输入 /exit 退出。`);

  const rl = createInterface({ input: process.stdin, output: process.stdout });

  try {
    for (;;) {
      const line = (await rl.question('> ')).trim();
      if (line.length === 0) continue;
      if (line === '/exit' || line === '/quit') break;

      try {
        const result = await runtime.run(line, { threadId });
        console.log(result.text);
      } catch (error) {
        logger.error(`执行失败: ${(error as Error).message}`);
      }
    }
  } finally {
    rl.close();
    await runtime.dispose();
  }
}

main().catch((error: unknown) => {
  console.error(`启动失败: ${(error as Error).message}`);
  process.exit(1);
});
```

- [ ] **Step 4: 写 `src/serve.ts`**

```ts
import { loadConfig, loadEnvFileIfPresent } from './config/index.js';
import { AgentRuntime } from './agent/index.js';
import { buildAgentCard } from './a2a/index.js';
import { createA2AServer } from './a2a/index.js';
import { createLogger } from './shared/index.js';

async function main(): Promise<void> {
  loadEnvFileIfPresent();
  const config = loadConfig();
  const logger = createLogger(config.logLevel, 'serve');

  const runtime = await AgentRuntime.create(config);

  const app = createA2AServer({
    cardProvider: () =>
      buildAgentCard({
        name: config.a2a.agentName,
        description: config.a2a.description,
        publicUrl: config.a2a.publicUrl,
        skills: runtime.listSkills().map((manifest) => ({
          id: manifest.name,
          name: manifest.name,
          description: manifest.description,
        })),
      }),
    runner: {
      run: async (input: string, options: { threadId: string }) =>
        runtime.run(input, options),
    },
  });

  const server = app.listen(config.a2a.port, () => {
    logger.info(`A2A server 已启动: ${config.a2a.publicUrl}`);
  });

  const shutdown = async (): Promise<void> => {
    server.close();
    await runtime.dispose();
    process.exit(0);
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((error: unknown) => {
  console.error(`启动失败: ${(error as Error).message}`);
  process.exit(1);
});
```

- [ ] **Step 5: 写 `README.md`**

```markdown
# muliuniuma

可扩展的 TypeScript Agent 运行时骨架：LLM、MCP、Skill、沙箱、A2A。

## 环境要求

Node >= 22（推荐 24）。仓库带 `.nvmrc`，执行 `nvm use` 即可。

## 快速开始

```bash
pnpm install
cp .env.example .env   # 填入 LLM_API_KEY
pnpm dev               # 本地 REPL
pnpm serve             # A2A HTTP server，默认 http://localhost:4124
```

## 目录结构

```
src/
├─ agent/      运行时装配、工具合并
├─ a2a/        A2A 卡片、消息、executor、server、client
├─ config/     环境变量校验
├─ llm/        provider 注册表
├─ mcp/        MCP 连接与工具
├─ sandbox/    沙箱接口与本地实现
├─ skills/     Skill 加载与注册表
└─ tools/      内置工具
```

## 扩展方式

| 想做的事 | 改哪里 |
|---|---|
| 换 LLM 厂商 | 装 `@langchain/*` 包，在 `src/llm/factory.ts` 加一行 `registerProvider` |
| 换沙箱实现 | 实现 `Sandbox` 接口，在 `src/sandbox/factory.ts` 加 `registerSandbox` |
| 新增 Skill | 在 `skills/<name>/` 放 `SKILL.md`（可选 `tool.ts`），无需改代码 |
| 新增 MCP server | 编辑 `config/mcp.servers.json` |
| 对接远端 agent | 编辑 `config/a2a.peers.json`，自动获得 `ask_<name>` 工具 |

## 安全提示

`LocalProcessSandbox` 只是**本地进程隔离，不是安全边界**。它做了路径穿越校验、
超时中断、环境变量白名单（不继承 `process.env`）和输出截断，但同机用户仍可
通过其他途径影响进程。需要强隔离时，用 `registerSandbox` 换成容器或 VM 实现。

## 常用命令

```bash
pnpm typecheck
pnpm test
pnpm build
```
```

- [ ] **Step 6: 跑全量验证**

```bash
export PATH="/Users/jianglu/.nvm/versions/node/v24.19.0/bin:$PATH" && pnpm typecheck && pnpm test
```

预期：`typecheck` 退出码 0；`test` 全部 PASS，无失败用例。

- [ ] **Step 7: 手动冒烟 CLI（需要真实 API key）**

```bash
export PATH="/Users/jianglu/.nvm/versions/node/v24.19.0/bin:$PATH" && cp .env.example .env
# 编辑 .env 填入 LLM_API_KEY / LLM_BASE_URL / LLM_MODEL
printf '演示一下\n/exit\n' | pnpm dev
```

预期：进入 REPL，模型回答里出现 skill 的回显内容。

**没有 API key 时**跳过本步，但必须确认报错清晰：

```bash
export PATH="/Users/jianglu/.nvm/versions/node/v24.19.0/bin:$PATH" && LLM_API_KEY= pnpm dev
```

预期：输出「启动失败: 环境变量校验失败 → LLM_API_KEY: ...」并以退出码 1 结束。

- [ ] **Step 8: 手动冒烟 A2A server（不需要 API key 的部分）**

```bash
export PATH="/Users/jianglu/.nvm/versions/node/v24.19.0/bin:$PATH" && pnpm serve
```

另开一个终端：

```bash
curl -s http://localhost:4124/.well-known/agent-card.json | head -40
```

预期：返回含 `"name":"muliuniuma"` 的 JSON。

- [ ] **Step 9: 提交**

```bash
git add src/cli.ts src/serve.ts skills README.md
git commit -m "feat: add CLI and A2A server entrypoints with example skill"
```

---

## 附录 A: 任务依赖关系

```
Task 1  工具链
  └─► Task 2  shared ──► Task 3  config
                              └─► Task 4  llm
  Task 5  sandbox ──► Task 6  沙箱工具
  Task 7  skills loader ──► Task 8  skill registry
  Task 9  mcp
  Task 10 a2a messages/card ──► Task 11 a2a client
  Task 12 agent runtime（依赖 3/4/5/6/8/9/11）
  Task 13 a2a server（依赖 10/12）
  Task 14 入口与验收（依赖全部）
```

Task 2–13 之间无相互依赖，可并行分派给不同 subagent；Task 12 与 Task 13 必须串行。

## 附录 B: 验收清单（对应 spec §10）

| # | 验收项 | 验证位置 |
|---|---|---|
| 1 | Node 24 下依赖安装成功（含 better-sqlite3 编译） | 已完成，`pnpm install` 通过 |
| 2 | `pnpm typecheck` 与 `pnpm test` 全绿 | Task 14 Step 6 |
| 3 | REPL 中模型可调用 skill 工具与沙箱工具 | Task 14 Step 7 |
| 4 | 模型可通过 `load_skill` 取得 skill 正文 | Task 8 用例 + Task 14 Step 7 |
| 5 | A2A 卡片可访问且能完成一次问答 | Task 13 用例 + Task 14 Step 8 |
| 6 | MCP 配置为空时其余功能照常 | Task 9 用例 + Task 12 用例 |
| 7 | 同 thread_id 二次提问能看到历史 | Task 12 第二个用例 |

