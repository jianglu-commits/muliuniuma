import { SandboxNotRegisteredError } from '../shared/index.js';
import { LocalProcessSandbox } from './local.js';
import type { Sandbox, SandboxOptions } from './types.js';

export type SandboxFactory = (options: SandboxOptions) => Promise<Sandbox>;

const factories = new Map<string, SandboxFactory>([
  ['local', (options) => LocalProcessSandbox.create(options)],
]);

export function registerSandbox(kind: string, factory: SandboxFactory): void {
  factories.set(kind, factory);
}

export async function createSandbox(
  kind: string,
  options: SandboxOptions,
): Promise<Sandbox> {
  const factory = factories.get(kind);
  if (!factory) {
    throw new SandboxNotRegisteredError(kind, [...factories.keys()]);
  }
  return factory(options);
}