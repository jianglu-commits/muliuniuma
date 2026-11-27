# 工具加载优化与工具输出清理 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 按工具规模三档选择加载方式（全量 / 目录+按需激活 / 检索+按需激活），并在模型视图层清理旧工具输出，两条轴共同优化 token 窗口。

**Architecture:** 三个新模块。`tool-catalog.ts` 是纯函数层（token 估算、选档、目录渲染、检索打分），不碰 SDK 中间件机制。`tool-loading.ts` 用 `createMiddleware` 提供持久化激活状态通道 + 两个元工具，在 `wrapModelCall` 里**只过滤**静态工具表。`context-clearing.ts` 复用 SDK 的 `ClearToolUsesEdit` 算法但自建外壳，以便浅拷贝历史并注入 CJK 感知计数器。装配期选档一次，运行期只按激活状态决定绑定哪些。

**Tech Stack:** TypeScript（ESM + NodeNext）、langchain 1.6.6（`createMiddleware` / `tool` / `ClearToolUsesEdit`）、@langchain/langgraph 1.7.5（`StateSchema` / `ReducedValue` / `Command`）、zod 4.6.7、vitest 5.1.0。

**Spec:** `docs/superpowers/specs/2026-11-27-tool-loading-optimization-design.md`

## Global Constraints

- 工作目录：`/Users/jianglu/Documents/Qoder/muliuniuma/.worktrees/feature-agent-runtime-scaffold`，分支 `feature/tool-loading-optimization`。**不要改主检出的源码。**
- **每条 shell 命令前置** `export PATH="$HOME/.nvm/versions/node/v24.19.0/bin:$PATH"`。shell 默认 node 是 v16.16.0，直接跑 `pnpm test` 会以 `styleText` 导入错误启动失败。
- 禁止 `pnpm install` / `add` / `remove`，禁止改 `package.json` 依赖。本计划不引入任何新依赖。
- 禁止 `git add .` / `git add -A`，只按明确路径暂存。禁止 `--no-verify` 及任何绕过 git hook 的手段。
- 禁止 `as never` / `as unknown as` / `as any`。需要收窄类型就写类型守卫（`'name' in value && typeof value.name === 'string'`，参照 `src/skills/registry.ts:7-22`）。
- 跨模块导入只走对方 `index.ts` barrel；同模块内用相对路径且**带 `.js` 后缀**（ESM + NodeNext）。
- `verbatimModuleSyntax`：类型导入必须单独写 `import type`。
- `noUncheckedIndexedAccess`：数组下标访问结果可能 `undefined`，必须处理。
- 错误用 `AppError` 子类 + `ErrorCode`（`src/shared/errors.ts`）；日志用 `createLogger`，告警文案格式 `logger.warn('<中文动作>，已 XXX', error)`。
- 注释默认不写。只在「为什么」不显然时写一行（隐藏约束、反直觉行为、SDK 坑）。不写解释「做什么」的注释。
- 每个文件末尾留一个换行。
- 布尔环境变量用 `z.enum(['true','false'])`，**不用 `z.coerce.boolean()`**（`Boolean('false') === true`）。
- 测试文案用中文，与现有用例风格一致。

## 已实测验证的前提（不要再推断，也不要绕开）

用一次性探针实跑确认，详见 spec §3.5：

1. **`ReducedValue` 的 `inputSchema` 必须自带 `.default()`**。`node_modules/langchain/dist/agents/nodes/utils.js:57` 的必填检查取 `field.inputSchema || field.valueSchema`；只在 `valueSchema` 上放 default 会被绕过，启动抛 `has required state fields that must be initialized`。
2. `wrapModelCall` 里过滤静态工具表**不会**触发 SDK 校验——前提是传**原实例**、只减不增。新增名字或同名换实例会抛错（`AgentNode.js:265`、`:267`）。
3. 激活状态跨 `invoke` 持久（同一 thread）。
4. FIFO 淘汰生效：上限 3、依次激活 t1,t2 → t3,t4，结果恰为 `t2,t3,t4`。
5. **激活扛住 `REMOVE_ALL_MESSAGES`**：清 `messages` 通道前后 `activatedTools` 不变。
6. 真实 `Command` 路径可写通道：模型发 tool_call → ToolNode → `Command.update` → 通道更新。
7. `request.state.activatedTools` 类型直接推断为 `string[]`，**不需要断言**（已用 tsc 严格模式验过）。
8. `StructuredToolInterface['schema']` 是 `InteropZodType | JsonSchema7Type`，正是 `toJsonSchema` 的入参类型，直接传即可。

## File Structure

**新建：**

| 文件 | 责任 |
|---|---|
| `src/agent/tool-catalog.ts` | 纯函数：`estimateToolTokens` / `selectTier` / `briefDescription` / `renderCatalog` / `tokenize` / `searchCatalog`，以及 `ToolTier` / `ToolLoadingPolicy` / `ToolMatch` 类型 |
| `src/agent/tool-loading.ts` | 加载中间件：激活状态通道、`activate_tools` / `search_tools` 元工具、`wrapModelCall` 过滤与提示注入 |
| `src/agent/context-clearing.ts` | 清理中间件：`ClearToolUsesEdit` + 浅拷贝 + CJK 计数 + schema token 计入 |
| `tests/agent.tool-catalog.test.ts` | 纯函数层用例 |
| `tests/agent.tool-loading.test.ts` | 加载中间件用例 |
| `tests/agent.tool-clearing.test.ts` | 清理中间件用例 |
| `readme-context-tool.md` | 实现过程记录（仓库根目录） |

**修改：**

| 文件 | 改动 |
|---|---|
| `src/agent/summary.ts` | 导出 `countTextTokens` 与 `isCjk`（当前私有） |
| `src/agent/index.ts` | barrel 补三个新模块 |
| `src/config/env.ts` | 10 个新环境变量 + `AppConfig.toolLoading` / `AppConfig.toolClearing` + 交叉约束校验 |
| `src/agent/runtime.ts` | 装配期选档、装中间件、顺序、档位日志 |
| `tests/config.env.test.ts` | 新变量默认值与非法值 |
| `tests/agent.runtime.test.ts` | 装配用例 |
| `README.md` | 特性表、配置表、压缩小节指路 |
| `.env.example` | 10 个新变量 |

---

### Task 1: token 估算与选档

**Files:**
- Modify: `src/agent/summary.ts:65-84`（把 `isCjk` 与 `countTextTokens` 改为导出）
- Create: `src/agent/tool-catalog.ts`
- Test: `tests/agent.tool-catalog.test.ts`

**Interfaces:**
- Consumes: `summary.ts` 的 `countTextTokens(text: string): number`、`isCjk(code: number): boolean`
- Produces:
  - `type ToolTier = 'eager' | 'catalog' | 'search'`
  - `interface ToolLoadingPolicy { enabled: boolean; eagerMaxTools: number; eagerMaxTokens: number; catalogMaxTools: number; catalogMaxTokens: number; searchTopK: number; maxActiveTools: number }`
  - `estimateToolTokens(tool: StructuredToolInterface): number`
  - `selectTier(count: number, tokens: number, policy: ToolLoadingPolicy): ToolTier`
  - `const ACTIVATE_TOOL_NAME = 'activate_tools'`、`const SEARCH_TOOL_NAME = 'search_tools'`（放这一层是为了让 `renderCatalog` 与加载中间件共用同一个常量，且不构成循环 import）
  - `isNamedTool(value: object): value is StructuredToolInterface`（Task 4 与 Task 6 共用，避免逐字重复定义）

- [ ] **Step 1: 写失败测试**

创建 `tests/agent.tool-catalog.test.ts`：

