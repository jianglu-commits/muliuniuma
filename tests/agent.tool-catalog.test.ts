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