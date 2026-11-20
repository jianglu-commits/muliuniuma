import { stat } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import type { StructuredToolInterface } from '@langchain/core/tools';
import { SkillNotFoundError, SkillParseError, renameTool } from '../shared/index.js';
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
