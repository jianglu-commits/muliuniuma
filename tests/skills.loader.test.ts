import { chmod, mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { loadSkills, parseSkillFile } from '../src/skills/index.js';
import { SkillParseError } from '../src/shared/index.js';

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return { ...actual, readdir: vi.fn(actual.readdir) };
});

let dir: string | undefined;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'skills-'));
});

afterEach(async () => {
  if (dir !== undefined) {
    await rm(dir, { recursive: true, force: true });
  }
  dir = undefined;
});

async function writeSkill(name: string, lines: string[]): Promise<string> {
  const skillDir = join(dir!, name);
  await mkdir(skillDir, { recursive: true });
  await writeFile(join(skillDir, 'SKILL.md'), lines.join('\n'));
  return skillDir;
}

describe('parseSkillFile', () => {
  const valid = [
    '---',
    'name: hello-world',
    'description: 演示用的 skill',
    'allowed-tools: [echo, sandbox_exec]',
    '---',
    '',
    '正文第一段。',
  ].join('\n');

  it('解析 frontmatter 与正文', () => {
    const manifest = parseSkillFile(valid, '/tmp/hello-world');
    expect(manifest.name).toBe('hello-world');
    expect(manifest.description).toBe('演示用的 skill');
    expect(manifest.allowedTools).toEqual(['echo', 'sandbox_exec']);
    expect(manifest.body).toBe('正文第一段。');
    expect(manifest.dir).toBe('/tmp/hello-world');
  });

  it('缺少 frontmatter 抛 SkillParseError', () => {
    expect(() => parseSkillFile('没有 frontmatter', '/tmp/x')).toThrowError(
      SkillParseError,
    );
  });

  it('缺少 name 抛错', () => {
    const noName = ['---', 'description: x', '---', 'body'].join('\n');
    expect(() => parseSkillFile(noName, '/tmp/x')).toThrowError(/name/);
  });

  it('缺少 description 抛错', () => {
    const noDesc = ['---', 'name: x', '---', 'body'].join('\n');
    expect(() => parseSkillFile(noDesc, '/tmp/x')).toThrowError(/description/);
  });

  it('双引号包裹的标量剥掉引号', () => {
    const quoted = [
      '---',
      'name: "hello-world"',
      'description: "演示用的 skill"',
      '---',
      'body',
    ].join('\n');
    const manifest = parseSkillFile(quoted, '/tmp/x');
    expect(manifest.name).toBe('hello-world');
    expect(manifest.description).toBe('演示用的 skill');
  });

  it('单引号包裹的标量剥掉引号', () => {
    const quoted = [
      '---',
      "name: 'hello-world'",
      "description: '演示用的 skill'",
      '---',
      'body',
    ].join('\n');
    const manifest = parseSkillFile(quoted, '/tmp/x');
    expect(manifest.name).toBe('hello-world');
    expect(manifest.description).toBe('演示用的 skill');
  });

  it('值内部的引号不被破坏', () => {
    const inner = [
      '---',
      'name: x',
      'description: 带 "内嵌引号" 与 \'单引号\' 的值',
      '---',
      'body',
    ].join('\n');
    expect(parseSkillFile(inner, '/tmp/x').description).toBe(
      '带 "内嵌引号" 与 \'单引号\' 的值',
    );
  });

  it('首尾不匹配的引号不剥', () => {
    const mismatched = [
      '---',
      'name: "unclosed',
      'description: d',
      '---',
      'body',
    ].join('\n');
    expect(parseSkillFile(mismatched, '/tmp/x').name).toBe('"unclosed');
  });

  it('allowed-tools 缺省时为空数组', () => {
    const noTools = ['---', 'name: x', 'description: d', '---', 'body'].join('\n');
    expect(parseSkillFile(noTools, '/tmp/x').allowedTools).toEqual([]);
  });

  it('allowed-tools 为单个字符串时包装成数组', () => {
    const single = [
      '---',
      'name: x',
      'description: d',
      'allowed-tools: echo',
      '---',
      'body',
    ].join('\n');
    expect(parseSkillFile(single, '/tmp/x').allowedTools).toEqual(['echo']);
  });

  it('allowed-tools 为空数组时保持空数组', () => {
    const empty = [
      '---',
      'name: x',
      'description: d',
      'allowed-tools: []',
      '---',
      'body',
    ].join('\n');
    expect(parseSkillFile(empty, '/tmp/x').allowedTools).toEqual([]);
  });

  it('行内数组元素同样剥掉成对引号', () => {
    const quotedItems = [
      '---',
      'name: x',
      'description: d',
      'allowed-tools: ["echo", \'sandbox_exec\']',
      '---',
      'body',
    ].join('\n');
    expect(parseSkillFile(quotedItems, '/tmp/x').allowedTools).toEqual([
      'echo',
      'sandbox_exec',
    ]);
  });

  it('只有 frontmatter 没有正文时 body 为空串', () => {
    const noBody = ['---', 'name: x', 'description: d', '---'].join('\n');
    expect(parseSkillFile(noBody, '/tmp/x').body).toBe('');
  });

  it('CRLF 换行的 SKILL.md 正确解析', () => {
    const crlf = [
      '---',
      'name: x',
      'description: d',
      'allowed-tools: [echo]',
      '---',
      '',
      '正文。',
    ].join('\r\n');
    const manifest = parseSkillFile(crlf, '/tmp/x');
    expect(manifest.name).toBe('x');
    expect(manifest.description).toBe('d');
    expect(manifest.allowedTools).toEqual(['echo']);
    expect(manifest.body).toBe('正文。');
  });

  it('frontmatter 里的 # 注释行被忽略', () => {
    const commented = [
      '---',
      '# 这是注释',
      'name: x',
      '  # 缩进的注释',
      'description: d',
      '---',
      'body',
    ].join('\n');
    const manifest = parseSkillFile(commented, '/tmp/x');
    expect(manifest.name).toBe('x');
    expect(manifest.description).toBe('d');
  });

  it('剥掉开头的 UTF-8 BOM 后正常解析', () => {
    const manifest = parseSkillFile(`\uFEFF${valid}`, '/tmp/x');
    expect(manifest.name).toBe('hello-world');
    expect(manifest.body).toBe('正文第一段。');
  });
});

