import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { constants } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import { SandboxEscapeError } from '../shared/index.js';
import type { ExecOptions, ExecResult, Sandbox, SandboxOptions } from './types.js';

const BASE_ENV: Record<string, string> = {
  PATH: '/usr/local/bin:/usr/bin:/bin',
  LANG: 'C.UTF-8',
  TERM: 'dumb',
};

const TRUNCATION_NOTICE = '\n...[输出已截断]';

/**
 * 采集子进程输出，超过上限后不再累积，避免大输出撑爆宿主进程内存。
 */
class OutputBuffer {
  private readonly chunks: Buffer[] = [];
  private size = 0;
  private truncated = false;

  constructor(private readonly maxBytes: number) {}

  push(chunk: Buffer): void {
    if (this.truncated) return;
    const remaining = this.maxBytes - this.size;
    if (chunk.length <= remaining) {
      this.chunks.push(chunk);
      this.size += chunk.length;
      return;
    }
    if (remaining > 0) {
      this.chunks.push(chunk.subarray(0, remaining));
      this.size += remaining;
    }
    this.truncated = true;
  }

  toText(): string {
    const raw = Buffer.concat(this.chunks);
    if (!this.truncated) return raw.toString('utf8');
    const noticeBytes = Buffer.byteLength(TRUNCATION_NOTICE, 'utf8');
    if (noticeBytes >= this.maxBytes) return new StringDecoder('utf8').write(raw);
    const keep = this.maxBytes - noticeBytes;
    return `${new StringDecoder('utf8').write(raw.subarray(0, keep))}${TRUNCATION_NOTICE}`;
  }
}

/**
 * 进程被信号杀死时按 shell 惯例返回 128 + 信号编号（如 SIGKILL=9 → 137）。
 */
function signalExitCode(signal: NodeJS.Signals): number {
  const number: number | undefined = constants.signals[signal];
  return number === undefined ? 1 : 128 + number;
}

/**
 * detached: true 让子进程自成进程组，超时时必须按组杀掉，
 * 否则 sh -c "sleep 5" 派生的孙进程会变成孤儿继续运行。
 */
function killProcessGroup(child: ChildProcess): void {
  if (child.pid === undefined) {
    child.kill('SIGKILL');
    return;
  }
  try {
    process.kill(-child.pid, 'SIGKILL');
  } catch {
    child.kill('SIGKILL');
  }
}

export class LocalProcessSandbox implements Sandbox {
  readonly id: string;
  readonly workdir: string;

  private readonly timeoutMs: number;
  private readonly maxOutputBytes: number;
  private readonly running = new Set<ChildProcess>();

  private constructor(options: SandboxOptions) {
    const root = resolve(options.root);
    const workdir = resolve(join(root, options.id));
    // id 是公开字段，必须保证 workdir 是 root 的真子目录：
    // id='..' 会把工作目录指到 root 之外，dispose() 就会递归删除那个目录；
    // id='' / '.' 会让 workdir 等于 root 本身，dispose() 会连同级其他沙箱一起删掉。
    const rel = relative(root, workdir);
    if (rel === '' || rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
      throw new SandboxEscapeError(options.id);
    }
    this.id = options.id;
    this.workdir = workdir;
    this.timeoutMs = options.timeoutMs;
    this.maxOutputBytes = options.maxOutputBytes;
  }

  static async create(options: SandboxOptions): Promise<LocalProcessSandbox> {
    const sandbox = new LocalProcessSandbox(options);
    await mkdir(sandbox.workdir, { recursive: true });
    return sandbox;
  }

  /**
   * 把相对路径解析到 workdir 内部，越界即拒绝。
   *
   * 注意：这里刻意不解析符号链接。沙箱内用 `ln -s /etc passwd` 建的软链，
   * readFile 会读到 workdir 之外的内容，writeFile 同样会跟随软链写到外部目标。
   * 这是有意为之：本地进程隔离只用于约束误操作，不是安全边界。
   */
  private resolveInside(relativePath: string): string {
    if (isAbsolute(relativePath)) {
      throw new SandboxEscapeError(relativePath);
    }
    const target = resolve(this.workdir, relativePath);
    const rel = relative(this.workdir, target);
    if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
      throw new SandboxEscapeError(relativePath);
    }
    return target;
  }

  async exec(command: string, options: ExecOptions = {}): Promise<ExecResult> {
    const cwd = options.cwd ? this.resolveInside(options.cwd) : this.workdir;
    const timeoutMs = options.timeoutMs ?? this.timeoutMs;

    return new Promise<ExecResult>((resolvePromise) => {
      const child = spawn('/bin/sh', ['-c', command], {
        cwd,
        env: { ...BASE_ENV, HOME: this.workdir, PWD: this.workdir },
        detached: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      this.running.add(child);

      const stdout = new OutputBuffer(this.maxOutputBytes);
      const stderr = new OutputBuffer(this.maxOutputBytes);
      let timedOut = false;
      let settled = false;
      let spawnError: string | undefined;

      const timer = setTimeout(() => {
        // 子进程可能已经退出、只是 close 事件还没送达（exit 早于 close）：
        // 这时不能再标记超时，否则成功的命令会被报成 exitCode 124。
        if (child.exitCode !== null || child.signalCode !== null) return;
        timedOut = true;
        killProcessGroup(child);
      }, timeoutMs);

      child.stdout?.on('data', (chunk: Buffer) => stdout.push(chunk));
      child.stderr?.on('data', (chunk: Buffer) => stderr.push(chunk));

      const settle = (exitCode: number): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this.running.delete(child);
        const stderrText = stderr.toText();
        resolvePromise({
          stdout: stdout.toText(),
          // spawn 失败的原因单独存放，不经过会被截断的输出缓冲，保证始终可见
          stderr: spawnError === undefined ? stderrText : `${stderrText}${spawnError}`,
          exitCode,
          timedOut,
        });
      };

      child.on('error', (error) => {
        spawnError = error.message;
        settle(127);
      });

      child.on('close', (code, signal) => {
        if (spawnError !== undefined) {
          settle(127);
          return;
        }
        if (timedOut) {
          settle(124);
          return;
        }
        if (code !== null) {
          settle(code);
          return;
        }
        if (signal !== null) {
          // 被信号杀死：返回 128 + 信号编号，不能回退到 0（那会把失败伪装成成功）
          settle(signalExitCode(signal));
          return;
        }
        // 既没有退出码也没有信号：进程没有正常结束，同样不能回退到 0
        settle(1);
      });
    });
  }

  async writeFile(relativePath: string, data: string | Uint8Array): Promise<void> {
    const target = this.resolveInside(relativePath);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, data);
  }

  async readFile(relativePath: string): Promise<Uint8Array> {
    const target = this.resolveInside(relativePath);
    return readFile(target);
  }

  async dispose(): Promise<void> {
    for (const child of this.running) {
      killProcessGroup(child);
    }
    this.running.clear();
    await rm(this.workdir, { recursive: true, force: true });
  }
}
