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