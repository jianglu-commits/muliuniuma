import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
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
    this.id = options.id;
    this.workdir = resolve(join(options.root, options.id));
    this.timeoutMs = options.timeoutMs;
    this.maxOutputBytes = options.maxOutputBytes;
  }

  static async create(options: SandboxOptions): Promise<LocalProcessSandbox> {
    const sandbox = new LocalProcessSandbox(options);
    await mkdir(sandbox.workdir, { recursive: true });
    return sandbox;
  }

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

      const timer = setTimeout(() => {
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
        resolvePromise({
          stdout: stdout.toText(),
          stderr: stderr.toText(),
          exitCode,
          timedOut,
        });
      };

      child.on('error', (error) => {
        stderr.push(Buffer.from(`\n${error.message}`, 'utf8'));
        settle(127);
      });

      child.on('close', (code) => {
        settle(code ?? (timedOut ? 124 : 0));
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
