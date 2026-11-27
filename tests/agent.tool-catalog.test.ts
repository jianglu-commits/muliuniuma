import { describe, expect, it } from 'vitest';
import { tool } from 'langchain';
import { z } from 'zod';
import type { StructuredToolInterface } from '@langchain/core/tools';
import { estimateToolTokens, isNamedTool, selectTier } from '../src/agent/index.js';
import type { ToolLoadingPolicy } from '../src/agent/index.js';

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
    const cjk = makeTool('t', '测'.repeat(40));
    const ascii = makeTool('t', 'a'.repeat(40));
    const cjkTokens = estimateToolTokens(cjk);
    const asciiTokens = estimateToolTokens(ascii);
    expect(cjkTokens - asciiTokens).toBe(30);
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

  it('仅名字更长（描述与 schema 相同）也计入更多 token', () => {
    const short = makeTool('a', 'same_description');
    const long = makeTool('a_very_long_tool_name', 'same_description');
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

  it('条数与 token 双超 catalog 上限走 search', () => {
    expect(selectTier(41, 4001, POLICY)).toBe('search');
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

  it('有 name 但非 Runnable 的普通对象不被判为具名工具', () => {
    expect(isNamedTool({ name: 'x', schema: {} })).toBe(false);
  });
});
