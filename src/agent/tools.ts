import type { StructuredToolInterface } from '@langchain/core/tools';
import { createLogger, renameTool } from '../shared/index.js';
import type { Logger } from '../shared/index.js';

export type ToolSource = 'builtin' | 'skill' | 'mcp' | 'a2a';

export interface ToolGroup {
  source: ToolSource;
  tools: StructuredToolInterface[];
}

/** 数值越小优先级越高：builtin > skill > mcp > a2a。 */
const PRIORITY: Record<ToolSource, number> = {
  builtin: 0,
  skill: 1,
  mcp: 2,
  a2a: 3,
};

export function mergeToolGroups(
  groups: ToolGroup[],
  logger: Logger = createLogger('info', 'tools'),
): StructuredToolInterface[] {
  const ordered = [...groups].sort(
    (a, b) => PRIORITY[a.source] - PRIORITY[b.source],
  );

  const used = new Set<string>();
  const merged: StructuredToolInterface[] = [];

  for (const group of ordered) {
    for (const item of group.tools) {
      if (!used.has(item.name)) {
        used.add(item.name);
        merged.push(item);
        continue;
      }

      let suffix = 1;
      while (used.has(`${item.name}_${suffix}`)) suffix += 1;
      const name = `${item.name}_${suffix}`;
      used.add(name);
      logger.warn(
        `工具名冲突：来源 "${group.source}" 的工具 "${item.name}" 已重命名为 "${name}"`,
      );
      merged.push(renameTool(item, name));
    }
  }

  return merged;
}
