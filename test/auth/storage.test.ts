import { afterEach, describe, expect, mock, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

async function importStorageModule() {
  return import(`../../src/auth/storage.ts?test=${crypto.randomUUID()}`);
}

afterEach(() => {
  mock.restore();
});

describe("auth/storage", () => {
  test("saveToken enforces 0600 permissions even when token file already exists", async () => {
    const homeDir = await mkdtemp(join(tmpdir(), "pi-perplexity-storage-"));
    const tokenPath = join(homeDir, ".config", "pi-perplexity", "auth.json");

    try {
      mock.module("node:os", () => ({
        homedir: () => homeDir,
      }));

      await mkdir(dirname(tokenPath), { recursive: true });
      await writeFile(tokenPath, '{"type":"oauth","access":"old"}\n', {
        encoding: "utf8",
        mode: 0o644,
      });

      const { saveToken } = await importStorageModule();
      await saveToken({ type: "oauth", access: "new-token" });

      const fileMode = (await stat(tokenPath)).mode & 0o777;
      expect(fileMode).toBe(0o600);

      const saved = JSON.parse(await readFile(tokenPath, "utf8")) as {
        type: string;
        access: string;
      };
      expect(saved.type).toBe("oauth");
      expect(saved.access).toBe("new-token");
    } finally {
      await rm(homeDir, { recursive: true, force: true });
    }
  });
});
