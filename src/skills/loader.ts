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
