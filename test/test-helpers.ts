import { AssertionError } from "node:assert";
import { afterEach, beforeEach, describe, mock as nodeMock, test } from "node:test";
import { isDeepStrictEqual } from "node:util";

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

function fail(message: string): never {
  throw new AssertionError({ message });
}

function format(value: unknown): string {
  return typeof value === "string" ? JSON.stringify(value) : String(value);
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
    if (match) {
      return match[1];
    }
  }

  return null;
}

function resolveMockSpecifier(specifier: string): string {
  if (!specifier.startsWith(".") && !specifier.startsWith("/")) {
    return specifier;
  }

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

function getCalls(value: unknown): unknown[][] {
  const calls = (value as { mock?: { calls?: unknown[] } }).mock?.calls;
  if (!Array.isArray(calls)) {
    return [];
  }

  return calls.map((call) => {
    if (Array.isArray(call)) {
      return call;
    }

    if (call && typeof call === "object" && "arguments" in call) {
      return Array.from((call as { arguments: Iterable<unknown> }).arguments);
    }

    return [];
  });
}

function matchesObject(actual: unknown, expected: unknown): boolean {
  if (!expected || typeof expected !== "object") {
    return isDeepStrictEqual(actual, expected);
  }

  if (!actual || typeof actual !== "object") {
    return false;
  }

  for (const [key, expectedValue] of Object.entries(expected)) {
    if (!(key in actual)) {
      return false;
    }

    const actualValue = (actual as Record<string, unknown>)[key];
    if (!matchesObject(actualValue, expectedValue)) {
      return false;
    }
  }

  return true;
}

function hasProperty(actual: unknown, property: string): boolean {
  return actual !== null && actual !== undefined && property in Object(actual);
}

function matchesThrown(error: unknown, expected?: unknown): boolean {
  if (expected === undefined) {
    return true;
  }

  if (typeof expected === "string") {
    return error instanceof Error && error.message.includes(expected);
  }

  if (expected instanceof RegExp) {
    return error instanceof Error && expected.test(error.message);
  }

  if (typeof expected === "function") {
    return error instanceof (expected as new (...args: never[]) => Error);
  }

  return matchesObject(error, expected);
}

function assertPass(pass: boolean, negated: boolean, message: string): void {
  if (negated ? pass : !pass) {
    fail(`${negated ? "Expected not: " : "Expected: "}${message}`);
  }
}

interface Matchers {
  not: Matchers;
  rejects: {
    toMatchObject(expected: unknown): Promise<void>;
    toThrow(expected?: unknown): Promise<void>;
  };
  toBe(expected: unknown): void;
  toEqual(expected: unknown): void;
  toContain(expected: unknown): void;
  toContainEqual(expected: unknown): void;
  toBeNull(): void;
  toBeDefined(): void;
  toBeTruthy(): void;
  toBeFalsy(): void;
  toHaveLength(expected: number): void;
  toHaveProperty(property: string): void;
  toBeInstanceOf(expected: new (...args: any[]) => unknown): void;
  toBeLessThan(expected: number): void;
  toMatchObject(expected: unknown): void;
  toHaveBeenCalledTimes(expected: number): void;
  toHaveBeenCalledWith(...expectedArgs: unknown[]): void;
  toThrow(expected?: unknown): void;
}

function createMatchers(actual: unknown, negated = false): Matchers {
  const matchers = {
    get not() {
      return createMatchers(actual, !negated);
    },
    rejects: {
      async toMatchObject(expected: unknown) {
        let rejected: unknown;
        try {
          await actual;
        } catch (error) {
          rejected = error;
        }

        assertPass(rejected !== undefined && matchesObject(rejected, expected), negated, "promise to reject with matching object");
      },
      async toThrow(expected?: unknown) {
        let rejected: unknown;
        try {
          await actual;
        } catch (error) {
          rejected = error;
        }

        assertPass(rejected !== undefined && matchesThrown(rejected, expected), negated, "promise to reject with matching error");
      },
    },
    toBe(expected: unknown) {
      assertPass(Object.is(actual, expected), negated, `${format(actual)} to be ${format(expected)}`);
    },
    toEqual(expected: unknown) {
      assertPass(isDeepStrictEqual(actual, expected), negated, `${format(actual)} to equal ${format(expected)}`);
    },
    toContain(expected: unknown) {
      const pass =
        typeof actual === "string"
          ? actual.includes(String(expected))
          : Array.isArray(actual) && actual.includes(expected);
      assertPass(pass, negated, `${format(actual)} to contain ${format(expected)}`);
    },
    toContainEqual(expected: unknown) {
      const pass = Array.isArray(actual) && actual.some((value) => isDeepStrictEqual(value, expected));
      assertPass(pass, negated, `${format(actual)} to contain equal ${format(expected)}`);
    },
    toBeNull() {
      assertPass(actual === null, negated, `${format(actual)} to be null`);
    },
    toBeDefined() {
      assertPass(actual !== undefined, negated, `${format(actual)} to be defined`);
    },
    toBeTruthy() {
      assertPass(Boolean(actual), negated, `${format(actual)} to be truthy`);
    },
    toBeFalsy() {
      assertPass(!actual, negated, `${format(actual)} to be falsy`);
    },
    toHaveLength(expected: number) {
      assertPass((actual as { length?: number })?.length === expected, negated, `${format(actual)} to have length ${expected}`);
    },
    toHaveProperty(property: string) {
      assertPass(hasProperty(actual, property), negated, `${format(actual)} to have property ${property}`);
    },
    toBeInstanceOf(expected: new (...args: any[]) => unknown) {
      assertPass(actual instanceof expected, negated, `${format(actual)} to be instance of ${expected.name}`);
    },
    toBeLessThan(expected: number) {
      assertPass(typeof actual === "number" && actual < expected, negated, `${format(actual)} to be less than ${expected}`);
    },
    toMatchObject(expected: unknown) {
      assertPass(matchesObject(actual, expected), negated, `${format(actual)} to match object ${format(expected)}`);
    },
    toHaveBeenCalledTimes(expected: number) {
      assertPass(getCalls(actual).length === expected, negated, `mock to be called ${expected} times`);
    },
    toHaveBeenCalledWith(...expectedArgs: unknown[]) {
      const pass = getCalls(actual).some((args) => isDeepStrictEqual(args, expectedArgs));
      assertPass(pass, negated, `mock to be called with ${format(expectedArgs)}`);
    },
    toThrow(expected?: unknown) {
      if (typeof actual !== "function") {
        fail("Expected value to be a function");
      }

      let thrown: unknown;
      try {
        actual();
      } catch (error) {
        thrown = error;
      }

      assertPass(thrown !== undefined && matchesThrown(thrown, expected), negated, "function to throw matching error");
    },
  } satisfies Matchers;

  return matchers;
}

export function expect(actual: unknown): Matchers {
  return createMatchers(actual);
}
