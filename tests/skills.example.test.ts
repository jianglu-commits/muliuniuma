import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { SkillRegistry, createLoadSkillTool, loadSkills } from '../src/skills/index.js';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SKILLS_DIR = join(REPO_ROOT, 'skills');
const BODY_TAIL = '把结果如实转述给用户';

async function loadExampleRegistry(): Promise<SkillRegistry> {
  return new SkillRegistry(await loadSkills(SKILLS_DIR));
}

describe('示例 skill hello-world', () => {
  it('loadSkills 能加载 hello-world 且 entry 指向 tool.ts', async () => {
    const manifests = await loadSkills(SKILLS_DIR);
    const hello = manifests.find((manifest) => manifest.name === 'hello-world');
    expect(hello).toBeDefined();
    expect(hello?.entry).toBe(join(SKILLS_DIR, 'hello-world', 'tool.ts'));
  });

  it('注册表产出的工具名恰为 hello-world_echo', async () => {
    const registry = await loadExampleRegistry();
    const tools = await registry.loadTools();
    expect(tools.map((tool) => tool.name)).toEqual(['hello-world_echo']);
  });

  it('echo 工具回显输入并加问候前缀', async () => {
    const registry = await loadExampleRegistry();
    const tools = await registry.loadTools();
    const echo = tools.find((tool) => tool.name === 'hello-world_echo');
    expect(echo).toBeDefined();
    const output = String(await echo!.invoke({ value: '世界' }));
    expect(output).toContain('你好');
    expect(output).toContain('世界');
  });

  it('promptSection 含 name 与 description、不含正文', async () => {
    const registry = await loadExampleRegistry();
    const section = registry.promptSection();
    expect(section).toContain('hello-world');
    expect(section).toContain('演示 skill');
    expect(section).not.toContain(BODY_TAIL);
  });

  it('load_skill 返回 SKILL.md 的完整正文', async () => {
    const registry = await loadExampleRegistry();
    const loadSkill = createLoadSkillTool(registry);
    const body = String(await loadSkill.invoke({ name: 'hello-world' }));
    expect(body).toBe(registry.get('hello-world').body);
    expect(body).toContain(BODY_TAIL);
  });

  it('SKILL.md 的 allowed-tools 与正文引用的工具名与注册名一致', async () => {
    const registry = await loadExampleRegistry();
    const manifest = registry.get('hello-world');
    const registered = (await registry.loadTools()).map((tool) => tool.name);
    expect(registered).toContain('hello-world_echo');
    expect(manifest.allowedTools).toContain('hello-world_echo');
    expect(manifest.body).toContain('hello-world_echo');
    expect(manifest.body).not.toContain('hello_echo');
  });
});