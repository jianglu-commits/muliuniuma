import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SkillRegistry, createLoadSkillTool, loadSkills } from '../src/skills/index.js';
import { SkillNotFoundError, SkillParseError } from '../src/shared/index.js';

let dir: string | undefined;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'skills-reg-'));
});

afterEach(async () => {
  if (dir !== undefined) {
    await rm(dir, { recursive: true, force: true });
  }
  dir = undefined;
});

async function writeSkill(
  folder: string,
  name: string,
  description = '演示',
  body = '正文',
): Promise<string> {
  const skillDir = join(dir!, folder);
  await mkdir(skillDir, { recursive: true });
  await writeFile(
    join(skillDir, 'SKILL.md'),
    ['---', `name: ${name}`, `description: ${description}`, '---', body].join('\n'),
  );
  return skillDir;
}

const ECHO_TOOL_SOURCE = [
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

describe('SkillRegistry', () => {
  it('列出全部 skill 的 name 与 description', async () => {
    await writeSkill('demo', 'demo', '演示', '正文');

    const registry = new SkillRegistry(await loadSkills(dir!));
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
    const skillDir = await writeSkill('demo', 'demo');
    await writeFile(join(skillDir, 'tool.ts'), ECHO_TOOL_SOURCE);

    const registry = new SkillRegistry(await loadSkills(dir!));
    const tools = await registry.loadTools();
    expect(tools).toHaveLength(1);
    expect(tools[0]?.name).toBe('demo_echo');
    const output = await tools[0]!.invoke({ value: 'hi' });
    expect(String(output)).toBe('hi');
  });

  it('重名 skill 构造时 fail-fast，错误含名字与两个目录', async () => {
    const dirA = await writeSkill('a', 'demo');
    const dirB = await writeSkill('b', 'demo');

    const manifests = await loadSkills(dir!);
    expect(() => new SkillRegistry(manifests)).toThrowError(SkillParseError);
    expect(() => new SkillRegistry(manifests)).toThrowError('demo');
    expect(() => new SkillRegistry(manifests)).toThrowError(dirA);
    expect(() => new SkillRegistry(manifests)).toThrowError(dirB);
  });

  it('list 返回全部 skill，且 promptSection 与 list 条目一致', async () => {
    await writeSkill('alpha', 'alpha', '第一个');
    await writeSkill('beta', 'beta', '第二个');

    const registry = new SkillRegistry(await loadSkills(dir!));
    const listed = registry.list();
    expect(listed.map((m) => m.name)).toEqual(['alpha', 'beta']);
    const lines = registry.promptSection().split('\n').slice(1);
    expect(lines).toEqual(listed.map((m) => `- ${m.name}: ${m.description}`));
  });

  it('空注册表的 promptSection 返回空字符串', () => {
    const registry = new SkillRegistry([]);
    expect(registry.promptSection()).toBe('');
  });

  it('无 entry 的 skill 被 loadTools 跳过', async () => {
    await writeSkill('plain', 'plain');
    const skillDir = await writeSkill('with-tool', 'with-tool');
    await writeFile(join(skillDir, 'tool.ts'), ECHO_TOOL_SOURCE);

    const registry = new SkillRegistry(await loadSkills(dir!));
    const tools = await registry.loadTools();
    expect(tools.map((t) => t.name)).toEqual(['with-tool_echo']);
  });

  it('两个 skill 的同名工具靠前缀区分且行为各自正确', async () => {
    const dirA = await writeSkill('a', 'a');
    const dirB = await writeSkill('b', 'b');
    await writeFile(
      join(dirA, 'tool.ts'),
      ECHO_TOOL_SOURCE.replace('=> value', "=> `a:${value}`"),
    );
    await writeFile(
      join(dirB, 'tool.ts'),
      ECHO_TOOL_SOURCE.replace('=> value', "=> `b:${value}`"),
    );

    const registry = new SkillRegistry(await loadSkills(dir!));
    const tools = await registry.loadTools();
    expect(tools.map((t) => t.name)).toEqual(['a_echo', 'b_echo']);
    expect(String(await tools[0]!.invoke({ value: 'hi' }))).toBe('a:hi');
    expect(String(await tools[1]!.invoke({ value: 'hi' }))).toBe('b:hi');
  });

  it('加前缀后保留 returnDirect / responseFormat / extras 行为配置', async () => {
    const skillDir = await writeSkill('demo', 'demo');
    await writeFile(
      join(skillDir, 'tool.ts'),
      [
        "import { tool } from 'langchain';",
        "import { z } from 'zod';",
        'export const tools = [',
        '  tool(async ({ value }) => [value, { artifact: true }], {',
        "    name: 'echo',",
        "    description: '回显',",
        '    schema: z.object({ value: z.string() }),',
        '    returnDirect: true,',
        "    responseFormat: 'content_and_artifact',",
        "    extras: { provider: 'demo-provider' },",
        '  }),',
        '];',
        '',
      ].join('\n'),
    );

    const registry = new SkillRegistry(await loadSkills(dir!));
    const tools = await registry.loadTools();
    expect(tools).toHaveLength(1);
    expect(tools[0]).toMatchObject({
      name: 'demo_echo',
      returnDirect: true,
      responseFormat: 'content_and_artifact',
      extras: { provider: 'demo-provider' },
    });
    expect(await tools[0]!.invoke({ value: 'hi' })).toBe('hi');
    const message = await tools[0]!.invoke({
      type: 'tool_call',
      id: 'call_1',
      name: 'demo_echo',
      args: { value: 'hi' },
    });
    expect(message).toMatchObject({ content: 'hi', artifact: { artifact: true } });
  });

  it('loadTools 幂等：连续两次调用工具名与行为一致', async () => {
    const skillDir = await writeSkill('demo', 'demo');
    await writeFile(join(skillDir, 'tool.ts'), ECHO_TOOL_SOURCE);

    const registry = new SkillRegistry(await loadSkills(dir!));
    const first = await registry.loadTools();
    const second = await registry.loadTools();
    expect(first.map((t) => t.name)).toEqual(['demo_echo']);
    expect(second.map((t) => t.name)).toEqual(['demo_echo']);
    expect(String(await first[0]!.invoke({ value: 'hi' }))).toBe('hi');
    expect(String(await second[0]!.invoke({ value: 'hi' }))).toBe('hi');
  });

  it('tools 不是数组时抛含 skill 名与 entry 路径的错误', async () => {
    const skillDir = await writeSkill('demo', 'demo');
    const entry = join(skillDir, 'tool.ts');
    await writeFile(entry, "export const tools = { name: 'echo' };\n");

    const registry = new SkillRegistry(await loadSkills(dir!));
    await expect(registry.loadTools()).rejects.toThrowError(SkillParseError);
    await expect(registry.loadTools()).rejects.toThrowError('demo');
    await expect(registry.loadTools()).rejects.toThrowError(entry);
  });

  it('tools 元素缺 name 时抛含 skill 名与 entry 路径的错误', async () => {
    const skillDir = await writeSkill('demo', 'demo');
    const entry = join(skillDir, 'tool.ts');
    await writeFile(
      entry,
      "export const tools = [{ invoke: async () => 'x', schema: {} }];\n",
    );

    const registry = new SkillRegistry(await loadSkills(dir!));
    await expect(registry.loadTools()).rejects.toThrowError(SkillParseError);
    await expect(registry.loadTools()).rejects.toThrowError('demo');
    await expect(registry.loadTools()).rejects.toThrowError(entry);
  });

  it('tool.ts 有语法错误时抛含 skill 名与 entry 路径的错误', async () => {
    const skillDir = await writeSkill('demo', 'demo');
    const entry = join(skillDir, 'tool.ts');
    await writeFile(entry, 'export const tools = [;\n');

    const registry = new SkillRegistry(await loadSkills(dir!));
    await expect(registry.loadTools()).rejects.toThrowError(SkillParseError);
    await expect(registry.loadTools()).rejects.toThrowError('demo');
    await expect(registry.loadTools()).rejects.toThrowError(entry);
  });

  it('tool.ts 未导出 tools 时抛含 skill 名与 entry 路径的错误', async () => {
    const skillDir = await writeSkill('demo', 'demo');
    const entry = join(skillDir, 'tool.ts');
    await writeFile(entry, 'export const other = 1;\n');

    const registry = new SkillRegistry(await loadSkills(dir!));
    await expect(registry.loadTools()).rejects.toThrowError(SkillParseError);
    await expect(registry.loadTools()).rejects.toThrowError('demo');
    await expect(registry.loadTools()).rejects.toThrowError(entry);
  });

  it('tools 元素缺 description 时抛含 description 的错误', async () => {
    const skillDir = await writeSkill('demo', 'demo');
    const entry = join(skillDir, 'tool.ts');
    await writeFile(
      entry,
      "export const tools = [{ name: 'echo', invoke: async () => 'x', schema: {} }];\n",
    );

    const registry = new SkillRegistry(await loadSkills(dir!));
    await expect(registry.loadTools()).rejects.toThrowError(SkillParseError);
    await expect(registry.loadTools()).rejects.toThrowError('description');
  });

  it('写 proxy.name 抛错且不污染模块缓存原对象', async () => {
    const skillDir = await writeSkill('demo', 'demo');
    await writeFile(join(skillDir, 'tool.ts'), ECHO_TOOL_SOURCE);

    const registry = new SkillRegistry(await loadSkills(dir!));
    const tools = await registry.loadTools();
    expect(() => {
      tools[0]!.name = 'hacked';
    }).toThrowError();

    const again = await registry.loadTools();
    expect(again.map((t) => t.name)).toEqual(['demo_echo']);
  });

  it('own-property 描述符的 name 与前缀一致', async () => {
    const skillDir = await writeSkill('demo', 'demo');
    await writeFile(join(skillDir, 'tool.ts'), ECHO_TOOL_SOURCE);

    const registry = new SkillRegistry(await loadSkills(dir!));
    const tools = await registry.loadTools();
    expect(Object.getOwnPropertyDescriptor(tools[0]!, 'name')?.value).toBe('demo_echo');
  });

  it('entry 是名为 tool.ts 的目录时抛明确错误而非 import 裸栈', async () => {
    const skillDir = await writeSkill('demo', 'demo');
    const entry = join(skillDir, 'tool.ts');
    await mkdir(entry);

    const registry = new SkillRegistry(await loadSkills(dir!));
    await expect(registry.loadTools()).rejects.toThrowError(SkillParseError);
    await expect(registry.loadTools()).rejects.toThrowError('不是普通文件');
    await expect(registry.loadTools()).rejects.toThrowError('demo');
    await expect(registry.loadTools()).rejects.toThrowError(entry);
  });
});

describe('createLoadSkillTool', () => {
  it('按名字返回 skill 正文', async () => {
    await writeSkill('demo', 'demo', '演示', '详细正文');

    const registry = new SkillRegistry(await loadSkills(dir!));
    const loadTool = createLoadSkillTool(registry);
    const output = await loadTool.invoke({ name: 'demo' });
    expect(String(output)).toBe('详细正文');
  });

  it('工具名恰好是 load_skill', async () => {
    const registry = new SkillRegistry([]);
    expect(createLoadSkillTool(registry).name).toBe('load_skill');
  });

  it('传未注册名字时抛 SkillNotFoundError', async () => {
    const registry = new SkillRegistry([]);
    const loadTool = createLoadSkillTool(registry);
    await expect(loadTool.invoke({ name: 'nope' })).rejects.toThrowError(SkillNotFoundError);
  });
});
