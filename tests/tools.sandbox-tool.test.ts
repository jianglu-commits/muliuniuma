import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createSandbox, registerSandbox } from '../src/sandbox/index.js';
import type { Sandbox, SandboxOptions } from '../src/sandbox/index.js';
import { createSandboxTools } from '../src/tools/index.js';
import { SandboxEscapeError, SandboxNotRegisteredError } from '../src/shared/index.js';

let root: string;
let sandbox: Sandbox | undefined;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'sandbox-tool-'));
  sandbox = await createSandbox('local', {
    id: 'tool-test',
    root,
    timeoutMs: 5_000,
    maxOutputBytes: 4_096,
  });
});

afterEach(async () => {
  await sandbox?.dispose();
  sandbox = undefined;
  await rm(root, { recursive: true, force: true });
});

describe('createSandboxTools', () => {
  it('sandbox_exec 执行命令并回传 JSON', async () => {
    const tools = createSandboxTools(sandbox!);
    const execTool = tools.find((t) => t.name === 'sandbox_exec');
    expect(execTool).toBeDefined();

    const output = await execTool!.invoke({ command: 'echo hi' });
    const parsed = JSON.parse(String(output)) as { stdout: string; exitCode: number };
    expect(parsed.stdout.trim()).toBe('hi');
    expect(parsed.exitCode).toBe(0);
  });

  it('sandbox_write_file 写入后能读回', async () => {
    const tools = createSandboxTools(sandbox!);
    const writeTool = tools.find((t) => t.name === 'sandbox_write_file');
    expect(writeTool).toBeDefined();

    const output = await writeTool!.invoke({ path: 'note.txt', content: 'hello' });
    expect(output).toBe('已写入 note.txt');
    const read = await sandbox!.readFile('note.txt');
    expect(new TextDecoder().decode(read)).toBe('hello');
  });

  it('返回的工具恰好是 sandbox_exec 与 sandbox_write_file', () => {
    const tools = createSandboxTools(sandbox!);
    expect(tools.map((t) => t.name).sort()).toEqual(['sandbox_exec', 'sandbox_write_file']);
  });

  it('sandbox_exec 如实回传非零退出码', async () => {
    const tools = createSandboxTools(sandbox!);
    const execTool = tools.find((t) => t.name === 'sandbox_exec');

    const output = await execTool!.invoke({ command: 'exit 3' });
    const parsed = JSON.parse(String(output)) as { exitCode: number; timedOut: boolean };
    expect(parsed.exitCode).toBe(3);
    expect(parsed.timedOut).toBe(false);
  });

  it('sandbox_exec 透传 timeoutMs 并如实回传超时', async () => {
    const tools = createSandboxTools(sandbox!);
    const execTool = tools.find((t) => t.name === 'sandbox_exec');

    const output = await execTool!.invoke({ command: 'sleep 5', timeoutMs: 300 });
    const parsed = JSON.parse(String(output)) as { exitCode: number; timedOut: boolean };
    expect(parsed.timedOut).toBe(true);
    expect(parsed.exitCode).toBe(124);
  });

  it('sandbox_write_file 越界路径 reject SandboxEscapeError', async () => {
    const tools = createSandboxTools(sandbox!);
    const writeTool = tools.find((t) => t.name === 'sandbox_write_file');

    await expect(
      writeTool!.invoke({ path: '../escape.txt', content: 'x' }),
    ).rejects.toBeInstanceOf(SandboxEscapeError);
  });
});

describe('createSandbox 注册表', () => {
  it('registerSandbox 注入的自定义工厂可被 createSandbox 使用', async () => {
    const fake: Sandbox = {
      id: 'fake',
      workdir: root,
      exec: async () => ({ stdout: 'fake', stderr: '', exitCode: 0, timedOut: false }),
      writeFile: async () => {},
      readFile: async () => new Uint8Array(),
      dispose: async () => {},
    };
    let received: SandboxOptions | undefined;
    registerSandbox('fake', async (options) => {
      received = options;
      return fake;
    });

    const options: SandboxOptions = {
      id: 'fake-instance',
      root,
      timeoutMs: 1_000,
      maxOutputBytes: 1_024,
    };
    const created = await createSandbox('fake', options);
    expect(created).toBe(fake);
    expect(received).toBe(options);
  });

  it('未注册的 kind 抛 SandboxNotRegisteredError，信息含 kind 与可用列表', async () => {
    const error: unknown = await createSandbox('no-such-kind', {
      id: 'missing',
      root,
      timeoutMs: 1_000,
      maxOutputBytes: 1_024,
    }).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(SandboxNotRegisteredError);
    expect((error as SandboxNotRegisteredError).code).toBe('SANDBOX_NOT_REGISTERED');
    expect((error as SandboxNotRegisteredError).message).toContain('no-such-kind');
    expect((error as SandboxNotRegisteredError).message).toContain('local');
  });
});