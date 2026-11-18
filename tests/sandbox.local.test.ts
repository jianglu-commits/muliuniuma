import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { constants, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
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
    expect(result.exitCode).toBe(124);
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
    expect(result.stdout.length).toBeGreaterThan(0);
    expect(result.stdout.length).toBeLessThanOrEqual(1_024);
    expect(Buffer.byteLength(result.stdout)).toBeLessThanOrEqual(1_024);
    expect(result.stdout).toContain('输出已截断');
  });

  it('多字节输出按字节截断而不是按字符截断', async () => {
    const result = await sandbox.exec(
      "i=0; while [ $i -lt 2000 ]; do printf '中'; i=$((i+1)); done",
    );
    expect(result.stdout.length).toBeGreaterThan(0);
    expect(Buffer.byteLength(result.stdout)).toBeLessThanOrEqual(1_024);
    expect(result.stdout).toContain('输出已截断');
    const chars = result.stdout.split('中').length - 1;
    expect(chars).toBeGreaterThan(0);
    // 中文每字 3 字节，1024 字节上限只装得下约 341 个字；
    // 若改成按字符截断，字符数会逼近字节上限（上面的 byteLength 断言也会同时失败）。
    expect(chars).toBeLessThan(500);
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

  it('id 越界或退化时拒绝创建沙箱，且不创建/删除 root 之外的目录', async () => {
    const outside = join(dirname(root), 'sandbox-outside-probe');
    await mkdir(outside, { recursive: true });
    await writeFile(join(outside, 'keep.txt'), 'keep');
    const neverCreated = join(dirname(root), 'sandbox-never-created');
    try {
      for (const id of ['..', '../..', '', '.', 'a/..']) {
        const error = await LocalProcessSandbox.create({
          id,
          root,
          timeoutMs: 5_000,
          maxOutputBytes: 1_024,
        }).then(
          () => undefined,
          (e: unknown) => e,
        );
        expect(error).toBeInstanceOf(SandboxEscapeError);
        expect((error as Error).message).toContain(id);
      }
      // 越界目标不得被创建出来
      const probeError = await LocalProcessSandbox.create({
        id: '../sandbox-never-created',
        root,
        timeoutMs: 5_000,
        maxOutputBytes: 1_024,
      }).then(
        () => undefined,
        (e: unknown) => e,
      );
      expect(probeError).toBeInstanceOf(SandboxEscapeError);
      expect(existsSync(neverCreated)).toBe(false);
      // root 之外的目录不得被 dispose 之类的递归删除波及
      expect(existsSync(outside)).toBe(true);
      expect(existsSync(join(outside, 'keep.txt'))).toBe(true);
      // 退化 id（'' / '.' / 'a/..'）不得让 dispose 把 root 自身或同级沙箱删掉
      expect(existsSync(root)).toBe(true);
      expect(existsSync(join(root, 'test'))).toBe(true);
    } finally {
      await rm(outside, { recursive: true, force: true });
      await rm(neverCreated, { recursive: true, force: true });
    }
  });

  it('被信号杀死的命令不会被报成成功', async () => {
    const result = await sandbox.exec('kill -9 $$');
    expect(result.exitCode).not.toBe(0);
    expect(result.exitCode).not.toBe(124);
    expect(result.exitCode).toBe(128 + constants.signals.SIGKILL);
  });

  it('名为 ..foo 的目录不被误判为越界', async () => {
    await sandbox.writeFile('..foo/x.txt', 'dots');
    const data = await sandbox.readFile('..foo/x.txt');
    expect(new TextDecoder().decode(data)).toBe('dots');
  });

  it('命令已退出但 close 事件未送达时不会被误报为超时', async () => {
    // 后台 sleep 持有 stdout 管道，close 要等它结束才触发；
    // 主进程早已退出（exitCode 已有值），超时定时器不该再把它标成超时。
    const result = await sandbox.exec('sleep 1 & exit 0', { timeoutMs: 400 });
    expect(result.exitCode).toBe(0);
    expect(result.timedOut).toBe(false);
  });

  it('spawn 失败的原因始终可见（不受输出上限影响）', async () => {
    const tiny = await LocalProcessSandbox.create({
      id: 'tiny',
      root,
      timeoutMs: 5_000,
      maxOutputBytes: 16,
    });
    try {
      // cwd 不存在 → spawn 直接失败
      const result = await tiny.exec('echo hi', { cwd: 'no-such-dir' });
      expect(result.exitCode).toBe(127);
      expect(result.stderr).toContain('ENOENT');
    } finally {
      await tiny.dispose();
    }
  });
});