```ts
import { describe, expect, it } from 'vitest';
import { tool } from 'langchain';
import { z } from 'zod';
import type { StructuredToolInterface } from '@langchain/core/tools';
import { estimateToolTokens, isNamedTool, selectTier } from '../src/agent/tool-catalog.js';
import type { ToolLoadingPolicy } from '../src/agent/tool-catalog.js';

const POLICY: ToolLoadingPolicy = {
  enabled: true,
  eagerMaxTools: 12,
  eagerMaxTokens: 1500,
  catalogMaxTools: 40,
  catalogMaxTokens: 4000,
  searchTopK: 8,
  maxActiveTools: 24,
};

function makeTool(name: string, description: string, schema = z.object({})): StructuredToolInterface {
  return tool(async () => 'ok', { name, description, schema });
}

describe('estimateToolTokens', () => {
  it('中文描述按一字一 token 计', () => {
    const t = makeTool('t', '读取文件内容');
    expect(estimateToolTokens(t)).toBeGreaterThanOrEqual(6);
  });

  it('schema 也计入：字段更多的工具 token 更高', () => {
    const small = makeTool('t', 'd', z.object({ a: z.string() }));
    const large = makeTool('t', 'd', z.object({
      alpha: z.string().describe('第一个参数'),
      beta: z.number().describe('第二个参数'),
      gamma: z.boolean().describe('第三个参数'),
    }));
    expect(estimateToolTokens(large)).toBeGreaterThan(estimateToolTokens(small));
  });

  it('名字与描述都计入', () => {
    const short = makeTool('a', 'b');
    const long = makeTool('a_very_long_tool_name', 'b_very_long_description_text');
    expect(estimateToolTokens(long)).toBeGreaterThan(estimateToolTokens(short));
  });
});

describe('selectTier', () => {
  it('条数与 token 都在 eager 预算内走 eager', () => {
    expect(selectTier(12, 1500, POLICY)).toBe('eager');
  });

  it('条数超 eager 上限即升 catalog，即使 token 很小', () => {
    expect(selectTier(13, 10, POLICY)).toBe('catalog');
  });

  it('token 超 eager 上限即升 catalog，即使条数很少', () => {
    expect(selectTier(2, 1501, POLICY)).toBe('catalog');
  });

  it('条数与 token 都在 catalog 预算内走 catalog', () => {
    expect(selectTier(40, 4000, POLICY)).toBe('catalog');
  });

  it('条数超 catalog 上限走 search', () => {
    expect(selectTier(41, 10, POLICY)).toBe('search');
  });

  it('token 超 catalog 上限走 search', () => {
    expect(selectTier(2, 4001, POLICY)).toBe('search');
  });

  it('零工具走 eager', () => {
    expect(selectTier(0, 0, POLICY)).toBe('eager');
  });
});

describe('isNamedTool', () => {
  it('真实工具被判为具名工具', () => {
    expect(isNamedTool(makeTool('t', 'd'))).toBe(true);
  });

  it('provider dict（非 Runnable）不被判为具名工具', () => {
    expect(isNamedTool({ type: 'tool_search' })).toBe(false);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

```bash
export PATH="$HOME/.nvm/versions/node/v24.19.0/bin:$PATH"
pnpm vitest run tests/agent.tool-catalog.test.ts
```

Expected: FAIL —— 无法解析 `../src/agent/tool-catalog.js`（模块不存在）。

- [ ] **Step 3: 导出 summary.ts 的两个私有函数**

在 `src/agent/summary.ts` 中，把这两行的函数声明加上 `export`（函数体不动）：

```ts
export function isCjk(code: number): boolean {
```

```ts
export function countTextTokens(text: string): number {
```

- [ ] **Step 4: 写最小实现**

创建 `src/agent/tool-catalog.ts`：

```ts
import { toJsonSchema } from '@langchain/core/utils/json_schema';
import { Runnable } from '@langchain/core/runnables';
import type { StructuredToolInterface } from '@langchain/core/tools';
import { countTextTokens } from './summary.js';

export const ACTIVATE_TOOL_NAME = 'activate_tools';
export const SEARCH_TOOL_NAME = 'search_tools';

export type ToolTier = 'eager' | 'catalog' | 'search';

export interface ToolLoadingPolicy {
  enabled: boolean;
  eagerMaxTools: number;
  eagerMaxTokens: number;
  catalogMaxTools: number;
  catalogMaxTokens: number;
  searchTopK: number;
  maxActiveTools: number;
}

export function estimateToolTokens(tool: StructuredToolInterface): number {
  const schema = JSON.stringify(toJsonSchema(tool.schema));
  return countTextTokens(`${tool.name}${tool.description}${schema}`);
}

export function selectTier(
  count: number,
  tokens: number,
  policy: ToolLoadingPolicy,
): ToolTier {
  if (count <= policy.eagerMaxTools && tokens <= policy.eagerMaxTokens) return 'eager';
  if (count <= policy.catalogMaxTools && tokens <= policy.catalogMaxTokens) return 'catalog';
  return 'search';
}

/** 区分客户端工具与 provider 原生工具 dict：后者没有 name/schema，不参与过滤与 token 估算。 */
export function isNamedTool(value: object): value is StructuredToolInterface {
  return 'name' in value && typeof value.name === 'string' && Runnable.isRunnable(value);
}
```

- [ ] **Step 5: 跑测试确认通过**

```bash
export PATH="$HOME/.nvm/versions/node/v24.19.0/bin:$PATH"
pnpm vitest run tests/agent.tool-catalog.test.ts
pnpm typecheck
```

Expected: 12 个用例 PASS；typecheck 退出码 0。

- [ ] **Step 6: 提交**

```bash
git add src/agent/tool-catalog.ts src/agent/summary.ts tests/agent.tool-catalog.test.ts
git commit -m "feat: add tool schema token estimation and tier selection"
```

---

### Task 2: 目录渲染与检索打分

**Files:**
- Modify: `src/agent/tool-catalog.ts`
- Test: `tests/agent.tool-catalog.test.ts`

**Interfaces:**
- Consumes: Task 1 的 `ToolLoadingPolicy`；`summary.ts` 的 `isCjk`
- Produces:
  - `const CATALOG_DESC_LIMIT = 80`
  - `briefDescription(description: string): string`
  - `renderCatalog(tools: StructuredToolInterface[]): string`
  - `tokenize(text: string): string[]`
  - `interface ToolMatch { name: string; description: string; score: number }`
  - `searchCatalog(tools: StructuredToolInterface[], query: string, topK: number): ToolMatch[]`

- [ ] **Step 1: 写失败测试**

在 `tests/agent.tool-catalog.test.ts` 末尾追加（顶部 import 补上 `briefDescription`、`renderCatalog`、`searchCatalog`、`tokenize`、`CATALOG_DESC_LIMIT`）：

```ts
describe('briefDescription', () => {
  it('只取首行', () => {
    expect(briefDescription('第一行\n第二行')).toBe('第一行');
  });

  it('超长截断并补省略号', () => {
    const long = '测'.repeat(200);
    const brief = briefDescription(long);
    expect(brief).toBe(`${'测'.repeat(CATALOG_DESC_LIMIT)}…`);
  });

  it('恰好等于上限时不加省略号', () => {
    const exact = '测'.repeat(CATALOG_DESC_LIMIT);
    expect(briefDescription(exact)).toBe(exact);
  });

  it('空描述返回空串', () => {
    expect(briefDescription('')).toBe('');
  });
});

describe('renderCatalog', () => {
  it('空工具集返回空串', () => {
    expect(renderCatalog([])).toBe('');
  });

  it('每个工具一行，含名字与截断后的描述', () => {
    const catalog = renderCatalog([makeTool('fs_read', '读取文件')]);
    expect(catalog).toContain('- fs_read: 读取文件');
  });

  it('长描述被截断，目录体积不随描述线性膨胀', () => {
    const catalog = renderCatalog([makeTool('t', '测'.repeat(500))]);
    expect(catalog).toContain('…');
    expect(catalog.length).toBeLessThan(200);
  });

  it('提示里点名 activate_tools', () => {
    expect(renderCatalog([makeTool('t', 'd')])).toContain('activate_tools');
  });
});

describe('tokenize', () => {
  it('ASCII 按单词切并转小写', () => {
    expect(tokenize('Read_File NOW')).toEqual(['read', 'file', 'now']);
  });

  it('CJK 产出单字与相邻二字', () => {
    expect(tokenize('读文件')).toEqual(['读', '读文', '文', '文件', '件']);
  });

  it('中英混合分别切', () => {
    expect(tokenize('读file')).toEqual(['读', 'file']);
  });

  it('空串返回空数组', () => {
    expect(tokenize('')).toEqual([]);
  });
});

describe('searchCatalog', () => {
  const tools = [
    makeTool('fs_read_file', '读取沙箱里的文件内容'),
    makeTool('fs_write_file', '往沙箱写入文本文件'),
    makeTool('ask_remote', '调用远端 agent 协作'),
  ];

  it('中文关键词能召回对应工具', () => {
    const hits = searchCatalog(tools, '写入', 8);
    expect(hits[0]?.name).toBe('fs_write_file');
  });

  it('名字命中权重高于描述命中', () => {
    const hits = searchCatalog(tools, 'read', 8);
    expect(hits[0]?.name).toBe('fs_read_file');
  });

  it('无匹配返回空数组', () => {
    expect(searchCatalog(tools, 'zzzznotfound', 8)).toEqual([]);
  });

  it('空 query 返回空数组', () => {
    expect(searchCatalog(tools, '', 8)).toEqual([]);
  });

  it('topK 截断结果条数', () => {
    expect(searchCatalog(tools, 'file', 1)).toHaveLength(1);
  });

  it('返回完整描述而非截断描述', () => {
    const long = makeTool('t_long', `${'前置说明'.repeat(30)}关键词尾巴`);
    const hits = searchCatalog([long], '关键词尾巴', 8);
    expect(hits[0]?.description).toBe(long.description);
  });

  it('同分时按名字排序，结果稳定', () => {
    const same = [makeTool('b_tool', '共同描述'), makeTool('a_tool', '共同描述')];
    expect(searchCatalog(same, '共同描述', 8).map((m) => m.name)).toEqual(['a_tool', 'b_tool']);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

```bash
export PATH="$HOME/.nvm/versions/node/v24.19.0/bin:$PATH"
pnpm vitest run tests/agent.tool-catalog.test.ts
```

Expected: FAIL —— `briefDescription` / `renderCatalog` / `tokenize` / `searchCatalog` / `CATALOG_DESC_LIMIT` 未导出。

- [ ] **Step 3: 写最小实现**

在 `src/agent/tool-catalog.ts` 顶部把 import 改成同时引入 `isCjk`：

```ts
import { countTextTokens, isCjk } from './summary.js';
```

在文件末尾追加：

```ts
/** 目录里列完整描述会让目录体积逼近完整 schema，token 收益归零。 */
export const CATALOG_DESC_LIMIT = 80;

export function briefDescription(description: string): string {
  const firstLine = description.split('\n')[0] ?? '';
  const flat = firstLine.replace(/\s+/g, ' ').trim();
  return flat.length > CATALOG_DESC_LIMIT
    ? `${flat.slice(0, CATALOG_DESC_LIMIT)}…`
    : flat;
}

export function renderCatalog(tools: StructuredToolInterface[]): string {
  if (tools.length === 0) return '';
  const lines = tools.map((t) => `- ${t.name}: ${briefDescription(t.description)}`);
  return [`可激活工具（用 ${ACTIVATE_TOOL_NAME} 传入名字后才能调用）:`, ...lines].join('\n');
}

export function tokenize(text: string): string[] {
  const terms: string[] = [];
  let ascii = '';
  const cjkRun: string[] = [];

  const flushAscii = (): void => {
    if (ascii.length > 0) {
      terms.push(ascii);
      ascii = '';
    }
  };
  const flushCjk = (): void => {
    for (const [index, char] of cjkRun.entries()) {
      terms.push(char);
      const next = cjkRun[index + 1];
      if (next !== undefined) terms.push(`${char}${next}`);
    }
    cjkRun.length = 0;
  };

  for (const char of text) {
    const lower = char.toLowerCase();
    if (isCjk(lower.codePointAt(0) ?? 0)) {
      flushAscii();
      cjkRun.push(lower);
      continue;
    }
    flushCjk();
    if (/[a-z0-9]/.test(lower)) ascii += lower;
    else flushAscii();
  }
  flushAscii();
  flushCjk();
  return terms;
}

export interface ToolMatch {
  name: string;
  description: string;
  score: number;
}

export function searchCatalog(
  tools: StructuredToolInterface[],
  query: string,
  topK: number,
): ToolMatch[] {
  const queryTerms = [...new Set(tokenize(query))];
  if (queryTerms.length === 0) return [];

  const matches: ToolMatch[] = [];
  for (const tool of tools) {
    const nameTerms = new Set(tokenize(tool.name));
    // 匹配用完整描述：截断只用于展示，否则长描述里的关键词召回不到。
    const descTerms = new Set(tokenize(tool.description));
    let score = 0;
    for (const term of queryTerms) {
      if (nameTerms.has(term)) score += 2;
      if (descTerms.has(term)) score += 1;
    }
    if (score > 0) {
      matches.push({ name: tool.name, description: tool.description, score });
    }
  }

  return matches
    .sort((a, b) => b.score - a.score || a.name.localeCompare(b.name))
    .slice(0, topK);
}
```

- [ ] **Step 4: 跑测试确认通过**

```bash
export PATH="$HOME/.nvm/versions/node/v24.19.0/bin:$PATH"
pnpm vitest run tests/agent.tool-catalog.test.ts
pnpm typecheck
```

Expected: 全部 PASS（Task 1 的 12 条 + 本任务 19 条 = 31 条）；typecheck 退出码 0。

- [ ] **Step 5: 提交**

```bash
git add src/agent/tool-catalog.ts tests/agent.tool-catalog.test.ts
git commit -m "feat: add tool catalog rendering and keyword search scoring"
```

---

### Task 3: 配置面

**Files:**
- Modify: `src/config/env.ts`
- Test: `tests/config.env.test.ts`

**Interfaces:**
- Consumes: 无（`AppConfig` 的结构与 `ToolLoadingPolicy` 同形，但 config 层不 import agent 层，保持模块边界）
- Produces:
  - `AppConfig['toolLoading']`：`{ enabled: boolean; eagerMaxTools: number; eagerMaxTokens: number; catalogMaxTools: number; catalogMaxTokens: number; searchTopK: number; maxActiveTools: number }`
  - `AppConfig['toolClearing']`：`{ enabled: boolean; triggerTokens: number; keepMessages: number }`

- [ ] **Step 1: 写失败测试**

在 `tests/config.env.test.ts` 末尾追加。该文件顶部已有 `const BASE`（四个必填 LLM 变量），直接复用它，**不要新建第二个基准对象**：

```ts
describe('工具加载与清理配置', () => {
  it('默认值', () => {
    const config = loadConfig({ ...BASE });
    expect(config.toolLoading).toEqual({
      enabled: true,
      eagerMaxTools: 12,
      eagerMaxTokens: 1500,
      catalogMaxTools: 40,
      catalogMaxTokens: 4000,
      searchTopK: 8,
      maxActiveTools: 24,
    });
    expect(config.toolClearing).toEqual({
      enabled: true,
      triggerTokens: 6000,
      keepMessages: 3,
    });
  });

  it('TOOL_LOADING_ENABLED=false 被解析为关闭而非开启', () => {
    expect(loadConfig({ ...BASE, TOOL_LOADING_ENABLED: 'false' }).toolLoading.enabled).toBe(false);
  });

  it('TOOL_CLEARING_ENABLED=false 被解析为关闭而非开启', () => {
    expect(loadConfig({ ...BASE, TOOL_CLEARING_ENABLED: 'false' }).toolClearing.enabled).toBe(false);
  });

  it('数值变量可覆盖', () => {
    const config = loadConfig({
      ...BASE,
      TOOL_LOADING_EAGER_MAX_TOOLS: '3',
      TOOL_LOADING_SEARCH_TOP_K: '2',
      TOOL_CLEARING_KEEP_MESSAGES: '5',
    });
    expect(config.toolLoading.eagerMaxTools).toBe(3);
    expect(config.toolLoading.searchTopK).toBe(2);
    expect(config.toolClearing.keepMessages).toBe(5);
  });

  it('非正数被拒绝并指出变量名', () => {
    for (const key of [
      'TOOL_LOADING_EAGER_MAX_TOOLS',
      'TOOL_LOADING_EAGER_MAX_TOKENS',
      'TOOL_LOADING_CATALOG_MAX_TOOLS',
      'TOOL_LOADING_CATALOG_MAX_TOKENS',
      'TOOL_LOADING_SEARCH_TOP_K',
      'TOOL_LOADING_MAX_ACTIVE',
      'TOOL_CLEARING_TRIGGER_TOKENS',
      'TOOL_CLEARING_KEEP_MESSAGES',
    ]) {
      expect(() => loadConfig({ ...BASE, [key]: '0' })).toThrow(key);
    }
  });

  it('eager 条数上限大于 catalog 条数上限时启动报错', () => {
    expect(() => loadConfig({
      ...BASE,
      TOOL_LOADING_EAGER_MAX_TOOLS: '50',
      TOOL_LOADING_CATALOG_MAX_TOOLS: '40',
    })).toThrow(/TOOL_LOADING_EAGER_MAX_TOOLS/);
  });

  it('eager token 上限大于 catalog token 上限时启动报错', () => {
    expect(() => loadConfig({
      ...BASE,
      TOOL_LOADING_EAGER_MAX_TOKENS: '5000',
      TOOL_LOADING_CATALOG_MAX_TOKENS: '4000',
    })).toThrow(/TOOL_LOADING_EAGER_MAX_TOKENS/);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

```bash
export PATH="$HOME/.nvm/versions/node/v24.19.0/bin:$PATH"
pnpm vitest run tests/config.env.test.ts
```

Expected: FAIL —— `config.toolLoading` 为 `undefined`。

- [ ] **Step 3: 写最小实现**

在 `src/config/env.ts` 的 `EnvSchema` 里，`SUMMARY_TRIM_TOKENS` 之后、`LOG_LEVEL` 之前插入：

```ts
  TOOL_LOADING_ENABLED: z.enum(['true', 'false']).default('true'),
  TOOL_LOADING_EAGER_MAX_TOOLS: z.coerce.number().int().positive().default(12),
  TOOL_LOADING_EAGER_MAX_TOKENS: z.coerce.number().int().positive().default(1500),
  TOOL_LOADING_CATALOG_MAX_TOOLS: z.coerce.number().int().positive().default(40),
  TOOL_LOADING_CATALOG_MAX_TOKENS: z.coerce.number().int().positive().default(4000),
  TOOL_LOADING_SEARCH_TOP_K: z.coerce.number().int().positive().default(8),
  TOOL_LOADING_MAX_ACTIVE: z.coerce.number().int().positive().default(24),

  TOOL_CLEARING_ENABLED: z.enum(['true', 'false']).default('true'),
  TOOL_CLEARING_TRIGGER_TOKENS: z.coerce.number().int().positive().default(6000),
  TOOL_CLEARING_KEEP_MESSAGES: z.coerce.number().int().positive().default(3),
```

在 `AppConfig` 的 `summary` 之后、`logLevel` 之前插入：

```ts
  toolLoading: {
    enabled: boolean;
    eagerMaxTools: number;
    eagerMaxTokens: number;
    catalogMaxTools: number;
    catalogMaxTokens: number;
    searchTopK: number;
    maxActiveTools: number;
  };
  toolClearing: {
    enabled: boolean;
    triggerTokens: number;
    keepMessages: number;
  };
```

在 `loadConfig` 的 `const v = parsed.data;` 之后、`return {` 之前插入交叉约束校验：

```ts
  // eager 是 catalog 的子集，上限反了会让 catalog 档永远选不中。
  if (v.TOOL_LOADING_EAGER_MAX_TOOLS > v.TOOL_LOADING_CATALOG_MAX_TOOLS) {
    throw new ConfigError(
      `环境变量校验失败 → TOOL_LOADING_EAGER_MAX_TOOLS(${v.TOOL_LOADING_EAGER_MAX_TOOLS}) 不得大于 TOOL_LOADING_CATALOG_MAX_TOOLS(${v.TOOL_LOADING_CATALOG_MAX_TOOLS})`,
    );
  }
  if (v.TOOL_LOADING_EAGER_MAX_TOKENS > v.TOOL_LOADING_CATALOG_MAX_TOKENS) {
    throw new ConfigError(
      `环境变量校验失败 → TOOL_LOADING_EAGER_MAX_TOKENS(${v.TOOL_LOADING_EAGER_MAX_TOKENS}) 不得大于 TOOL_LOADING_CATALOG_MAX_TOKENS(${v.TOOL_LOADING_CATALOG_MAX_TOKENS})`,
    );
  }
```

在 `return` 对象的 `summary` 之后、`logLevel` 之前插入：

```ts
    toolLoading: {
      enabled: v.TOOL_LOADING_ENABLED === 'true',
      eagerMaxTools: v.TOOL_LOADING_EAGER_MAX_TOOLS,
      eagerMaxTokens: v.TOOL_LOADING_EAGER_MAX_TOKENS,
      catalogMaxTools: v.TOOL_LOADING_CATALOG_MAX_TOOLS,
      catalogMaxTokens: v.TOOL_LOADING_CATALOG_MAX_TOKENS,
      searchTopK: v.TOOL_LOADING_SEARCH_TOP_K,
      maxActiveTools: v.TOOL_LOADING_MAX_ACTIVE,
    },
    toolClearing: {
      enabled: v.TOOL_CLEARING_ENABLED === 'true',
      triggerTokens: v.TOOL_CLEARING_TRIGGER_TOKENS,
      keepMessages: v.TOOL_CLEARING_KEEP_MESSAGES,
    },
```

- [ ] **Step 4: 跑测试确认通过**

```bash
export PATH="$HOME/.nvm/versions/node/v24.19.0/bin:$PATH"
pnpm vitest run tests/config.env.test.ts
pnpm typecheck
```

Expected: 全部 PASS；typecheck 退出码 0。

- [ ] **Step 5: 提交**

```bash
git add src/config/env.ts tests/config.env.test.ts
git commit -m "feat: add tool loading and clearing configuration"
```

---

### Task 4: catalog 档加载中间件

**Files:**
- Create: `src/agent/tool-loading.ts`
- Test: `tests/agent.tool-loading.test.ts`

**Interfaces:**
- Consumes: Task 1/2 的 `ToolLoadingPolicy`、`ToolTier`、`renderCatalog`、`isNamedTool`、`ACTIVATE_TOOL_NAME`、`SEARCH_TOOL_NAME`
- Produces:
  - `interface ToolLoadingOptions { tier: 'catalog' | 'search'; deferrable: StructuredToolInterface[]; alwaysOn: string[]; policy: ToolLoadingPolicy; logger: Logger }`
  - `createToolLoadingMiddleware(options: ToolLoadingOptions): ReturnType<typeof createMiddleware>`

本任务只实现 `catalog` 档：`ToolLoadingOptions['tier']` 的类型就是字面量 `'catalog'`。Task 5 才把它放宽为 `'catalog' | 'search'` 并加 `search_tools`。本任务不要为 search 档预留分支或占位注释。

- [ ] **Step 1: 写失败测试**

创建 `tests/agent.tool-loading.test.ts`：

```ts
import { describe, expect, it } from 'vitest';
import { createAgent, tool } from 'langchain';
import { MemorySaver, REMOVE_ALL_MESSAGES } from '@langchain/langgraph';
import { AIMessage, RemoveMessage } from '@langchain/core/messages';
import type { BaseMessage } from '@langchain/core/messages';
import type { ChatResult } from '@langchain/core/outputs';
import { FakeListChatModel } from '@langchain/core/utils/testing';
import type { FakeChatInput, ToolSpec } from '@langchain/core/utils/testing';
import type { StructuredTool, StructuredToolInterface } from '@langchain/core/tools';
import { z } from 'zod';
import { createToolLoadingMiddleware } from '../src/agent/tool-loading.js';
import type { ToolLoadingPolicy } from '../src/agent/tool-catalog.js';
import { createLogger } from '../src/shared/index.js';

const silentLogger = createLogger('silent', 'test');

const POLICY: ToolLoadingPolicy = {
  enabled: true,
  eagerMaxTools: 12,
  eagerMaxTokens: 1500,
  catalogMaxTools: 40,
  catalogMaxTokens: 4000,
  searchTopK: 8,
  maxActiveTools: 3,
};

function dummy(name: string, description = '描述'): StructuredToolInterface {
  return tool(async () => 'ok', { name, description, schema: z.object({}) });
}

/** 记录每次模型调用真实绑定的工具名，并可选地在首个回合发一次 tool_call。 */
class RecordingModel extends FakeListChatModel {
  readonly boundNames: string[][] = [];
  readonly systemTexts: string[] = [];
  private firstCallTool: { name: string; args: Record<string, unknown> } | undefined;
  private calls = 0;

  constructor(firstCallTool?: { name: string; args: Record<string, unknown> }) {
    super({ responses: [] } as FakeChatInput);
    this.firstCallTool = firstCallTool;
  }

  override async _generate(messages: BaseMessage[]): Promise<ChatResult> {
    this.calls += 1;
    const system = messages.find((m) => m.getType() === 'system');
    this.systemTexts.push(system === undefined ? '' : String(system.content));
    if (this.calls === 1 && this.firstCallTool !== undefined) {
      const message = new AIMessage({
        content: '',
        tool_calls: [{ ...this.firstCallTool, id: 'call_1' }],
      });
      return { generations: [{ text: '', message }], llmOutput: {} };
    }
    return {
      generations: [{ text: '完成', message: new AIMessage('完成') }],
      llmOutput: {},
    };
  }

  override bindTools(tools: (StructuredTool | ToolSpec)[]): ReturnType<FakeListChatModel['bindTools']> {
    this.boundNames.push(tools.map((t) => ('name' in t ? String(t.name) : '?')));
    return this.withConfig({});
  }
}

function build(model: RecordingModel, deferrable: StructuredToolInterface[]) {
  const middleware = createToolLoadingMiddleware({
    tier: 'catalog',
    deferrable,
    alwaysOn: ['always_on'],
    policy: POLICY,
    logger: silentLogger,
  });
  return createAgent({
    model,
    tools: [dummy('always_on'), ...deferrable],
    checkpointer: new MemorySaver(),
    middleware: [middleware],
  });
}

describe('catalog 档加载中间件', () => {
  it('首次调用只绑常驻工具与 activate_tools', async () => {
    const model = new RecordingModel();
    const agent = build(model, [dummy('t1'), dummy('t2')]);
    await agent.invoke({ messages: [{ role: 'human', content: '你好' }] }, { configurable: { thread_id: 'a' } });
    expect(model.boundNames[0]).toEqual(['always_on', 'activate_tools']);
  });

  it('系统提示里列出可激活工具目录', async () => {
    const model = new RecordingModel();
    const agent = build(model, [dummy('t1', '读取文件')]);
    await agent.invoke({ messages: [{ role: 'human', content: '你好' }] }, { configurable: { thread_id: 'b' } });
    expect(model.systemTexts[0]).toContain('t1: 读取文件');
  });

  it('activate_tools 之后该工具的完整 schema 被绑定', async () => {
    const model = new RecordingModel({ name: 'activate_tools', args: { names: ['t1'] } });
    const agent = build(model, [dummy('t1'), dummy('t2')]);
    await agent.invoke({ messages: [{ role: 'human', content: '你好' }] }, { configurable: { thread_id: 'c' } });
    expect(model.boundNames.at(-1)).toContain('t1');
    expect(model.boundNames.at(-1)).not.toContain('t2');
  });

  it('激活状态跨 invoke 持久', async () => {
    const first = new RecordingModel({ name: 'activate_tools', args: { names: ['t1'] } });
    const agent = build(first, [dummy('t1'), dummy('t2')]);
    const config = { configurable: { thread_id: 'd' } };
    await agent.invoke({ messages: [{ role: 'human', content: '第一轮' }] }, config);
    await agent.invoke({ messages: [{ role: 'human', content: '第二轮' }] }, config);
    expect(first.boundNames.at(-1)).toContain('t1');
  });

  it('摘要式清空 messages 后激活不丢', async () => {
    const model = new RecordingModel({ name: 'activate_tools', args: { names: ['t1'] } });
    const agent = build(model, [dummy('t1'), dummy('t2')]);
    const config = { configurable: { thread_id: 'e' } };
    await agent.invoke({ messages: [{ role: 'human', content: '第一轮' }] }, config);
    await agent.updateState(config, { messages: [new RemoveMessage({ id: REMOVE_ALL_MESSAGES })] }, '__start__');
    await agent.invoke({ messages: [{ role: 'human', content: '清空后' }] }, config);
    expect(model.boundNames.at(-1)).toContain('t1');
  });

  it('超上限按 FIFO 淘汰，且生效清单对模型可见', async () => {
    const model = new RecordingModel({ name: 'activate_tools', args: { names: ['t1', 't2'] } });
    const agent = build(model, [dummy('t1'), dummy('t2'), dummy('t3'), dummy('t4')]);
    const config = { configurable: { thread_id: 'f' } };
    await agent.invoke({ messages: [{ role: 'human', content: '第一批' }] }, config);
    await agent.updateState(config, { activatedTools: ['t3', 't4'] }, '__start__');
    await agent.invoke({ messages: [{ role: 'human', content: '第二批' }] }, config);
    const bound = model.boundNames.at(-1) ?? [];
    expect(bound).not.toContain('t1');
    expect(bound).toContain('t2');
    expect(bound).toContain('t3');
    expect(bound).toContain('t4');
    expect(model.systemTexts.at(-1)).toContain('t2、t3、t4');
  });

  it('未知工具名在工具回执里点名', async () => {
    const model = new RecordingModel({ name: 'activate_tools', args: { names: ['nope'] } });
    const agent = build(model, [dummy('t1')]);
    const result = await agent.invoke({ messages: [{ role: 'human', content: '你好' }] }, { configurable: { thread_id: 'g' } });
    const texts = result.messages.map((m) => String(m.content)).join('\n');
    expect(texts).toContain('未知工具名');
    expect(texts).toContain('nope');
  });

  it('已常驻的名字回一句无需激活', async () => {
    const model = new RecordingModel({ name: 'activate_tools', args: { names: ['always_on'] } });
    const agent = build(model, [dummy('t1')]);
    const result = await agent.invoke({ messages: [{ role: 'human', content: '你好' }] }, { configurable: { thread_id: 'h' } });
    expect(result.messages.map((m) => String(m.content)).join('\n')).toContain('已常驻');
  });

  it('尚未激活时系统提示明确说明', async () => {
    const model = new RecordingModel();
    const agent = build(model, [dummy('t1')]);
    await agent.invoke({ messages: [{ role: 'human', content: '你好' }] }, { configurable: { thread_id: 'i' } });
    expect(model.systemTexts[0]).toContain('尚未激活');
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

```bash
export PATH="$HOME/.nvm/versions/node/v24.19.0/bin:$PATH"
pnpm vitest run tests/agent.tool-loading.test.ts
```

Expected: FAIL —— 无法解析 `../src/agent/tool-loading.js`。

- [ ] **Step 3: 写最小实现**

创建 `src/agent/tool-loading.ts`：

```ts
import { createMiddleware, tool } from 'langchain';
import { Command, ReducedValue, StateSchema } from '@langchain/langgraph';
import { ToolMessage } from '@langchain/core/messages';
import { z } from 'zod';
import type { StructuredToolInterface } from '@langchain/core/tools';
import type { Logger } from '../shared/index.js';
import {
  ACTIVATE_TOOL_NAME,
  SEARCH_TOOL_NAME,
  isNamedTool,
  renderCatalog,
} from './tool-catalog.js';
import type { ToolLoadingPolicy } from './tool-catalog.js';

export interface ToolLoadingOptions {
  tier: 'catalog';
  deferrable: StructuredToolInterface[];
  alwaysOn: string[];
  policy: ToolLoadingPolicy;
  logger: Logger;
}

function createActivateTool(
  known: Set<string>,
  resident: Set<string>,
  maxActive: number,
): StructuredToolInterface {
  return tool(
    ({ names }, config) => {
      const accepted = names.filter((name) => known.has(name));
      const alreadyOn = names.filter((name) => resident.has(name));
      const unknown = names.filter((name) => !known.has(name) && !resident.has(name));
      const lines: string[] = [];
      if (accepted.length > 0) lines.push(`已激活：${accepted.join('、')}`);
      if (alreadyOn.length > 0) lines.push(`已常驻，无需激活：${alreadyOn.join('、')}`);
      if (unknown.length > 0) lines.push(`未知工具名：${unknown.join('、')}`);
      lines.push(`同时激活上限 ${maxActive}，超出时最早激活的会被移出；当前生效清单见系统提示。`);
      return new Command({
        update: {
          activatedTools: accepted,
          messages: [
            new ToolMessage({
              content: lines.join('\n'),
              tool_call_id: config.toolCall?.id ?? '',
              name: ACTIVATE_TOOL_NAME,
            }),
          ],
        },
      });
    },
    {
      name: ACTIVATE_TOOL_NAME,
      description: '按名字激活工具。只有激活过的工具才能调用，可一次传多个名字。',
      schema: z.object({ names: z.array(z.string().min(1)).min(1) }),
    },
  );
}

export function createToolLoadingMiddleware(
  options: ToolLoadingOptions,
): ReturnType<typeof createMiddleware> {
  const { deferrable, alwaysOn, policy, logger } = options;
  const resident = new Set([...alwaysOn, ACTIVATE_TOOL_NAME, SEARCH_TOOL_NAME]);
  const deferrableNames = new Set(deferrable.map((t) => t.name));
  const maxActive = policy.maxActiveTools;

  const activate = createActivateTool(deferrableNames, new Set(alwaysOn), maxActive);

  logger.info(
    `工具加载档位 catalog：可延迟工具 ${deferrable.length} 个，激活上限 ${maxActive}`,
  );

  return createMiddleware({
    name: 'ToolLoading',
    stateSchema: new StateSchema({
      activatedTools: new ReducedValue(z.array(z.string()).default(() => []), {
        // default 必须落在 inputSchema 上：SDK 的必填检查取 inputSchema || valueSchema。
        inputSchema: z.array(z.string()).default(() => []),
        reducer: (current: string[], next: string[]) => {
          const merged = current.filter((name) => !next.includes(name)).concat(next);
          return merged.length > maxActive ? merged.slice(merged.length - maxActive) : merged;
        },
      }),
    }),
    tools: [activate],
    wrapModelCall: (request, handler) => {
      const active = new Set(request.state.activatedTools);
      const tools = request.tools.filter(
        (item) => !isNamedTool(item) || resident.has(item.name) || active.has(item.name),
      );
      const listed = [...active];
      const sections = [
        renderCatalog(deferrable),
        listed.length > 0
          ? `当前已激活工具：${listed.join('、')}`
          : '当前尚未激活任何工具。',
      ].filter((section) => section.length > 0);
      return handler({
        ...request,
        tools,
        systemMessage: request.systemMessage.concat(`\n\n${sections.join('\n\n')}`),
      });
    },
  });
}
```

- [ ] **Step 4: 跑测试确认通过**

```bash
export PATH="$HOME/.nvm/versions/node/v24.19.0/bin:$PATH"
pnpm vitest run tests/agent.tool-loading.test.ts
pnpm typecheck
```

Expected: 9 个用例 PASS；typecheck 退出码 0。

若出现 `has required state fields that must be initialized`，说明 `inputSchema` 上的 `.default(() => [])` 掉了——补回去，不要改成在 invoke 时传初值。

- [ ] **Step 5: 提交**

```bash
git add src/agent/tool-loading.ts tests/agent.tool-loading.test.ts
git commit -m "feat: add catalog-tier tool loading middleware with persistent activation"
```

---

### Task 5: search 档与 search_tools

**Files:**
- Modify: `src/agent/tool-loading.ts`
- Test: `tests/agent.tool-loading.test.ts`

**Interfaces:**
- Consumes: Task 2 的 `searchCatalog`、`briefDescription`；Task 4 的 `createToolLoadingMiddleware`
- Produces: `ToolLoadingOptions['tier']` 放宽为 `'catalog' | 'search'`

- [ ] **Step 1: 写失败测试**

在 `tests/agent.tool-loading.test.ts` 末尾追加（`build` 增加可选 tier 参数：把 `function build(model, deferrable)` 改为 `function build(model, deferrable, tier: 'catalog' | 'search' = 'catalog')`，并把里面 `tier: 'catalog'` 改为 `tier`）：

```ts
describe('search 档加载中间件', () => {
  const deferrable = [
    dummy('fs_read_file', '读取沙箱里的文件内容'),
    dummy('fs_write_file', '往沙箱写入文本文件'),
    dummy('ask_remote', '调用远端 agent 协作'),
  ];

  it('绑定 search_tools 与 activate_tools', async () => {
    const model = new RecordingModel();
    const agent = build(model, deferrable, 'search');
    await agent.invoke({ messages: [{ role: 'human', content: '你好' }] }, { configurable: { thread_id: 's1' } });
    expect(model.boundNames[0]).toContain('search_tools');
    expect(model.boundNames[0]).toContain('activate_tools');
  });

  it('系统提示不列工具目录，只给数量与检索指引', async () => {
    const model = new RecordingModel();
    const agent = build(model, deferrable, 'search');
    await agent.invoke({ messages: [{ role: 'human', content: '你好' }] }, { configurable: { thread_id: 's2' } });
    const system = model.systemTexts[0] ?? '';
    expect(system).not.toContain('fs_read_file');
    expect(system).toContain('3');
    expect(system).toContain('search_tools');
  });

  it('search_tools 返回候选但不自动激活', async () => {
    const model = new RecordingModel({ name: 'search_tools', args: { query: '写入' } });
    const agent = build(model, deferrable, 'search');
    const result = await agent.invoke({ messages: [{ role: 'human', content: '你好' }] }, { configurable: { thread_id: 's3' } });
    const texts = result.messages.map((m) => String(m.content)).join('\n');
    expect(texts).toContain('fs_write_file');
    expect(model.boundNames.at(-1)).not.toContain('fs_write_file');
  });

  it('检索无匹配时给出可执行的下一步', async () => {
    const model = new RecordingModel({ name: 'search_tools', args: { query: 'zzzznotfound' } });
    const agent = build(model, deferrable, 'search');
    const result = await agent.invoke({ messages: [{ role: 'human', content: '你好' }] }, { configurable: { thread_id: 's4' } });
    const texts = result.messages.map((m) => String(m.content)).join('\n');
    expect(texts).toContain('无匹配');
    expect(texts).toContain('activate_tools');
  });

  it('检索后再激活即可绑定', async () => {
    const model = new RecordingModel({ name: 'activate_tools', args: { names: ['fs_write_file'] } });
    const agent = build(model, deferrable, 'search');
    await agent.invoke({ messages: [{ role: 'human', content: '你好' }] }, { configurable: { thread_id: 's5' } });
    expect(model.boundNames.at(-1)).toContain('fs_write_file');
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

```bash
export PATH="$HOME/.nvm/versions/node/v24.19.0/bin:$PATH"
pnpm vitest run tests/agent.tool-loading.test.ts
```

Expected: FAIL —— `tier: 'search'` 不在 `ToolLoadingOptions['tier']` 类型内（typecheck 报错），且 `search_tools` 未注册。

- [ ] **Step 3: 写最小实现**

在 `src/agent/tool-loading.ts` 中：

把 `ToolLoadingOptions` 的 `tier` 改为：

```ts
  tier: 'catalog' | 'search';
```

把 Task 4 已有的 `tool-catalog.js` import 块**补上** `briefDescription` 与 `searchCatalog`，其余名字保留不动：

```ts
import {
  ACTIVATE_TOOL_NAME,
  SEARCH_TOOL_NAME,
  briefDescription,
  isNamedTool,
  renderCatalog,
  searchCatalog,
} from './tool-catalog.js';
```

在 `createActivateTool` 之后新增：

```ts
function createSearchTool(
  deferrable: StructuredToolInterface[],
  topK: number,
): StructuredToolInterface {
  return tool(
    ({ query }) => {
      const matches = searchCatalog(deferrable, query, topK);
      if (matches.length === 0) {
        return `无匹配，请换个说法或用 ${ACTIVATE_TOOL_NAME} 直接指定名字。`;
      }
      return [
        `候选工具（尚未激活，需要用 ${ACTIVATE_TOOL_NAME} 激活后才能调用）:`,
        ...matches.map((m) => `- ${m.name}: ${briefDescription(m.description)}`),
      ].join('\n');
    },
    {
      name: SEARCH_TOOL_NAME,
      description: '按关键词检索可用工具，返回候选名字与简介。检索本身不会激活工具。',
      schema: z.object({ query: z.string().min(1) }),
    },
  );
}
```

在 `createToolLoadingMiddleware` 里，把 `const activate = ...` 之后改为按档位组装工具与提示：

```ts
  const { tier, deferrable, alwaysOn, policy, logger } = options;
```

```ts
  const activate = createActivateTool(deferrableNames, new Set(alwaysOn), maxActive);
  const middlewareTools =
    tier === 'search'
      ? [createSearchTool(deferrable, policy.searchTopK), activate]
      : [activate];

  logger.info(
    `工具加载档位 ${tier}：可延迟工具 ${deferrable.length} 个，激活上限 ${maxActive}`,
  );
```

把 `tools: [activate],` 改为：

```ts
    tools: middlewareTools,
```

把 `wrapModelCall` 里的 `sections` 组装改为：

```ts
      const listed = [...active];
      const guide =
        tier === 'search'
          ? `共有 ${deferrable.length} 个工具可用，目录未列出。用 ${SEARCH_TOOL_NAME} 按关键词检索候选，再用 ${ACTIVATE_TOOL_NAME} 激活。`
          : renderCatalog(deferrable);
      const sections = [
        guide,
        listed.length > 0
          ? `当前已激活工具：${listed.join('、')}`
          : '当前尚未激活任何工具。',
      ].filter((section) => section.length > 0);
```

- [ ] **Step 4: 跑测试确认通过**

```bash
export PATH="$HOME/.nvm/versions/node/v24.19.0/bin:$PATH"
pnpm vitest run tests/agent.tool-loading.test.ts
pnpm typecheck
```

Expected: 14 个用例 PASS；typecheck 退出码 0。

- [ ] **Step 5: 提交**

```bash
git add src/agent/tool-loading.ts tests/agent.tool-loading.test.ts
git commit -m "feat: add search-tier tool loading with keyword discovery"
```

---

### Task 6: 工具输出清理中间件

**Files:**
- Create: `src/agent/context-clearing.ts`
- Test: `tests/agent.tool-clearing.test.ts`

**Interfaces:**
- Consumes: Task 1 的 `estimateToolTokens`；`summary.ts` 的 `countMessageTokens`
- Produces:
  - `interface ToolClearingPolicy { enabled: boolean; triggerTokens: number; keepMessages: number }`
  - `const CLEARED_PLACEHOLDER = '[已清理的工具输出]'`
  - `createToolClearingMiddleware(policy: ToolClearingPolicy, logger: Logger): ReturnType<typeof createMiddleware>`

- [ ] **Step 1: 写失败测试**

创建 `tests/agent.tool-clearing.test.ts`：

```ts
import { describe, expect, it } from 'vitest';
import { createAgent, tool } from 'langchain';
import { MemorySaver } from '@langchain/langgraph';
import { AIMessage, ToolMessage } from '@langchain/core/messages';
import type { BaseMessage } from '@langchain/core/messages';
import type { ChatResult } from '@langchain/core/outputs';
import { FakeListChatModel } from '@langchain/core/utils/testing';
import type { FakeChatInput, ToolSpec } from '@langchain/core/utils/testing';
import type { StructuredTool } from '@langchain/core/tools';
import { z } from 'zod';
import {
  CLEARED_PLACEHOLDER,
  createToolClearingMiddleware,
} from '../src/agent/context-clearing.js';
import { createLogger } from '../src/shared/index.js';

const silentLogger = createLogger('silent', 'test');

/** 记录模型每次真实看到的消息，用于断言「视图被削、原文未动」。 */
class RecordingModel extends FakeListChatModel {
  readonly seen: BaseMessage[][] = [];

  constructor() {
    super({ responses: [] } as FakeChatInput);
  }

  override async _generate(messages: BaseMessage[]): Promise<ChatResult> {
    this.seen.push([...messages]);
    return {
      generations: [{ text: '完成', message: new AIMessage('完成') }],
      llmOutput: {},
    };
  }

  override bindTools(tools: (StructuredTool | ToolSpec)[]): ReturnType<FakeListChatModel['bindTools']> {
    return this.withConfig({});
  }
}

const echo = tool(async () => 'ok', {
  name: 'big_output',
  description: '产出一大段输出',
  schema: z.object({}),
});

function toolTurn(id: string, body: string): [AIMessage, ToolMessage] {
  return [
    new AIMessage({ content: '', tool_calls: [{ name: 'big_output', args: {}, id }] }),
    new ToolMessage({ content: body, tool_call_id: id, name: 'big_output' }),
  ];
}

function build(model: RecordingModel, triggerTokens: number, keepMessages: number) {
  return createAgent({
    model,
    tools: [echo],
    checkpointer: new MemorySaver(),
    middleware: [
      createToolClearingMiddleware(
        { enabled: true, triggerTokens, keepMessages },
        silentLogger,
      ),
    ],
  });
}

function toolTexts(messages: BaseMessage[]): string[] {
  return messages
    .filter((m) => m.getType() === 'tool')
    .map((m) => String(m.content));
}

describe('工具输出清理中间件', () => {
  it('超阈值时把旧工具输出换成占位符', async () => {
    const model = new RecordingModel();
    const agent = build(model, 100, 1);
    const config = { configurable: { thread_id: 'c1' } };
    await agent.updateState(
      config,
      { messages: [...toolTurn('a', '测'.repeat(200)), ...toolTurn('b', '最近输出')] },
      '__start__',
    );
    await agent.invoke({ messages: [{ role: 'human', content: '继续' }] }, config);
    const seen = toolTexts(model.seen.at(-1) ?? []);
    expect(seen).toContain(CLEARED_PLACEHOLDER);
    expect(seen).toContain('最近输出');
  });

  it('未达阈值时不清理', async () => {
    const model = new RecordingModel();
    const agent = build(model, 100_000, 1);
    const config = { configurable: { thread_id: 'c2' } };
    await agent.updateState(
      config,
      { messages: [...toolTurn('a', '测'.repeat(200)), ...toolTurn('b', '最近输出')] },
      '__start__',
    );
    await agent.invoke({ messages: [{ role: 'human', content: '继续' }] }, config);
    expect(toolTexts(model.seen.at(-1) ?? [])).not.toContain(CLEARED_PLACEHOLDER);
  });

  it('checkpoint 里的原文一字不动', async () => {
    const model = new RecordingModel();
    const agent = build(model, 100, 1);
    const config = { configurable: { thread_id: 'c3' } };
    const original = '测'.repeat(200);
    await agent.updateState(
      config,
      { messages: [...toolTurn('a', original), ...toolTurn('b', '最近输出')] },
      '__start__',
    );
    await agent.invoke({ messages: [{ role: 'human', content: '继续' }] }, config);
    const snapshot = await agent.getState(config);
    const values = snapshot.values as { messages: BaseMessage[] };
    expect(toolTexts(values.messages)).toContain(original);
    expect(toolTexts(values.messages)).not.toContain(CLEARED_PLACEHOLDER);
  });

  it('CJK 口径生效：同样字符数比 chars/4 更早触发', async () => {
    const model = new RecordingModel();
    // 300 个中文字符：CJK 口径约 300 token，chars/4 口径只有 75。阈值 200 只在前者下命中。
    const agent = build(model, 200, 1);
    const config = { configurable: { thread_id: 'c4' } };
    await agent.updateState(
      config,
      { messages: [...toolTurn('a', '测'.repeat(300)), ...toolTurn('b', '尾')] },
      '__start__',
    );
    await agent.invoke({ messages: [{ role: 'human', content: '继续' }] }, config);
    expect(toolTexts(model.seen.at(-1) ?? [])).toContain(CLEARED_PLACEHOLDER);
  });

  it('保留窗口内的输出不被清', async () => {
    const model = new RecordingModel();
    const agent = build(model, 100, 3);
    const config = { configurable: { thread_id: 'c5' } };
    await agent.updateState(
      config,
      {
        messages: [
          ...toolTurn('a', '测'.repeat(200)),
          ...toolTurn('b', '测'.repeat(200)),
          ...toolTurn('c', '测'.repeat(200)),
        ],
      },
      '__start__',
    );
    await agent.invoke({ messages: [{ role: 'human', content: '继续' }] }, config);
    expect(toolTexts(model.seen.at(-1) ?? [])).not.toContain(CLEARED_PLACEHOLDER);
  });

  it('重复调用幂等，不叠加清理', async () => {
    const model = new RecordingModel();
    const agent = build(model, 100, 1);
    const config = { configurable: { thread_id: 'c6' } };
    await agent.updateState(
      config,
      { messages: [...toolTurn('a', '测'.repeat(200)), ...toolTurn('b', '最近输出')] },
      '__start__',
    );
    await agent.invoke({ messages: [{ role: 'human', content: '第一次' }] }, config);
    await agent.invoke({ messages: [{ role: 'human', content: '第二次' }] }, config);
    const seen = toolTexts(model.seen.at(-1) ?? []);
    expect(seen.filter((t) => t === CLEARED_PLACEHOLDER)).toHaveLength(1);
  });

  it('工具 schema 的 token 计入判据：消息本身不超阈也会清理', async () => {
    const model = new RecordingModel();
    // 工具描述 500 个中文字符 ≈ 500 token；两条工具输出各 20 字符 ≈ 40 token。
    // 阈值 300：只数消息（40）不该触发，把 schema 计入（540）才该触发。
    const fatTool = tool(async () => 'ok', {
      name: 'big_output',
      description: '测'.repeat(500),
      schema: z.object({}),
    });
    const agent = createAgent({
      model,
      tools: [fatTool],
      checkpointer: new MemorySaver(),
      middleware: [
        createToolClearingMiddleware(
          { enabled: true, triggerTokens: 300, keepMessages: 1 },
          silentLogger,
        ),
      ],
    });
    const config = { configurable: { thread_id: 'c7' } };
    await agent.updateState(
      config,
      { messages: [...toolTurn('a', '测'.repeat(20)), ...toolTurn('b', '尾'.repeat(20))] },
      '__start__',
    );
    await agent.invoke({ messages: [{ role: 'human', content: '继续' }] }, config);
    expect(toolTexts(model.seen.at(-1) ?? [])).toContain(CLEARED_PLACEHOLDER);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

```bash
export PATH="$HOME/.nvm/versions/node/v24.19.0/bin:$PATH"
pnpm vitest run tests/agent.tool-clearing.test.ts
```

Expected: FAIL —— 无法解析 `../src/agent/context-clearing.js`。

- [ ] **Step 3: 写最小实现**

创建 `src/agent/context-clearing.ts`：

```ts
import { ClearToolUsesEdit, createMiddleware } from 'langchain';
import type { BaseMessage } from '@langchain/core/messages';
import type { Logger } from '../shared/index.js';
import { countMessageTokens } from './summary.js';
import { estimateToolTokens, isNamedTool } from './tool-catalog.js';

export interface ToolClearingPolicy {
  enabled: boolean;
  triggerTokens: number;
  keepMessages: number;
}

export const CLEARED_PLACEHOLDER = '[已清理的工具输出]';

/**
 * 复用 SDK 的 ClearToolUsesEdit 算法，但自建外壳：
 * SDK 的 contextEditingMiddleware 既不给 tokenCounter 注入口，也直接原地改
 * request.messages —— 而那个数组与 state.messages 同引用，会写脏 checkpoint。
 */
export function createToolClearingMiddleware(
  policy: ToolClearingPolicy,
  logger: Logger,
): ReturnType<typeof createMiddleware> {
  const edit = new ClearToolUsesEdit({
    trigger: { tokens: policy.triggerTokens },
    keep: { messages: policy.keepMessages },
    placeholder: CLEARED_PLACEHOLDER,
  });

  return createMiddleware({
    name: 'ToolOutputClearing',
    wrapModelCall: async (request, handler) => {
      if (request.messages.length === 0) return handler(request);

      const messages = [...request.messages];
      const schemaTokens = request.tools.reduce(
        (sum, item) => (isNamedTool(item) ? sum + estimateToolTokens(item) : sum),
        0,
      );
      const before = countMessageTokens(messages) + schemaTokens;

      await edit.apply({
        messages,
        model: request.model,
        countTokens: async (msgs: BaseMessage[]) => countMessageTokens(msgs) + schemaTokens,
      });

      const after = countMessageTokens(messages) + schemaTokens;
      if (after < before) {
        logger.info(`已清理旧工具输出：视图 token ${before} → ${after}（checkpoint 原文未改）`);
      }
      return handler({ ...request, messages });
    },
  });
}
```

- [ ] **Step 4: 跑测试确认通过**

```bash
export PATH="$HOME/.nvm/versions/node/v24.19.0/bin:$PATH"
pnpm vitest run tests/agent.tool-clearing.test.ts
pnpm typecheck
```

Expected: 7 个用例 PASS；typecheck 退出码 0。

若「checkpoint 原文一字不动」失败，说明浅拷贝被去掉或 `edit.apply` 收到了 `request.messages` 本身——改回传副本。

- [ ] **Step 5: 提交**

```bash
git add src/agent/context-clearing.ts tests/agent.tool-clearing.test.ts
git commit -m "feat: add view-layer tool output clearing with CJK-aware counting"
```

---

### Task 7: 装配接线

**Files:**
- Modify: `src/agent/index.ts`
- Modify: `src/agent/runtime.ts:113-155`
- Test: `tests/agent.runtime.test.ts`

**Interfaces:**
- Consumes: Task 1–6 全部产出
- Produces: `AgentRuntime.create` 在装配期选档并安装中间件；barrel 导出三个新模块

- [ ] **Step 1: 写失败测试**

在 `tests/agent.runtime.test.ts` 里做三件事。

**(a) 扩展已有的 `makeConfig`（当前签名是 `makeConfig(root: string, checkpointDb?: string)`，见该文件第 276 行），加第三个参数以支持环境变量覆盖：**

```ts
function makeConfig(
  root: string,
  checkpointDb?: string,
  extra: Record<string, string> = {},
): AppConfig {
  return loadConfig({
    LLM_PROVIDER: 'openai-compatible',
    LLM_MODEL: 'gpt-4o-mini',
    LLM_BASE_URL: 'https://example.com/v1',
    LLM_API_KEY: 'sk-test',
    SKILLS_DIR: join(root, 'skills'),
    CHECKPOINT_DB: checkpointDb ?? join(root, 'data', 'checkpoints.sqlite'),
    MCP_CONFIG: join(root, 'mcp.json'),
    A2A_PEERS: join(root, 'peers.json'),
    SANDBOX_ROOT: join(root, 'sandbox'),
    ...extra,
  });
}
```

**(b) 扩展已有的 `RecordingChatModel`（见该文件第 69 行），加第三个构造参数记录绑定的工具名。`recorder` 参数保持不变，现有用例不受影响：**

```ts
class RecordingChatModel extends FakeListChatModel {
  constructor(
    params: FakeChatInput,
    private readonly recorder: BaseMessage[][],
    private readonly bound: string[][] = [],
  ) {
    super(params);
  }
```

并把它的 `bindTools` 改为：

```ts
  override bindTools(
    tools: (StructuredTool | ToolSpec)[],
  ): ReturnType<FakeListChatModel['bindTools']> {
    this.bound.push(tools.map((t) => ('name' in t ? String(t.name) : '?')));
    return this.withConfig({});
  }
```

**(c) 在文件末尾追加一个自包含的 describe 块。** 已有的 `root` / `runtime` 变量声明在 `describe('AgentRuntime')` 内部，新块访问不到，所以自己管临时目录。

**必须造一个带 `tool.ts` 的 skill**：可延迟集合为空时 `selectTier(0, 0, ...)` 恒为 `eager`，任何阈值都升不了档，升档用例会假绿。升档判据用 `TOOL_LOADING_EAGER_MAX_TOKENS: '1'`（任何真实工具的 name+description+schema 都超过 1 token），**不要用 `EAGER_MAX_TOOLS: '1'`**——只有 1 个可延迟工具时 `1 <= 1` 仍成立，升不了档。

```ts
const SKILL_TOOL_SOURCE = [
  "import { tool } from 'langchain';",
  "import { z } from 'zod';",
  'export const tools = [',
  '  tool(async ({ value }) => value, {',
  "    name: 'echo',",
  "    description: '回显',",
  '    schema: z.object({ value: z.string() }),',
  '  }),',
  '];',
  '',
].join('\n');

describe('工具加载与清理装配', () => {
  let dir: string | undefined;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'tool-loading-'));
    const skillDir = join(dir, 'skills', 'demo');
    await mkdir(skillDir, { recursive: true });
    await writeFile(
      join(skillDir, 'SKILL.md'),
      ['---', 'name: demo', 'description: 演示', '---', '', '正文', ''].join('\n'),
    );
    await writeFile(join(skillDir, 'tool.ts'), SKILL_TOOL_SOURCE);
  });

  afterEach(async () => {
    if (dir !== undefined) {
      await rm(dir, { recursive: true, force: true });
      dir = undefined;
    }
  });

  it('工具少时选 eager 档，日志点名档位', async () => {
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const runtime = await AgentRuntime.create(makeConfig(dir!), {
      model: new RecordingChatModel({ responses: ['好'] } as FakeChatInput, []),
    });
    try {
      expect(stderr.mock.calls.map((c) => String(c[0])).join('\n')).toContain('工具加载档位 eager');
    } finally {
      await runtime.dispose();
      stderr.mockRestore();
    }
  });

  it('eager 档不安装加载中间件，内置与 skill 工具直接绑定', async () => {
    const bound: string[][] = [];
    const runtime = await AgentRuntime.create(makeConfig(dir!), {
      model: new RecordingChatModel({ responses: ['好'] } as FakeChatInput, [], bound),
    });
    try {
      await runtime.run('你好', { threadId: 'wire-eager' });
      const names = bound.at(-1) ?? [];
      expect(names).toContain('sandbox_exec');
      expect(names).toContain('load_skill');
      expect(names).toContain('demo_echo');
      expect(names).not.toContain('activate_tools');
    } finally {
      await runtime.dispose();
    }
  });

  it('schema token 超 eager 预算时升档并注入 activate_tools', async () => {
    const bound: string[][] = [];
    const runtime = await AgentRuntime.create(
      makeConfig(dir!, undefined, { TOOL_LOADING_EAGER_MAX_TOKENS: '1' }),
      { model: new RecordingChatModel({ responses: ['好'] } as FakeChatInput, [], bound) },
    );
    try {
      await runtime.run('你好', { threadId: 'wire-catalog' });
      const names = bound.at(-1) ?? [];
      expect(names).toContain('activate_tools');
      expect(names).not.toContain('demo_echo');
    } finally {
      await runtime.dispose();
    }
  });

  it('TOOL_LOADING_ENABLED=false 时即使超预算也不注入元工具', async () => {
    const bound: string[][] = [];
    const runtime = await AgentRuntime.create(
      makeConfig(dir!, undefined, {
        TOOL_LOADING_ENABLED: 'false',
        TOOL_LOADING_EAGER_MAX_TOKENS: '1',
      }),
      { model: new RecordingChatModel({ responses: ['好'] } as FakeChatInput, [], bound) },
    );
    try {
      await runtime.run('你好', { threadId: 'wire-off' });
      const names = bound.at(-1) ?? [];
      expect(names).not.toContain('activate_tools');
      expect(names).toContain('demo_echo');
    } finally {
      await runtime.dispose();
    }
  });
});
```

该文件顶部已 import `mkdir` / `mkdtemp` / `rm` / `writeFile` / `tmpdir` / `join` / `beforeEach` / `afterEach` / `vi` / `FakeChatInput` / `StructuredTool` / `ToolSpec`，无需补 import。

- [ ] **Step 2: 跑测试确认失败**

```bash
export PATH="$HOME/.nvm/versions/node/v24.19.0/bin:$PATH"
pnpm vitest run tests/agent.runtime.test.ts
```

Expected: FAIL —— 日志里没有「工具加载档位」，`activate_tools` 永不出现。

- [ ] **Step 3: 写最小实现**

`src/agent/index.ts` 追加三行：

```ts
export * from './tool-catalog.js';
export * from './tool-loading.js';
export * from './context-clearing.js';
```

`src/agent/runtime.ts` 顶部 import 补上：

```ts
import { estimateToolTokens, selectTier } from './tool-catalog.js';
import type { ToolLoadingPolicy } from './tool-catalog.js';
import { createToolLoadingMiddleware } from './tool-loading.js';
import { createToolClearingMiddleware } from './context-clearing.js';
import type { ToolClearingPolicy } from './context-clearing.js';
```

把 `const tools = mergeToolGroups([...], appLogger.child('tools'));` 这段改为先留住分组，再合并：

```ts
      const builtinTools = [
        ...createSandboxTools(sandbox),
        createLoadSkillTool(skillRegistry),
      ];
      const toolGroups = [
        { source: 'builtin' as const, tools: builtinTools },
        { source: 'skill' as const, tools: await skillRegistry.loadTools() },
        { source: 'mcp' as const, tools: await mcpHub.tools() },
        { source: 'a2a' as const, tools: createRemoteAgentTools(a2aHub) },
      ];
      const tools = mergeToolGroups(toolGroups, appLogger.child('tools'));
      const alwaysOn = builtinTools.map((t) => t.name);
      const alwaysOnNames = new Set(alwaysOn);
      const deferrable = tools.filter((t) => !alwaysOnNames.has(t.name));
```

在 `const agentLogger = appLogger.child('agent');` 之后、`summaryPolicy` 之前插入：

```ts
      const toolLoadingPolicy: ToolLoadingPolicy = { ...config.toolLoading };
      const deferrableTokens = deferrable.reduce(
        (sum, t) => sum + estimateToolTokens(t),
        0,
      );
      const tier = selectTier(deferrable.length, deferrableTokens, toolLoadingPolicy);
      const toolLoadingMiddleware =
        toolLoadingPolicy.enabled && tier !== 'eager'
          ? createToolLoadingMiddleware({
              tier,
              deferrable,
              alwaysOn,
              policy: toolLoadingPolicy,
              logger: agentLogger,
            })
          : undefined;
      if (toolLoadingMiddleware === undefined) {
        agentLogger.info(
          `工具加载档位 eager：可延迟工具 ${deferrable.length} 个 / ${deferrableTokens} token，全量绑定`,
        );
      }

      const toolClearingPolicy: ToolClearingPolicy = { ...config.toolClearing };
      const clearingMiddleware = toolClearingPolicy.enabled
        ? createToolClearingMiddleware(toolClearingPolicy, agentLogger)
        : undefined;
```

把 `createAgent` 的 `middleware` 参数改为（顺序有意义：加载在外层，清理在内层才能拿到过滤后的真实绑定集）：

```ts
        middleware: [
          ...(toolLoadingMiddleware ? [toolLoadingMiddleware] : []),
          ...(clearingMiddleware ? [clearingMiddleware] : []),
          ...(summaryMiddleware ? [summaryMiddleware.agentMiddleware] : []),
        ],
```

- [ ] **Step 4: 跑测试确认通过**

```bash
export PATH="$HOME/.nvm/versions/node/v24.19.0/bin:$PATH"
pnpm vitest run
pnpm typecheck
pnpm build
```

Expected: 全量测试 PASS（283 基线 + 本次新增）；typecheck 与 build 退出码 0。

- [ ] **Step 5: 提交**

```bash
git add src/agent/index.ts src/agent/runtime.ts tests/agent.runtime.test.ts
git commit -m "feat: wire tool loading tiers and output clearing into agent runtime"
```

---

### Task 8: 文档

**Files:**
- Create: `readme-context-tool.md`
- Modify: `README.md`
- Modify: `.env.example`

**Interfaces:**
- Consumes: Task 1–7 的最终行为与实测数字
- Produces: 无代码接口

- [ ] **Step 1: 取真实测试数字**

```bash
export PATH="$HOME/.nvm/versions/node/v24.19.0/bin:$PATH"
pnpm vitest run 2>&1 | tail -6
```

记下 `Test Files` 与 `Tests` 的真实数字，文档里只用这两个数字，**不要写估算值**。

- [ ] **Step 2: 写 readme-context-tool.md**

创建 `readme-context-tool.md`，按下列小节写，每节都要有实质内容：

1. **为什么做**：工具 schema 与工具输出是两类不同的 token 源；摘要只管历史增长，管不到 schema。
2. **三档判据表**：列出 `eager` / `catalog` / `search` 的条件、绑定内容、进提示的内容、元工具。判据是「条数 OR token」，只算可延迟集合（skill / mcp / a2a），builtin 与元工具常驻。
3. **数据流**：装配期算一次档位 → 每次模型调用按 `activatedTools` 过滤静态表 → 清理在副本上削视图 → 摘要在 `beforeModel` 独立节点先跑。
4. **实现过程中被推翻的两个前提**（必须写，这是本文档的核心价值）：
   - 「清理排在摘要之前就能推迟摘要」是错的：`beforeModel` 是独立图节点，恒早于模型节点内部的 `wrapModelCall`，与数组顺序无关。
   - 「`ReducedValue` 的 default 放 `valueSchema` 上就行」是错的：SDK 必填检查取 `inputSchema || valueSchema`，default 必须落在 `inputSchema` 上，否则启动即抛。
5. **SDK 硬约束**：`wrapModelCall` 只能减不能增/换（`AgentNode.js:265`、`:267`）；`request.messages` 与 `state.messages` 同引用（`AgentNode.js:359`）；`contextEditingMiddleware` 无 `tokenCounter` 注入口；`providerToolSearchMiddleware` 对 OpenAI 兼容网关不可用；`llmToolSelectorMiddleware` 的选择器只看得到工具名。
6. **为什么不引入额外 LLM 调用**：三档全部靠本地判据与本地检索，零配额开销、零额外延迟。
7. **配置表**：10 个变量、默认值、含义，以及 `EAGER_MAX_* ≤ CATALOG_MAX_*` 的约束。
8. **语义与边界**：被隐藏/淘汰的工具仍可执行；清理可逆、checkpoint 原文不动；清理不能推迟摘要；token 是 CJK 感知近似值；保留窗口内的超大输出仍靠 `SANDBOX_MAX_OUTPUT_BYTES` 兜；不要与对话并发。
9. **测试证据**：Step 1 取到的真实数字，以及三个新测试文件各自覆盖什么。

- [ ] **Step 3: 更新 README.md**

- 特性表加一行：`| **工具加载优化** | 按工具条数与 schema token 三档选加载方式（全量 / 目录+按需激活 / 检索+按需激活），零额外 LLM 调用；旧工具输出在模型视图层清理，checkpoint 原文不动 |`
- 「可测试」行的用例数改成 Step 1 的真实数字。
- 环境变量表补 10 行，默认值与 Task 3 一致。
- 「上下文压缩」小节末尾加一句指向 `readme-context-tool.md`。
- 「目录结构」里 `agent/` 那行补上新模块名。

- [ ] **Step 4: 更新 .env.example**

在 `SUMMARY_*` 之后追加 10 个变量及默认值，注释风格与文件现有内容一致。

- [ ] **Step 5: 校验文档与代码一致**

```bash
export PATH="$HOME/.nvm/versions/node/v24.19.0/bin:$PATH"
grep -c 'TOOL_LOADING_\|TOOL_CLEARING_' .env.example
grep -n 'TOOL_LOADING_EAGER_MAX_TOOLS\|TOOL_CLEARING_TRIGGER_TOKENS' README.md
pnpm vitest run 2>&1 | tail -6
```

Expected: `.env.example` 命中 10；README 两个变量都能找到；测试数字与文档写的一致。

- [ ] **Step 6: 提交**

```bash
git add readme-context-tool.md README.md .env.example
git commit -m "docs: document tool loading optimization implementation"
```

---

## 验收

全部任务完成后：

```bash
export PATH="$HOME/.nvm/versions/node/v24.19.0/bin:$PATH"
pnpm vitest run
pnpm typecheck
pnpm build
git status --short
```

要求：测试全绿、typecheck 与 build 退出码 0、工作树干净。

**注意**：本计划不合并到 `main`，不推送远端——这两件事需要用户明确指示。