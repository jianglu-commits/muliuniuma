import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { LocalProcessSandbox } from '../src/sandbox/index.js';
import { SandboxEscapeError } from '../src/shared/index.js';

let root: string;
let sandbox: LocalProcessSandbox;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'sandbox-test-'));
  sandbox = await LocalProcessSandbox.create({
    id: 'test',
    root,
    timeoutMs: 5_000,
    maxOutputBytes: 1_024,
  });
});

afterEach(async () => {
  await sandbox?.dispose();
  await rm(root, { recursive: true, force: true });
});

describe('LocalProcessSandbox', () => {
  it('执行命令并返回 stdout', async () => {
    const result = await sandbox.exec('echo hello');
    expect(result.stdout.trim()).toBe('hello');
    expect(result.exitCode).toBe(0);
    expect(result.timedOut).toBe(false);
  });

  it('非零退出码被如实返回', async () => {
    const result = await sandbox.exec('exit 3');
    expect(result.exitCode).toBe(3);
  });

  it('超时后终止命令并标记 timedOut', async () => {
    const result = await sandbox.exec('sleep 5', { timeoutMs: 300 });
    expect(result.timedOut).toBe(true);
  });

  it('命令看不到宿主机的环境变量', async () => {
    process.env.SANDBOX_LEAK_TEST = 'leaked';
    try {
      const result = await sandbox.exec('echo "[$SANDBOX_LEAK_TEST]"');
      expect(result.stdout.trim()).toBe('[]');
    } finally {
      delete process.env.SANDBOX_LEAK_TEST;
    }
  });

  it('超长输出被截断', async () => {
    const result = await sandbox.exec('head -c 100000 /dev/zero | tr "\\0" "a"');
    expect(result.stdout.length).toBeLessThanOrEqual(1_024);
  });

  it('writeFile 与 readFile 在工作目录内往返', async () => {
    await sandbox.writeFile('a/b.txt', 'content');
    const data = await sandbox.readFile('a/b.txt');
    expect(new TextDecoder().decode(data)).toBe('content');
  });

  it('路径越界的 readFile 被拒绝', async () => {
    await expect(sandbox.readFile('../escape.txt')).rejects.toBeInstanceOf(
      SandboxEscapeError,
    );
  });

  it('路径越界的 writeFile 被拒绝', async () => {
    await expect(sandbox.writeFile('../../escape.txt', 'x')).rejects.toBeInstanceOf(
      SandboxEscapeError,
    );
  });

  it('绝对路径的读写被拒绝', async () => {
    await expect(sandbox.readFile('/etc/passwd')).rejects.toBeInstanceOf(
      SandboxEscapeError,
    );
    await expect(sandbox.writeFile('/tmp/escape.txt', 'x')).rejects.toBeInstanceOf(
      SandboxEscapeError,
    );
  });

  it('看似越界但仍留在目录内的路径被允许', async () => {
    await sandbox.writeFile('b.txt', 'inside');
    const data = await sandbox.readFile('a/../b.txt');
    expect(new TextDecoder().decode(data)).toBe('inside');
  });

  it('exec 的 cwd 越界被拒绝', async () => {
    await expect(sandbox.exec('pwd', { cwd: '../' })).rejects.toBeInstanceOf(
      SandboxEscapeError,
    );
    await expect(sandbox.exec('pwd', { cwd: '/etc' })).rejects.toBeInstanceOf(
      SandboxEscapeError,
    );
  });

  it('exec 可在工作目录的子目录中执行', async () => {
    await sandbox.writeFile('sub/file.txt', 'x');
    const result = await sandbox.exec('cat file.txt', { cwd: 'sub' });
    expect(result.stdout.trim()).toBe('x');
  });

  it('超时会连同子进程一起终止', async () => {
    const marker = join(sandbox.workdir, 'alive.txt');
    const result = await sandbox.exec(`(sleep 1; echo alive > "${marker}") & sleep 5`, {
      timeoutMs: 300,
    });
    expect(result.timedOut).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 1_500));
    expect(existsSync(marker)).toBe(false);
  });

  it('dispose 删除工作目录', async () => {
    const workdir = sandbox.workdir;
    await sandbox.dispose();
    expect(existsSync(workdir)).toBe(false);
  });
});