describe('loadSkills', () => {
  it('目录不存在时返回空数组', async () => {
    expect(await loadSkills(join(dir!, 'missing'))).toEqual([]);
  });

  it('扫描每个子目录下的 SKILL.md', async () => {
    const skillDir = join(dir!, 'demo');
    await mkdir(skillDir, { recursive: true });
    await writeFile(
      join(skillDir, 'SKILL.md'),
      ['---', 'name: demo', 'description: d', '---', 'body'].join('\n'),
    );

    const manifests = await loadSkills(dir!);
    expect(manifests).toHaveLength(1);
    expect(manifests[0]?.name).toBe('demo');
    expect(manifests[0]?.entry).toBeUndefined();
  });

  it('存在 tool.ts 时记录 entry 路径', async () => {
    const skillDir = join(dir!, 'demo');
    await mkdir(skillDir, { recursive: true });
    await writeFile(
      join(skillDir, 'SKILL.md'),
      ['---', 'name: demo', 'description: d', '---', 'body'].join('\n'),
    );
    await writeFile(join(skillDir, 'tool.ts'), 'export const tools = [];\n');

    const manifests = await loadSkills(dir!);
    expect(manifests[0]?.entry).toBe(join(skillDir, 'tool.ts'));
  });

  it('指向普通文件路径时抛出 ENOTDIR 而不是返回空数组', async () => {
    const filePath = join(dir!, 'not-a-dir');
    await writeFile(filePath, 'i am a file');
    await expect(loadSkills(filePath)).rejects.toMatchObject({ code: 'ENOTDIR' });
  });

  it('一个坏 skill 让整体 fail-fast，错误信息含坏 skill 目录', async () => {
    await writeSkill('aaa-good', ['---', 'name: good', 'description: d', '---', 'body']);
    const badDir = await writeSkill('zzz-bad', ['---', 'description: d', '---', 'body']);

    const error = await loadSkills(dir!).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(SkillParseError);
    expect((error as Error).message).toContain(badDir);
  });

  it('多个 skill 按目录名排序输出', async () => {
    await writeSkill('zeta', ['---', 'name: zeta', 'description: d', '---', 'body']);
    await writeSkill('alpha', ['---', 'name: alpha', 'description: d', '---', 'body']);
    await writeSkill('mid', ['---', 'name: mid', 'description: d', '---', 'body']);

    const manifests = await loadSkills(dir!);
    expect(manifests.map((m) => m.name)).toEqual(['alpha', 'mid', 'zeta']);
  });

  // 本机文件系统恰好按字母序返回条目，必须模拟乱序 readdir 才能检验排序契约。
  it('readdir 返回乱序时输出仍按目录名排序', async () => {
    await writeSkill('zeta', ['---', 'name: zeta', 'description: d', '---', 'body']);
    await writeSkill('alpha', ['---', 'name: alpha', 'description: d', '---', 'body']);
    await writeSkill('mid', ['---', 'name: mid', 'description: d', '---', 'body']);
    const entries = await readdir(dir!, { withFileTypes: true });
    const descending = entries.sort((a, b) => (a.name > b.name ? -1 : 1));
    vi.mocked(readdir).mockImplementationOnce(async () => descending as never);

    const manifests = await loadSkills(dir!);
    expect(manifests.map((m) => m.name)).toEqual(['alpha', 'mid', 'zeta']);
  });

  it('没有 SKILL.md 的子目录被跳过', async () => {
    await mkdir(join(dir!, 'empty-dir'), { recursive: true });
    await writeSkill('demo', ['---', 'name: demo', 'description: d', '---', 'body']);

    const manifests = await loadSkills(dir!);
    expect(manifests).toHaveLength(1);
    expect(manifests[0]?.name).toBe('demo');
  });

  it('目录里的普通文件条目被跳过', async () => {
    await writeFile(join(dir!, 'stray.txt'), 'not a skill');
    await writeSkill('demo', ['---', 'name: demo', 'description: d', '---', 'body']);

    const manifests = await loadSkills(dir!);
    expect(manifests).toHaveLength(1);
    expect(manifests[0]?.name).toBe('demo');
  });

  // root 用户可以读 mode 000 的文件，构造不出 EACCES，跳过该用例。
  it.skipIf(process.getuid?.() === 0)(
    'SKILL.md 存在但不可读时抛出而不是静默跳过',
    async () => {
      const skillDir = await writeSkill('demo', [
        '---',
        'name: demo',
        'description: d',
        '---',
        'body',
      ]);
      await chmod(join(skillDir, 'SKILL.md'), 0o000);

      await expect(loadSkills(dir!)).rejects.toMatchObject({ code: 'EACCES' });
    },
  );
});
