export interface ExecResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  timedOut: boolean;
}

export interface ExecOptions {
  timeoutMs?: number;
  cwd?: string;
}

export interface Sandbox {
  readonly id: string;
  readonly workdir: string;
  exec(command: string, options?: ExecOptions): Promise<ExecResult>;
  writeFile(relativePath: string, data: string | Uint8Array): Promise<void>;
  readFile(relativePath: string): Promise<Uint8Array>;
  dispose(): Promise<void>;
}

export interface SandboxOptions {
  id: string;
  root: string;
  timeoutMs: number;
  maxOutputBytes: number;
}
