import {
  copyFileSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("better-sqlite3", () => ({
  default: class FakeDatabase {
    constructor(private readonly path: string) {}
    async backup(destination: string): Promise<void> {
      copyFileSync(this.path, destination);
    }
    close(): void {}
  },
}));

vi.mock("electron", () => ({
  app: { getPath: () => process.cwd() },
}));

import { importDatabaseSnapshot } from "../../../src/main/db/database";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("Internal database import", () => {
  it("uses the SQLite backup boundary and atomically installs its snapshot", async () => {
    const directory = mkdtempSync(join(tmpdir(), "anything-analyzer-import-"));
    temporaryDirectories.push(directory);
    const sourcePath = join(directory, "public.db");
    const destinationPath = join(directory, "internal", "data.db");
    writeFileSync(sourcePath, "sqlite-backup-snapshot");

    await importDatabaseSnapshot(sourcePath, destinationPath);

    expect(readFileSync(destinationPath, "utf-8")).toBe(
      "sqlite-backup-snapshot",
    );
  });

  it("never overwrites an existing Internal database", async () => {
    const directory = mkdtempSync(join(tmpdir(), "anything-analyzer-import-"));
    temporaryDirectories.push(directory);
    const sourcePath = join(directory, "public.db");
    const destinationPath = join(directory, "internal.db");
    writeFileSync(sourcePath, "public");
    writeFileSync(destinationPath, "internal");

    await expect(
      importDatabaseSnapshot(sourcePath, destinationPath),
    ).rejects.toThrow(/already exists/i);
    expect(readFileSync(destinationPath, "utf-8")).toBe("internal");
  });
});
