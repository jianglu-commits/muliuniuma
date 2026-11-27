import { toJsonSchema } from '@langchain/core/utils/json_schema';
import { Runnable } from '@langchain/core/runnables';
import type { StructuredToolInterface } from '@langchain/core/tools';
import { countTextTokens, isCjk } from './summary.js';

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
  return 'name' in value && typeof value.name === 'string' && Boolean(Runnable.isRunnable(value));
}

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
