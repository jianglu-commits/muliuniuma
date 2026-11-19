import type { StructuredToolInterface } from '@langchain/core/tools';
import { createLogger } from '../shared/index.js';
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

/**
 * 用 Proxy 改名而非 invoke 重包装：重包装会把 content_and_artifact 的
 * tuple 拍平成普通内容，工具语义失真。
 *
 * 必须同时拦 get 与 getOwnPropertyDescriptor：只拦 get 时，
 * Object.getOwnPropertyDescriptor(proxy, 'name').value 仍是旧名，
 * 展开运算符与描述符读数会和 .name 打架。
 */
function renameTool(original: StructuredToolInterface, name: string): StructuredToolInterface {
  return new Proxy(original, {
    get(target, property, receiver) {
      if (property === 'name') return name;
      return Reflect.get(target, property, receiver);
    },
    getOwnPropertyDescriptor(target, property) {
      const descriptor = Reflect.getOwnPropertyDescriptor(target, property);
      if (property !== 'name' || descriptor === undefined) return descriptor;
      // 不可配置且不可写的属性必须原样上报，否则违反 Proxy 不变量。
      if (descriptor.configurable === false && descriptor.writable === false) {
        return descriptor;
      }
      return { ...descriptor, value: name };
    },
  });
}

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
