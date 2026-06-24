import { afterEach, beforeEach, describe, mock as nodeMock, test } from "node:test";

export { afterEach, beforeEach, describe, test };

type AnyFunction = (...args: any[]) => any;

type MockFunction<T extends AnyFunction> = ((...args: Parameters<T>) => ReturnType<T>) & {
  mock: { calls: Parameters<T>[] };
};

interface MockApi {
  <T extends AnyFunction>(implementation?: T): MockFunction<T>;
  module(specifier: string, factory: () => Record<string, unknown>): unknown;
  restore(): void;
}

function createMock<T extends AnyFunction>(implementation?: T): MockFunction<T> {
  const calls: Parameters<T>[] = [];
  const fn = function (this: unknown, ...args: Parameters<T>): ReturnType<T> {
    calls.push(args);
    return implementation?.apply(this, args) as ReturnType<T>;
  } as MockFunction<T>;

  fn.mock = { calls };
  return fn;
}

function callerUrl(): string | null {
  const stack = new Error().stack?.split("\n") ?? [];
  for (const line of stack) {
    if (line.includes("test-helpers.js") || line.includes("test-helpers.ts")) {
      continue;
    }

    const match = line.match(/(file:\/\/.*):(\d+):(\d+)/);
    if (match) return match[1] ?? null;
  }

  return null;
}

function resolveMockSpecifier(specifier: string): string {
  if (!specifier.startsWith(".") && !specifier.startsWith("/")) return specifier;

  const base = callerUrl();
  return base ? new URL(specifier, base).href : specifier;
}

export const mock: MockApi = Object.assign(
  <T extends AnyFunction>(implementation?: T) => createMock(implementation),
  {
    module(specifier: string, factory: () => Record<string, unknown>) {
      const moduleMock = nodeMock.module as unknown as (
        specifier: string,
        options: { exports: Record<string, unknown> },
      ) => unknown;
      return moduleMock.call(nodeMock, resolveMockSpecifier(specifier), { exports: factory() });
    },
    restore() {
      nodeMock.restoreAll();
    },
  },
);
